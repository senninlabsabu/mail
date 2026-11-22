require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// 起動前に必須設定を確認する
const PLACEHOLDER = /^(replace-|change-this)/;
const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET']
  .filter(k => !process.env[k] || PLACEHOLDER.test(process.env[k]));
if (missing.length) {
  console.error(`.env に次の値を設定してください: ${missing.join(', ')}`);
  process.exit(1);
}

const db = require('./db');
const V = require('./views');
const { SupabaseSessionStore, startSessionCleanup } = require('./sessionStore');

const PAGE_SIZE = 50;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { styleSrc: ["'self'", "'unsafe-inline'"] } } }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(session({
  name: 'nb.sid',
  secret: process.env.SESSION_SECRET,
  store: new SupabaseSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
  },
}));

// --- helpers ---
const str = v => (typeof v === 'string' ? v : '');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const regenerate = req => new Promise((ok, ng) => req.session.regenerate(e => (e ? ng(e) : ok())));
const destroy = req => new Promise((ok, ng) => req.session.destroy(e => (e ? ng(e) : ok())));
const idParam = req => {
  const n = Number(req.params.id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const fingerprint = ip => crypto.createHmac('sha256', process.env.SESSION_SECRET)
  .update(String(ip || '')).digest('hex');

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  return req.session.csrf;
}

// ページ描画に必要な共通コンテキスト。フラッシュメッセージは一度だけ表示する
function ctx(req, extra = {}) {
  const flash = req.session.flash;
  delete req.session.flash;
  return { user: req.user || null, csrf: csrfToken(req), unread: req.unread || 0, flash, ...extra };
}

function send(req, res, status, title, build, extra = {}) {
  const c = ctx(req, extra);
  res.status(status).send(V.page(title, build(c), c));
}

// --- CSRF 検証（すべての POST に適用） ---
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const sent = str(req.body && req.body._csrf);
  const expected = req.session && req.session.csrf;
  if (expected && sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
    return next();
  }
  res.status(403).type('text').send('フォームの有効期限が切れました。ページを再読み込みしてからもう一度お試しください。');
});

// --- 認可 ---
async function loadUser(req) {
  const id = req.session.userId;
  if (!id) return null;
  const u = await db.findUserById(id);
  if (!u || u.status !== 'active') {
    await destroy(req).catch(() => {});
    return null;
  }
  return u;
}

const requireUser = wrap(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u) return res.redirect('/login');
  req.user = u;
  req.unread = await db.countUnread(u.id);
  next();
});

const requireAdmin = [
  requireUser,
  (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).send('管理者のみ利用できます')),
];

// --- レート制限 ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true, // 成功したログインは数えない
  standardHeaders: true,
  legacyHeaders: false,
  message: '試行回数が多すぎます。しばらく時間をおいてください。',
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: '申請回数が多すぎます。時間をおいてください。',
});

// --- 利用者向け ---
app.get('/', requireUser, wrap(async (req, res) => {
  const msgs = await db.listMessages(req.user.id);
  const freshIds = msgs.filter(m => !m.read_at).map(m => m.id);
  if (freshIds.length) await db.markRead(freshIds);
  send(req, res, 200, '受信箱', () => V.inboxBody({ msgs, fresh: new Set(freshIds) }), { unread: 0 });
}));

app.get('/register', (req, res) => send(req, res, 200, '利用登録申請', c => V.registerBody(c)));

app.post('/register', registerLimiter, wrap(async (req, res) => {
  const username = str(req.body.username).trim();
  const password = str(req.body.password);
  const reason = str(req.body.reason).trim();
  const fail = (status, error) =>
    send(req, res, status, '利用登録申請', c => V.registerBody({ ...c, error }));

  if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
    return fail(400, 'ユーザー名は3〜24文字の英数字・_・- で入力してください');
  }
  // bcrypt は 72 バイトまでしか使わないため、それ以上は受け付けない
  if (password.length < 12 || Buffer.byteLength(password) > 72) {
    return fail(400, 'パスワードは12文字以上、72バイト以内で入力してください');
  }
  if (reason.length < 3 || reason.length > 500) {
    return fail(400, '申請理由は3〜500文字で入力してください');
  }

  const fp = fingerprint(req.ip);
  if ((await db.countOpenByFingerprint(fp)) >= 3) {
    return fail(429, '同じ接続元からの申請上限に達しました。管理者へお問い合わせください。');
  }

  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    user = await db.insertUser({
      username, password_hash: hash, role: 'user', status: 'pending', reason, ip_fingerprint: fp,
    });
  } catch (e) {
    if (e.code === '23505') return fail(400, 'このユーザー名は利用できません');
    throw e;
  }

  await db.insertMessages([{
    user_id: user.id,
    title: '申請を受け付けました',
    body: '管理者の審査が完了するまでお待ちください。承認されるとログインできるようになります。',
    kind: 'system',
  }]);
  send(req, res, 200, '申請受付', () => V.registeredBody());
}));

app.get('/login', (req, res) => send(req, res, 200, 'ログイン', c => V.loginBody(c)));

app.post('/login', loginLimiter, wrap(async (req, res) => {
  const username = str(req.body.username).trim();
  const password = str(req.body.password);
  const u = username ? await db.findUserByName(username) : null;
  const passOk = !!(u && password && await bcrypt.compare(password, u.password_hash));

  if (!passOk) {
    return send(req, res, 401, 'ログイン失敗', () =>
      '<p>ユーザー名またはパスワードが違います。</p><p><a href="/login">戻る</a></p>');
  }
  if (u.status === 'pending') {
    return send(req, res, 403, '審査待ち', () =>
      '<p>管理者の審査待ちです。承認されるまでログインできません。</p>');
  }
  if (u.status !== 'active') {
    return send(req, res, 403, '利用不可', () =>
      '<p>このアカウントは現在利用できません。管理者にお問い合わせください。</p>');
  }

  await regenerate(req); // セッション固定化対策
  req.session.userId = u.id;
  res.redirect('/');
}));

app.post('/logout', wrap(async (req, res) => {
  await destroy(req).catch(() => {});
  res.clearCookie('nb.sid');
  res.redirect('/login');
}));

// --- 管理者向け ---
app.get('/admin', requireAdmin, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const [pending, users, active] = await Promise.all([
    db.listPending(),
    db.listUsers(page, PAGE_SIZE),
    db.listActiveRegularUsers(),
  ]);
  send(req, res, 200, '管理', c => V.adminBody({
    ...c, pending, users: users.rows, total: users.total, page, pageSize: PAGE_SIZE, active,
  }));
}));

app.get('/admin/audit', requireAdmin, wrap(async (req, res) => {
  const logs = await db.listAudit(200);
  send(req, res, 200, '監査ログ', () => V.auditBody(logs));
}));

function statusAction(path, from, to, action, label, onDone) {
  app.post(path, requireAdmin, wrap(async (req, res) => {
    const id = idParam(req);
    if (!id) return send(req, res, 400, 'エラー', () => '<p>不正なIDです。</p>');
    const ok = await db.transition(id, from, to);
    if (ok) {
      await db.insertAudit({ adminId: req.user.id, action, targetUser: id });
      if (onDone) await onDone(id);
    }
    req.session.flash = ok ? `${label}しました` : '対象が見つからないか、既に処理済みです';
    res.redirect('/admin');
  }));
}

statusAction('/admin/approve/:id', ['pending'], 'active', 'approve', '承認', id =>
  db.insertMessages([{
    user_id: id, title: '利用登録が承認されました', body: 'ログインしてご利用いただけます。', kind: 'system',
  }]));
statusAction('/admin/reject/:id', ['pending'], 'rejected', 'reject', '拒否');
statusAction('/admin/suspend/:id', ['active'], 'suspended', 'suspend', '停止');
statusAction('/admin/reactivate/:id', ['suspended'], 'active', 'reactivate', '再開');

app.post('/admin/message', requireAdmin, wrap(async (req, res) => {
  const to = str(req.body.to);
  const title = str(req.body.title).trim();
  const body = str(req.body.body).trim();
  const kind = req.body.kind === 'internal-code' ? 'internal-code' : 'notice';
  const back = msg => { req.session.flash = msg; res.redirect('/admin'); };

  if (!title || title.length > 120 || !body || body.length > 2000) {
    return back('タイトル（120文字以内）と本文（2000文字以内）を入力してください');
  }

  const broadcast = to === 'all';
  let targets;
  if (broadcast) {
    targets = await db.activeRegularUserIds();
  } else {
    const id = Number(to);
    const u = Number.isSafeInteger(id) ? await db.findUserById(id) : null;
    if (!u || u.role !== 'user' || u.status !== 'active') return back('有効な利用者が見つかりません');
    targets = [u.id];
  }
  if (!targets.length) return back('送信先の利用者がいません');

  await db.insertMessages(targets.map(user_id => ({ user_id, title, body, kind })));
  await db.insertAudit({
    adminId: req.user.id,
    action: broadcast ? 'broadcast' : 'message',
    targetUser: broadcast ? null : targets[0],
  });
  back(`${targets.length}名に送信しました`);
}));

// --- 404 / エラー ---
app.use((req, res) => send(req, res, 404, '404', () => '<p>ページが見つかりません。</p>'));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type('text').send('サーバーでエラーが発生しました。時間をおいて再度お試しください。');
});

// --- 初期管理者 ---
async function ensureAdmin() {
  const name = process.env.ADMIN_USERNAME || 'admin';
  const pass = process.env.ADMIN_PASSWORD || '';
  if (pass.length < 12 || pass === 'change-this-long-password') {
    console.warn('WARNING: ADMIN_PASSWORD を12文字以上の値に設定してください（初期管理者は作成されません）');
    return;
  }
  if (await db.findUserByName(name)) return;
  try {
    await db.insertUser({
      username: name,
      password_hash: await bcrypt.hash(pass, 12),
      role: 'admin',
      status: 'active',
      reason: '初期管理者',
      ip_fingerprint: '',
    });
    console.log(`初期管理者 ${name} を作成しました`);
  } catch (e) {
    if (e.code !== '23505') throw e; // 同時起動による重複は無視
  }
}

const port = Number(process.env.PORT || 3000);
ensureAdmin()
  .then(() => {
    startSessionCleanup();
    app.listen(port, () => console.log(`NotifyBox running on http://localhost:${port}`));
  })
  .catch(err => {
    console.error('起動に失敗しました:', err.message);
    process.exit(1);
  });

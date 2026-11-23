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
const api = express.Router();
app.use('/api/v1', express.json({ limit: '8kb' }), api); // セッション/CSRFの対象外 (APIキー認証)
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

const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const codeHash = c => crypto.createHmac('sha256', process.env.SESSION_SECRET).update('code:' + c).digest('hex');
const clientUA = req => str(req.get('user-agent')).slice(0, 400);
const GENDERS = ['male', 'female', 'other', 'no_answer'];

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

app.get('/messages/:id', requireUser, wrap(async (req, res) => {
  const id = idParam(req);
  const m = id ? await db.getMessageForUser(id, req.user.id) : null;
  if (!m) return send(req, res, 404, '404', () => '<p>メッセージが見つかりません。</p>');
  if (!m.read_at) await db.markRead([m.id]);
  send(req, res, 200, m.title, () => V.messageBody(m), { unread: Math.max(0, req.unread - (m.read_at ? 0 : 1)) });
}));

app.get('/register', (req, res) => send(req, res, 200, '利用登録申請', c => V.registerBody(c)));

app.post('/register', registerLimiter, wrap(async (req, res) => {
  const username = str(req.body.username).trim();
  const password = str(req.body.password);
  const realName = str(req.body.real_name).trim();
  const ageRaw = str(req.body.age).trim();
  const gender = str(req.body.gender);
  const values = { username, real_name: realName, age: ageRaw, gender };
  const fail = (status, error) =>
    send(req, res, status, '利用登録申請', c => V.registerBody({ ...c, error, values }));

  if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
    return fail(400, 'ユーザー名は3〜24文字の英数字・_・- で入力してください');
  }
  // bcrypt は 72 バイトまでしか使わないため、それ以上は受け付けない
  if (password.length < 12 || Buffer.byteLength(password) > 72) {
    return fail(400, 'パスワードは12文字以上、72バイト以内で入力してください');
  }
  if (realName.length < 1 || realName.length > 50) return fail(400, '本名は50文字以内で入力してください');
  const age = /^\d{1,3}$/.test(ageRaw) ? Number(ageRaw) : 0;
  if (age < 1 || age > 120) return fail(400, '年齢は1〜120の数字で入力してください');
  if (!GENDERS.includes(gender)) return fail(400, '性別を選択してください');
  if (req.body.consent !== '1') return fail(400, '情報の取得・保存への同意が必要です');

  const fp = fingerprint(req.ip);
  if ((await db.countOpenByFingerprint(fp)) >= 3) {
    return fail(429, '同じ接続元からの申請上限に達しました。管理者へお問い合わせください。');
  }

  const hash = await bcrypt.hash(password, 12);
  let user;
  try {
    user = await db.insertUser({
      username, password_hash: hash, role: 'user', status: 'pending',
      real_name: realName, age, gender,
      ip_address: String(req.ip || '').slice(0, 64),
      user_agent: clientUA(req),
      accept_language: str(req.get('accept-language')).slice(0, 100),
      ip_fingerprint: fp,
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
  await db.updateLastLogin(u.id, String(req.ip || '').slice(0, 64), clientUA(req)).catch(e => console.error(e.message));
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

app.get('/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const u = id ? await db.findUserDetail(id) : null;
  if (!u) return send(req, res, 404, '404', () => '<p>ユーザーが見つかりません。</p>');
  await db.insertAudit({ adminId: req.user.id, action: 'view_user', targetUser: u.id }); // 個人情報の閲覧を記録
  send(req, res, 200, u.username, () => V.userDetailBody(u));
}));

app.post('/admin/message', requireAdmin, wrap(async (req, res) => {
  const to = str(req.body.to);
  const title = str(req.body.title).trim();
  const body = str(req.body.body).trim();
  const kind = req.body.kind === 'internal-code' ? 'internal-code' : 'notice';
  const format = req.body.format === 'html' ? 'html' : 'text';
  const back = msg => { req.session.flash = msg; res.redirect('/admin'); };

  const maxBody = format === 'html' ? 20000 : 2000;
  if (!title || title.length > 120 || !body || body.length > maxBody) {
    return back(`タイトル（120文字以内）と本文（${maxBody}文字以内）を入力してください`);
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

  const batch = await db.insertBatch({
    sender_id: req.user.id, source: 'admin', title, body, kind, format, recipient_count: targets.length,
  });
  await db.insertMessages(targets.map(user_id => ({ user_id, title, body, kind, format, batch_id: batch.id })));
  await db.insertAudit({
    adminId: req.user.id,
    action: broadcast ? 'broadcast' : 'message',
    targetUser: broadcast ? null : targets[0],
  });
  req.session.flash = `${targets.length}名に送信しました`;
  res.redirect(`/admin/sent/${batch.id}`);
}));

// --- 送信履歴 ---
app.get('/admin/sent', requireAdmin, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const { rows, total } = await db.listBatches(page, PAGE_SIZE);
  send(req, res, 200, '送信履歴', () => V.sentListBody({ rows, total, page, pageSize: PAGE_SIZE }));
}));

app.get('/admin/sent/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const batch = id ? await db.getBatch(id) : null;
  if (!batch) return send(req, res, 404, '404', () => '<p>送信履歴が見つかりません。</p>');
  const rec = await db.batchRecipients(batch.id, 200);
  send(req, res, 200, batch.title, () => V.sentDetailBody({ batch, rec }));
}));

// --- 外部アプリ管理 ---
app.get('/admin/apps', requireAdmin, wrap(async (req, res) => {
  const apps = await db.listApps();
  const origin = `${req.protocol}://${req.get('host')}`;
  send(req, res, 200, '外部アプリ', c => V.appsBody({ apps, csrf: c.csrf, origin }));
}));

app.post('/admin/apps', requireAdmin, wrap(async (req, res) => {
  const name = str(req.body.name).trim();
  if (!name || name.length > 40) {
    req.session.flash = 'アプリ名は1〜40文字で入力してください';
    return res.redirect('/admin/apps');
  }
  const key = 'nbk_' + crypto.randomBytes(24).toString('hex');
  await db.insertApp({ name, key_hash: hashKey(key), created_by: req.user.id });
  await db.insertAudit({ adminId: req.user.id, action: 'app_create', targetUser: null });
  res.set('Cache-Control', 'no-store');
  send(req, res, 200, 'APIキー発行', () => V.appCreatedBody({ name, key }));
}));

app.post('/admin/apps/:id/:op', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const op = req.params.op;
  let ok = false;
  if (id && op === 'disable') ok = await db.setAppStatus(id, 'disabled');
  else if (id && op === 'enable') ok = await db.setAppStatus(id, 'active');
  else if (id && op === 'delete') ok = await db.deleteApp(id);
  if (ok) await db.insertAudit({ adminId: req.user.id, action: `app_${op}`, targetUser: null });
  req.session.flash = ok ? '更新しました' : '対象が見つかりません';
  res.redirect('/admin/apps');
}));

// --- 外部アプリ向け API (認証コード) ---
const CODE_TTL_SEC = 600;
const CODE_MAX_ATTEMPTS = 5;
const CODE_MAX_PER_10MIN = 5;
const apiErr = (res, status, error) => res.status(status).json({ error });

api.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => hashKey(req.get('authorization') || req.ip),
  handler: (req, res) => apiErr(res, 429, 'rate_limited'),
}));

api.use(wrap(async (req, res, next) => {
  const m = /^Bearer (nbk_[a-f0-9]{48})$/.exec(req.get('authorization') || '');
  const a = m ? await db.findAppByKeyHash(hashKey(m[1])) : null;
  if (!a || a.status !== 'active') return apiErr(res, 401, 'invalid_api_key');
  req.extApp = a;
  db.touchApp(a.id).catch(() => {});
  next();
}));

api.post('/codes/send', wrap(async (req, res) => {
  const username = str(req.body && req.body.username).trim();
  const u = username ? await db.findUserByName(username) : null;
  if (!u || u.role !== 'user' || u.status !== 'active') return apiErr(res, 404, 'user_not_found');

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  if ((await db.countRecentCodes(req.extApp.id, u.id, since)) >= CODE_MAX_PER_10MIN) {
    return apiErr(res, 429, 'too_many_codes');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const row = await db.insertCode({
    app_id: req.extApp.id,
    user_id: u.id,
    code_hash: codeHash(code),
    expires_at: new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString(),
  });

  const title = `【${req.extApp.name}】認証コード`;
  const batch = await db.insertBatch({
    app_id: req.extApp.id, source: 'app', title, kind: 'internal-code', format: 'text', recipient_count: 1,
    body: '（認証コードは管理画面には保存・表示されません）',
  });
  await db.insertMessages([{
    user_id: u.id, title, kind: 'internal-code', format: 'text', batch_id: batch.id, app_id: req.extApp.id,
    body: `認証コード: ${code}\n有効期限: ${CODE_TTL_SEC / 60}分\n心当たりがない場合は無視してください。このコードを他人に教えないでください。`,
  }]);
  res.json({ id: row.id, expires_in: CODE_TTL_SEC });
}));

api.post('/codes/verify', wrap(async (req, res) => {
  const id = str(req.body && req.body.id);
  const code = str(req.body && req.body.code);
  const invalid = reason => res.json({ valid: false, reason });
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{6}$/.test(code)) return invalid('bad_request');

  const row = await db.getCode(id);
  if (!row || row.app_id !== req.extApp.id) return invalid('not_found');
  if (row.used_at) return invalid('already_used');
  if (new Date(row.expires_at) < new Date()) return invalid('expired');
  if (row.attempts >= CODE_MAX_ATTEMPTS) return invalid('too_many_attempts');

  const a = Buffer.from(codeHash(code));
  const b = Buffer.from(row.code_hash);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    await db.bumpAttempts(row.id, row.attempts);
    return invalid('mismatch');
  }
  if (!(await db.markCodeUsed(row.id))) return invalid('already_used');
  const u = await db.findUserById(row.user_id);
  res.json({ valid: true, username: u ? u.username : null });
}));

// --- 404 / エラー ---
app.use((req, res) => send(req, res, 404, '404', () => '<p>ページが見つかりません。</p>'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) {
    if (err.type !== 'entity.parse.failed') console.error(err);
    return res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.type === 'entity.parse.failed' ? 'invalid_json' : 'server_error' });
  }
  console.error(err);
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
      real_name: '初期管理者',
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

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmt = d => (d ? new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '');
const csrfField = csrf => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

const KIND = { notice: 'お知らせ', 'internal-code': '内部コード', system: 'システム' };
const STATUS = { pending: '審査待ち', active: '有効', rejected: '拒否', suspended: '停止中' };
const ACTION = {
  approve: '承認', reject: '拒否', suspend: '停止', reactivate: '再開', message: '個別通知', broadcast: '全体通知',
  view_user: '個人情報の閲覧', app_create: '外部アプリ作成', app_disable: '外部アプリ無効化',
  app_enable: '外部アプリ有効化', app_delete: '外部アプリ削除',
};
const GENDER = { male: '男性', female: '女性', other: 'その他', no_answer: '回答しない' };

// HTMLメールはスクリプト不可・外部通信不可のサンドボックスiframeで表示する
function htmlFrame(html) {
  const cleaned = String(html ?? '').replace(/<\/?(meta|base|script|iframe|object|embed|link|form)\b[^>]*>/gi, '');
  const doc = '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">' +
    '<base target="_blank"><style>body{font-family:system-ui,sans-serif;color:#222;background:#fff;margin:12px}</style>' + cleaned;
  return `<iframe class="mailframe" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${esc(doc)}"></iframe>`;
}
const content = m => (m.format === 'html' ? htmlFrame(m.body) : `<p class="body">${esc(m.body)}</p>`);
const snippet = (s, n = 60) => { const t = String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

const CSS = `
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;max-width:860px;margin:30px auto;padding:0 16px;line-height:1.6}
header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
h1{margin:0;font-size:1.6rem}
h2{margin-top:28px}
a{color:#4a90e2}
nav{display:flex;flex-wrap:wrap;gap:14px;align-items:center;border-bottom:1px solid #8885;padding-bottom:10px}
.card,article{padding:16px;border:1px solid #8885;border-radius:12px;margin:14px 0}
input,textarea,select,button{font:inherit;padding:10px;margin:6px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #8888;background:transparent;color:inherit}
textarea{min-height:110px}
button{cursor:pointer;background:#4a90e2;color:#fff;border-color:#4a90e2;width:auto;padding:8px 16px}
button.danger{background:#d9534f;border-color:#d9534f}
button.link{background:none;border:0;color:#4a90e2;padding:0;margin:0}
label{display:block;margin-top:8px;font-weight:600}
.inline{display:inline-block;margin:0 8px 0 0;padding:0;border:0}
.inline button{margin:4px 0}
.muted{opacity:.7;font-size:.9em}
.pill{display:inline-block;padding:1px 8px;border:1px solid #8888;border-radius:20px;font-size:.85em}
.pill.new{border-color:#4a90e2;color:#4a90e2}
.badge{display:inline-block;min-width:1.4em;padding:0 6px;border-radius:20px;background:#d9534f;color:#fff;font-size:.8em;text-align:center}
.body,.reason{white-space:pre-wrap;word-break:break-word}
.reason{padding:10px;background:#8881;border-radius:8px}
.flash{padding:10px 14px;border-radius:8px;background:#4a90e233}
.error{color:#d9534f;font-weight:600}
.mailframe{width:100%;height:480px;border:1px solid #8885;border-radius:8px;background:#fff;resize:vertical}
.table-wrap{overflow-x:auto}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}dt{font-weight:600}dd{margin:0;word-break:break-all}
code,pre{background:#8882;border-radius:6px;padding:2px 6px}pre{padding:10px;overflow-x:auto}
input[type=checkbox]{width:auto;margin-right:8px}
table{width:100%;border-collapse:collapse;font-size:.92em}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #8883;vertical-align:middle}
.pager{display:flex;gap:16px;align-items:center;margin:12px 0}
footer{margin-top:40px}
`;

function page(title, body, c = {}) {
  const { user, csrf, unread = 0, flash } = c;
  const nav = user ? `<nav>
  <a href="/">受信箱${unread ? ` <span class="badge">${unread}</span>` : ''}</a>
  ${user.role === 'admin' ? '<a href="/admin">管理</a><a href="/admin/sent">送信履歴</a><a href="/admin/apps">外部アプリ</a><a href="/admin/audit">監査ログ</a>' : ''}
  <form method="post" action="/logout" class="inline">${csrfField(csrf)}<button class="link">ログアウト</button></form>
</nav>` : '';
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | NotifyBox</title><style>${CSS}</style></head>
<body>
<header><h1>NotifyBox</h1>${user ? `<span>${esc(user.username)} <span class="pill">${user.role === 'admin' ? '管理者' : '利用者'}</span></span>` : ''}</header>
${nav}
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
${body}
<footer class="muted"><p>内部通知専用です。外部メール・SMS連携はありません。</p></footer>
</body></html>`;
}

function loginBody({ csrf }) {
  return `<h2>ログイン</h2>
<form method="post" action="/login" class="card">${csrfField(csrf)}
  <label>ユーザー名</label><input name="username" required maxlength="24" autocomplete="username">
  <label>パスワード</label><input name="password" type="password" required autocomplete="current-password">
  <button>ログイン</button>
</form>
<p><a href="/register">利用登録を申請する</a></p>`;
}

function registerBody({ csrf, error, values = {} }) {
  const val = k => esc(values[k] ?? '');
  const sel = (k, x) => (values[k] === x ? ' selected' : '');
  return `<h2>利用登録申請</h2>
<p class="card">申請後、管理者が承認するまでログインできません。入力内容と接続情報（IPアドレス・ブラウザ情報）は、本人確認と不正利用の防止のため管理者が確認します。</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/register" class="card">${csrfField(csrf)}
  <label>ユーザー名（3〜24文字、英数字・_・-）</label>
  <input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_-]+" value="${val('username')}">
  <label>パスワード（12文字以上）</label>
  <input name="password" type="password" required minlength="12" autocomplete="new-password">
  <label>本名</label>
  <input name="real_name" required maxlength="50" autocomplete="name" value="${val('real_name')}">
  <label>年齢</label>
  <input name="age" type="number" required min="1" max="120" inputmode="numeric" value="${val('age')}">
  <label>性別</label>
  <select name="gender" required>
    <option value="">選択してください</option>
    <option value="male"${sel('gender', 'male')}>男性</option>
    <option value="female"${sel('gender', 'female')}>女性</option>
    <option value="other"${sel('gender', 'other')}>その他</option>
    <option value="no_answer"${sel('gender', 'no_answer')}>回答しない</option>
  </select>
  <label style="font-weight:400"><input type="checkbox" name="consent" value="1" required>上記の情報とIPアドレス・ブラウザ情報の取得・保存に同意します</label>
  <button>申請する</button>
</form>
<p><a href="/login">ログインへ戻る</a></p>`;
}

function registeredBody() {
  return `<h2>申請を受け付けました</h2>
<p>管理者の審査が完了するまでお待ちください。承認されるとログインできるようになります。</p>
<p><a href="/login">ログイン画面へ</a></p>`;
}

function inboxBody({ msgs, fresh }) {
  if (!msgs.length) return '<h2>受信箱</h2><p class="muted">通知はありません。</p>';
  return '<h2>受信箱</h2>' + msgs.map(m => `<article>
  <h3>${fresh.has(m.id) ? '<span class="pill new">NEW</span> ' : ''}<a href="/messages/${m.id}">${esc(m.title)}</a></h3>
  <p class="body">${m.format === 'html' ? `<span class="pill">HTML</span> ${esc(snippet(m.body))}` : esc(m.body)}</p>
  <small class="muted">${esc(KIND[m.kind] || m.kind)} · ${fmt(m.created_at)}</small>
</article>`).join('');
}

function messageBody(m) {
  return `<p><a href="/">← 受信箱へ戻る</a></p>
<article>
  <h2>${esc(m.title)}</h2>
  <small class="muted">${esc(KIND[m.kind] || m.kind)} · ${fmt(m.created_at)}${m.format === 'html' ? ' · HTML' : ''}</small>
  ${content(m)}
</article>`;
}

function adminBody({ pending, users, total, page, pageSize, active, csrf }) {
  const pendingHtml = pending.length ? pending.map(u => `<article>
  <h3><a href="/admin/users/${u.id}">${esc(u.username)}</a> <small class="muted">#${u.id}</small></h3>
  <dl>
    <dt>本名</dt><dd>${esc(u.real_name)}</dd>
    <dt>年齢 / 性別</dt><dd>${esc(u.age ?? '')} / ${esc(GENDER[u.gender] || u.gender)}</dd>
    <dt>IPアドレス</dt><dd>${esc(u.ip_address)}</dd>
    <dt>User-Agent</dt><dd>${esc(u.user_agent)}</dd>
    <dt>申請日時</dt><dd>${fmt(u.created_at)}</dd>
  </dl>
  <form method="post" action="/admin/approve/${u.id}" class="inline">${csrfField(csrf)}<button>承認して有効化</button></form>
  <form method="post" action="/admin/reject/${u.id}" class="inline">${csrfField(csrf)}<button class="danger">拒否</button></form>
</article>`).join('') : '<p class="muted">審査待ちの申請はありません。</p>';

  const userRows = users.map(u => {
    let action = '';
    if (u.role !== 'admin' && u.status === 'active') {
      action = `<form method="post" action="/admin/suspend/${u.id}" class="inline">${csrfField(csrf)}<button class="danger">停止</button></form>`;
    } else if (u.role !== 'admin' && u.status === 'suspended') {
      action = `<form method="post" action="/admin/reactivate/${u.id}" class="inline">${csrfField(csrf)}<button>再開</button></form>`;
    }
    return `<tr><td>${u.id}</td><td><a href="/admin/users/${u.id}">${esc(u.username)}</a></td><td>${u.role === 'admin' ? '管理者' : '利用者'}</td>
<td><span class="pill">${esc(STATUS[u.status] || u.status)}</span></td><td>${fmt(u.created_at)}</td><td>${action}</td></tr>`;
  }).join('');

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pager = `<div class="pager">
  ${page > 1 ? `<a href="/admin?page=${page - 1}">← 前へ</a>` : ''}
  <span class="muted">${page} / ${pages}（全${total}件）</span>
  ${page < pages ? `<a href="/admin?page=${page + 1}">次へ →</a>` : ''}
</div>`;

  const options = active.map(u => `<option value="${u.id}">${esc(u.username)} (#${u.id})</option>`).join('');

  return `<h2>審査待ち</h2>
${pendingHtml}

<h2>通知を送信</h2>
<form method="post" action="/admin/message" class="card">${csrfField(csrf)}
  <label>送信先</label>
  <select name="to" required><option value="all">全員（有効な利用者）</option>${options}</select>
  <label>種類</label>
  <select name="kind"><option value="notice">お知らせ</option><option value="internal-code">内部コード</option></select>
  <label>形式</label>
  <select name="format"><option value="text">テキスト</option><option value="html">HTML（サンドボックス表示）</option></select>
  <label>タイトル（120文字以内）</label>
  <input name="title" required maxlength="120">
  <label>本文（テキスト2000文字 / HTML20000文字まで）</label>
  <textarea name="body" required maxlength="20000"></textarea>
  <p class="muted">HTMLはスクリプト・外部画像・フォームが無効な枠内に表示されます。画像は data: URI のみ使えます。</p>
  <button>送信</button>
</form>

<h2>ユーザー</h2>
<div class="table-wrap"><table>
  <thead><tr><th>ID</th><th>ユーザー名</th><th>種別</th><th>状態</th><th>登録日時</th><th></th></tr></thead>
  <tbody>${userRows || '<tr><td colspan="6" class="muted">ユーザーがいません</td></tr>'}</tbody>
</table></div>
${pager}
<p><a href="/admin/sent">送信履歴</a> · <a href="/admin/apps">外部アプリ</a> · <a href="/admin/audit">監査ログ</a></p>`;
}

function auditBody(logs) {
  const rows = logs.map(l => `<tr>
  <td>${fmt(l.created_at)}</td>
  <td>${esc(l.admin_name || '（削除済み）')}</td>
  <td>${esc(ACTION[l.action] || l.action)}</td>
  <td>${esc(l.target_name || (l.target_user ? `#${l.target_user}` : '全体'))}</td>
</tr>`).join('');
  return `<h2>監査ログ（直近200件）</h2>
<div class="table-wrap"><table>
  <thead><tr><th>日時</th><th>管理者</th><th>操作</th><th>対象</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="muted">記録はありません</td></tr>'}</tbody>
</table></div>
<p><a href="/admin">管理画面へ戻る</a></p>`;
}

function userDetailBody(u) {
  return `<p><a href="/admin">← 管理画面へ戻る</a></p>
<h2>${esc(u.username)} <small class="muted">#${u.id}</small></h2>
<div class="card"><dl>
  <dt>状態</dt><dd>${esc(STATUS[u.status] || u.status)}（${u.role === 'admin' ? '管理者' : '利用者'}）</dd>
  <dt>本名</dt><dd>${esc(u.real_name)}</dd>
  <dt>年齢</dt><dd>${esc(u.age ?? '')}</dd>
  <dt>性別</dt><dd>${esc(GENDER[u.gender] || u.gender)}</dd>
  <dt>登録日時</dt><dd>${fmt(u.created_at)}</dd>
  <dt>登録時IP</dt><dd>${esc(u.ip_address)}</dd>
  <dt>登録時UA</dt><dd>${esc(u.user_agent)}</dd>
  <dt>登録時言語</dt><dd>${esc(u.accept_language)}</dd>
  <dt>最終ログイン</dt><dd>${fmt(u.last_login_at)}</dd>
  <dt>最終ログインIP</dt><dd>${esc(u.last_login_ip)}</dd>
  <dt>最終ログインUA</dt><dd>${esc(u.last_login_ua)}</dd>
</dl></div>
<p class="muted">この画面の閲覧は監査ログに記録されます。</p>`;
}

function sentListBody({ rows, total, page, pageSize }) {
  const trs = rows.map(b => `<tr>
  <td>${fmt(b.created_at)}</td>
  <td><a href="/admin/sent/${b.id}">${esc(b.title)}</a></td>
  <td>${esc(KIND[b.kind] || b.kind)}${b.format === 'html' ? ' / HTML' : ''}</td>
  <td>${b.source === 'app' ? esc('アプリ: ' + (b.app && b.app.name || '（削除済み）')) : esc(b.sender && b.sender.username || '（削除済み）')}</td>
  <td>${b.recipient_count}</td></tr>`).join('');
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `<h2>送信履歴</h2>
<div class="table-wrap"><table>
  <thead><tr><th>日時</th><th>タイトル</th><th>種類</th><th>送信元</th><th>宛先数</th></tr></thead>
  <tbody>${trs || '<tr><td colspan="5" class="muted">送信履歴はありません</td></tr>'}</tbody>
</table></div>
<div class="pager">
  ${page > 1 ? `<a href="/admin/sent?page=${page - 1}">← 前へ</a>` : ''}
  <span class="muted">${page} / ${pages}（全${total}件）</span>
  ${page < pages ? `<a href="/admin/sent?page=${page + 1}">次へ →</a>` : ''}
</div>`;
}

function sentDetailBody({ batch: b, rec }) {
  const rows = rec.rows.map(r => `<tr><td>${r.user ? `<a href="/admin/users/${r.user.id}">${esc(r.user.username)}</a>` : '（削除済み）'}</td>
  <td>${r.read_at ? `既読 (${fmt(r.read_at)})` : '<span class="muted">未読</span>'}</td></tr>`).join('');
  return `<p><a href="/admin/sent">← 送信履歴へ戻る</a></p>
<h2>${esc(b.title)}</h2>
<div class="card"><dl>
  <dt>送信日時</dt><dd>${fmt(b.created_at)}</dd>
  <dt>送信元</dt><dd>${b.source === 'app' ? esc('外部アプリ: ' + (b.app && b.app.name || '（削除済み）')) : esc(b.sender && b.sender.username || '（削除済み）')}</dd>
  <dt>種類 / 形式</dt><dd>${esc(KIND[b.kind] || b.kind)} / ${b.format === 'html' ? 'HTML' : 'テキスト'}</dd>
  <dt>宛先数 / 既読</dt><dd>${b.recipient_count}名 / ${rec.read}名</dd>
</dl></div>
<h3>送信内容</h3>
${content(b)}
<h3>宛先${rec.total > rec.rows.length ? `（先頭${rec.rows.length}件 / 全${rec.total}件）` : ''}</h3>
<div class="table-wrap"><table>
  <thead><tr><th>ユーザー</th><th>既読</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="2" class="muted">宛先がありません</td></tr>'}</tbody>
</table></div>`;
}

function appsBody({ apps, csrf, origin }) {
  const trs = apps.map(a => {
    const toggle = a.status === 'active'
      ? `<form method="post" action="/admin/apps/${a.id}/disable" class="inline">${csrfField(csrf)}<button class="danger">無効化</button></form>`
      : `<form method="post" action="/admin/apps/${a.id}/enable" class="inline">${csrfField(csrf)}<button>有効化</button></form>`;
    return `<tr><td>${a.id}</td><td>${esc(a.name)}</td><td><span class="pill">${a.status === 'active' ? '有効' : '無効'}</span></td>
<td>${fmt(a.created_at)}</td><td>${fmt(a.last_used_at) || '<span class="muted">未使用</span>'}</td>
<td>${toggle}<form method="post" action="/admin/apps/${a.id}/delete" class="inline" onsubmit="return confirm('削除しますか？')">${csrfField(csrf)}<button class="danger">削除</button></form></td></tr>`;
  }).join('');
  return `<h2>外部アプリ</h2>
<p class="muted">ご自身が運用するアプリが、登録済み利用者の受信箱へ認証コードを送るためのAPIです。他社サービスの認証コードを受け取る用途には使えません。</p>
<form method="post" action="/admin/apps" class="card">${csrfField(csrf)}
  <label>アプリ名（40文字以内。コード通知の件名に表示されます）</label>
  <input name="name" required maxlength="40">
  <button>アプリを追加してAPIキーを発行</button>
</form>
<div class="table-wrap"><table>
  <thead><tr><th>ID</th><th>名前</th><th>状態</th><th>作成日時</th><th>最終利用</th><th></th></tr></thead>
  <tbody>${trs || '<tr><td colspan="6" class="muted">外部アプリはありません</td></tr>'}</tbody>
</table></div>
<h3>API の使い方</h3>
<p>1. コード送信（利用者の受信箱に6桁コードが届きます。有効10分）</p>
<pre>curl -X POST ${esc(origin)}/api/v1/codes/send \
  -H "Authorization: Bearer nbk_..." \
  -H "Content-Type: application/json" \
  -d '{"username":"alice"}'
→ {"id":"…","expires_in":600}</pre>
<p>2. コード検証（1回のみ有効、5回まで試行可）</p>
<pre>curl -X POST ${esc(origin)}/api/v1/codes/verify \
  -H "Authorization: Bearer nbk_..." \
  -H "Content-Type: application/json" \
  -d '{"id":"…","code":"123456"}'
→ {"valid":true,"username":"alice"}</pre>`;
}

function appCreatedBody({ name, key }) {
  return `<h2>APIキーを発行しました</h2>
<div class="card"><p>アプリ「${esc(name)}」のAPIキーです。<strong>この画面を閉じると二度と表示されません。</strong>今すぐ安全な場所に保存してください。</p>
<pre>${esc(key)}</pre></div>
<p><a href="/admin/apps">外部アプリ一覧へ</a></p>`;
}

module.exports = {
  page, loginBody, registerBody, registeredBody, inboxBody, messageBody, adminBody, auditBody,
  userDetailBody, sentListBody, sentDetailBody, appsBody, appCreatedBody,
};

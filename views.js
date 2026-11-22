const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmt = d => (d ? new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '');
const csrfField = csrf => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

const KIND = { notice: 'お知らせ', 'internal-code': '内部コード', system: 'システム' };
const STATUS = { pending: '審査待ち', active: '有効', rejected: '拒否', suspended: '停止中' };
const ACTION = { approve: '承認', reject: '拒否', suspend: '停止', reactivate: '再開', message: '個別通知', broadcast: '全体通知' };

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
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92em}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #8883;vertical-align:middle}
.pager{display:flex;gap:16px;align-items:center;margin:12px 0}
footer{margin-top:40px}
`;

function page(title, body, c = {}) {
  const { user, csrf, unread = 0, flash } = c;
  const nav = user ? `<nav>
  <a href="/">受信箱${unread ? ` <span class="badge">${unread}</span>` : ''}</a>
  ${user.role === 'admin' ? '<a href="/admin">管理</a><a href="/admin/audit">監査ログ</a>' : ''}
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

function registerBody({ csrf, error }) {
  return `<h2>利用登録申請</h2>
<p class="card">申請後、管理者が承認するまでログインできません。申請理由は管理者のみが確認します。</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/register" class="card">${csrfField(csrf)}
  <label>ユーザー名（3〜24文字、英数字・_・-）</label>
  <input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_-]+">
  <label>パスワード（12文字以上）</label>
  <input name="password" type="password" required minlength="12" autocomplete="new-password">
  <label>申請理由（500文字以内）</label>
  <textarea name="reason" required maxlength="500"></textarea>
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
  <h3>${fresh.has(m.id) ? '<span class="pill new">NEW</span> ' : ''}${esc(m.title)}</h3>
  <p class="body">${esc(m.body)}</p>
  <small class="muted">${esc(KIND[m.kind] || m.kind)} · ${fmt(m.created_at)}</small>
</article>`).join('');
}

function adminBody({ pending, users, total, page, pageSize, active, csrf }) {
  const pendingHtml = pending.length ? pending.map(u => `<article>
  <h3>${esc(u.username)} <small class="muted">#${u.id}</small></h3>
  <p class="muted">申請日時: ${fmt(u.created_at)}</p>
  <p class="reason">${esc(u.reason)}</p>
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
    return `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${u.role === 'admin' ? '管理者' : '利用者'}</td>
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
  <label>タイトル（120文字以内）</label>
  <input name="title" required maxlength="120">
  <label>本文（2000文字以内）</label>
  <textarea name="body" required maxlength="2000"></textarea>
  <button>送信</button>
</form>

<h2>ユーザー</h2>
<div class="table-wrap"><table>
  <thead><tr><th>ID</th><th>ユーザー名</th><th>種別</th><th>状態</th><th>登録日時</th><th></th></tr></thead>
  <tbody>${userRows || '<tr><td colspan="6" class="muted">ユーザーがいません</td></tr>'}</tbody>
</table></div>
${pager}
<p><a href="/admin/audit">監査ログを見る</a></p>`;
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

module.exports = { page, loginBody, registerBody, registeredBody, inboxBody, adminBody, auditBody };

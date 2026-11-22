const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Supabase のレスポンスを検査し、エラーなら Postgres のエラーコードを保持して投げる
function must(res, label) {
  if (res.error) {
    const err = new Error(`[${label}] ${res.error.message}`);
    err.code = res.error.code;
    throw err;
  }
  return res.data;
}

const USER_COLS = 'id,username,role,status,reason,created_at';

// --- users ---
async function findUserByName(username) {
  return must(await sb.from('users').select('*').eq('username', username).maybeSingle(), 'findUserByName');
}

async function findUserById(id) {
  return must(await sb.from('users').select(USER_COLS).eq('id', id).maybeSingle(), 'findUserById');
}

async function insertUser(row) {
  return must(await sb.from('users').insert(row).select(USER_COLS).single(), 'insertUser');
}

async function countOpenByFingerprint(fp) {
  const res = await sb.from('users').select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'active']).eq('ip_fingerprint', fp);
  must(res, 'countOpenByFingerprint');
  return res.count ?? 0;
}

async function listPending() {
  return must(
    await sb.from('users').select(USER_COLS).eq('status', 'pending').order('created_at', { ascending: true }),
    'listPending'
  );
}

async function listUsers(page, size) {
  const from = (page - 1) * size;
  const res = await sb.from('users').select(USER_COLS, { count: 'exact' })
    .order('id', { ascending: false }).range(from, from + size - 1);
  return { rows: must(res, 'listUsers'), total: res.count ?? 0 };
}

async function listActiveRegularUsers() {
  return must(
    await sb.from('users').select('id,username').eq('role', 'user').eq('status', 'active')
      .order('username', { ascending: true }).limit(1000),
    'listActiveRegularUsers'
  );
}

// 全体通知用。Supabase の 1 リクエスト上限 (既定1000行) を超えないようページングする
async function activeRegularUserIds() {
  const ids = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(
      await sb.from('users').select('id').eq('role', 'user').eq('status', 'active')
        .order('id', { ascending: true }).range(from, from + 999),
      'activeRegularUserIds'
    );
    ids.push(...rows.map(r => r.id));
    if (rows.length < 1000) break;
  }
  return ids;
}

// 状態遷移。対象が期待する状態のときだけ更新し、更新できたら true
async function transition(id, fromStatuses, toStatus) {
  const rows = must(
    await sb.from('users').update({ status: toStatus }).eq('id', id).eq('role', 'user')
      .in('status', fromStatuses).select('id'),
    'transition'
  );
  return rows.length > 0;
}

// --- messages ---
async function listMessages(userId, limit = 100) {
  return must(
    await sb.from('messages').select('id,title,body,kind,created_at,read_at')
      .eq('user_id', userId).order('id', { ascending: false }).limit(limit),
    'listMessages'
  );
}

async function insertMessages(rows) {
  if (!rows.length) return;
  must(await sb.from('messages').insert(rows), 'insertMessages');
}

async function markRead(ids) {
  must(await sb.from('messages').update({ read_at: new Date().toISOString() }).in('id', ids), 'markRead');
}

async function countUnread(userId) {
  const res = await sb.from('messages').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).is('read_at', null);
  must(res, 'countUnread');
  return res.count ?? 0;
}

// --- audit ---
async function insertAudit({ adminId, action, targetUser }) {
  must(
    await sb.from('audit').insert({ admin_id: adminId, action, target_user: targetUser ?? null }),
    'insertAudit'
  );
}

async function listAudit(limit = 200) {
  const logs = must(
    await sb.from('audit').select('id,admin_id,action,target_user,created_at')
      .order('id', { ascending: false }).limit(limit),
    'listAudit'
  );
  const ids = [...new Set(logs.flatMap(l => [l.admin_id, l.target_user]).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const rows = must(await sb.from('users').select('id,username').in('id', ids), 'listAuditNames');
    rows.forEach(r => names.set(r.id, r.username));
  }
  return logs.map(l => ({
    ...l,
    admin_name: names.get(l.admin_id) || null,
    target_name: names.get(l.target_user) || null,
  }));
}

module.exports = {
  sb, must,
  findUserByName, findUserById, insertUser, countOpenByFingerprint,
  listPending, listUsers, listActiveRegularUsers, activeRegularUserIds, transition,
  listMessages, insertMessages, markRead, countUnread,
  insertAudit, listAudit,
};

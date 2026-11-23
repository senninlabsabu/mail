const { createClient } = require('@supabase/supabase-js');
// Node.js 20 は WebSocket が組み込みでないため、supabase-js (realtime) に ws を渡す。
// Node.js 22 以上でも問題なく動作する。
const ws = require('ws');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
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

const USER_COLS = 'id,username,role,status,created_at';
const USER_DETAIL_COLS = USER_COLS + ',real_name,age,gender,ip_address,user_agent,accept_language,last_login_at,last_login_ip,last_login_ua';

// --- users ---
async function findUserByName(username) {
  return must(await sb.from('users').select('*').eq('username', username).maybeSingle(), 'findUserByName');
}

async function findUserById(id) {
  return must(await sb.from('users').select(USER_COLS).eq('id', id).maybeSingle(), 'findUserById');
}

async function findUserDetail(id) {
  return must(await sb.from('users').select(USER_DETAIL_COLS).eq('id', id).maybeSingle(), 'findUserDetail');
}

async function updateLastLogin(id, ip, ua) {
  must(await sb.from('users').update({
    last_login_at: new Date().toISOString(), last_login_ip: ip, last_login_ua: ua,
  }).eq('id', id), 'updateLastLogin');
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
    await sb.from('users').select(USER_DETAIL_COLS).eq('status', 'pending').order('created_at', { ascending: true }),
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
    await sb.from('messages').select('id,title,body,kind,format,created_at,read_at')
      .eq('user_id', userId).order('id', { ascending: false }).limit(limit),
    'listMessages'
  );
}

async function getMessageForUser(id, userId) {
  return must(
    await sb.from('messages').select('id,title,body,kind,format,created_at,read_at')
      .eq('id', id).eq('user_id', userId).maybeSingle(),
    'getMessageForUser'
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

// --- 送信履歴 ---
async function insertBatch(row) {
  return must(await sb.from('sent_batches').insert(row).select('id').single(), 'insertBatch');
}

const BATCH_COLS = 'id,title,body,kind,format,source,recipient_count,created_at,sender:users(username),app:apps(name)';

async function listBatches(page, size) {
  const from = (page - 1) * size;
  const res = await sb.from('sent_batches').select(BATCH_COLS, { count: 'exact' })
    .order('id', { ascending: false }).range(from, from + size - 1);
  return { rows: must(res, 'listBatches'), total: res.count ?? 0 };
}

async function getBatch(id) {
  return must(await sb.from('sent_batches').select(BATCH_COLS).eq('id', id).maybeSingle(), 'getBatch');
}

async function batchRecipients(batchId, limit = 200) {
  const res = await sb.from('messages').select('id,read_at,user:users(id,username)', { count: 'exact' })
    .eq('batch_id', batchId).order('id', { ascending: true }).limit(limit);
  const rows = must(res, 'batchRecipients');
  const readRes = await sb.from('messages').select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId).not('read_at', 'is', null);
  must(readRes, 'batchReadCount');
  return { rows, total: res.count ?? 0, read: readRes.count ?? 0 };
}

// --- 外部アプリ / 認証コード ---
async function insertApp(row) {
  return must(await sb.from('apps').insert(row).select('id,name').single(), 'insertApp');
}
async function listApps() {
  return must(
    await sb.from('apps').select('id,name,status,created_at,last_used_at').order('id', { ascending: false }),
    'listApps'
  );
}
async function findAppByKeyHash(hash) {
  return must(await sb.from('apps').select('id,name,status').eq('key_hash', hash).maybeSingle(), 'findAppByKeyHash');
}
async function touchApp(id) {
  await sb.from('apps').update({ last_used_at: new Date().toISOString() }).eq('id', id);
}
async function setAppStatus(id, status) {
  const rows = must(await sb.from('apps').update({ status }).eq('id', id).select('id'), 'setAppStatus');
  return rows.length > 0;
}
async function deleteApp(id) {
  const rows = must(await sb.from('apps').delete().eq('id', id).select('id'), 'deleteApp');
  return rows.length > 0;
}

async function insertCode(row) {
  return must(await sb.from('auth_codes').insert(row).select('id').single(), 'insertCode');
}
async function getCode(id) {
  return must(await sb.from('auth_codes').select('*').eq('id', id).maybeSingle(), 'getCode');
}
async function countRecentCodes(appId, userId, sinceIso) {
  const res = await sb.from('auth_codes').select('id', { count: 'exact', head: true })
    .eq('app_id', appId).eq('user_id', userId).gte('created_at', sinceIso);
  must(res, 'countRecentCodes');
  return res.count ?? 0;
}
// 試行回数を原子的に +1 (他の同時試行に負けたら false)
async function bumpAttempts(id, current) {
  const rows = must(
    await sb.from('auth_codes').update({ attempts: current + 1 }).eq('id', id).eq('attempts', current).select('id'),
    'bumpAttempts'
  );
  return rows.length > 0;
}
// 未使用の場合のみ使用済みにする (二重使用防止)
async function markCodeUsed(id) {
  const rows = must(
    await sb.from('auth_codes').update({ used_at: new Date().toISOString() }).eq('id', id).is('used_at', null).select('id'),
    'markCodeUsed'
  );
  return rows.length > 0;
}

module.exports = {
  sb, must,
  findUserByName, findUserById, findUserDetail, updateLastLogin, insertUser, countOpenByFingerprint,
  listPending, listUsers, listActiveRegularUsers, activeRegularUserIds, transition,
  listMessages, getMessageForUser, insertMessages, markRead, countUnread,
  insertBatch, listBatches, getBatch, batchRecipients,
  insertApp, listApps, findAppByKeyHash, touchApp, setAppStatus, deleteApp,
  insertCode, getCode, countRecentCodes, bumpAttempts, markCodeUsed,
  insertAudit, listAudit,
};

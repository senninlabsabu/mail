const session = require('express-session');
const { sb, must } = require('./db');

// express-session の Store を Supabase の sessions テーブルで実装する。
// 再起動してもログインが維持され、複数台構成にもできる。
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Supabase の非同期処理を express-session のコールバック形式に変換する
function settle(promise, cb, map = () => undefined) {
  return promise.then(
    res => {
      let value;
      try {
        value = map(res);
      } catch (e) {
        return cb(e);
      }
      cb(null, value);
    },
    err => cb(err)
  );
}

class SupabaseSessionStore extends session.Store {
  get(sid, cb) {
    settle(
      sb.from('sessions').select('sess,expires_at').eq('sid', sid).maybeSingle(),
      cb,
      res => {
        const row = must(res, 'session.get');
        if (!row || new Date(row.expires_at) <= new Date()) return null;
        return row.sess;
      }
    );
  }

  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    settle(
      sb.from('sessions').upsert({ sid, sess, expires_at: expires.toISOString() }),
      cb || (() => {}),
      res => { must(res, 'session.set'); }
    );
  }

  destroy(sid, cb) {
    settle(
      sb.from('sessions').delete().eq('sid', sid),
      cb || (() => {}),
      res => { must(res, 'session.destroy'); }
    );
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : null;
    if (!expires) return cb && cb(null);
    settle(
      sb.from('sessions').update({ expires_at: expires.toISOString() }).eq('sid', sid),
      cb || (() => {}),
      res => { must(res, 'session.touch'); }
    );
  }
}

function startSessionCleanup() {
  const timer = setInterval(() => {
    sb.from('sessions').delete().lt('expires_at', new Date().toISOString())
      .then(({ error }) => {
        if (error) console.error('session cleanup failed:', error.message);
      });
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
}

module.exports = { SupabaseSessionStore, startSessionCleanup };

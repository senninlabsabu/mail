-- NotifyBox schema for Supabase
-- Supabase ダッシュボード > SQL Editor に貼り付けて実行してください。

create table if not exists public.users (
  id              bigint generated always as identity primary key,
  username        text not null unique check (username ~ '^[A-Za-z0-9_-]{3,24}$'),
  password_hash   text not null,
  role            text not null default 'user'    check (role in ('user', 'admin')),
  status          text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'suspended')),
  reason          text not null default '',   -- 旧版の申請理由 (新規登録では使用しません)
  ip_fingerprint  text not null default '',
  created_at      timestamptz not null default now()
);
-- 登録時に取得する情報 (既存DBにも適用できるよう add column if not exists)
alter table public.users add column if not exists real_name       text not null default '';
alter table public.users add column if not exists age             smallint check (age between 1 and 120);
alter table public.users add column if not exists gender          text not null default 'no_answer'
  check (gender in ('male', 'female', 'other', 'no_answer'));
alter table public.users add column if not exists ip_address      text not null default '';
alter table public.users add column if not exists user_agent      text not null default '';
alter table public.users add column if not exists accept_language text not null default '';
alter table public.users add column if not exists last_login_at   timestamptz;
alter table public.users add column if not exists last_login_ip   text not null default '';
alter table public.users add column if not exists last_login_ua   text not null default '';
create index if not exists users_status_idx on public.users (status);
create index if not exists users_fingerprint_idx on public.users (ip_fingerprint);

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references public.users (id) on delete cascade,
  title       text not null,
  body        text not null,
  kind        text not null default 'notice' check (kind in ('notice', 'internal-code', 'system')),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists messages_user_idx on public.messages (user_id, id desc);
create index if not exists messages_unread_idx on public.messages (user_id) where read_at is null;

create table if not exists public.audit (
  id           bigint generated always as identity primary key,
  admin_id     bigint references public.users (id) on delete set null,
  action       text not null,
  target_user  bigint references public.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit (created_at desc);

-- express-session 用のセッションストア
create table if not exists public.sessions (
  sid        text primary key,
  sess       jsonb not null,
  expires_at timestamptz not null
);
create index if not exists sessions_expires_idx on public.sessions (expires_at);

-- 外部アプリ (認証コード送信APIを使うアプリ)
create table if not exists public.apps (
  id           bigint generated always as identity primary key,
  name         text not null check (char_length(name) between 1 and 40),
  key_hash     text not null unique,            -- APIキーのSHA-256 (キー本体は保存しない)
  status       text not null default 'active' check (status in ('active', 'disabled')),
  created_by   bigint references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- 送信履歴 (1回の送信操作 = 1行。全体通知でも1行)
create table if not exists public.sent_batches (
  id               bigint generated always as identity primary key,
  sender_id        bigint references public.users (id) on delete set null,
  app_id           bigint references public.apps (id) on delete set null,
  source           text not null default 'admin' check (source in ('admin', 'app')),
  title            text not null,
  body             text not null,
  kind             text not null default 'notice' check (kind in ('notice', 'internal-code', 'system')),
  format           text not null default 'text' check (format in ('text', 'html')),
  recipient_count  integer not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists sent_batches_created_idx on public.sent_batches (id desc);

alter table public.messages add column if not exists format   text not null default 'text' check (format in ('text', 'html'));
alter table public.messages add column if not exists batch_id bigint references public.sent_batches (id) on delete set null;
alter table public.messages add column if not exists app_id   bigint references public.apps (id) on delete set null;
create index if not exists messages_batch_idx on public.messages (batch_id);

-- 外部アプリが発行した認証コード (コードはHMACのみ保存)
create table if not exists public.auth_codes (
  id          uuid primary key default gen_random_uuid(),
  app_id      bigint not null references public.apps (id) on delete cascade,
  user_id     bigint not null references public.users (id) on delete cascade,
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists auth_codes_recent_idx on public.auth_codes (app_id, user_id, created_at desc);

-- RLS を有効化し、ポリシーは作らない。
-- anon / authenticated キーからの読み書きは全て拒否される。
-- サーバーは service_role キーを使うため RLS をバイパスして動作する。
alter table public.users    enable row level security;
alter table public.messages enable row level security;
alter table public.audit    enable row level security;
alter table public.sessions enable row level security;
alter table public.apps         enable row level security;
alter table public.sent_batches enable row level security;
alter table public.auth_codes   enable row level security;

-- service_role に権限を付与 (「permission denied for table」対策)
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

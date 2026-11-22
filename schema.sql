-- NotifyBox schema for Supabase
-- Supabase ダッシュボード > SQL Editor に貼り付けて実行してください。

create table if not exists public.users (
  id              bigint generated always as identity primary key,
  username        text not null unique check (username ~ '^[A-Za-z0-9_-]{3,24}$'),
  password_hash   text not null,
  role            text not null default 'user'    check (role in ('user', 'admin')),
  status          text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'suspended')),
  reason          text not null default '',
  ip_fingerprint  text not null default '',
  created_at      timestamptz not null default now()
);
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

-- RLS を有効化し、ポリシーは作らない。
-- anon / authenticated キーからの読み書きは全て拒否される。
-- サーバーは service_role キーを使うため RLS をバイパスして動作する。
alter table public.users    enable row level security;
alter table public.messages enable row level security;
alter table public.audit    enable row level security;
alter table public.sessions enable row level security;

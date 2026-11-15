-- Run this ONCE in Supabase: Dashboard > SQL Editor > New query > paste > Run.
create table if not exists apex_users (
  id          text primary key,
  email       text not null unique,
  name        text not null,
  pass_hash   text not null,
  role        text not null default 'user',
  disabled    boolean not null default false,
  created_at  timestamptz not null default now(),
  last_login  timestamptz
);

create table if not exists apex_usage (
  user_id text not null,
  day     date not null,
  count   integer not null default 0,
  primary key (user_id, day)
);

-- Atomic daily counter used by the server.
create or replace function apex_incr_usage(p_user text, p_day date)
returns integer language sql as $$
  insert into apex_usage (user_id, day, count) values (p_user, p_day, 1)
  on conflict (user_id, day) do update set count = apex_usage.count + 1
  returning count;
$$;

-- Lock the tables: only the server (service key) may touch them, never the browser.
alter table apex_users enable row level security;
alter table apex_usage enable row level security;

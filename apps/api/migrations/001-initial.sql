create table content_versions (
  version text primary key,
  checksum text not null,
  bundle jsonb not null,
  published_at timestamptz not null default now()
);

create table players (
  id uuid primary key default gen_random_uuid(),
  supertokens_user_id text unique,
  guest_token text unique,
  display_name text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  current_rank int not null default 0,
  lifetime_tickets numeric not null default 0,
  leaderboard_score numeric not null default 0,
  check ((supertokens_user_id is null) <> (guest_token is null))
);

create table player_worlds (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players on delete cascade,
  world_type text not null default 'main',
  expedition_id text,
  content_version text not null references content_versions,
  state jsonb not null,
  state_version bigint not null default 0,
  last_resolved_at timestamptz not null,
  schema_version int not null,
  unique nulls not distinct (player_id, world_type, expedition_id)
);

create table action_log (
  id bigserial primary key,
  player_id uuid not null,
  world_id uuid not null references player_worlds on delete cascade,
  actions jsonb not null,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create index action_log_world_created on action_log (world_id, created_at);

create table idempotency (
  key text primary key,
  player_id uuid not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create table sessions (
  id bigserial primary key,
  player_id uuid not null references players on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  client text
);

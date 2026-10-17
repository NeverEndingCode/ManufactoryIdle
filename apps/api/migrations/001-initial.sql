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
  -- The world's recorded start, so initialWorld(initial_content_version, initial_seed,
  -- created_at) plus action_log replays it exactly (spec 16.3). The PRNG state in `state`
  -- cannot be inverted back to its seed, hence the column. int4 is enough: seeds are drawn
  -- with randomInt(0, 2**31), and makePrng reads `seed | 0`, a 32-bit integer, anyway.
  initial_seed int not null,
  created_at timestamptz not null,
  -- Never updated: D.6's migrate re-pins only content_version.
  initial_content_version text not null references content_versions,
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

-- Keys are client-chosen, so they are scoped per player: one player's key can never
-- collide with (or replay) another's.
create table idempotency (
  player_id uuid not null,
  key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (player_id, key)
);

create table sessions (
  id bigserial primary key,
  player_id uuid not null references players on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  client text
);
-- At most one open session per player, so concurrent GET /api/world calls cannot open
-- two; the insert targets this index with on conflict ... do nothing.
create unique index sessions_one_open on sessions (player_id) where closed_at is null;

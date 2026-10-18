-- Phase 3c anti-cheat. Later tasks append to this file; 001 is never edited.

-- A stored 409 must replay as a 409, so the status is kept beside the body.
alter table idempotency add column status int not null default 200;

-- R-19: the server-side tap ceiling. The request time of the last batch that held a TAP;
-- null means never, and the budget then runs from player_worlds.created_at.
alter table player_worlds add column last_tap_flush_at timestamptz;

-- R-21: every log row records the content version its batch ran on, so replay crosses a
-- re-pin. Rows logged before this migration ran on the world's current pin (nothing could
-- re-pin before 3c), so they take it.
alter table action_log add column content_version text references content_versions;
update action_log l set content_version = w.content_version from player_worlds w where w.id = l.world_id;
alter table action_log alter column content_version set not null;

-- R-20: the replay base. Null until the first cleanup deletes log rows; then the state after
-- replaying every deleted row onto the previous base (or the recorded start), and the time of
-- the last deleted row, which is also that state's lastResolvedAt. Base plus the remaining
-- log replays the world exactly.
alter table player_worlds add column replay_base_state jsonb;
alter table player_worlds add column replay_base_at timestamptz;

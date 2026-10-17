-- Phase 3c anti-cheat. Later tasks append to this file; 001 is never edited.

-- A stored 409 must replay as a 409, so the status is kept beside the body.
alter table idempotency add column status int not null default 200;

-- R-19: the server-side tap ceiling. The request time of the last batch that held a TAP;
-- null means never, and the budget then runs from player_worlds.created_at.
alter table player_worlds add column last_tap_flush_at timestamptz;

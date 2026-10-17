-- Phase 3c anti-cheat. Later tasks append to this file; 001 is never edited.

-- A stored 409 must replay as a 409, so the status is kept beside the body.
alter table idempotency add column status int not null default 200;

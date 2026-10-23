-- Phase 4c (W-16): a repeat claim is idempotent. A claim whose response was lost is retried by
-- the client; the guest token is gone from the row by then, so the account's player records
-- the hash of the token it claimed, and the same claim again answers 200 with that world.
-- Unique: one guest token is claimed by one account. Read through supertokens_user_id (already
-- unique), so the unique index is the only one needed.
alter table players add column claimed_guest_token_hash text unique;

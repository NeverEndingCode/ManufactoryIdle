// The sync layer's named constants (P-6, P-7, W-12).

/** W-9: never GET sooner than this after the previous snapshot. */
export const MIN_REPOLL_MS = 5_000;
/** W-9: fetch this long after the boundary, so the server's clock has passed it. */
export const BOUNDARY_SLACK_MS = 250;
/** P-6: a boundary closer than this to atMs is "short" (a pin/unpin cycle). */
export const SHORT_BOUNDARY_MS = 1_000;
/** P-6: the backoff starts at this many short snapshots in a row. */
export const SHORT_STREAK = 3;
/** P-6: the minimum repoll gap, by streak. */
export const REPOLL_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
/** P-7: the network-retry backoff (outbox and GET), then the last step forever. */
export const RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** P-7: the "offline" banner shows after this many consecutive failures. */
export const OFFLINE_AFTER_FAILURES = 2;
/** W-7: interpolated text updates at 4 Hz. */
export const TEXT_TICK_MS = 250;
/** W-12: a held tap repeats at 10 Hz. */
export const TAP_REPEAT_MS = 100;
/** W-12: flush taps at most once a second while tapping... */
export const TAP_FLUSH_EVERY_MS = 1_000;
/** ...and this long after release. */
export const TAP_FLUSH_AFTER_RELEASE_MS = 300;
/** Q-11: the outbox label of a tap flush. */
export const TAP_LABEL = "tap";
/** W-16: the guest token's localStorage key. */
export const GUEST_TOKEN_KEY = "mi.guestToken";
/** W-16, S-6: a guest token parked while signed in (a 409 claim, at a sign-in or at boot). */
export const PARKED_GUEST_TOKEN_KEY = "mi.parkedGuestToken";

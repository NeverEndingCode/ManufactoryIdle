// Identity resolution (spec 3b, R-13): a verified session wins over a guest token, and an
// account's player and world are created lazily on its first request (R-17 for the race).
import type { FastifyRequest } from "fastify";
import type { Db } from "./db/db.js";
import type { ContentStore } from "./content.js";
import { guestAuth, type Auth } from "./server.js";
import { createPlayerWithWorld } from "./worlds.js";

/** Returns the SuperTokens user id of the request's session, or null. */
export type SessionVerifier = (request: FastifyRequest) => Promise<string | null>;

/**
 * Thrown by a SessionVerifier when the accounts backend (the SuperTokens core) cannot be
 * reached. The API answers `503 accounts-unavailable` with `Retry-After`, and never falls
 * back to the request's guest token. Any other error a verifier throws is a 500.
 * The SuperTokens wrapper decides what is an outage (src/auth/supertokens.ts), so nothing
 * here matches on SDK error strings.
 */
export class AccountsUnavailableError extends Error {
  constructor(cause: unknown) {
    super("accounts backend unavailable", { cause });
    this.name = "AccountsUnavailableError";
  }
}

/** A verifier that never finds a session (guest-only servers). */
export const noSessions: SessionVerifier = async () => null;

export function identityAuth(deps: {
  db: Db;
  content: ContentStore;
  clock: () => number;
  verifySession: SessionVerifier;
}): Auth {
  const { db, content, clock, verifySession } = deps;
  const guest = guestAuth(db);
  return async (request) => {
    const userId = await verifySession(request);
    if (userId !== null) {
      const rows = await db.query<{ id: string }>(
        "select id from players where supertokens_user_id = $1",
        [userId],
      );
      if (rows.length > 0) return { playerId: rows[0]!.id };
      const { playerId } = await createPlayerWithWorld(
        db,
        { superTokensUserId: userId },
        content,
        clock(),
      );
      return { playerId };
    }
    return guest(request);
  };
}

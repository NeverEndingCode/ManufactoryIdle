// TRUST_PROXY (main.ts) → Fastify's `trustProxy`. Behind a reverse proxy, request.ip is the
// proxy's address unless this is set, and every guest then shares one POST /api/guests bucket.
import type { FastifyServerOptions } from "fastify";

export type TrustProxy = NonNullable<FastifyServerOptions["trustProxy"]>;

/**
 * Unset, empty or `false`: off (request.ip is the socket's peer). `true`: trust every hop,
 * only safe when nothing can reach the API except through the proxy. Otherwise a comma list
 * of proxy addresses or CIDRs (e.g. `10.0.0.1` or `127.0.0.1,10.0.0.0/8`), passed to Fastify.
 *
 * A hop count is refused: Fastify 5.12 accepts a number but treats it as "trust nothing"
 * (hop counts cannot validate the immediate peer, so it fails closed), which would silently
 * leave every guest on the proxy's bucket. Name the proxy's address instead.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = (raw ?? "").trim();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) {
    throw new Error(
      `TRUST_PROXY=${value}: a hop count is not supported (Fastify ignores it and trusts no proxy); ` +
        "set the proxy's address or CIDR, e.g. TRUST_PROXY=10.0.0.1, or true",
    );
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(",");
}

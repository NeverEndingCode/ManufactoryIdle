// One classifier for every response, GET and POST alike (W-11).
import type { RejectionBody, WorldResponse } from "./wire.js";

export type Outcome =
  | { kind: "adopt"; body: WorldResponse }
  /** 409: drop the batch, toast the reason, GET to re-sync. */
  | { kind: "rejected"; body: RejectionBody }
  /** 429 / 503: pause the outbox and polling (one shared bucket), then resend with the same key. */
  | { kind: "paused"; retryAfterMs: number; banner: "accounts-unavailable" | null }
  /** A network error (fetch threw), a 5xx, 408, 425, a 1xx or 3xx, or a non-JSON 2xx: unknown whether it committed, resend with the same key. */
  | { kind: "retry" }
  /** 400, or any other unexpected 4xx: drop, log, re-sync, a generic toast. */
  | { kind: "client-bug"; status: number; body: unknown }
  /** 401: identity is gone (W-14 / W-16). */
  | { kind: "unauthorized" }
  /** 404: no world. */
  | { kind: "no-world" };

/** Retry-After in whole seconds; a missing or malformed header counts as `fallbackSec`. */
function retryAfterMs(res: Response, fallbackSec: number): number {
  const header = res.headers.get("retry-after")?.trim();
  const sec = header !== undefined && /^\d+$/.test(header) ? Number(header) : fallbackSec;
  return sec * 1000;
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `res` is null when fetch threw (a network error). */
export async function classify(res: Response | null): Promise<Outcome> {
  if (res === null) return { kind: "retry" };
  const { status } = res;
  if (status >= 200 && status < 300) {
    const body = await bodyOf(res);
    // A 2xx that isn't JSON came from something in front of the API: try again later.
    return typeof body === "object" && body !== null
      ? { kind: "adopt", body: body as WorldResponse }
      : { kind: "retry" };
  }
  switch (status) {
    case 409:
      return { kind: "rejected", body: (await bodyOf(res)) as RejectionBody };
    case 429:
      return { kind: "paused", retryAfterMs: retryAfterMs(res, 1), banner: null };
    case 503: {
      const body = await bodyOf(res);
      const accounts =
        typeof body === "object" &&
        body !== null &&
        (body as { error?: unknown }).error === "accounts-unavailable";
      return {
        kind: "paused",
        retryAfterMs: retryAfterMs(res, res.headers.has("retry-after") ? 1 : 5),
        banner: accounts ? "accounts-unavailable" : null,
      };
    }
    case 401:
      return { kind: "unauthorized" };
    case 404:
      return { kind: "no-world" };
    // Timeouts and "too early": transient, the same request may succeed.
    case 408:
    case 425:
      return { kind: "retry" };
  }
  if (status >= 500 || status < 200 || (status >= 300 && status < 400)) return { kind: "retry" };
  return { kind: "client-bug", status, body: await bodyOf(res) };
}

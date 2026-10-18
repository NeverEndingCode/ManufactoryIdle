// Test-only (P-8): an inject()-backed fetch over a real buildServer on PGlite, and a fake
// ClientClock that moves in step with the server's clock. Nothing here listens on a port.
// Excluded from tsconfig.json and from the browser lint block; it is never bundled.
import { fileURLToPath } from "node:url";
import { buildServer, type ServerDeps } from "@manufactory/api/server";
import { guestAuth, migrate, openContentStore, pgliteDb, type Db } from "@manufactory/api/testing";
import type { ClientClock } from "./snapshot.js";
import type { FetchLike, GuestResponse, WorldResponse } from "./wire.js";

export type FastifyInstance = ReturnType<typeof buildServer>;

export const SLICE_DIR = fileURLToPath(
  new URL("../../../../packages/content/bundles/vertical-slice", import.meta.url),
);

/** The server clock's start, as in the API's own tests. */
export const SERVER_T0 = 1_760_000_000_000;
/** The client clock's start: a performance.now()-like origin, far from the server's epoch. */
export const CLIENT_T0 = 1_000_000;

export interface RigFetch extends FetchLike {
  /** The next request reaches the server, then the fetch throws TypeError("network"). */
  dropNextResponse: boolean;
  calls: { method: string; url: string; body?: unknown }[];
  /** The next matching request reaches the server, but its Response is withheld until release() is called. */
  hold(method: string, url: string): () => void;
  /** Holds registered and not yet released. */
  readonly activeHolds: number;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function pathOf(input: string): string {
  // Accept absolute URLs as well as the client's same-origin paths.
  return /^[a-z]+:\/\//i.test(input) ? new URL(input).pathname + new URL(input).search : input;
}

function parseBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") return body ?? undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export function injectFetch(app: FastifyInstance): RigFetch {
  const holds: { method: string; url: string; gate: Promise<void> }[] = [];
  let active = 0;

  const fetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = pathOf(input);
    fetch.calls.push({ method, url, body: parseBody(init?.body) });

    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const res = await app.inject({
      method: method as "GET",
      url,
      headers,
      ...(init?.body === undefined || init.body === null ? {} : { payload: init.body as string }),
    });

    const held = holds.findIndex((h) => h.method === method && h.url === url);
    if (held !== -1) {
      await holds.splice(held, 1)[0]!.gate;
    }
    if (fetch.dropNextResponse) {
      fetch.dropNextResponse = false;
      throw new TypeError("network");
    }

    const out = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) out.append(name, String(v));
    }
    return new Response(NULL_BODY_STATUSES.has(res.statusCode) ? null : res.body, {
      status: res.statusCode,
      headers: out,
    });
  }) as RigFetch;

  fetch.dropNextResponse = false;
  fetch.calls = [];
  fetch.hold = (method, url) => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    holds.push({ method: method.toUpperCase(), url, gate });
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      open();
    };
  };
  Object.defineProperty(fetch, "activeHolds", { get: () => active });
  return fetch;
}

/** Drains promise callbacks and one macrotask turn, so injected requests can make progress. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeClientClock implements ClientClock {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = CLIENT_T0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.#timers.delete(id);
  }

  /** Timers set and neither fired nor cleared. */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Awaited after each timer fires (and once at the end), on top of one macrotask turn. Point
   * it at the code under test's idle(), so the work a timer starts finishes, and sets its next
   * timer, before time moves on. Without it a timer set after a slow response lands past the
   * window. */
  settleWith: (() => Promise<void>) | null = null;

  /** Moves time forward by `ms`, firing due timers in order (by due time, then creation).
   * Before each scan it settles (one macrotask turn, then settleWith), so a timer set by work
   * already in flight, or by a timer, fires too if it falls inside the window. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await settle();
      await this.settleWith?.();
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at > target) continue;
        if (!due || entry[1].at < due[1].at) due = entry;
      }
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].at);
      due[1].fn();
    }
    this.#now = target;
    await settle();
    await this.settleWith?.();
  }
}

export interface TestRig {
  app: FastifyInstance;
  db: Db;
  clock: FakeClientClock;
  serverNow(): number;
  fetch: RigFetch;
  /** clock.advance(ms); the server's clock follows the client's, timer by timer. */
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}

export async function makeRig(
  opts: { limits?: ServerDeps["limits"]; contentDir?: string } = {},
): Promise<TestRig> {
  const db = await pgliteDb();
  await migrate(db);
  const content = await openContentStore(db, opts.contentDir ?? SLICE_DIR);
  // The server's clock is the client's, shifted: a timer that fires mid-advance sees both
  // clocks at its own due time, never a server clock already at the end of the window.
  const clock = new FakeClientClock();
  const serverNow = () => SERVER_T0 + (clock.now() - CLIENT_T0);
  const app = buildServer({
    db,
    content,
    clock: serverNow,
    auth: guestAuth(db),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  await app.ready();
  const fetch = injectFetch(app);
  return {
    app,
    db,
    clock,
    serverNow,
    fetch,
    async advance(ms) {
      // settleWith is usually some idle(), which would wait forever on a held response.
      if (clock.settleWith && fetch.activeHolds > 0) {
        throw new Error(
          "rig.advance() with an active rig.fetch.hold(): release() it first, or clear clock.settleWith",
        );
      }
      await clock.advance(ms);
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** POST /api/guests, then a real GET /api/world with the new token, both through rig.fetch. */
export async function guestWorld(
  rig: TestRig,
): Promise<{ guestToken: string; world: WorldResponse; checksum: string }> {
  const created = await rig.fetch("/api/guests", { method: "POST" });
  if (created.status !== 201) throw new Error(`POST /api/guests: ${created.status}`);
  const { guestToken } = (await created.json()) as GuestResponse;
  const res = await rig.fetch("/api/world", { headers: { authorization: `Guest ${guestToken}` } });
  if (res.status !== 200) throw new Error(`GET /api/world: ${res.status}`);
  const world = (await res.json()) as WorldResponse;
  return { guestToken, world, checksum: world.contentChecksum };
}

import { describe, expect, it } from "vitest";
import type { Action } from "@manufactory/engine";
import { RETRY_STEPS_MS } from "./constants.js";
import type { Outcome } from "./errors.js";
import { Outbox, type Batch } from "./outbox.js";
import { FakeClientClock } from "./test-rig.js";
import type { ActionsRequest, FetchLike } from "./wire.js";

const TAP: Action = { type: "TAP", count: 1, clientElapsedMs: 1_000 };

type Reply = "ok" | "drop" | { status: number; headers?: Record<string, string>; body?: unknown };

/** A scripted fetch, no server: each POST takes the next reply (default "ok") and is held
 * until released when `manual` is set. */
function scripted(clock: FakeClientClock, replies: Reply[] = []) {
  const sent: { at: number; body: ActionsRequest; auth: string | null }[] = [];
  let open = 0;
  let maxOpen = 0;
  const gates: (() => void)[] = [];
  let manual = false;
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init!.body as string) as ActionsRequest;
    sent.push({ at: clock.now(), body, auth: new Headers(init?.headers).get("authorization") });
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    if (manual) await new Promise<void>((r) => gates.push(r));
    open -= 1;
    const reply = replies.shift() ?? "ok";
    if (reply === "drop") throw new TypeError("network");
    if (reply === "ok") {
      return new Response(
        JSON.stringify({ state: {}, schedule: {}, stateVersion: 1, contentChecksum: "c" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: reply.headers ?? {},
    });
  };
  return {
    fetch,
    sent,
    get maxOpen() {
      return maxOpen;
    },
    hold() {
      manual = true;
    },
    releaseOne() {
      gates.shift()?.();
    },
  };
}

function outbox(clock: FakeClientClock, fetch: FetchLike, paused: () => number = () => 0) {
  const outcomes: { batch: Batch; outcome: Outcome }[] = [];
  const box = new Outbox({
    fetch,
    clock,
    authHeader: () => "Guest t",
    baseVersion: () => 7,
    onOutcome: (batch, outcome) => void outcomes.push({ batch, outcome }),
    isPaused: paused,
  });
  clock.settleWith = () => box.idle();
  return { box, outcomes };
}

describe("Outbox (W-10, W-11, P-7)", () => {
  it("sends FIFO, one in flight at a time, with the auth header and baseVersion", async () => {
    const clock = new FakeClientClock();
    const s = scripted(clock);
    s.hold();
    const { box } = outbox(clock, s.fetch);
    clock.settleWith = null; // the requests are held: idle() would wait for the release
    const done = [box.enqueue([TAP], "a"), box.enqueue([TAP], "b"), box.enqueue([TAP], "c")];
    await clock.advance(0);
    expect(s.sent).toHaveLength(1);
    expect(box.inFlight?.label).toBe("a");
    expect(box.queued.map((b) => b.label)).toEqual(["b", "c"]);
    for (let i = 0; i < 3; i++) {
      s.releaseOne();
      await clock.advance(0);
    }
    const outcomes = await Promise.all(done);
    expect(outcomes.map((o) => o.kind)).toEqual(["adopt", "adopt", "adopt"]);
    expect(s.maxOpen).toBe(1);
    expect(s.sent.map((x) => x.body.actions)).toEqual([[TAP], [TAP], [TAP]]);
    expect(s.sent.every((x) => x.auth === "Guest t" && x.body.baseVersion === 7)).toBe(true);
    expect(box.inFlight).toBeNull();
    expect(box.queued).toEqual([]);
  });

  it("makes each key at enqueue, distinct per batch, and reuses it on every retry", async () => {
    const clock = new FakeClientClock();
    const s = scripted(clock, ["drop", "drop", "ok", "ok"]);
    const { box } = outbox(clock, s.fetch);
    const a = box.enqueue([TAP], "a");
    const b = box.enqueue([TAP], "b");
    const keyA = box.inFlight!.key;
    const keyB = box.queued[0]!.key;
    expect(keyA).not.toBe(keyB);
    await clock.advance(10_000);
    await Promise.all([a, b]);
    expect(s.sent.map((x) => x.body.idempotencyKey)).toEqual([keyA, keyA, keyA, keyB]);
  });

  it("retries on RETRY_STEPS_MS: 1, 2, 4, 8, 16, 30, then 30 s", async () => {
    const clock = new FakeClientClock();
    const s = scripted(clock, Array<Reply>(8).fill("drop"));
    const { box } = outbox(clock, s.fetch);
    const done = box.enqueue([TAP], "a");
    await clock.advance(200_000);
    await done;
    const gaps = s.sent.slice(1).map((x, i) => x.at - s.sent[i]!.at);
    expect(gaps).toEqual([...RETRY_STEPS_MS, 30_000, 30_000]);
  });

  it("kick() retries at once", async () => {
    const clock = new FakeClientClock();
    const s = scripted(clock, ["drop", "drop"]);
    const { box } = outbox(clock, s.fetch);
    const done = box.enqueue([TAP], "a");
    await clock.advance(0);
    expect(s.sent).toHaveLength(1);
    box.kick();
    await clock.advance(0);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.at).toBe(s.sent[0]!.at);
    box.kick();
    await clock.advance(0);
    expect((await done).kind).toBe("adopt");
    expect(s.sent).toHaveLength(3);
  });

  it("settles on 409 and moves on; reports every attempt to onOutcome", async () => {
    const clock = new FakeClientClock();
    const s = scripted(clock, [
      "drop",
      { status: 409, body: { failedAction: TAP, index: 0, reason: "nope" } },
      "ok",
    ]);
    const { box, outcomes } = outbox(clock, s.fetch);
    const a = box.enqueue([TAP], "a");
    const b = box.enqueue([TAP], "b");
    await clock.advance(5_000);
    expect((await a).kind).toBe("rejected");
    expect((await b).kind).toBe("adopt");
    expect(outcomes.map((o) => [o.batch.label, o.outcome.kind])).toEqual([
      ["a", "retry"],
      ["a", "rejected"],
      ["b", "adopt"],
    ]);
  });

  it("waits out isPaused(), and floors a Retry-After: 0 at 1 s so it can't spin", async () => {
    const clock = new FakeClientClock();
    const s = scripted(clock, [{ status: 429, headers: { "retry-after": "0" } }, "ok"]);
    let pausedUntil = 0;
    const box = new Outbox({
      fetch: s.fetch,
      clock,
      authHeader: () => null,
      baseVersion: () => 0,
      onOutcome: (_b, o) => {
        if (o.kind === "paused") pausedUntil = clock.now() + o.retryAfterMs;
      },
      isPaused: () => Math.max(0, pausedUntil - clock.now()),
    });
    clock.settleWith = () => box.idle();
    const done = box.enqueue([TAP], "a");
    await clock.advance(999);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.auth).toBeNull();
    await clock.advance(1);
    expect((await done).kind).toBe("adopt");
    expect(s.sent.map((x) => x.at - s.sent[0]!.at)).toEqual([0, 1_000]);
  });
});

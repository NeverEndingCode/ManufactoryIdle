// @vitest-environment jsdom
// U-9e, L-19: the advice types itself out on the store's clock, one character per
// min(30, 600 / length) ms. Driven here by a fake later() queue.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { typeInterval, useTyped, type TypedClock } from "./use-typed.js";

/** A fake later() queue: advance() fires due timers in time order, each in its own act(), so a
 * timer a firing timer sets fires too when due. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  let timers: { at: number; seq: number; fn: () => void }[] = [];
  const clock: TypedClock = {
    later(fn, ms) {
      const t = { at: now + Math.max(0, ms), seq: seq++, fn };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
  };
  return {
    clock,
    get pending() {
      return timers.length;
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= until + 1e-9)
          .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (due === undefined) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        act(() => due.fn());
      }
      now = until;
    },
  };
}

function typed(text: string, enabled: boolean, c = fakeClock()) {
  const r = renderHook(
    (p: { text: string; enabled: boolean }) => useTyped(p.text, p.enabled, c.clock),
    {
      initialProps: { text, enabled },
    },
  );
  return { ...r, c };
}

describe("typeInterval (U-9e)", () => {
  it("is min(30, 600 / length), with a length of at least 1", () => {
    expect(typeInterval(7)).toBe(30);
    expect(typeInterval(20)).toBe(30);
    expect(typeInterval(60)).toBe(10);
    expect(typeInterval(200)).toBe(3);
    expect(typeInterval(0)).toBe(30);
  });
});

describe("useTyped (U-9e, L-19)", () => {
  // Catches: a hook that types on a wall-clock setTimeout, or more than one character a step.
  it("1. it types on the clock", () => {
    const { result, c } = typed("buy 4 x", true);
    for (let i = 1; i <= 7; i++) {
      c.advance(30);
      expect(result.current.shown).toBe("buy 4 x".slice(0, i));
      expect(result.current.done).toBe(i === 7);
    }
    expect(c.now).toBe(210);
    expect(c.pending).toBe(0);
  });

  // Catches: a fixed 30 ms, so a long command takes longer than 600 ms.
  it("2. the 600 ms cap", () => {
    const sixty = "x".repeat(60);
    const a = typed(sixty, true);
    a.c.advance(599);
    expect(a.result.current.done).toBe(false);
    a.c.advance(1);
    expect(a.result.current.shown).toBe(sixty);
    expect(a.result.current.done).toBe(true);

    const long = "y".repeat(200);
    const b = typed(long, true);
    b.c.advance(600 + typeInterval(200));
    expect(b.result.current.shown).toBe(long);
    expect(b.result.current.done).toBe(true);
  });

  // Catches: typing while disabled (reduced motion, the plain voice, a card open), or a
  // first frame of "" before an effect fills it in.
  it("3. instant when disabled", () => {
    const { result, c } = typed("buy 4 x", false);
    expect(result.current.shown).toBe("buy 4 x");
    expect(result.current.done).toBe(true);
    expect(c.pending).toBe(0);
  });

  // Catches: a finish() that leaves its timer queued, or doesn't complete the text.
  it("4. finish()", () => {
    const { result, c } = typed("buy 4 x", true);
    c.advance(60);
    expect(result.current.shown).toBe("bu");
    expect(c.pending).toBe(1);
    act(() => result.current.finish());
    expect(result.current.shown).toBe("buy 4 x");
    expect(result.current.done).toBe(true);
    expect(c.pending).toBe(0);
  });

  // Catches: a new text carrying on from the old one's position, or two timers racing.
  it("5. a change mid-type restarts from the start, one timer", () => {
    const { result, rerender, c } = typed("buy 4 x", true);
    c.advance(90);
    expect(result.current.shown).toBe("buy");
    rerender({ text: "reserve y 25%", enabled: true });
    expect(result.current.shown).toBe("");
    expect(result.current.done).toBe(false);
    expect(c.pending).toBe(1);
    c.advance(30);
    expect(result.current.shown).toBe("r");
    expect(c.pending).toBeLessThanOrEqual(1);
  });

  // Catches: keying on object identity, or on the 4 Hz run label: a re-render with the same
  // text restarts the typing.
  it("6. the same text again doesn't restart", () => {
    const { result, rerender, c } = typed("buy 4 x", true);
    c.advance(90);
    rerender({ text: "buy 4 x", enabled: true });
    rerender({ text: ["buy", "4", "x"].join(" "), enabled: true });
    expect(result.current.shown).toBe("buy");
    expect(c.pending).toBe(1);
    c.advance(1_000);
    expect(result.current.shown).toBe("buy 4 x");
    rerender({ text: "buy 4 x", enabled: true });
    expect(result.current.done).toBe(true);
    expect(c.pending).toBe(0);
  });

  // Catches: the first advice of a session showing whole (U-9e: it types too).
  it("7. the first advice types too", () => {
    const { result, c } = typed("buy 4 x", true);
    expect(result.current.shown).toBe("");
    expect(result.current.done).toBe(false);
    expect(c.pending).toBe(1);
  });

  // Catches: an unmount that leaves the timer queued (it would set state on nothing).
  it("unmount cancels the pending timer", () => {
    const { unmount, c } = typed("buy 4 x", true);
    c.advance(30);
    expect(c.pending).toBe(1);
    unmount();
    expect(c.pending).toBe(0);
  });

  // Catches: a card opening mid-type leaving the text half typed behind it.
  it("turning disabled mid-type finishes the text", () => {
    const { result, rerender, c } = typed("buy 4 x", true);
    c.advance(30);
    rerender({ text: "buy 4 x", enabled: false });
    expect(result.current.shown).toBe("buy 4 x");
    expect(c.pending).toBe(0);
  });
});

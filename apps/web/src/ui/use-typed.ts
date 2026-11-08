// U-9e, L-19: the advice types itself out. Purely visual: the caller renders `shown` in an
// aria-hidden span next to the complete words, and the action never waits on `done`.
// One character per typeInterval(length) on the store's clock (a chain of later() timers, one
// pending at a time), so no command takes longer than 600 ms. It types only when `text`
// changes: a re-render with the same text (the 4 Hz run label) never restarts it. `enabled`
// is read when the text changes; turning it off mid-type finishes the text.
import { useCallback, useEffect, useRef, useState } from "react";

export interface TypedClock {
  later(fn: () => void, ms: number): () => void;
}

/** min(30 ms, 600 ms / length), with a length of at least 1. */
export function typeInterval(length: number): number {
  return Math.min(30, 600 / Math.max(1, length));
}

export function useTyped(
  text: string,
  enabled: boolean,
  clock: TypedClock,
): { shown: string; done: boolean; finish(): void } {
  const [typed, setTyped] = useState(() => ({ text, n: enabled ? 0 : text.length }));
  let current = typed;
  if (current.text !== text) {
    // A new text: restart from "" (or show it whole), in this render, so the old text never
    // flashes. React re-renders at once with the new state.
    current = { text, n: enabled ? 0 : text.length };
    setTyped(current);
  } else if (!enabled && current.n < text.length) {
    current = { text, n: text.length };
    setTyped(current);
  }
  const typing = current.n < text.length;

  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!typing) return;
    const interval = typeInterval(text.length);
    let n = 0;
    const step = () => {
      n += 1;
      setTyped((t) => (t.text === text ? { text, n: Math.max(t.n, n) } : t));
      cancel.current = n < text.length ? clock.later(step, interval) : null;
    };
    cancel.current = clock.later(step, interval);
    return () => {
      cancel.current?.();
      cancel.current = null;
    };
  }, [text, typing, clock]);

  const finish = useCallback(() => {
    cancel.current?.();
    cancel.current = null;
    setTyped((t) => (t.n >= t.text.length ? t : { text: t.text, n: t.text.length }));
  }, []);

  return { shown: text.slice(0, current.n), done: !typing, finish };
}

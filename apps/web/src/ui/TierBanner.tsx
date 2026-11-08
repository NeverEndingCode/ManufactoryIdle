// U-9d, L-17, L-18: the tier-up banner, `*** TIER 3 REACHED · ROTOR unlocked ***` for 8 s over
// the tier readout. It is the picture of the store's tier-up notice, which Notices says once,
// hidden, in the one region (U-8a): so it's aria-hidden, has no role, is never focusable and
// never takes focus (a mousedown's default is prevented). It ends 8 s after the first render
// that sees a new tier-up notice object, or on a click; either way it dismisses the notice, and
// fades out over 400 ms (at once under reduced motion). A notice that goes away by itself (a
// world change) ends it at once. One per notice: a remount (a resize across layouts) resumes
// the same 8 s rather than starting another.
import { useEffect, useState, type ReactElement } from "react";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore, Notice, StoreView } from "../sync/store.js";
import { useTheme } from "./theme.js";
import css from "./TierBanner.module.css";
import { unlockedAt, unlockSummary } from "./unlocks.js";
import { prefersReducedMotion } from "./use-tween.js";

/** U-9d: how long the banner shows. */
export const BANNER_MS = 8_000;
/** L-18: the out-fade, before it unmounts. */
export const BANNER_OUT_MS = 400;

/** Per notice object: when its banner started (the store clock), and whether it has ended.
 *  Module-level, so a remount resumes the same banner instead of starting a second. */
const started = new WeakMap<Notice, number>();
const ended = new WeakSet<Notice>();

interface Held {
  notice: Notice;
  out: boolean;
}

export function TierBanner(p: {
  view: StoreView;
  snapshot: Snapshot;
  store: Pick<GameStore, "dismiss" | "later" | "now">;
}): ReactElement | null {
  const { applied } = useTheme();
  const { store } = p;
  const notice = p.view.notices.find((n) => n.kind === "tier-up") ?? null;
  const [held, setHeld] = useState<Held | null>(null);

  // A new notice object starts a banner; the notice gone while it shows (a world change) ends
  // it at once.
  useEffect(() => {
    if (notice === null) {
      setHeld((h) => (h !== null && !h.out ? null : h));
      return;
    }
    if (ended.has(notice)) return;
    if (!started.has(notice)) started.set(notice, store.now());
    setHeld((h) => (h?.notice === notice ? h : { notice, out: false }));
  }, [notice, store]);

  // The 8 s, then the 400 ms out-fade; each cancelled with the banner, on unmount, or when a
  // newer notice replaces it.
  useEffect(() => {
    if (held === null) return;
    if (held.out) return store.later(() => setHeld(null), BANNER_OUT_MS);
    const left = (started.get(held.notice) ?? store.now()) + BANNER_MS - store.now();
    return store.later(() => end(held.notice), left);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, store]);

  function end(n: Notice) {
    ended.add(n);
    setHeld(prefersReducedMotion() ? null : { notice: n, out: true });
    store.dismiss("tier-up");
  }

  if (held === null) return null;
  const tier = p.snapshot.state.tier;
  const shell = applied.voice === "shell";
  const summary = unlockSummary(p.snapshot, unlockedAt(p.snapshot.content, tier), applied.voice);
  const unlocked = summary === "" ? "" : ` · ${summary} unlocked`;
  const text = shell
    ? `*** TIER ${tier} REACHED${unlocked} ***`
    : `Tier ${tier} reached${unlocked}`;
  return (
    <div
      className={css.banner}
      aria-hidden="true"
      data-tier-banner
      data-out={held.out ? "" : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!held.out) end(held.notice);
      }}
    >
      <span className={css.text}>{text}</span>
    </div>
  );
}

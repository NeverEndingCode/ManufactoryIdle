// Discrete events, all in one polite live region (W-20). Ticking numbers are never in it,
// and the rate-limit countdown inside it is marked aria-live="off". Other components'
// announcements (the priority list's moves) are read from here too (announce.ts).
// U-2e: the visible list is an overlay at the foot of the main box, so a notice never moves a
// row; the region element itself is unchanged and permanent. A frameless bottleneck is no
// longer a line here (U-3e): it's the command line's comment, and announced (V-14).
import type { CSSProperties, ReactNode } from "react";
import { isPlateaued } from "../sync/interpolate.js";
import type { GameStore, Notice, StoreView } from "../sync/store.js";
import { useAnnouncement } from "./announce.js";
import { plateauText } from "./derive.js";
import { useTick } from "./use-tick.js";

/** Toasts: the only notices a player dismisses. Banners clear when their cause does. */
const TOASTS: ReadonlySet<Notice["kind"]> = new Set([
  "rejected",
  "client-bug",
  "tier-up",
  "signed-in",
  "sign-in-failed",
]);

const OFFLINE_TEXT = "Offline. Your factory keeps running; we'll reconnect when we can.";

/** Read, not seen: the notices themselves are the visible part of the region. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

type Shown = { kind: Notice["kind"] | "offline"; text: string; retryAt?: number };

export interface NoticesProps {
  store: Pick<GameStore, "dismiss" | "newFactory" | "now">;
  view: StoreView;
  /** The phone's save line (U-2e: the chip is the first notice line there). */
  lead?: ReactNode;
}

export function Notices({ store, view, lead = null }: NoticesProps) {
  const said = useAnnouncement();
  const shown: Shown[] = [...view.notices];
  const s = view.snapshot;
  if (s !== null && isPlateaued(s) && !shown.some((n) => n.kind === "plateau"))
    shown.push({ kind: "plateau", text: plateauText(s)! });
  if (view.status === "offline") shown.push({ kind: "offline", text: OFFLINE_TEXT });

  return (
    <div role="status" aria-live="polite" aria-atomic="false" className="notices">
      {/* The visible notices, an overlay (base.css): two at a time, scrolling for the rest
          (V-13); empty, it isn't drawn. */}
      <div className="notice-list notice-overlay">
        {lead}
        {shown.map((n) => (
          <div key={n.kind} className="notice" data-notice={n.kind}>
            <span>{n.text}</span>
            {n.kind === "guest-expired" && (
              <button type="button" className="btn" onClick={() => void store.newFactory()}>
                Start a new factory
              </button>
            )}
            {n.kind === "guest-rate-limited" && (
              <RetryCountdown retryAt={n.retryAt ?? 0} store={store} />
            )}
            {TOASTS.has(n.kind as Notice["kind"]) && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => store.dismiss(n.kind as Notice["kind"])}
              >
                Dismiss
              </button>
            )}
          </div>
        ))}
      </div>
      {said.text !== "" && (
        // Keyed by seq: a new node per announcement, so the same words twice are read twice.
        <span key={said.seq} data-announce style={VISUALLY_HIDDEN}>
          {said.text}
        </span>
      )}
    </div>
  );
}

function RetryCountdown({
  retryAt,
  store,
}: {
  retryAt: number;
  store: Pick<GameStore, "newFactory" | "now">;
}) {
  useTick();
  const left = Math.ceil((retryAt - store.now()) / 1000);
  if (left > 0)
    return (
      <span aria-live="off" className="num">
        {`Try again in ${left}s`}
      </span>
    );
  return (
    <button type="button" className="btn" onClick={() => void store.newFactory()}>
      Try again
    </button>
  );
}

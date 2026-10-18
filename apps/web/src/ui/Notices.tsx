// Discrete events, all in one polite live region (W-20). Ticking numbers are never in it,
// and the rate-limit countdown inside it is marked aria-live="off".
import { isPlateaued } from "../sync/interpolate.js";
import type { GameStore, Notice, StoreView } from "../sync/store.js";
import { plateauText, type BottleneckModel } from "./derive.js";
import { useTick } from "./use-tick.js";

/** Toasts: the only notices a player dismisses. Banners clear when their cause does. */
const TOASTS: ReadonlySet<Notice["kind"]> = new Set(["rejected", "client-bug", "tier-up"]);

const OFFLINE_TEXT = "Offline. Your factory keeps running; we'll reconnect when we can.";

type Shown = { kind: Notice["kind"] | "offline" | "bottleneck"; text: string; retryAt?: number };

export interface NoticesProps {
  store: Pick<GameStore, "dismiss" | "newFactory" | "now">;
  view: StoreView;
  bottleneck: BottleneckModel | null;
}

export function Notices({ store, view, bottleneck }: NoticesProps) {
  const shown: Shown[] = [...view.notices];
  const s = view.snapshot;
  if (s !== null && isPlateaued(s) && !shown.some((n) => n.kind === "plateau"))
    shown.push({ kind: "plateau", text: plateauText(s)! });
  if (view.status === "offline") shown.push({ kind: "offline", text: OFFLINE_TEXT });
  // P-2: a bottleneck no row can carry (a power shortfall with no generator, or an item not
  // yet shown) frames nothing; it is a line here instead.
  if (bottleneck !== null && bottleneck.laneId === null)
    shown.push({ kind: "bottleneck", text: bottleneck.text });

  return (
    <div role="status" aria-live="polite" aria-atomic="false" className="notices">
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

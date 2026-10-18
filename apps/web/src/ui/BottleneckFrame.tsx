// The one framed row (P-2): the "bottleneck" label in text, the advice, and its one action:
// the inline buy (P-3), or storage, Quantum Storage or a reserve (Q-5). Spends are pessimistic
// (W-13): the button is busy until the batch's response lands. The reserve is a setting.
import type { ReactNode } from "react";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import {
  BOTTLENECK_BUY_LABEL,
  className,
  type BottleneckModel,
  type FrameAction,
} from "./derive.js";
import { affordability } from "./quote.js";
import styles from "./BottleneckFrame.module.css";
import { useTick } from "./use-tick.js";

export interface BottleneckFrameProps {
  model: BottleneckModel;
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
  children: ReactNode;
}

export function BottleneckFrame({
  model,
  snapshot,
  store,
  pending,
  children,
}: BottleneckFrameProps) {
  return (
    <div className={styles.frame} data-frame>
      <div className={styles.label}>bottleneck</div>
      {children}
      <p className={styles.advice}>{model.text}</p>
      {model.action?.type === "SET_RESERVE" && (
        <ReserveButton reserve={model.action} snapshot={snapshot} store={store} />
      )}
      {model.action !== null && model.action.type !== "SET_RESERVE" && (
        <SpendButton spend={model.action} snapshot={snapshot} store={store} pending={pending} />
      )}
    </div>
  );
}

type FrameSpend = Exclude<FrameAction, { type: "SET_RESERVE" }>;

/** "Buy 1 Constructor", "Buy storage for Iron Plate", "Buy Quantum Storage for Iron". */
function spendText(s: Snapshot, a: FrameSpend): string {
  switch (a.type) {
    case "BUY_MACHINE":
      return `Buy ${a.count} ${className(s, a.machineClass, a.count)}`;
    case "BUY_STORAGE":
      return `Buy storage for ${s.content.items.get(a.itemId)?.name ?? a.itemId}`;
    case "BUY_QS":
      return `Buy Quantum Storage for ${s.content.lanes.get(a.lane)?.name ?? a.lane}`;
  }
}

/** A setting, not a spend (W-13): always enabled, nothing to wait for. */
function ReserveButton({
  reserve,
  snapshot,
  store,
}: {
  reserve: Extract<FrameAction, { type: "SET_RESERVE" }>;
  snapshot: Snapshot;
  store: Pick<GameStore, "send">;
}) {
  const name = snapshot.content.items.get(reserve.itemId)?.name ?? reserve.itemId;
  return (
    <button
      type="button"
      className={`btn ${styles.buy}`}
      onClick={() => {
        store.send([reserve], BOTTLENECK_BUY_LABEL).catch((err: unknown) => console.error(err));
      }}
    >
      {`Reserve ${Math.round(reserve.percent * 100)}% of ${name}`}
    </button>
  );
}

function SpendButton({
  spend,
  snapshot,
  store,
  pending,
}: {
  spend: FrameSpend;
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
}) {
  useTick(); // the countdown and the enable both move with the 4 Hz text tick
  const busy = pending.some((b) => b.label === BOTTLENECK_BUY_LABEL);
  const a = affordability(snapshot, spend, serverNow(snapshot, store.now()));
  const label =
    busy || a.affordable
      ? spendText(snapshot, spend)
      : a.inMs === null
        ? "not affordable yet"
        : `affordable in ${Math.max(1, Math.ceil(a.inMs / 1000))}s`;
  return (
    <button
      type="button"
      className={`btn ${styles.buy}`}
      disabled={busy || !a.affordable}
      aria-busy={busy}
      onClick={() => {
        store.send([spend], BOTTLENECK_BUY_LABEL).catch((err: unknown) => console.error(err));
      }}
    >
      {label}
    </button>
  );
}

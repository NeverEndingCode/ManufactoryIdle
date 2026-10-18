// The one framed row (P-2): the "bottleneck" label in text, the advice, and the inline buy
// (P-3). Spends are pessimistic (W-13): the button is busy until the batch's response lands.
import type { ReactNode } from "react";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import {
  affordability,
  BOTTLENECK_BUY_LABEL,
  className,
  type BottleneckModel,
  type BuyMachine,
} from "./derive.js";
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
      {model.buy !== null && (
        <BuyButton buy={model.buy} snapshot={snapshot} store={store} pending={pending} />
      )}
    </div>
  );
}

function BuyButton({
  buy,
  snapshot,
  store,
  pending,
}: {
  buy: BuyMachine;
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
}) {
  useTick(); // the countdown and the enable both move with the 4 Hz text tick
  const busy = pending.some((b) => b.label === BOTTLENECK_BUY_LABEL);
  const a = affordability(snapshot, buy, serverNow(snapshot, store.now()));
  const label =
    busy || a.affordable
      ? `Buy ${buy.count} ${className(snapshot, buy.machineClass, buy.count)}`
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
        store.send([buy], BOTTLENECK_BUY_LABEL).catch((err: unknown) => console.error(err));
      }}
    >
      {label}
    </button>
  );
}

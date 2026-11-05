// The one framed row (P-2): the "bottleneck" label in text, the advice, and its one action:
// the inline buy (P-3), or storage, Quantum Storage or a reserve (Q-5). Its buttons are the
// command line's, imported back for one commit (V-23) so the buy is never missing; both send
// under BOTTLENECK_BUY_LABEL, so they're busy together. Task 5 deletes the frame.
import type { ReactNode } from "react";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { ReserveRun, RunButton } from "./CommandBar.js";
import type { BottleneckModel } from "./derive.js";
import styles from "./BottleneckFrame.module.css";
import { useTheme } from "./theme.js";

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
  const voice = useTheme().applied.voice;
  return (
    <div className={styles.frame} data-frame>
      <div className={styles.label}>bottleneck</div>
      {children}
      <p className={styles.advice}>{model.text}</p>
      {model.action?.type === "SET_RESERVE" && (
        <ReserveRun
          model={model}
          reserve={model.action}
          snapshot={snapshot}
          store={store}
          kind="card"
          voice={voice}
          className={`btn ${styles.buy}`}
        />
      )}
      {model.action !== null && model.action.type !== "SET_RESERVE" && (
        <RunButton
          model={model}
          spend={model.action}
          snapshot={snapshot}
          store={store}
          pending={pending}
          kind="card"
          voice={voice}
          className={`btn ${styles.buy}`}
        />
      )}
    </div>
  );
}

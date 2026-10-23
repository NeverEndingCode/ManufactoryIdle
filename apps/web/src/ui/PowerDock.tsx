// The power dock (W-1 item 4, §13.2): the grid's demand against supply, and the holdable tap
// with its stacks, kick and remaining time (W-12, Q-12). The tap holds by pointer and by a
// held Space or Enter (W-20); the store owns the repeat and the flush (Q-11).
import { D, format } from "@manufactory/engine";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { dockModel } from "./dock-model.js";
import styles from "./PowerDock.module.css";
import { useTick } from "./use-tick.js";

export interface PowerDockProps {
  store: Pick<GameStore, "pressTap" | "releaseTap" | "now">;
  snapshot: Snapshot;
  taps: StoreView["taps"];
  /** The outbox, for the taps in flight (W-12). */
  pending?: StoreView["pending"];
}

/** MW to one decimal, and the notation past 10,000. */
function mw(n: number): string {
  return Math.abs(n) >= 10_000 ? format(D(n), "hybrid") : n.toFixed(1);
}

const HOLD_KEYS = new Set([" ", "Enter"]);

export function PowerDock({ store, snapshot, taps, pending }: PowerDockProps) {
  useTick(); // the kick's countdown, at 4 Hz
  const m = dockModel(snapshot, taps, store.now(), pending);
  const keyHeld = useRef(false);

  const fill = m.supplyMw > 0 ? Math.min(1, m.demandMw / m.supplyMw) : m.demandMw > 0 ? 1 : 0;
  const short = m.ratio < 1;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No capture (an old engine, or jsdom): pointerup on the button still releases.
    }
    store.pressTap();
  };
  const release = () => store.releaseTap();
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!HOLD_KEYS.has(e.key)) return;
    e.preventDefault(); // no click, no page scroll
    if (e.repeat || keyHeld.current) return;
    keyHeld.current = true;
    store.pressTap();
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!HOLD_KEYS.has(e.key)) return;
    e.preventDefault();
    if (!keyHeld.current) return;
    keyHeld.current = false;
    store.releaseTap();
  };
  const onBlur = () => {
    keyHeld.current = false;
    store.releaseTap();
  };

  return (
    <section
      className={styles.dock}
      aria-label="Power"
      data-dock
      data-stacks={m.stacks}
      data-holding={taps.holding ? "" : undefined}
    >
      <div className={styles.readouts}>
        <div className={styles.line}>
          <span className={styles.name}>Grid</span>
          <span className="num">{`${mw(m.demandMw)} / ${mw(m.supplyMw)} MW`}</span>
        </div>
        <div
          role="meter"
          aria-label="Grid"
          aria-valuemin={0}
          aria-valuemax={m.supplyMw}
          aria-valuenow={Math.min(m.demandMw, m.supplyMw)}
          aria-valuetext={`${mw(m.demandMw)} of ${mw(m.supplyMw)} MW`}
          className={m.limited ? `${styles.meter} state-bottleneck` : styles.meter}
        >
          <div className={styles.fill} style={{ transform: `scaleX(${fill})` }} />
        </div>
        {(m.limited || short) && (
          <div className={styles.line}>
            <span className={m.limited ? `${styles.note} state-bottleneck` : styles.note}>
              {m.limited ? "Power limits production" : "Power is short"}
            </span>
            {short && <span className="num">{`needs ${mw(m.fullDemandMw)} MW`}</span>}
          </div>
        )}
        <div className={styles.line}>
          <span className={`${styles.kick} num`}>
            {m.stacks > 0
              ? `×${m.kick.toFixed(2)} · ${m.stacks}/${m.maxStacks} stacks · ${Math.ceil(m.remainingMs / 1000)}s`
              : "Hold to keep the kick"}
          </span>
          {m.injectionMw > 0 && <span className="num">{`+${m.injectionMw} MW`}</span>}
        </div>
      </div>
      <button
        type="button"
        className={styles.tap}
        aria-label="Tap: hold to keep the kick"
        data-tap
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className={styles.z} aria-hidden="true">
          ⚡
        </span>
        <span aria-hidden="true">tap</span>
      </button>
    </section>
  );
}

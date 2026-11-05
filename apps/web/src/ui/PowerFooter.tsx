// U-2b / U-6c: the desktop and tablet footer, PowerDock's readouts and tap, moved. PWR, the grid
// bar with demand / supply, the kick (V-22: KICK x1.35 · 7 STK · 21s, or KICK off · hold TAP),
// then the [T] TAP button. The phone has no footer: its header carries PowerReading, and the
// floating TAP the kick (U-6a).
import { useMemo } from "react";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { Bar } from "./Bar.js";
import { dockModel, mwText, tapName, type DockModel } from "./dock-model.js";
import css from "./Power.module.css";
import { useTapHold } from "./use-tap-hold.js";
import { useTick } from "./use-tick.js";

export interface TapProps {
  store: Pick<GameStore, "pressTap" | "releaseTap" | "now">;
  snapshot: Snapshot;
  taps: StoreView["taps"];
  /** The outbox, for the taps in flight (W-12). */
  pending?: readonly Batch[];
}

/** The tap's model at the 4 Hz tick, and its accessible name, which isn't: it's memoised on
 * (snapshot, the last tap, the stacks), so a screen reader never hears the countdown (V-22). */
export function useTapReadout({ store, snapshot, taps, pending = [] }: TapProps) {
  useTick();
  const m = dockModel(snapshot, taps, store.now(), pending);
  // The model at the key's first render names it; the 4 Hz renders reuse that name.
  const name = useMemo(
    () => tapName(m),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, taps.lastTapAt, m.stacks],
  );
  return { m, name };
}

/** The grid as a fraction: demand over supply, full when there's demand and no supply. */
export function gridFill(m: Pick<DockModel, "demandMw" | "supplyMw">): number {
  if (m.supplyMw > 0) return Math.min(1, m.demandMw / m.supplyMw);
  return m.demandMw > 0 ? 1 : 0;
}

/** The grid's Bar: per snapshot, static (W-20); the bottleneck tone when power limits. */
export function GridBar({ m, cells }: { m: DockModel; cells?: number }) {
  const f = gridFill(m);
  return (
    <Bar
      label="Grid"
      valueNow={f}
      valueText={`${mwText(m.demandMw)} of ${mwText(m.supplyMw)} MW`}
      tone={m.limited ? "bottleneck" : "normal"}
      transition={{ from: f, to: f, durationMs: 0 }}
      cells={cells}
    />
  );
}

/** "x1.35": the kick, always to two places. */
export const kickText = (m: DockModel) => `x${m.kick.toFixed(2)}`;

const secondsLeft = (m: DockModel) => Math.ceil(m.remainingMs / 1000);

export function PowerFooter(p: TapProps) {
  const { m, name } = useTapReadout(p);
  const hold = useTapHold(p.store);
  return (
    <footer
      className={css.footer}
      aria-label="Power"
      data-power
      data-stacks={m.stacks}
      data-holding={p.taps.holding ? "" : undefined}
    >
      <span className={css.pwr}>PWR</span>
      <div className={css.grid}>
        <GridBar m={m} />
        <span className={`${css.gridText} num`}>
          {`${mwText(m.demandMw)}/${mwText(m.supplyMw)} MW`}
        </span>
      </div>
      <span className={`${css.footKick} num`}>
        {m.stacks > 0
          ? `KICK ${kickText(m)} · ${m.stacks} STK · ${secondsLeft(m)}s`
          : "KICK off · hold TAP"}
      </span>
      <button type="button" className={css.footTap} aria-label={name} data-tap {...hold}>
        <span className="key-hint" aria-hidden="true">
          [T]
        </span>
        <span aria-hidden="true">TAP</span>
      </button>
    </footer>
  );
}

/** U-2d: the phone header's power line, PWR 412/450 MW; on the power tab, 412 / 450 MW over
 * 91% load. Per snapshot. */
export function PowerReading({ snapshot, powerTab }: { snapshot: Snapshot; powerTab: boolean }) {
  const { demandMw, supplyMw } = snapshot.display.solution.power;
  const d = mwText(demandMw);
  const s = mwText(supplyMw);
  if (!powerTab)
    return <div className={`${css.reading} num`} data-power-reading>{`PWR ${d}/${s} MW`}</div>;
  const load = supplyMw > 0 ? Math.round((demandMw / supplyMw) * 100) : demandMw > 0 ? 100 : 0;
  return (
    <div className={`${css.reading} num`} data-power-reading>
      <div>{`${d} / ${s} MW`}</div>
      <div>{`${load}% load`}</div>
    </div>
  );
}

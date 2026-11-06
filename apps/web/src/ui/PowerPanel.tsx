// U-6b: the power panel, one for the desktop's 5 POWER lane tab and the phone's ~ power tab
// (U-6a). Load (the grid Bar and headroom, or the short line), GENERATORS (one row per class with
// its +1), FUEL (the power lane's fixed rows), BIGGEST USERS and the kick line. Generator rows
// aren't clickable in UI-1: the generator drawer is UI-2 (V-21). The +1 is the panel's one spend,
// pessimistic like the drawer's (W-13): Guarded, busy while a batch under its label is out.
import { D, type ItemId } from "@manufactory/engine";
import { useMemo } from "react";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { className, plural, powerLaneId, type BottleneckModel } from "./derive.js";
import {
  dockModel,
  generatorLabel,
  generatorRows,
  mwText,
  nextMachineDrawMw,
  powerByLane,
  type GeneratorRow,
} from "./dock-model.js";
import { Guarded } from "./Guarded.js";
import { PLAIN } from "./command.js";
import { itemName, machineLabel, useNames, type Names } from "./names.js";
import { fmt, useNotation } from "./notation.js";
import css from "./Power.module.css";
import { GridBar, kickText, useTapReadout, type TapProps } from "./PowerFooter.js";
import { affordability } from "./quote.js";
import { RowList } from "./RowList.js";
import { Spoken } from "./Spoken.js";
import type { LayoutMode } from "./use-layout-mode.js";
import { useTick } from "./use-tick.js";

export interface PowerPanelProps {
  store: Pick<GameStore, "now" | "send" | "pressTap" | "releaseTap">;
  snapshot: Snapshot;
  view: StoreView;
  bottleneck: BottleneckModel | null;
  /** The App's selection in the power lane (U-7d). */
  selected: ItemId | null;
  onSelect(id: ItemId): void;
  onOpen(id: ItemId): void;
  openItem: ItemId | null;
  mode: LayoutMode;
}

const seconds = (inMs: number) => Math.max(1, Math.ceil(inMs / 1000));

/** +1 on a generator class: BUY_MACHINE at the best unlocked mark, count 1, under
 * power:<class>:buy. Counts down on the 4 Hz tick until affordable. */
function GeneratorBuy({
  row,
  snapshot,
  store,
  pending,
}: {
  row: GeneratorRow & { buy: NonNullable<GeneratorRow["buy"]> };
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
}) {
  useTick();
  const label = generatorLabel(row.machineClass);
  const busy = pending.some((b) => b.label === label);
  const a = affordability(snapshot, row.buy, serverNow(snapshot, store.now()));
  const base = `Buy 1 ${className(snapshot, row.machineClass, 1)}`;
  let name = base;
  let text = "+1";
  if (!busy && !a.affordable) {
    if (a.inMs === null) name = `${base}, not affordable yet`;
    else {
      const n = seconds(a.inMs);
      name = `${base}, affordable in ${n} ${plural(n, "second")}`;
      text = `${n}s`;
    }
  }
  return (
    <Guarded
      className={css.plus}
      off={busy || !a.affordable}
      aria-busy={busy}
      aria-label={name}
      data-generator-buy={row.machineClass}
      onPress={() => {
        store.send([row.buy], label).catch((err: unknown) => console.error(err));
      }}
    >
      {text}
    </Guarded>
  );
}

function eatsText(row: GeneratorRow, item: (id: ItemId) => string): string {
  const eats = row.eats.map((e) => `${fmt(D(e.perSecond))} ${item(e.itemId)}/s`).join(" + ");
  return `eats ${eats} · ${mwText(row.mwEach)} MW each`;
}

function Generators({
  snapshot,
  store,
  pending,
  names,
}: {
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
  names: Names;
}) {
  const rows = useMemo(() => generatorRows(snapshot), [snapshot]);
  return (
    <section aria-label="Generators" className={css.section}>
      <h2 className={css.head}>GENERATORS</h2>
      <ul className={css.list}>
        {rows.map((row) => {
          // U-1h: COAL_GENERATOR x3 is seen; a reader hears Coal Generator x3.
          const label = `${names.machine(row.machineClass, null)} x${row.owned}`;
          const said = `${machineLabel(snapshot, row.machineClass, null, PLAIN)} x${row.owned}`;
          const buy = row.buy;
          return (
            <li key={row.machineClass} className={css.gen} data-generator={row.machineClass}>
              {buy === null ? (
                <span className={css.locked}>
                  <Spoken
                    shown={`${label} · unlocks at tier ${row.unlockTier}`}
                    said={`${said} · unlocks at tier ${row.unlockTier}`}
                  />
                </span>
              ) : (
                <>
                  <span className={css.genText}>
                    <span className={css.genName}>
                      <Spoken shown={label} said={said} />
                    </span>
                    <span className={css.genDetail}>
                      <Spoken
                        shown={eatsText(row, names.item)}
                        said={eatsText(row, (id) => itemName(snapshot, id))}
                      />
                    </span>
                  </span>
                  <span className={`${css.genMw} num`}>{`${mwText(row.mwNow)} MW`}</span>
                  <GeneratorBuy
                    row={{ ...row, buy }}
                    snapshot={snapshot}
                    store={store}
                    pending={pending}
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** U-6b's kick line, at the 4 Hz tick (V-22). */
function KickLine(p: TapProps) {
  const { m } = useTapReadout(p);
  return (
    <p className={`${css.line} ${css.kickLine}`} data-kick-line>
      {m.stacks > 0
        ? `KICK ${kickText(m)} · ${m.stacks} / ${m.maxStacks} stacks · ${Math.ceil(m.remainingMs / 1000)}s left · hold TAP to keep it up`
        : "KICK off · hold TAP to start it"}
    </p>
  );
}

export function PowerPanel(p: PowerPanelProps) {
  const { snapshot: s, view } = p;
  useNotation(); // the eats rates go through fmt (S-11)
  const names = useNames(s);
  // Load reads the grid only, per snapshot: no 4 Hz render here (the kick line has its own).
  const m = dockModel(s, view.taps, p.store.now(), view.pending);
  const users = useMemo(() => powerByLane(s).slice(0, 3), [s]);
  const upTo = useMemo(() => nextMachineDrawMw(s), [s]);
  const laneId = powerLaneId(s);
  const short = m.ratio < 1;
  return (
    <div
      className={p.mode === "phone" ? `${css.panel} ${css.phonePanel}` : css.panel}
      data-power-panel
    >
      <section aria-label="Load" className={`${css.section} ${css.load}`}>
        <GridBar m={m} cells={20} />
        <p className={css.line}>
          {short ? (
            <span className="state-bottleneck">{`power is short · needs ${mwText(m.fullDemandMw)} MW`}</span>
          ) : m.limited ? (
            <span className="state-bottleneck">power limits production</span>
          ) : (
            `headroom ${mwText(m.supplyMw - m.demandMw)} MW · next machine needs up to ${mwText(upTo)} MW`
          )}
        </p>
      </section>
      <Generators snapshot={s} store={p.store} pending={view.pending} names={names} />
      {laneId !== null && (
        <section aria-label="Fuel" className={css.section}>
          <h2 className={css.head}>FUEL</h2>
          <RowList
            store={p.store}
            snapshot={s}
            laneId={laneId}
            bottleneck={p.bottleneck}
            selected={p.selected}
            onSelect={p.onSelect}
            onOpen={p.onOpen}
            openItem={p.openItem}
            mode={p.mode}
          />
        </section>
      )}
      <section aria-label="Biggest users" className={css.section}>
        <h2 className={css.head}>BIGGEST USERS</h2>
        {users.length === 0 ? (
          <p className={css.line}>nothing draws power yet</p>
        ) : (
          <ul className={css.list}>
            {users.map((u) => (
              <li key={u.laneId} className={css.user}>
                <span>{`${names.lane(u.laneId)} lane`}</span>
                <span className="num">{`${mwText(u.mw)} MW`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <KickLine store={p.store} snapshot={s} taps={view.taps} pending={view.pending} />
    </div>
  );
}

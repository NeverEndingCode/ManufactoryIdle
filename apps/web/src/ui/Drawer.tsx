// The item drawer (W-1 item 2, Q-6): every D.1 verb for the item's machines, its recipe, its
// storage and its lane's Quantum Storage, over one pure model (drawerModel). Spends are
// pessimistic (W-13): a button is busy while its own batch is pending, and the numbers move
// only with snapshots. Settings (recipe, assignment) are optimistic in the control (Q-10).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  D,
  DECIMAL_ZERO,
  format,
  type Action,
  type ItemId,
  type RecipeId,
} from "@manufactory/engine";
import { shownStock } from "../sync/interpolate.js";
import type { Outcome } from "../sync/errors.js";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { className as classLabel } from "./derive.js";
import styles from "./Drawer.module.css";
import {
  buyAction,
  dismantleAction,
  drawerModel,
  idleMove,
  moveMachines,
  type DrawerModel,
  type LevelSection,
  type MachineSection,
} from "./machines.js";
import { Projection } from "./Projection.js";
import { affordability, maxAffordableCount, quote, type Quote } from "./quote.js";
import { useTick } from "./use-tick.js";

export type DrawerVerb = "buy" | "dismantle" | "upgrade" | "storage" | "qs" | "recipe" | "assign";

/** Batch labels: a spend's button is busy while its batch is pending (W-13, pessimistic). */
export const drawerLabel = (itemId: ItemId, verb: DrawerVerb) => `drawer:${itemId}:${verb}`;

export interface DrawerProps {
  store: Pick<GameStore, "now" | "send">;
  snapshot: Snapshot;
  itemId: ItemId;
  pending: readonly Batch[];
  onClose(): void;
  /** Under 600 px: a bottom sheet, role="dialog" (Q-7). */
  sheet?: boolean;
}

type Tab = "buy" | "upgrade" | "dismantle" | "recipe" | "storage" | "assign";

const TAB_NAMES: Record<Tab, string> = {
  buy: "Buy",
  upgrade: "Upgrade",
  dismantle: "Dismantle",
  recipe: "Recipe",
  storage: "Storage",
  assign: "Assign",
};

type Assign = Extract<Action, { type: "ASSIGN_MACHINES" }>;
type SelectRecipe = Extract<Action, { type: "SELECT_RECIPE" }>;

/** Only the sections the model has. */
function tabsOf(m: DrawerModel): Tab[] {
  const sec = m.machines;
  const tabs: Tab[] = [];
  if (sec !== null && sec.bestMark !== null) tabs.push("buy");
  if (sec?.marks.some((r) => r.consolidation !== null)) tabs.push("upgrade");
  if (sec?.marks.some((r) => r.owned > 0)) tabs.push("dismantle");
  if (m.recipes.length > 0) tabs.push("recipe");
  tabs.push("storage");
  if (sec !== null && sec.assign.length > 0) tabs.push("assign");
  return tabs;
}

interface Ctx {
  snapshot: Snapshot;
  model: DrawerModel;
  now: () => number;
  busy(verb: DrawerVerb): boolean;
  send(actions: Action[], verb: DrawerVerb): Promise<Outcome>;
}

export function Drawer({ store, snapshot, itemId, pending, onClose, sheet = false }: DrawerProps) {
  // The store's snapshot object as is: drawerModel and preview memoise on its identity.
  const model = drawerModel(snapshot, itemId);
  const tabs = tabsOf(model);
  const [picked, setPicked] = useState<Tab>(tabs[0]!);
  const tab = tabs.includes(picked) ? picked : tabs[0]!;
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, [itemId]);

  const ctx: Ctx = {
    snapshot,
    model,
    now: () => store.now(),
    busy: (verb) => pending.some((b) => b.label === drawerLabel(itemId, verb)),
    send: (actions, verb) => store.send(actions, drawerLabel(itemId, verb)),
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };

  const sec = model.machines;
  return (
    <section
      id="detail"
      aria-labelledby="drawer-title"
      data-drawer={itemId}
      className={sheet ? `${styles.drawer} ${styles.sheet}` : styles.drawer}
      role={sheet ? "dialog" : undefined}
      aria-modal={sheet ? "false" : undefined}
      onKeyDown={onKeyDown}
    >
      <div className={styles.head}>
        <h2 id="drawer-title" ref={title} tabIndex={-1} className={styles.title}>
          {model.name}
        </h2>
        {sec !== null && (
          <span data-class className={styles.muted}>
            {sec.className}
          </span>
        )}
        <button type="button" className={`btn secondary ${styles.close}`} onClick={onClose}>
          Close
        </button>
      </div>
      <div role="group" aria-label="Action" className={styles.seg}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={t === tab}
            className={t === tab ? `${styles.segBtn} ${styles.on}` : styles.segBtn}
            onClick={() => setPicked(t)}
          >
            {TAB_NAMES[t]}
          </button>
        ))}
      </div>
      {tab === "buy" && sec !== null && <BuySection ctx={ctx} sec={sec} />}
      {tab === "upgrade" && sec !== null && <UpgradeSection ctx={ctx} sec={sec} />}
      {tab === "dismantle" && sec !== null && <DismantleSection ctx={ctx} sec={sec} />}
      {tab === "recipe" && <RecipeSection ctx={ctx} />}
      {tab === "storage" && <StorageSection ctx={ctx} />}
      {tab === "assign" && sec !== null && <AssignSection ctx={ctx} sec={sec} />}
    </section>
  );
}

// ---- Q-10: optimistic settings, held in the component -------------------------------------

/** Each key shows its latest requested value until THAT request's promise settles; then the
 * server's value (the new one after adoption, the old one after a rejection). */
function usePendingMap<V>() {
  const [held, setHeld] = useState<ReadonlyMap<string, { value: V; token: number }>>(
    () => new Map(),
  );
  const seq = useRef(0);
  return {
    shown(key: string, server: V): V {
      const h = held.get(key);
      return h === undefined ? server : h.value;
    },
    run(entries: readonly (readonly [string, V])[], send: () => Promise<Outcome>): void {
      const token = ++seq.current;
      setHeld((m) => {
        const next = new Map(m);
        for (const [k, value] of entries) next.set(k, { value, token });
        return next;
      });
      const release = () =>
        setHeld((m) => {
          const next = new Map(m);
          for (const [k] of entries) if (next.get(k)?.token === token) next.delete(k);
          return next;
        });
      send().then(release, (err: unknown) => {
        console.error(err);
        release();
      });
    },
  };
}

// ---- shared pieces ---------------------------------------------------------------------------

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function itemName(s: Snapshot, itemId: ItemId): string {
  return s.content.items.get(itemId)?.name ?? itemId;
}

/** "43s", "1m 20s", "2h 5m". */
function duration(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function spend(ctx: Ctx, actions: Action[], verb: DrawerVerb): void {
  ctx.send(actions, verb).catch((err: unknown) => console.error(err));
}

/** Each cost item, red when the shown stock + bound (+ the action's own refund) is short. */
function CostList({ s, q, atMs }: { s: Snapshot; q: Quote; atMs: number }) {
  if (q.cost.size === 0) return null;
  return (
    <ul aria-label="Cost" className={styles.cost}>
      {[...q.cost].map(([itemId, need]) => {
        const have = shownStock(s, itemId, atMs)
          .plus(own(s.state.bound, itemId) ?? DECIMAL_ZERO)
          .plus(q.refund.get(itemId) ?? DECIMAL_ZERO);
        const short = have.lt(need);
        return (
          <li
            key={itemId}
            data-cost={itemId}
            data-short={short ? "" : undefined}
            className={short ? styles["state-bottleneck"] : undefined}
          >
            <span>{itemName(s, itemId)}</span>
            <span className="num">{format(need, "hybrid")}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A spend's cost, its countdown and its button, at the 4 Hz tick. Enabled only when the
 * model offers the action (non-null) AND it is affordable: a rejected action quotes empty
 * maps, which affordability() alone would call affordable.
 */
function Spend({
  ctx,
  action,
  verb,
  text,
  ariaLabel,
}: {
  ctx: Ctx;
  action: Action | null;
  verb: DrawerVerb;
  text: string;
  ariaLabel?: string;
}) {
  useTick();
  const s = ctx.snapshot;
  const atMs = serverNow(s, ctx.now());
  const q = action === null ? null : quote(s.content, s.state, action);
  const a = action === null ? null : affordability(s, action, atMs);
  const busy = ctx.busy(verb);
  const can = action !== null && a !== null && a.affordable;
  return (
    <div className={styles.spend}>
      {q !== null && <CostList s={s} q={q} atMs={atMs} />}
      <div className={styles.btnrow}>
        <button
          type="button"
          className="btn"
          disabled={busy || !can}
          aria-busy={busy}
          aria-label={ariaLabel}
          onClick={() => {
            if (action !== null) spend(ctx, [action], verb);
          }}
        >
          {text}
        </button>
        {a !== null && !a.affordable && !busy && (
          <span data-countdown aria-live="off" className={`${styles.muted} num`}>
            {a.inMs === null
              ? "not affordable on current rates"
              : `affordable in ${duration(a.inMs)}`}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- Buy -------------------------------------------------------------------------------------

type CountChoice = "1" | "10" | "max";

function BuySection({ ctx, sec }: { ctx: Ctx; sec: MachineSection }) {
  useTick(); // ×max moves with the stock
  const s = ctx.snapshot;
  const unlocked = sec.marks.filter((m) => m.unlocked);
  const [picked, setPicked] = useState<number>(sec.bestMark!);
  const mark = unlocked.some((m) => m.mark === picked) ? picked : sec.bestMark!;
  const [choice, setChoice] = useState<CountChoice>("1");
  const row = sec.marks.find((m) => m.mark === mark)!;
  const max = Math.max(
    1,
    maxAffordableCount(s, sec.lane, sec.machineClass, mark, serverNow(s, ctx.now())),
  );
  const n = choice === "1" ? 1 : choice === "10" ? 10 : max;
  const action = buyAction(sec, mark, n);
  const markId = useId();
  return (
    <div className={styles.body}>
      <div className={styles.kv}>
        <label htmlFor={markId}>Mark</label>
        <select
          id={markId}
          className={styles.select}
          value={mark}
          onChange={(e) => setPicked(Number(e.target.value))}
        >
          {unlocked.map((m) => (
            <option key={m.mark} value={m.mark}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.kv}>
        <span data-owned className="num">{`${row.owned} owned`}</span>
        <span className="num">{`${sec.pool} in the pool, ${sec.unassigned} unassigned`}</span>
      </div>
      <div role="group" aria-label="Count" className={styles.seg}>
        {(["1", "10", "max"] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={c === choice}
            className={c === choice ? `${styles.segBtn} ${styles.on}` : styles.segBtn}
            onClick={() => setChoice(c)}
          >
            {`×${c}`}
          </button>
        ))}
      </div>
      {sec.ladder !== null && (
        <p data-ladder className={styles.ladder}>
          <span className="num">{`Ladder ×${format(D(sec.ladder.multiplier), "hybrid")}`}</span>
          <span className="num">{sec.ladder.text}</span>
        </p>
      )}
      <Spend
        ctx={ctx}
        action={action}
        verb="buy"
        text={`Buy ${n} ${classLabel(s, sec.machineClass, n)}`}
      />
      <Projection snapshot={s} actions={[action]} laneId={ctx.model.laneId} />
    </div>
  );
}

// ---- Upgrade ---------------------------------------------------------------------------------

function UpgradeSection({ ctx, sec }: { ctx: Ctx; sec: MachineSection }) {
  const rows = sec.marks.filter((r) => r.consolidation !== null);
  const [focus, setFocus] = useState(0);
  const shown = rows[Math.min(focus, rows.length - 1)];
  const offered = (r: (typeof rows)[number]) => (r.upgradeBlocked === null ? r.upgrade : null);
  const focusAction = shown === undefined ? null : offered(shown);
  return (
    <div className={styles.body}>
      <ul className={styles.list}>
        {rows.map((r, i) => {
          const c = r.consolidation!;
          const text = `${c.from} Mk${r.mark} → ${c.to} Mk${c.toMark}`;
          return (
            <li
              key={r.mark}
              data-upgrade={r.mark}
              className={styles.item}
              onFocus={() => setFocus(i)}
              onMouseEnter={() => setFocus(i)}
            >
              <span className="num">{text}</span>
              {r.upgradeBlocked !== null && (
                <span className={styles.muted}>{r.upgradeBlocked}</span>
              )}
              <Spend
                ctx={ctx}
                action={offered(r)}
                verb="upgrade"
                text="Upgrade"
                ariaLabel={`Upgrade ${text}`}
              />
            </li>
          );
        })}
      </ul>
      <Projection
        snapshot={ctx.snapshot}
        actions={focusAction === null ? null : [focusAction]}
        laneId={ctx.model.laneId}
      />
    </div>
  );
}

// ---- Dismantle -------------------------------------------------------------------------------

function refundText(s: Snapshot, q: Quote): string {
  if (q.refund.size === 0) return "no refund";
  const parts = [...q.refund].map(([id, v]) => `${format(v, "hybrid")} ${itemName(s, id)}`);
  // C.5: a refund lands in Quantum Storage first, then BOUND.
  return `refunds ${parts.join(", ")}; to Quantum Storage first, then BOUND`;
}

function DismantleSection({ ctx, sec }: { ctx: Ctx; sec: MachineSection }) {
  const s = ctx.snapshot;
  const rows = sec.marks.filter((r) => r.owned > 0);
  const [focus, setFocus] = useState<{ mark: number; count: number } | null>(null);
  const busy = ctx.busy("dismantle");
  const first = rows[0];
  const shown = focus ?? (first === undefined ? null : { mark: first.mark, count: 1 });
  return (
    <div className={styles.body}>
      <ul className={styles.list}>
        {rows.map((r) => {
          const one = dismantleAction(sec, r.mark, 1);
          const all = dismantleAction(sec, r.mark, r.owned);
          return (
            <li key={r.mark} data-dismantle={r.mark} className={styles.item}>
              <span className="num">{`${r.name} · ${r.owned} owned`}</span>
              <p data-refund className={`${styles.muted} num`}>
                {refundText(s, quote(s.content, s.state, one))}
              </p>
              <div className={styles.btnrow}>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  aria-busy={busy}
                  aria-label={`Dismantle 1 Mk${r.mark}`}
                  onFocus={() => setFocus({ mark: r.mark, count: 1 })}
                  onMouseEnter={() => setFocus({ mark: r.mark, count: 1 })}
                  onClick={() => spend(ctx, [one], "dismantle")}
                >
                  ×1
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  aria-busy={busy}
                  aria-label={`Dismantle all ${r.owned} Mk${r.mark}`}
                  onFocus={() => setFocus({ mark: r.mark, count: r.owned })}
                  onMouseEnter={() => setFocus({ mark: r.mark, count: r.owned })}
                  onClick={() => spend(ctx, [all], "dismantle")}
                >
                  {`all ${r.owned}`}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <Projection
        snapshot={s}
        actions={shown === null ? null : [dismantleAction(sec, shown.mark, shown.count)]}
        laneId={ctx.model.laneId}
      />
    </div>
  );
}

// ---- Recipe ----------------------------------------------------------------------------------

function RecipeSection({ ctx }: { ctx: Ctx }) {
  const s = ctx.snapshot;
  const { recipes, itemId } = ctx.model;
  const pend = usePendingMap<RecipeId | null>();
  const server = recipes.find((c) => c.active)?.recipeId ?? null;
  const shown = pend.shown("recipe", server);
  const [focus, setFocus] = useState<RecipeId | null>(null);
  const reasonOf = (c: (typeof recipes)[number]): string | null =>
    c.unlockTier > s.state.tier
      ? `unlocks at tier ${c.unlockTier}`
      : c.inCycle
        ? "part of a recipe cycle"
        : null;
  const select = (recipeId: RecipeId): SelectRecipe => ({
    type: "SELECT_RECIPE",
    itemId,
    recipeId,
  });
  const target = focus ?? recipes.find((c) => c.select !== null)?.recipeId ?? null;
  const name = useId();
  return (
    <div className={styles.body}>
      <div role="radiogroup" aria-label="Recipe" className={styles.list}>
        {recipes.map((c) => {
          const reason = reasonOf(c);
          return (
            <label
              key={c.recipeId}
              data-recipe={c.recipeId}
              className={styles.radio}
              onMouseEnter={() => setFocus(c.recipeId)}
            >
              <input
                type="radio"
                name={name}
                value={c.recipeId}
                checked={shown === c.recipeId}
                disabled={reason !== null}
                onFocus={() => setFocus(c.recipeId)}
                onChange={() => {
                  if (shown === c.recipeId) return;
                  pend.run([["recipe", c.recipeId]], () =>
                    ctx.send([select(c.recipeId)], "recipe"),
                  );
                }}
              />
              <span>{c.name}</span>
              {reason !== null && <span className={styles.muted}>{reason}</span>}
            </label>
          );
        })}
      </div>
      <Projection
        snapshot={s}
        actions={target === null || target === server ? null : [select(target)]}
        laneId={ctx.model.laneId}
      />
    </div>
  );
}

// ---- Storage and Quantum Storage -------------------------------------------------------------

function Level<A extends Action>({
  ctx,
  title,
  sec,
  verb,
  onFocus,
}: {
  ctx: Ctx;
  title: string;
  sec: LevelSection<A>;
  verb: DrawerVerb;
  onFocus(): void;
}) {
  return (
    <div data-level={verb} className={styles.item} onFocus={onFocus} onMouseEnter={onFocus}>
      <div className={styles.kv}>
        <span className={styles.subhead}>{title}</span>
        <span className="num">{`Lv ${sec.level} / ${sec.maxLevel}`}</span>
      </div>
      <div className={`${styles.kv} num`}>
        {sec.nextCap === null
          ? `Cap ${format(sec.cap, "hybrid")}, the maximum`
          : `Cap ${format(sec.cap, "hybrid")} → ${format(sec.nextCap, "hybrid")}`}
      </div>
      <Spend ctx={ctx} action={sec.buy} verb={verb} text="+1" ariaLabel={`${title} +1`} />
    </div>
  );
}

function StorageSection({ ctx }: { ctx: Ctx }) {
  const { storage, qs } = ctx.model;
  const [focus, setFocus] = useState<"storage" | "qs">("storage");
  const action = focus === "storage" ? storage.buy : qs.buy;
  return (
    <div className={styles.body}>
      <Level
        ctx={ctx}
        title="Storage"
        sec={storage}
        verb="storage"
        onFocus={() => setFocus("storage")}
      />
      <Level ctx={ctx} title="Quantum Storage" sec={qs} verb="qs" onFocus={() => setFocus("qs")} />
      <Projection
        snapshot={ctx.snapshot}
        actions={action === null ? null : [action]}
        laneId={ctx.model.laneId}
      />
    </div>
  );
}

// ---- Assign ----------------------------------------------------------------------------------

function AssignSection({ ctx, sec }: { ctx: Ctx; sec: MachineSection }) {
  const s = ctx.snapshot;
  const pend = usePendingMap<number>();
  const shownOf = (recipeId: RecipeId, server: number) => pend.shown(recipeId, server);
  const delta = sec.assign.reduce(
    (acc, r) => acc + shownOf(r.recipeId, r.assigned) - r.assigned,
    0,
  );
  const free = sec.unassigned - delta;
  const move = idleMove(s, sec);
  const moveActions = move === null ? null : moveMachines(sec, move.from, move.to, move.n);
  const nameOf = (id: RecipeId) => sec.assign.find((r) => r.recipeId === id)?.name ?? id;

  /** One intent, one batch; every count it sets shows at once. */
  const assign = (actions: Action[]) =>
    pend.run(
      actions.flatMap((a) =>
        a.type === "ASSIGN_MACHINES" ? [[a.recipeId, a.count] as const] : [],
      ),
      () => ctx.send(actions, "assign"),
    );
  const one = (recipeId: RecipeId, count: number): Assign => ({
    type: "ASSIGN_MACHINES",
    recipeId,
    count,
  });

  return (
    <div className={styles.body}>
      <div className={`${styles.kv} num`}>
        <span>{`${sec.pool} ${classLabel(s, sec.machineClass, sec.pool)}`}</span>
        <span data-unassigned>{`${free} unassigned`}</span>
      </div>
      {move !== null && moveActions !== null && (
        <button type="button" className="btn" onClick={() => assign(moveActions)}>
          {`Move ${move.n} idle ${classLabel(s, sec.machineClass, move.n)} to ${nameOf(move.to)}`}
        </button>
      )}
      <ul className={styles.list}>
        {sec.assign.map((r) => {
          const n = shownOf(r.recipeId, r.assigned);
          const status = !r.live
            ? "not selected"
            : r.starved
              ? "starved"
              : r.idle || r.assigned === 0
                ? "idle"
                : "running";
          return (
            <li key={r.recipeId} data-assign={r.recipeId} className={styles.assign}>
              <span className={styles.assignName}>{r.name}</span>
              <span data-status data-state={status} className={styles.muted}>
                {status}
              </span>
              <span className={styles.stepper}>
                <button
                  type="button"
                  className="btn secondary"
                  aria-label={`One fewer on ${r.name}`}
                  disabled={n <= 0}
                  onClick={() => assign([one(r.recipeId, n - 1)])}
                >
                  −
                </button>
                <span data-assigned className="num">
                  {n}
                </span>
                <button
                  type="button"
                  className="btn secondary"
                  aria-label={`One more on ${r.name}`}
                  disabled={free <= 0}
                  onClick={() => assign([one(r.recipeId, n + 1)])}
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <Projection snapshot={s} actions={moveActions} laneId={ctx.model.laneId} />
    </div>
  );
}

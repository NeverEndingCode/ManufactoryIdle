// The item drawer (W-1 item 2, Q-6): every D.1 verb for the item's machines, its recipe, its
// storage and its lane's Quantum Storage, over one pure model (drawerModel). Spends are
// pessimistic (W-13): a button is busy while its own batch is pending, and the numbers move
// only with snapshots. Settings (recipe, assignment) are optimistic in the control (Q-10).
// U-5c: MACHINES is the default body; the other sections are MORE buttons with letter keys
// (K-4: a key clicks the button carrying its data-key, so a key is a click).
// K-12: a generator drawer (a power recipe's lane-class, opened from the power panel) shows
// MACHINES with [U] and [D] only, and its spends go under the panel's power:<class>:<verb>.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  D,
  DECIMAL_ZERO,
  getMark,
  liquidCap,
  type Action,
  type Dec,
  type ItemId,
  type MachineClassId,
  type RecipeId,
  type WorldState,
} from "@manufactory/engine";
import { shownStock } from "../sync/interpolate.js";
import type { Outcome } from "../sync/errors.js";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import {
  bottleneckRow,
  className as classLabel,
  plural,
  rateText,
  splitOf,
  type RowModel,
} from "./derive.js";
import { trapTab } from "./dialog.js";
import { generatorLabel, generatorRows, mwText } from "./dock-model.js";
import styles from "./Drawer.module.css";
import type { SectionKey } from "./keys.js";
import {
  buyAction,
  dismantleAction,
  drawerModel,
  idleMove,
  moveMachines,
  type DrawerModel,
  type GeneratorModel,
  type LevelSection,
  type MachineSection,
} from "./machines.js";
import { Guarded } from "./Guarded.js";
import { itemName as spokenName, laneLabel, useNames, type Names } from "./names.js";
import { fmt, useNotation } from "./notation.js";
import { Projection } from "./Projection.js";
import { navigate, routePath } from "./route.js";
import {
  affordability,
  creditFor,
  maxAffordableCount,
  quote,
  type Affordability,
  type Quote,
} from "./quote.js";
import { LiveStock } from "./Row.js";
import { Spoken } from "./Spoken.js";
import { useTheme } from "./theme.js";
import { usePendingMap, usePendingSetting } from "./use-pending.js";
import { useSheetDrag } from "./use-sheet-drag.js";
import { useTick } from "./use-tick.js";

export type DrawerVerb = "buy" | "dismantle" | "upgrade" | "storage" | "qs" | "recipe" | "assign";

/** Batch labels: a spend's button is busy while its batch is pending (W-13, pessimistic). */
export const drawerLabel = (itemId: ItemId, verb: DrawerVerb) => `drawer:${itemId}:${verb}`;

/** K-12: what the drawer is open on, an item row or a generator recipe. */
export type DrawerTarget =
  { kind: "item"; itemId: ItemId } | { kind: "generator"; recipeId: RecipeId };

/** The React key: "item:iron_ore" or "gen:burn_biomass". */
export function drawerKey(t: DrawerTarget): string {
  return t.kind === "item" ? `item:${t.itemId}` : `gen:${t.recipeId}`;
}

type GeneratorVerb = "buy" | "upgrade" | "dismantle";

/** K-12: a generator drawer's labels are the power panel's, so its buy and the +1 are busy
 * together (V-21's generatorLabel). */
export const generatorVerbLabel = (machineClass: MachineClassId, verb: GeneratorVerb) =>
  verb === "buy" ? generatorLabel(machineClass) : `power:${machineClass}:${verb}`;

/** A spend's batch label for this drawer's model. */
function labelOf(m: DrawerModel | GeneratorModel, verb: DrawerVerb): string {
  if (m.kind === "item") return drawerLabel(m.itemId, verb);
  if (verb === "buy" || verb === "upgrade" || verb === "dismantle")
    return generatorVerbLabel(m.machineClass, verb);
  throw new Error(`a generator drawer has no ${verb}`);
}

export interface DrawerProps {
  store: Pick<GameStore, "now" | "send">;
  snapshot: Snapshot;
  target: DrawerTarget;
  pending: readonly Batch[];
  onClose(): void;
  /** K-15 / §13.1: a SPLIT row's tap, to the item's entry in the priority list (items only). */
  onSplit(itemId: ItemId): void;
  /** U-5a: the desktop and tablet panel over the content row, non-modal (aria-modal="false",
   * the rows live). U-5b / K-3: the phone's fixed sheet, modal in a [data-drawer-host] backdrop
   * over the --scrim; App inerts everything else. */
  presentation: "panel" | "sheet";
  /** Called on mount: true when the player just opened this drawer, so the title takes focus.
   * A remount for any other reason (a view switch) must not steal focus. Default: always. */
  claimFocus?: () => boolean;
  /** Called when the drawer unmounts while it holds focus (a remount across 600 px drops it to
   * the body): App hands the next mount's claimFocus a true, once. */
  onLeaveFocused?: () => void;
}

/** U-5c: the sections behind MORE; MACHINES is the body when none is open. */
export type Section = "upgrade" | "recipe" | "assign" | "storage" | "dismantle";

/** Each section's letter (U-5c's table); B is MACHINES' own buy 1. */
export const SECTION_KEY: Readonly<Record<Section, SectionKey>> = {
  upgrade: "U",
  recipe: "R",
  assign: "A",
  storage: "S",
  dismantle: "D",
};

/** A reader's name for each MORE button (storage adds its next cost). */
const SECTION_NAME: Record<Section, string> = {
  upgrade: "Upgrade",
  recipe: "Recipe",
  assign: "Assign",
  storage: "Storage",
  dismantle: "Dismantle",
};

type Assign = Extract<Action, { type: "ASSIGN_MACHINES" }>;
type SelectRecipe = Extract<Action, { type: "SELECT_RECIPE" }>;

/** Only what the model offers (U-5c): upgrade with a consolidation, recipe with ≥ 2 recipes,
 *  assign with assign rows, storage always (items), dismantle with any owned; in that order.
 *  A generator has upgrade and dismantle only (K-12). */
export function sectionsOf(m: DrawerModel | GeneratorModel): Section[] {
  const sec = m.machines;
  const item = m.kind === "item" ? m : null;
  const out: Section[] = [];
  if (sec?.marks.some((r) => r.consolidation !== null)) out.push("upgrade");
  if (item !== null && item.recipes.length >= 2) out.push("recipe");
  if (item !== null && sec !== null && sec.assign.length > 0) out.push("assign");
  if (item !== null) out.push("storage");
  if (sec?.marks.some((r) => r.owned > 0)) out.push("dismantle");
  return out;
}

interface Ctx {
  snapshot: Snapshot;
  model: DrawerModel | GeneratorModel;
  names: Names;
  now: () => number;
  busy(verb: DrawerVerb): boolean;
  send(actions: Action[], verb: DrawerVerb): Promise<Outcome>;
  /** Q-10's hold owner: the store, so a held setting survives a section switch or a close. */
  owner: object;
  /** U-7e / K-17: key hints on the desktop panel only; the phone has none. */
  hints: boolean;
}

/** K-7: a hint is rendered from its control's own data-key, so it can't name another key. */
function hint(ctx: Ctx, key: string | undefined): ReactNode {
  if (!ctx.hints || key === undefined) return null;
  return (
    <span className="key-hint" aria-hidden="true">
      {`[${key}]`}
    </span>
  );
}

export function Drawer({
  store,
  snapshot,
  target,
  pending,
  onClose,
  onSplit,
  presentation,
  claimFocus,
  onLeaveFocused,
}: DrawerProps) {
  // The store's snapshot object as is: drawerModel and preview memoise on its identity.
  const [notation] = useNotation();
  const model =
    target.kind === "item"
      ? drawerModel(snapshot, target.itemId, notation)
      : drawerModel(snapshot, { recipeId: target.recipeId }, notation);
  const item = model.kind === "item" ? model : null;
  const sections = sectionsOf(model);
  const [picked, setPicked] = useState<Section | null>(null);
  // A section the model no longer offers falls back to MACHINES.
  const shown = picked !== null && sections.includes(picked) ? picked : null;
  const title = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLElement>(null);
  const names = useNames(snapshot);
  const itemId = item?.itemId ?? null;
  const hot = useMemo(
    () => itemId !== null && bottleneckRow(snapshot)?.itemId === itemId,
    [snapshot, itemId],
  );
  const targetKey = drawerKey(target);

  const claim = useRef(claimFocus);
  claim.current = claimFocus;
  useEffect(() => {
    if (claim.current === undefined || claim.current()) title.current?.focus();
  }, [targetKey]);
  // A layout cleanup runs while the DOM is still attached, so focus is still where it was.
  const left = useRef(onLeaveFocused);
  left.current = onLeaveFocused;
  useLayoutEffect(() => {
    const el = box.current;
    return () => {
      if (el !== null && el.contains(document.activeElement)) left.current?.();
    };
  }, []);

  // K-11: the drawer never drops focus to <body>. After every commit: when the last element
  // focused inside it has gone (a section swap, a dismantle-all's row, a mark row) and focus
  // fell to the body, the title takes it. A click on blank space leaves that element in place,
  // so it never pulls focus back. It runs on the Drawer's own commits only; that's enough,
  // because its elements only disappear when a new snapshot (or its own state) re-renders it.
  const lastFocused = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const el = lastFocused.current;
    if (el === null || el.isConnected) return;
    lastFocused.current = null;
    if (document.activeElement === document.body && box.current?.isConnected === true) {
      title.current?.focus();
    }
  });

  const sheet = presentation === "sheet";
  const ctx: Ctx = {
    snapshot,
    model,
    names,
    now: () => store.now(),
    busy: (verb) => pending.some((b) => b.label === labelOf(model, verb)),
    send: (actions, verb) => store.send(actions, labelOf(model, verb)),
    owner: store,
    hints: !sheet,
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    // K-3: the sheet is modal, so Tab wraps inside it (V-12's trapTab).
    if (sheet && box.current !== null) trapTab(e.nativeEvent, box.current);
  };

  // K-20: the grip, and the head while the content is scrolled to the top, drag the sheet down.
  // The body never starts a drag (that's a scroll), nor do the head's own buttons (the x).
  const { grip, offset } = useSheetDrag(onClose);
  const [atTop, setAtTop] = useState(true);
  const fromHead = (e: PointerEvent<HTMLElement>) =>
    !(e.target instanceof Element && e.target.closest("button") !== null) &&
    (box.current?.scrollTop ?? 0) <= 0;
  const head = sheet
    ? {
        onPointerDown: (e: PointerEvent<HTMLElement>) => {
          if (fromHead(e)) grip.onPointerDown(e);
        },
        onPointerMove: grip.onPointerMove,
        onPointerUp: grip.onPointerUp,
        onPointerCancel: grip.onPointerCancel,
        onLostPointerCapture: grip.onLostPointerCapture,
      }
    : {};

  const sec = model.machines;
  const dialog = (
    <section
      ref={box}
      id="detail"
      role="dialog"
      aria-modal={sheet ? "true" : "false"}
      aria-labelledby="drawer-title"
      data-drawer={model.kind === "item" ? model.itemId : `power:${model.machineClass}`}
      data-presentation={presentation}
      data-dragging={offset !== null ? "" : undefined}
      data-at-top={sheet && atTop ? "" : undefined}
      className={`${styles.drawer} ${sheet ? styles.sheet : styles.panel}`}
      style={offset !== null ? { transform: `translateY(${offset}px)` } : undefined}
      onKeyDown={onKeyDown}
      onScroll={sheet ? (e) => setAtTop(e.currentTarget.scrollTop <= 0) : undefined}
      onFocus={(e) => {
        lastFocused.current = e.target;
      }}
    >
      <div className={styles.head} {...head}>
        {sheet && (
          // K-20: the grip's 44 px hit area, the sheet's width; a button too, so a key or a
          // screen reader can press it (the x stays the plain Close).
          <button
            type="button"
            className={styles.grip}
            data-grip
            aria-label="Drag down to close"
            onPointerDown={grip.onPointerDown}
            onPointerMove={grip.onPointerMove}
            onPointerUp={grip.onPointerUp}
            onPointerCancel={grip.onPointerCancel}
            onLostPointerCapture={grip.onLostPointerCapture}
            onClick={grip.onClick}
          />
        )}
        {/* U-1h: the theme's label shown; a reader gets the content name. */}
        <h2
          id="drawer-title"
          ref={title}
          tabIndex={-1}
          aria-label={model.name}
          className={hot ? `${styles.title} state-bottleneck` : styles.title}
        >
          {model.kind === "item"
            ? names.item(model.itemId)
            : names.machine(model.machineClass, null)}
        </h2>
        {sheet ? (
          // U-5b: a 44 × 44 x.
          <button type="button" className={styles.x} aria-label="Close" onClick={onClose}>
            x
          </button>
        ) : (
          <button type="button" className={`btn secondary ${styles.close}`} onClick={onClose}>
            Close
          </button>
        )}
        {model.kind === "item" ? (
          <Meta snapshot={snapshot} itemId={model.itemId} now={ctx.now} />
        ) : (
          <GeneratorMeta snapshot={snapshot} model={model} />
        )}
        {/* U-5a's hint, fine pointer only (U-7e). No ↑/↓ on the phone, nor from a generator
            drawer, which ↑/↓ don't follow (K-12). */}
        {!sheet && (
          <span className={`key-hint ${styles.hint}`} aria-hidden="true">
            {item !== null ? "[↑↓] row  [ESC] close" : "[ESC] close"}
          </span>
        )}
      </div>
      <div className={styles.body} data-body={shown ?? "machines"}>
        {shown === null ? (
          <MachinesBody ctx={ctx} sec={sec} onSplit={onSplit} />
        ) : (
          <h3 className={styles.h3}>{SECTION_NAME[shown].toUpperCase()}</h3>
        )}
        {shown === "upgrade" && sec !== null && <UpgradeSection ctx={ctx} sec={sec} />}
        {shown === "recipe" && item !== null && <RecipeSection ctx={ctx} m={item} />}
        {shown === "assign" && sec !== null && <AssignSection ctx={ctx} sec={sec} />}
        {shown === "storage" && item !== null && <StorageSection ctx={ctx} m={item} />}
        {shown === "dismantle" && sec !== null && <DismantleSection ctx={ctx} sec={sec} />}
      </div>
      <MoreBar
        ctx={ctx}
        sections={sections}
        shown={shown}
        sheet={sheet}
        onToggle={(s) => setPicked(shown === s ? null : s)}
      />
    </section>
  );
  if (!sheet) return dialog;
  // K-3: the backdrop; a press on it (not on the sheet) closes, as Settings' and NEXT_BUY's do.
  return (
    <div
      className={styles.backdrop}
      data-drawer-host
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {dialog}
    </div>
  );
}

// ---- shared pieces ---------------------------------------------------------------------------

/** U-3c / V-18: "IRON lane · +0.4/s · 214/2.0k · QS 40.0k · BOUND 12", QS and BOUND only when
 * non-zero; what left the row. The stock is live at the 4 Hz tick, as in the row. */
function Meta({
  snapshot,
  itemId,
  now,
}: {
  snapshot: Snapshot;
  itemId: ItemId;
  now: () => number;
}) {
  const theme = useTheme().applied;
  const [notation] = useNotation();
  const item = snapshot.content.items.get(itemId);
  const own = <T,>(r: Readonly<Record<string, T>>) =>
    Object.hasOwn(r, itemId) ? r[itemId] : undefined;
  const qs = own(snapshot.state.quantum);
  const bound = own(snapshot.state.bound);
  const net = snapshot.schedule.items[itemId]?.netPerSecond ?? 0;
  return (
    <p className={`${styles.meta} num`} data-meta>
      {item === undefined ? "" : `${laneLabel(snapshot, item.lane, theme)} lane · `}
      {`${rateText(net)} · `}
      <LiveStock snapshot={snapshot} itemId={itemId} now={now} />
      {`/${fmt(liquidCap(snapshot.content, snapshot.state, itemId), notation)}`}
      {qs !== undefined && !qs.eq(DECIMAL_ZERO) && ` · QS ${fmt(qs, notation)}`}
      {bound !== undefined && !bound.eq(DECIMAL_ZERO) && ` · BOUND ${fmt(bound, notation)}`}
    </p>
  );
}

/** U-5c / K-12: "POWER lane · x14 · 420 MW now", the owned count and the MW from the power
 * panel's own row (generatorRows), so the two agree. */
function GeneratorMeta({ snapshot, model }: { snapshot: Snapshot; model: GeneratorModel }) {
  const theme = useTheme().applied;
  const row = useMemo(
    () => generatorRows(snapshot).find((r) => r.machineClass === model.machineClass),
    [snapshot, model.machineClass],
  );
  return (
    <p className={`${styles.meta} num`} data-meta>
      {`${laneLabel(snapshot, model.laneId, theme)} lane · x${row?.owned ?? model.machines.pool} · ${mwText(row?.mwNow ?? 0)} MW now`}
    </p>
  );
}

/** "900 IRON_PLATE" seen, "900 Iron Plate" heard; a two-item cost joins with " + ". */
function costWords(ctx: Ctx, q: Quote): { shown: string; said: string } {
  const parts = [...q.cost];
  return {
    shown: parts.map(([id, n]) => `${fmt(n)} ${ctx.names.item(id)}`).join(" + "),
    said: parts.map(([id, n]) => `${fmt(n)} ${spokenName(ctx.snapshot, id)}`).join(" + "),
  };
}

/** U-5c: the MORE buttons, one per section the model offers, then the handbook link. On the
 *  phone sheet a 2-column grid at the bottom, with no heading (U-5b). */
function MoreBar({
  ctx,
  sections,
  shown,
  sheet,
  onToggle,
}: {
  ctx: Ctx;
  sections: readonly Section[];
  shown: Section | null;
  sheet: boolean;
  onToggle(s: Section): void;
}) {
  const item = ctx.model.kind === "item" ? ctx.model : null;
  const s = ctx.snapshot;
  const label = (sec: Section): { shown: string; said: string } => {
    if (sec !== "storage" || item === null) return { shown: sec, said: SECTION_NAME[sec] };
    const { storage } = item;
    // U-5c: the next level's cost, so the key reads as opening the section, not as a buy.
    if (storage.buy === null) return { shown: "storage · max", said: "Storage, max" };
    const words = costWords(ctx, quote(s.content, s.state, storage.buy));
    return { shown: `storage · next ${words.shown}`, said: `Storage, next ${words.said}` };
  };
  return (
    <div className={styles.more} data-more>
      {!sheet && <h3 className={styles.h3}>MORE</h3>}
      {sections.map((sec) => {
        const key = SECTION_KEY[sec];
        const words = label(sec);
        return (
          <button
            key={sec}
            type="button"
            className={styles.moreBtn}
            data-section={sec}
            data-key={key}
            aria-pressed={shown === sec}
            aria-label={words.said}
            onClick={() => onToggle(sec)}
          >
            {hint(ctx, key)}
            {words.shown}
          </button>
        );
      })}
      {/* §13.4's context-aware entry: this item's handbook page. A link, so it can open in a
          new tab too; a plain click stays in the app. H is the global handbook key (K-10).
          A generator has no entry (K-12). */}
      {item !== null && (
        <a
          className={styles.moreBtn}
          href={routePath({ kind: "handbook", itemId: item.itemId })}
          data-handbook-link
          data-key="H"
          aria-label="Handbook entry"
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate({ kind: "handbook", itemId: item.itemId });
          }}
        >
          {hint(ctx, "H")}
          handbook
        </a>
      )}
    </div>
  );
}

const SPLIT_TONES = ["toneA", "toneB", "toneC"] as const;

/** K-15 / U-3c: the producer's allocations as SPLIT, one button per part, each to the item's
 *  priority entry (as onSplit did from the bar). The bar itself is decoration. */
function SplitSection({
  ctx,
  item,
  split,
  onSplit,
}: {
  ctx: Ctx;
  item: DrawerModel;
  split: NonNullable<RowModel["split"]>;
  onSplit(itemId: ItemId): void;
}) {
  const { itemId, name } = item;
  const shownLabel = (entryId: string, label: string) =>
    entryId.startsWith("item:") ? ctx.names.item(entryId.slice("item:".length)) : label;
  return (
    <div className={styles.splitSection}>
      <h3 className={styles.h3}>SPLIT</h3>
      <div className={styles.split} aria-hidden="true">
        {split.map((part, i) => (
          <div
            key={part.entryId}
            className={styles[SPLIT_TONES[i % SPLIT_TONES.length]!]}
            style={{ flexGrow: part.share }}
          />
        ))}
      </div>
      <ul className={styles.splitList}>
        {split.map((part, i) => {
          const pct = `${Math.round(part.share * 100)}%`;
          return (
            <li key={part.entryId}>
              <button
                type="button"
                className={styles.splitRow}
                data-split
                aria-label={`${pct} ${part.label}: show ${name} in the priority list`}
                onClick={() => onSplit(itemId)}
              >
                <span
                  className={`${styles.swatch} ${styles[SPLIT_TONES[i % SPLIT_TONES.length]!]}`}
                  aria-hidden="true"
                />
                <span className="num">
                  <Spoken
                    shown={`${pct} ${shownLabel(part.entryId, part.label)}`}
                    said={`${pct} ${part.label}`}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
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

/** The state as of atMs for these cost items: the shown (interpolated) liquid stock in
 * `stored`, none in `quantum`, so creditFor reads exactly what affordability() reads. */
function stateAt(s: Snapshot, q: Quote, atMs: number): WorldState {
  const stored = { ...s.state.stored };
  const quantum = { ...s.state.quantum };
  for (const itemId of q.cost.keys()) {
    stored[itemId] = shownStock(s, itemId, atMs);
    quantum[itemId] = DECIMAL_ZERO;
  }
  return { ...s.state, stored, quantum };
}

/** One spend's standing at atMs. Off when busy, or when the model doesn't offer the action
 *  (null), or for lack of an item: one shortfall for both the red cost and the button, so they
 *  can never disagree. A rejected action quotes empty maps, which affordability() alone would
 *  call affordable. */
interface SpendState {
  q: Quote | null;
  short: ReadonlyMap<ItemId, Dec>;
  a: Affordability | null;
  busy: boolean;
  off: boolean;
}

function spendState(ctx: Ctx, action: Action | null, verb: DrawerVerb, atMs: number): SpendState {
  const s = ctx.snapshot;
  const q = action === null ? null : quote(s.content, s.state, action);
  const short = q === null ? new Map<ItemId, Dec>() : creditFor(stateAt(s, q, atMs), q);
  const a = action === null ? null : affordability(s, action, atMs);
  const busy = ctx.busy(verb);
  return { q, short, a, busy, off: busy || action === null || short.size > 0 };
}

/** "affordable in 43s", or the words for never, while off for lack and not busy. */
function Countdown({ st }: { st: SpendState }) {
  if (st.a === null || st.a.affordable || st.busy) return null;
  return (
    <span data-countdown aria-live="off" className={`${styles.muted} num`}>
      {st.a.inMs === null
        ? "not affordable on current rates"
        : `affordable in ${duration(st.a.inMs)}`}
    </span>
  );
}

/** Each cost item, red exactly when the model's shortfall (creditFor) has it. */
function CostList({ ctx, q, short }: { ctx: Ctx; q: Quote; short: ReadonlyMap<ItemId, Dec> }) {
  if (q.cost.size === 0) return null;
  return (
    <ul aria-label="Cost" className={styles.cost}>
      {[...q.cost].map(([itemId, need]) => {
        const isShort = short.has(itemId);
        return (
          <li
            key={itemId}
            data-cost={itemId}
            data-short={isShort ? "" : undefined}
            className={isShort ? "state-bottleneck" : undefined}
          >
            <span>
              <Spoken shown={ctx.names.item(itemId)} said={spokenName(ctx.snapshot, itemId)} />
            </span>
            <span className="num">{fmt(need)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A spend's cost, its countdown and its button, at the 4 Hz tick. Enabled only when the
 * model offers the action (non-null) AND it is affordable.
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
  const st = spendState(ctx, action, verb, serverNow(ctx.snapshot, ctx.now()));
  return (
    <div className={styles.spend}>
      {st.q !== null && <CostList ctx={ctx} q={st.q} short={st.short} />}
      <div className={styles.btnrow}>
        <Guarded
          off={st.off}
          aria-busy={st.busy}
          aria-label={ariaLabel}
          onPress={() => {
            if (action !== null) spend(ctx, [action], verb);
          }}
        >
          {text}
        </Guarded>
        {action !== null && <Countdown st={st} />}
      </div>
    </div>
  );
}

// ---- MACHINES --------------------------------------------------------------------------------

type Count = "1" | "10" | "max";
const COUNTS: readonly Count[] = ["1", "10", "max"];

/** V-17's form: the plain words, plus when it's off for lack and not busy ", affordable in N
 *  seconds" (or ", not affordable yet"). */
function buyName(base: string, st: SpendState): string {
  if (!st.off || st.busy || st.a === null || st.a.affordable) return base;
  if (st.a.inMs === null) return `${base}, not affordable yet`;
  const n = Math.max(1, Math.ceil(st.a.inMs / 1000));
  return `${base}, affordable in ${n} ${plural(n, "second")}`;
}

/**
 * U-5c / K-13: a row per mark (the label, the owned count, the cost of one), each unlocked mark
 * with buy 1, ×10 and max; the best mark's buy 1 carries B. Then the ladder, the IF YOU BUY
 * line following the hovered or focused count, its projection, and SPLIT when contested.
 */
function MachinesBody({
  ctx,
  sec,
  onSplit,
}: {
  ctx: Ctx;
  sec: MachineSection | null;
  onSplit(itemId: ItemId): void;
}) {
  useTick(); // max and the countdowns move with the stock
  const s = ctx.snapshot;
  const [follow, setFollow] = useState<{ mark: number; count: Count } | null>(null);
  // SPLIT is an item's (U-3c); a generator has none (K-12).
  const item = ctx.model.kind === "item" ? ctx.model : null;
  const split = useMemo(() => (item === null ? null : splitOf(s, item.itemId)), [s, item]);
  if (sec === null) {
    return (
      <>
        <h3 className={styles.h3}>MACHINES</h3>
        <p className={styles.muted}>No machine makes this.</p>
      </>
    );
  }
  const atMs = serverNow(s, ctx.now());
  const best = sec.bestMark;
  const unlocked = (mark: number) => sec.marks.some((r) => r.mark === mark && r.unlocked);
  const followed =
    follow !== null && unlocked(follow.mark)
      ? follow
      : best === null
        ? null
        : { mark: best, count: "1" as const };
  const countOf = (mark: number, c: Count) =>
    c === "1"
      ? 1
      : c === "10"
        ? 10
        : Math.max(1, maxAffordableCount(s, sec.lane, sec.machineClass, mark, atMs));
  const followAction =
    followed === null
      ? null
      : buyAction(sec, followed.mark, countOf(followed.mark, followed.count));
  const followState = spendState(ctx, followAction, "buy", atMs);
  const ladder = sec.ladder;

  return (
    <>
      <h3 className={styles.h3}>MACHINES</h3>
      <ul className={styles.marks}>
        {sec.marks.map((r) => {
          const name = (
            <span className={styles.markName}>
              <Spoken shown={ctx.names.machine(sec.machineClass, r.mark)} said={r.name} />
            </span>
          );
          if (!r.unlocked) {
            const tier = getMark(s.content, sec.machineClass, r.mark)?.unlockTier;
            return (
              <li key={r.mark} data-mark={r.mark} data-locked className={styles.mark}>
                {name}
                <span className={styles.owned} aria-hidden="true">
                  —
                </span>
                <span className={styles.locked}>{`locked · tier ${tier ?? "?"}`}</span>
              </li>
            );
          }
          const one = spendState(ctx, buyAction(sec, r.mark, 1), "buy", atMs);
          const each = one.q === null ? null : costWords(ctx, one.q);
          return (
            <li key={r.mark} data-mark={r.mark} className={styles.mark}>
              {name}
              <span data-owned className={`${styles.owned} num`}>{`x${r.owned}`}</span>
              <span
                data-each
                className={
                  one.short.size > 0 ? `${styles.each} num state-bottleneck` : `${styles.each} num`
                }
              >
                {each !== null && (
                  <Spoken shown={`${each.shown} each`} said={`${each.said} each`} />
                )}
              </span>
              <span className={styles.markBtns}>
                {COUNTS.map((c) => {
                  const n = countOf(r.mark, c);
                  const action = buyAction(sec, r.mark, n);
                  const st = c === "1" ? one : spendState(ctx, action, "buy", atMs);
                  const key = c === "1" && r.mark === best ? "B" : undefined;
                  const base = c === "max" ? `Buy max (${n}) ${r.name}` : `Buy ${n} ${r.name}`;
                  const point = () => setFollow({ mark: r.mark, count: c });
                  return (
                    <Guarded
                      key={c}
                      className={c === "1" ? `${styles.markBtn} ${styles.buy}` : styles.markBtn}
                      data-mark-buy={r.mark}
                      data-count={c}
                      data-key={key}
                      off={st.off}
                      aria-busy={st.busy}
                      aria-label={buyName(base, st)}
                      onFocus={point}
                      onMouseEnter={point}
                      onPress={() => spend(ctx, [action], "buy")}
                    >
                      {hint(ctx, key)}
                      {c === "1" ? "buy 1" : c === "10" ? "x10" : "max"}
                    </Guarded>
                  );
                })}
              </span>
            </li>
          );
        })}
      </ul>
      {ladder !== null && (
        // K-13: "ladder: 8 more MINER → x1.50" seen; a reader hears ladder.text.
        <p data-ladder className={`${styles.ladder} num`}>
          <Spoken
            shown={`ladder: ${ladder.more} more ${ctx.names.machine(sec.machineClass, null)} → x${fmt(D(ladder.nextMultiplier / ladder.multiplier))}`}
            said={ladder.text}
          />
        </p>
      )}
      {followed !== null && (
        <div data-follow className={styles.follow}>
          <p
            className={styles.followLine}
          >{`IF YOU BUY ${countOf(followed.mark, followed.count)}`}</p>
          {followState.q !== null && (
            <CostList ctx={ctx} q={followState.q} short={followState.short} />
          )}
          <Countdown st={followState} />
        </div>
      )}
      <Projection
        snapshot={s}
        actions={followAction === null ? null : [followAction]}
        laneId={ctx.model.laneId}
        caption=""
      />
      {item !== null && split !== null && (
        <SplitSection ctx={ctx} item={item} split={split} onSplit={onSplit} />
      )}
    </>
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
    <div className={styles.stack}>
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
  const parts = [...q.refund].map(([id, v]) => `${fmt(v)} ${spokenName(s, id)}`);
  // C.5: a refund lands in Quantum Storage first, then BOUND.
  return `refunds ${parts.join(", ")}; to Quantum Storage first, then BOUND`;
}

function DismantleSection({ ctx, sec }: { ctx: Ctx; sec: MachineSection }) {
  const s = ctx.snapshot;
  const rows = sec.marks.filter((r) => r.owned > 0);
  // The focused button, as (mark, ×1 or all); a mark no longer owned falls back to the first
  // row, and "all" always means the current stock, so the projection is never stale.
  const [focus, setFocus] = useState<{ mark: number; all: boolean } | null>(null);
  const busy = ctx.busy("dismantle");
  const at = rows.find((r) => r.mark === focus?.mark) ?? rows[0];
  const shown =
    at === undefined
      ? null
      : {
          mark: at.mark,
          count: focus !== null && focus.mark === at.mark && focus.all ? at.owned : 1,
        };
  return (
    <div className={styles.stack}>
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
                <Guarded
                  className="btn secondary"
                  off={busy}
                  aria-busy={busy}
                  aria-label={`Dismantle ×1 Mk${r.mark}`}
                  onFocus={() => setFocus({ mark: r.mark, all: false })}
                  onMouseEnter={() => setFocus({ mark: r.mark, all: false })}
                  onPress={() => spend(ctx, [one], "dismantle")}
                >
                  ×1
                </Guarded>
                <Guarded
                  className="btn secondary"
                  off={busy}
                  aria-busy={busy}
                  aria-label={`Dismantle all ${r.owned} Mk${r.mark}`}
                  onFocus={() => setFocus({ mark: r.mark, all: true })}
                  onMouseEnter={() => setFocus({ mark: r.mark, all: true })}
                  onPress={() => spend(ctx, [all], "dismantle")}
                >
                  {`all ${r.owned}`}
                </Guarded>
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

function RecipeSection({ ctx, m }: { ctx: Ctx; m: DrawerModel }) {
  const s = ctx.snapshot;
  const { recipes, itemId } = m;
  const server = recipes.find((c) => c.active)?.recipeId ?? null;
  const pend = usePendingSetting<RecipeId | null>(server, {
    owner: ctx.owner,
    key: drawerLabel(itemId, "recipe"),
  });
  const shown = pend.shown;
  const [focus, setFocus] = useState<RecipeId | null>(null);
  /** Only the words: whether a choice is selectable is the model's (`select`). */
  const reasonOf = (c: (typeof recipes)[number]): string | null =>
    c.select !== null || c.active
      ? null
      : c.unlockTier > s.state.tier
        ? `unlocks at tier ${c.unlockTier}`
        : c.inCycle
          ? "part of a recipe cycle"
          : "not selectable";
  const select = (recipeId: RecipeId): SelectRecipe => ({
    type: "SELECT_RECIPE",
    itemId,
    recipeId,
  });
  const target = focus ?? recipes.find((c) => c.select !== null)?.recipeId ?? null;
  const name = useId();
  return (
    <div className={styles.stack}>
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
                disabled={c.select === null && !c.active}
                onFocus={() => setFocus(c.recipeId)}
                onChange={() => {
                  if (shown === c.recipeId) return;
                  // The active choice has no `select`; choosing it back while another is
                  // pending re-selects it.
                  const action = c.select ?? select(c.recipeId);
                  pend.run(c.recipeId, () => ctx.send([action], "recipe"));
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
          ? `Cap ${fmt(sec.cap)}, the maximum`
          : `Cap ${fmt(sec.cap)} → ${fmt(sec.nextCap)}`}
      </div>
      <Spend ctx={ctx} action={sec.buy} verb={verb} text="+1" ariaLabel={`${title} +1`} />
    </div>
  );
}

function StorageSection({ ctx, m }: { ctx: Ctx; m: DrawerModel }) {
  const { storage, qs } = m;
  const [focus, setFocus] = useState<"storage" | "qs">("storage");
  const action = focus === "storage" ? storage.buy : qs.buy;
  return (
    <div className={styles.stack}>
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
  const pend = usePendingMap<number>(ctx.owner);
  /** By recipe only: two drawers on one recipe show the same hold. */
  const keyOf = (recipeId: RecipeId) => `assign:${recipeId}`;
  const shownOf = (recipeId: RecipeId, server: number) => pend.shown(keyOf(recipeId), server);
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
        a.type === "ASSIGN_MACHINES" ? [[keyOf(a.recipeId), a.count] as const] : [],
      ),
      () => ctx.send(actions, "assign"),
    );
  const one = (recipeId: RecipeId, count: number): Assign => ({
    type: "ASSIGN_MACHINES",
    recipeId,
    count,
  });

  return (
    <div className={styles.stack}>
      <div className={`${styles.kv} num`}>
        <span>{`${sec.pool} ${classLabel(s, sec.machineClass, sec.pool)}`}</span>
        <span data-unassigned>{`${free} unassigned`}</span>
      </div>
      {move !== null && moveActions !== null && (
        // Computed from the server's counts: while any stepper's hold is pending it would
        // undo or double that step, so it waits.
        <Guarded
          off={sec.assign.some((r) => pend.held(keyOf(r.recipeId)))}
          onPress={() => assign(moveActions)}
        >
          {`Move ${move.n} idle ${classLabel(s, sec.machineClass, move.n)} to ${nameOf(move.to)}`}
        </Guarded>
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
                <Guarded
                  className="btn secondary"
                  aria-label={`One fewer on ${r.name}`}
                  off={n <= 0}
                  onPress={() => assign([one(r.recipeId, n - 1)])}
                >
                  −
                </Guarded>
                <span data-assigned className="num">
                  {n}
                </span>
                <Guarded
                  className="btn secondary"
                  aria-label={`One more on ${r.name}`}
                  off={free <= 0}
                  onPress={() => assign([one(r.recipeId, n + 1)])}
                >
                  +
                </Guarded>
              </span>
            </li>
          );
        })}
      </ul>
      <Projection snapshot={s} actions={moveActions} laneId={ctx.model.laneId} />
    </div>
  );
}

// The item drawer's model (Q-4, Q-6): pure, once per (snapshot, itemId). Every D.1 machine
// verb for the lane-class of the item's active recipe, the recipe choice, and storage and QS.
// Everything reads s.display.state, the state s.display.solution was solved from.
import {
  assignedTotal,
  bestUnlockedMark,
  D,
  getMark,
  installedAt,
  installedMachines,
  isLiveRecipe,
  itemStateTag,
  laneClassKey,
  ladderInput,
  ladderMultiplier,
  powIntNumber,
  quantumCap,
  softcap,
  storageCap,
  type Action,
  type Dec,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type RecipeId,
  type WorldState,
} from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { currentNotation, fmt } from "./notation.js";
import { className as classLabel } from "./derive.js";

type UpgradeMark = Extract<Action, { type: "UPGRADE_MARK" }>;
type BuyMachine = Extract<Action, { type: "BUY_MACHINE" }>;
type Dismantle = Extract<Action, { type: "DISMANTLE" }>;
type BuyStorage = Extract<Action, { type: "BUY_STORAGE" }>;
type BuyQs = Extract<Action, { type: "BUY_QS" }>;
type SelectRecipe = Extract<Action, { type: "SELECT_RECIPE" }>;

/** Q-4: progress to the ladder's next step, counted in machines of the best unlocked mark. */
export interface LadderProgress {
  /** Mark-weighted machine count (spec B.2). */
  input: number;
  /** The input at the next step. */
  nextAt: number;
  /** Best-mark machines to reach nextAt. */
  more: number;
  /** The ladder's multiplier now, softcapped. */
  multiplier: number;
  /** ... and at the next step. */
  nextMultiplier: number;
  /** "2 more Constructors → ×1.50" */
  text: string;
}

export interface MarkRow {
  mark: number;
  name: string;
  owned: number;
  unlocked: boolean;
  /** The reducer's own: the whole stock of this mark. null when mark+1 is missing or locked,
   * or none is owned. */
  upgrade: UpgradeMark | null;
  /** floor(owned × r_m / r_{m+1}); `to` may be 0, and then upgradeBlocked says why. */
  consolidation: { from: number; to: number; toMark: number } | null;
  /** The reducer's words, "need at least 2 to upgrade", when the consolidation is 0. */
  upgradeBlocked: string | null;
}

export interface AssignRow {
  recipeId: RecipeId;
  name: string;
  assigned: number;
  live: boolean;
  /** Has machines, and the solver runs none of them (clock ≤ 1e-9, the sim's IDLE_CLOCK). */
  idle: boolean;
  /** Live, none assigned, and its output is not FULL. */
  starved: boolean;
}

export interface MachineSection {
  lane: LaneId;
  machineClass: MachineClassId;
  className: string;
  /** The item's active recipe while it is live, else null. */
  recipeId: RecipeId | null;
  pool: number;
  unassigned: number;
  bestMark: number | null;
  marks: MarkRow[];
  ladder: LadderProgress | null;
  /** The lane-class's unlocked, selectable recipes, in authored order. */
  assign: AssignRow[];
}

export interface LevelSection<A> {
  level: number;
  maxLevel: number;
  cap: Dec;
  nextCap: Dec | null;
  /** null at maxLevel. */
  buy: A | null;
}

export interface RecipeChoice {
  recipeId: RecipeId;
  name: string;
  active: boolean;
  unlockTier: number;
  inCycle: boolean;
  /** null when active, locked, or inside a recipe cycle. */
  select: SelectRecipe | null;
}

export interface DrawerModel {
  itemId: ItemId;
  name: string;
  laneId: LaneId;
  /** The lane-class of the item's active recipe; null if the item has no producer. */
  machines: MachineSection | null;
  /** [] unless two or more recipes have the item as primaryOutput. */
  recipes: RecipeChoice[];
  storage: LevelSection<BuyStorage>;
  qs: LevelSection<BuyQs>;
}

/** The sim's IDLE_CLOCK (apps/sim/src/policies.ts). */
const IDLE_CLOCK = 1e-9;

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function activeRecipeOf(s: Snapshot, itemId: ItemId): RecipeId | undefined {
  return own(s.display.state.activeRecipe, itemId) ?? own(s.content.defaultActiveRecipe, itemId);
}

export function ladderProgress(
  s: Snapshot,
  lane: LaneId,
  machineClass: MachineClassId,
): LadderProgress | null {
  const cls = s.content.machineClasses.get(machineClass);
  const best = bestUnlockedMark(s.content, machineClass, s.display.state.tier);
  const bestDef = best === null ? undefined : getMark(s.content, machineClass, best);
  if (!cls || !bestDef) return null;
  const { interval, step } = cls.ladder;
  const input = ladderInput(s.content, s.display.state, lane, machineClass);
  const steps = Math.floor(input / interval);
  const nextAt = (steps + 1) * interval;
  const more = Math.ceil((nextAt - input) / bestDef.rateMultiplier);
  const multiplier = ladderMultiplier(s.content, s.display.state, lane, machineClass);
  const nextMultiplier = softcap(powIntNumber(step, steps + 1), s.content.bundle.softcaps.ladder);
  const text = `${more} more ${classLabel(s, machineClass, more)} → ×${fmt(D(nextMultiplier / multiplier))}`;
  return { input, nextAt, more, multiplier, nextMultiplier, text };
}

function markRows(s: Snapshot, lane: LaneId, machineClass: MachineClassId): MarkRow[] {
  const cls = s.content.machineClasses.get(machineClass);
  if (!cls) return [];
  return [...cls.marks]
    .sort((a, b) => a.mark - b.mark)
    .map((m) => {
      const owned = installedAt(s.display.state, lane, machineClass, m.mark);
      const next = getMark(s.content, machineClass, m.mark + 1);
      const canUpgrade = next !== undefined && next.unlockTier <= s.display.state.tier && owned > 0;
      const to = canUpgrade ? Math.floor((owned * m.rateMultiplier) / next.rateMultiplier) : 0;
      return {
        mark: m.mark,
        name: m.name,
        owned,
        unlocked: m.unlockTier <= s.display.state.tier,
        upgrade: canUpgrade ? { type: "UPGRADE_MARK", lane, machineClass, fromMark: m.mark } : null,
        consolidation: canUpgrade ? { from: owned, to, toMark: next.mark } : null,
        upgradeBlocked:
          canUpgrade && to < 1
            ? `need at least ${Math.ceil(next.rateMultiplier / m.rateMultiplier)} to upgrade`
            : null,
      };
    });
}

function assignRows(s: Snapshot, lane: LaneId, machineClass: MachineClassId): AssignRow[] {
  const state = s.display.state;
  const clocks = s.display.solution.clocks;
  const ids = s.content.recipesByLaneClass.get(laneClassKey(lane, machineClass)) ?? [];
  const rows: AssignRow[] = [];
  for (const recipeId of ids) {
    const recipe = s.content.recipes.get(recipeId);
    if (!recipe || recipe.inCycle || recipe.def.unlockTier > state.tier) continue;
    const assigned = own(state.assignment, recipeId) ?? 0;
    const live = isLiveRecipe(s.content, recipeId, state.tier, state.activeRecipe);
    rows.push({
      recipeId,
      name: recipe.def.name,
      assigned,
      live,
      idle: assigned > 0 && (clocks.get(recipeId) ?? 0) <= IDLE_CLOCK,
      starved:
        live &&
        assigned === 0 &&
        itemStateTag(s.content, state, recipe.primaryOutput) !== "FULL",
    });
  }
  return rows;
}

function machineSection(s: Snapshot, itemId: ItemId): MachineSection | null {
  const recipeId = activeRecipeOf(s, itemId);
  const recipe = recipeId === undefined ? undefined : s.content.recipes.get(recipeId);
  if (recipeId === undefined || !recipe) return null;
  const { lane, machineClass } = recipe;
  const pool = installedMachines(s.display.state, lane, machineClass);
  return {
    lane,
    machineClass,
    className: s.content.machineClasses.get(machineClass)?.name ?? machineClass,
    recipeId: isLiveRecipe(s.content, recipeId, s.display.state.tier, s.display.state.activeRecipe)
      ? recipeId
      : null,
    pool,
    unassigned: pool - assignedTotal(s.content, s.display.state, lane, machineClass),
    bestMark: bestUnlockedMark(s.content, machineClass, s.display.state.tier),
    marks: markRows(s, lane, machineClass),
    ladder: ladderProgress(s, lane, machineClass),
    assign: assignRows(s, lane, machineClass),
  };
}

function recipeChoices(s: Snapshot, itemId: ItemId): RecipeChoice[] {
  const ids = (s.content.producersOf.get(itemId) ?? []).filter(
    (id) => s.content.recipes.get(id)?.primaryOutput === itemId,
  );
  if (ids.length < 2) return [];
  const active = activeRecipeOf(s, itemId);
  return ids.map((recipeId) => {
    const r = s.content.recipes.get(recipeId)!;
    const isActive = recipeId === active;
    const selectable = !isActive && !r.inCycle && r.def.unlockTier <= s.display.state.tier;
    return {
      recipeId,
      name: r.def.name,
      active: isActive,
      unlockTier: r.def.unlockTier,
      inCycle: r.inCycle,
      select: selectable ? { type: "SELECT_RECIPE", itemId, recipeId } : null,
    };
  });
}

function levelSection<A>(
  level: number,
  maxLevel: number,
  capAt: (level: number) => Dec,
  buy: A,
): LevelSection<A> {
  const top = level >= maxLevel;
  return {
    level,
    maxLevel,
    cap: capAt(level),
    nextCap: top ? null : capAt(level + 1),
    buy: top ? null : buy,
  };
}

function storageSection(s: Snapshot, itemId: ItemId): LevelSection<BuyStorage> {
  const st = s.display.state;
  const at = (level: number): WorldState => ({
    ...st,
    storageLevel: Object.fromEntries([...Object.entries(st.storageLevel), [itemId, level]]),
  });
  return levelSection(
    own(st.storageLevel, itemId) ?? 0,
    s.content.bundle.storage.maxLevel,
    (level) => storageCap(s.content, at(level), itemId),
    { type: "BUY_STORAGE", itemId, levels: 1 },
  );
}

function qsSection(s: Snapshot, itemId: ItemId, lane: LaneId): LevelSection<BuyQs> {
  const st = s.display.state;
  const at = (level: number): WorldState => ({
    ...st,
    qsLevel: Object.fromEntries([...Object.entries(st.qsLevel), [lane, level]]),
  });
  return levelSection(
    own(st.qsLevel, lane) ?? 0,
    s.content.bundle.quantumStorage.maxLevel,
    (level) => quantumCap(s.content, at(level), itemId),
    { type: "BUY_QS", lane, levels: 1 },
  );
}

/** Per snapshot, then per (notation, item): the sections carry formatted text (S-11). */
const memo = new WeakMap<Snapshot, Map<string, DrawerModel>>();

export function drawerModel(s: Snapshot, itemId: ItemId): DrawerModel {
  let bySnapshot = memo.get(s);
  if (bySnapshot === undefined) {
    bySnapshot = new Map();
    memo.set(s, bySnapshot);
  }
  const key = `${currentNotation()}:${itemId}`;
  const hit = bySnapshot.get(key);
  if (hit !== undefined) return hit;
  const item = s.content.items.get(itemId);
  if (!item) throw new Error(`drawerModel: unknown item "${itemId}"`);
  const m: DrawerModel = {
    itemId,
    name: item.name,
    laneId: item.lane,
    machines: machineSection(s, itemId),
    recipes: recipeChoices(s, itemId),
    storage: storageSection(s, itemId),
    qs: qsSection(s, itemId, item.lane),
  };
  bySnapshot.set(key, m);
  return m;
}

/** BUY_MACHINE for this section, naming its recipe while that recipe is live. */
export function buyAction(sec: MachineSection, mark: number, count: number): BuyMachine {
  return {
    type: "BUY_MACHINE",
    lane: sec.lane,
    machineClass: sec.machineClass,
    mark,
    count,
    ...(sec.recipeId === null ? {} : { recipeId: sec.recipeId }),
  };
}

export function dismantleAction(sec: MachineSection, mark: number, count: number): Dismantle {
  return { type: "DISMANTLE", lane: sec.lane, machineClass: sec.machineClass, mark, count };
}

function assignedIn(sec: MachineSection, recipeId: RecipeId): number {
  return sec.assign.find((r) => r.recipeId === recipeId)?.assigned ?? 0;
}

/** One batch, donor first: ASSIGN_MACHINES sets a count and rejects an oversubscribed pool. */
export function moveMachines(
  sec: MachineSection,
  from: RecipeId,
  to: RecipeId,
  n: number,
): [Action, Action] {
  return [
    { type: "ASSIGN_MACHINES", recipeId: from, count: assignedIn(sec, from) - n },
    { type: "ASSIGN_MACHINES", recipeId: to, count: assignedIn(sec, to) + n },
  ];
}

/** The sim's idleReassignments rule, for this lane-class only: the best-ranked starved live
 * recipe, and the donor with the most machines whose clock ≤ 1e-9; n = max(1, floor(held / 2)),
 * none if n ≥ held. */
export function idleMove(
  s: Snapshot,
  sec: MachineSection,
): { from: RecipeId; to: RecipeId; n: number } | null {
  const live = sec.assign.filter((r) => r.live);
  if (live.length < 2 || sec.pool <= 0) return null;

  const rankByItem = new Map<ItemId, number>();
  s.display.state.priority.forEach((entry, index) => {
    if (entry.paused || entry.itemId === null) return;
    if (!rankByItem.has(entry.itemId)) rankByItem.set(entry.itemId, index);
  });
  const rankOf = (recipeId: RecipeId): number => {
    const recipe = s.content.recipes.get(recipeId);
    if (!recipe) return Number.POSITIVE_INFINITY;
    return rankByItem.get(recipe.primaryOutput) ?? Number.POSITIVE_INFINITY;
  };
  const byId = (a: RecipeId, b: RecipeId) => (a < b ? -1 : 1);

  const starved = live
    .filter((r) => r.starved)
    .map((r) => r.recipeId)
    .sort((a, b) => rankOf(a) - rankOf(b) || byId(a, b));
  const donor = live
    .filter((r) => r.idle)
    .sort((a, b) => b.assigned - a.assigned || byId(a.recipeId, b.recipeId))[0];
  const to = starved[0];
  if (to === undefined || donor === undefined) return null;
  const n = Math.max(1, Math.floor(donor.assigned / 2));
  if (n >= donor.assigned) return null;
  return { from: donor.recipeId, to, n };
}

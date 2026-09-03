// The engine's own view of a content bundle.
//
// Spec A.2 forbids `packages/engine` from importing `@manufactory/content`, so the
// shape is declared here instead. TypeScript's structural typing makes the content
// package's Zod-inferred `Bundle` assignable to `ContentBundle`; `apps/sim` carries
// a compile-time check that the two have not drifted.

export type LaneId = string;
export type ItemId = string;
export type RecipeId = string;
export type MachineClassId = string;

/**
 * Synthetic item representing one megawatt-second of grid generation.
 *
 * Spec C.4 makes power an ordinary priority entry so generators get first call on
 * fuel and the death spiral cannot start on its own. Modelling generation as an item
 * that generator recipes produce means the waterfall needs no power special case at
 * all. It is never stored and never appears in `stockItemIds`.
 */
export const POWER_ITEM: ItemId = "__power__";

export interface LadderDef {
  step: number;
  interval: number;
}

export interface CostEntryDef {
  item: ItemId;
  amount: number;
}

export interface MarkDef {
  mark: number;
  name: string;
  rateMultiplier: number;
  buildCostMultiplier: number;
  powerDraw: number;
  buildCost: CostEntryDef[];
  unlockTier: number;
}

export interface MachineClassDef {
  id: MachineClassId;
  name: string;
  ladder: LadderDef;
  costRatio: number;
  marks: MarkDef[];
}

export interface RecipePartDef {
  item: ItemId;
  /** Exact rational string, per minute, per machine-unit. Parsed at index time. */
  rate: string;
  byproduct: boolean;
}

export interface RecipeDef {
  id: RecipeId;
  name: string;
  lane: LaneId;
  machineClass: MachineClassId;
  inputs: RecipePartDef[];
  outputs: RecipePartDef[];
  /** Megawatts produced per machine-unit at clock 1. Generators only. */
  powerOutput: number;
  isAlternate: boolean;
  unlockTier: number;
}

export interface LaneDef {
  id: LaneId;
  name: string;
  order: number;
  unlockTier: number;
}

export interface ItemDef {
  id: ItemId;
  lane: LaneId;
  tier: number;
  name: string;
  fluid: boolean;
  terminal: boolean;
  baseStorageCap: number;
  baseQuantumCap: number;
  icon?: string | undefined;
}

export interface StorageCurveDef {
  capGrowth: number;
  costGrowth: number;
  baseCostItem: ItemId | null;
  baseCostAmount: number;
  maxLevel: number;
}

export interface SoftcapDef {
  threshold: number;
  slope: number;
}

export interface SoftcapsDef {
  ladder: SoftcapDef;
  lane: SoftcapDef;
  tap: SoftcapDef;
  product: SoftcapDef;
}

export interface TapDef {
  kickPerStack: number;
  durationSeconds: number;
  maxStacks: number;
  powerInjectionMw: number;
}

export interface MilestoneDef {
  tier: number;
  name: string;
  requires: CostEntryDef[];
  laneMultipliers: Record<LaneId, number>;
}

export interface StartDef {
  tier: number;
  machines: { lane: LaneId; machineClass: MachineClassId; mark: number; count: number }[];
  assignments: Record<RecipeId, number>;
  priority: ItemId[];
}

export interface PacingDef {
  targetCollectionsToTier: number[];
  activeHoursPerDay: number;
  offlineCollectionsPerDay: number;
  purchaseIntervalEarlySeconds: number;
  purchaseIntervalLateSeconds: number;
  storageBindingCadence: number;
}

export interface ContentBundle {
  version: string;
  lanes: LaneDef[];
  items: ItemDef[];
  machineClasses: MachineClassDef[];
  recipes: RecipeDef[];
  storage: StorageCurveDef;
  quantumStorage: StorageCurveDef;
  softcaps: SoftcapsDef;
  tap: TapDef;
  milestones: MilestoneDef[];
  start: StartDef;
  baseGridCapacityMw: number;
  offlineCapHours: number;
  pacing: PacingDef;
}

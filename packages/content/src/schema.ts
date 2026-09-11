// The authored shape of a content bundle. Spec B.1: the graph and the pacing
// intent are hand-authored; cost ratios, storage curves, and milestone
// requirements are solved by the calibration script and arrive in the `derived`
// block at the bottom of this file, which `loadBundleDir` lays over the authored
// values. The authored fields they replace are still present and still required --
// a bundle has to load and validate before it can be calibrated at all -- but on a
// calibrated bundle they are seeds, not the numbers the game runs on.
import { z } from "zod";
import { isPositive, parseRational } from "@manufactory/rational";

const Id = z.string().min(1);
const Tier = z.number().int().min(0);

// Rates are exact rationals (spec A.4 zone 1), authored as either a decimal
// ("11.25") or a fraction ("45/4"), and parsed with @manufactory/rational at
// load time. They are never floats. The regex alone would also accept
// "5/0" (zero denominator) and "0" (zero rate) — neither is a rate anything
// downstream can use, so a division-by-zero would otherwise first surface
// deep inside Phase 1's expansion-vector code instead of here. The refine
// below closes that: it parses with the real parser (proving the dependency
// declared in package.json is actually load-bearing) and requires the
// result be strictly positive.
const Rate = z
  .string()
  .regex(/^\d+\/\d+$|^\d+(\.\d+)?$/, "rate must be a decimal or a fraction, not both")
  .refine(
    (value) => {
      try {
        return isPositive(parseRational(value));
      } catch {
        return false;
      }
    },
    { message: "rate must parse to a positive exact rational (zero and \"n/0\" are not rates)" },
  );

export const LaneSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    order: z.number().int(),
    unlockTier: Tier,
  })
  .strict();

export const ItemSchema = z
  .object({
    id: Id,
    lane: Id,
    tier: Tier,
    name: z.string().min(1),
    fluid: z.boolean().default(false),
    // `terminal` marks an item that legitimately has no consumer recipe because
    // it is delivered or sunk. Without it, validator check 4 would flag every
    // end product as a dead end.
    terminal: z.boolean().default(false),
    baseStorageCap: z.number().positive(),
    baseQuantumCap: z.number().positive(),
    icon: z.string().optional(),
  })
  .strict();

export const CostEntrySchema = z.object({ item: Id, amount: z.number().positive() }).strict();

export const MarkSchema = z
  .object({
    mark: z.number().int().min(1),
    name: z.string().min(1),
    // Spec C.0: when buildCostMultiplier equals rateMultiplier, a mark is exactly
    // pace-neutral across a tier cycle. Set it lower to make the game accelerate.
    rateMultiplier: z.number().positive(),
    buildCostMultiplier: z.number().positive(),
    powerDraw: z.number().nonnegative(),
    buildCost: z.array(CostEntrySchema).min(1),
    unlockTier: Tier,
  })
  .strict();

// Spec B.3: authored, not derived, because it is a feel decision. Default is
// x1.5 every 10 machines, which holds the pace sawtooth under 1.6x.
export const LadderSchema = z
  .object({
    step: z.number().gt(1),
    interval: z.number().int().positive(),
  })
  .strict();

export const MachineClassSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    ladder: LadderSchema,
    // Spec B.4: `r` is derived by the calibration script. Cost(n) = base * r^n, and
    // n is always an integer, so it is evaluated by exponentiation by squaring
    // (spec E.4). The default is spec D3's stated 1.09.
    costRatio: z.number().gt(1).default(1.09),
    // Spec D3's authoring inversion: you author the ladder (a feel decision) and
    // `rEff` (a pacing decision), and calibration derives r = rEff * m where
    // m = step^(1/interval). Retuning the ladder because it feels better then
    // changes pacing by exactly zero. Optional because a bundle that authors `r`
    // directly is still legal -- the fixture does, and its numbers are hand-verified
    // by tests -- but content meant to be calibrated should author this instead.
    //
    // > 1 is D3's runaway floor: at rEff <= 1 machine count grows linearly or faster
    // and production explodes, which check 8 exists to prevent.
    rEff: z.number().gt(1).optional(),
    marks: z.array(MarkSchema).min(1),
  })
  .strict();

export const RecipePartSchema = z
  .object({
    item: Id,
    rate: Rate,
    byproduct: z.boolean().default(false),
  })
  .strict();

export const RecipeSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    lane: Id,
    machineClass: Id,
    inputs: z.array(RecipePartSchema),
    outputs: z.array(RecipePartSchema),
    // Generators are ordinary recipes that consume fuel items and emit power
    // (spec section 6.3), so they carry powerOutput and usually no item outputs.
    powerOutput: z.number().nonnegative().default(0),
    isAlternate: z.boolean().default(false),
    unlockTier: Tier,
  })
  .strict();

export const PacingSchema = z
  .object({
    targetCollectionsToTier: z.array(z.number().positive()).min(1),
    activeHoursPerDay: z.number().positive(),
    offlineCollectionsPerDay: z.number().positive(),
    purchaseIntervalEarlySeconds: z.number().positive(),
    purchaseIntervalLateSeconds: z.number().positive(),
    storageBindingCadence: z.number().int().positive(),
  })
  .strict();

// Spec B.4. Storage cap = baseStorageCap * capGrowth^level; a level costs
// baseCostAmount * costGrowth^level of baseCostItem. Quantum Storage uses the same
// shape but is scoped per lane, not per item, so one purchase lifts every item in
// the lane. `s`, `sc`, `q` and the QS cost curve are all derived by Phase 2's
// calibration; these are authored placeholders.
//
// baseCostItem is nullable because a schema-level default cannot name an item that
// exists in every bundle. null means levels are free — only the fixture and
// calibrated content set a real item.
export const StorageCurveSchema = z
  .object({
    capGrowth: z.number().gt(1),
    costGrowth: z.number().gt(1),
    baseCostItem: Id.nullable(),
    baseCostAmount: z.number().positive(),
    maxLevel: z.number().int().positive(),
  })
  .strict();

// Spec D3: softcaps are piecewise-linear, not a power law, for the determinism
// reason in spec E.4. Above `threshold`, each further unit of multiplier counts for
// `slope` units. slope must be in (0, 1]: 0 would hard-cap (spec 16.6 forbids it)
// and > 1 would amplify.
export const SoftcapSchema = z
  .object({
    threshold: z.number().positive(),
    slope: z.number().gt(0).max(1),
  })
  .strict();

export const SoftcapsSchema = z
  .object({
    ladder: SoftcapSchema,
    lane: SoftcapSchema,
    tap: SoftcapSchema,
    product: SoftcapSchema,
  })
  .strict();

// Spec C.6: the kick is a step function, not a decaying curve, because continuously
// varying rates would break the piecewise-constant assumption the event model rests
// on. Stacks share one expiry timer.
export const TapSchema = z
  .object({
    kickPerStack: z.number().positive(),
    durationSeconds: z.number().positive(),
    maxStacks: z.number().int().positive(),
    powerInjectionMw: z.number().nonnegative(),
  })
  .strict();

// Spec 10.1 and ruling R7. Requirements are paid from liquid stock (stored +
// quantum); `bound` is never touched, which is what keeps storage caps a real gate
// on milestones (spec D4).
export const MilestoneSchema = z
  .object({
    tier: z.number().int().min(1),
    name: z.string().min(1),
    requires: z.array(CostEntrySchema).min(1),
    // Spec D3 lever 3: a discrete, roughly x1.5 lane-wide multiplier granted on unlock.
    laneMultipliers: z.record(Id, z.number().positive()).default({}),
  })
  .strict();

export const StartSchema = z
  .object({
    tier: z.number().int().min(0),
    machines: z
      .array(
        z
          .object({
            lane: Id,
            machineClass: Id,
            mark: z.number().int().min(1),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .default([]),
    assignments: z.record(Id, z.number().int().nonnegative()).default({}),
    priority: z.array(Id).default([]),
  })
  .strict();


// What the calibration script solved for (spec B.7), emitted as a generated file
// alongside the authored ones and laid over them at load time by `applyDerived`.
//
// Every field is optional and every entry is a patch, not a replacement: a run that
// solves only milestone amounts must not silently reset a storage curve it never
// looked at. `loadBundleDir` rejects a patch that names something the bundle does
// not have, because that means the content was re-authored after the calibration run
// and the numbers no longer describe it.
const DerivedMachineClassSchema = z
  .object({ id: Id, costRatio: z.number().gt(1) })
  .strict();

const DerivedMilestoneSchema = z
  .object({ tier: z.number().int().min(1), requires: z.array(CostEntrySchema).min(1) })
  .strict();

const DerivedStorageCurveSchema = StorageCurveSchema.partial().strict();

// Provenance. These are not inputs to the game -- nothing reads them at runtime --
// they are the reviewable claim the calibration run is making: here is what I was
// aiming at, here is what these numbers actually measured, run this policy on this
// seed to check me. A calibrated bundle whose observed column has drifted from its
// target column is visibly stale without anyone having to re-run anything.
export const CalibrationRunSchema = z
  .object({
    calibratedAt: z.string().min(1),
    policy: z.string().min(1),
    seed: z.number().int(),
    targetCollectionsToTier: z.array(z.number().positive()),
    observedCollectionsToTier: z.array(z.number().nonnegative().nullable()),
    observedStorageBindingCadence: z.number().nonnegative().nullable().optional(),
  })
  .strict();

export const DerivedSchema = z
  .object({
    run: CalibrationRunSchema.optional(),
    machineClasses: z.array(DerivedMachineClassSchema).optional(),
    milestones: z.array(DerivedMilestoneSchema).optional(),
    storage: DerivedStorageCurveSchema.optional(),
    quantumStorage: DerivedStorageCurveSchema.optional(),
  })
  .strict();

export const BundleSchema = z
  .object({
    version: z.string().min(1),
    lanes: z.array(LaneSchema).min(1),
    items: z.array(ItemSchema).min(1),
    machineClasses: z.array(MachineClassSchema).min(1),
    recipes: z.array(RecipeSchema).min(1),
    storage: StorageCurveSchema.default({
      capGrowth: 1.6,
      costGrowth: 2,
      baseCostItem: null,
      baseCostAmount: 50,
      maxLevel: 20,
    }),
    quantumStorage: StorageCurveSchema.default({
      capGrowth: 1.6,
      costGrowth: 2.5,
      baseCostItem: null,
      baseCostAmount: 500,
      maxLevel: 15,
    }),
    softcaps: SoftcapsSchema.default({
      ladder: { threshold: 1000, slope: 0.25 },
      lane: { threshold: 50, slope: 0.25 },
      tap: { threshold: 2, slope: 0.25 },
      product: { threshold: 5000, slope: 0.2 },
    }),
    tap: TapSchema.default({
      kickPerStack: 0.05,
      durationSeconds: 30,
      maxStacks: 10,
      powerInjectionMw: 25,
    }),
    milestones: z.array(MilestoneSchema).default([]),
    start: StartSchema.default({ tier: 0, machines: [], assignments: {}, priority: [] }),
    // Spec 3.2: the HUB equivalent supplies a starting power allowance, so a fresh
    // world is not stalled at powerRatio 0 before any generator is unlocked.
    baseGridCapacityMw: z.number().nonnegative().default(0),
    // Spec section 8: the offline accrual cap, default 8h.
    offlineCapHours: z.number().positive().default(8),
    pacing: PacingSchema,
    derived: DerivedSchema.optional(),
  })
  .strict();

export type Lane = z.infer<typeof LaneSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type CostEntry = z.infer<typeof CostEntrySchema>;
export type Mark = z.infer<typeof MarkSchema>;
export type Ladder = z.infer<typeof LadderSchema>;
export type MachineClass = z.infer<typeof MachineClassSchema>;
export type RecipePart = z.infer<typeof RecipePartSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type Pacing = z.infer<typeof PacingSchema>;
export type StorageCurve = z.infer<typeof StorageCurveSchema>;
export type Softcap = z.infer<typeof SoftcapSchema>;
export type Softcaps = z.infer<typeof SoftcapsSchema>;
export type TapConfig = z.infer<typeof TapSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type StartState = z.infer<typeof StartSchema>;
export type Derived = z.infer<typeof DerivedSchema>;
export type CalibrationRun = z.infer<typeof CalibrationRunSchema>;
export type Bundle = z.infer<typeof BundleSchema>;

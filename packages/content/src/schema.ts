// The authored shape of a content bundle. Spec B.1: the graph and the pacing
// intent are hand-authored; cost ratios, storage curves, and milestone
// requirements are derived by the calibration script in Phase 2 and land in a
// separate `derived` block, so they are deliberately absent here.
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

export const BundleSchema = z
  .object({
    version: z.string().min(1),
    lanes: z.array(LaneSchema).min(1),
    items: z.array(ItemSchema).min(1),
    machineClasses: z.array(MachineClassSchema).min(1),
    recipes: z.array(RecipeSchema).min(1),
    pacing: PacingSchema,
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
export type Bundle = z.infer<typeof BundleSchema>;

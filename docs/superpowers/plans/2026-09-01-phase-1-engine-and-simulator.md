# Phase 1 — Engine and Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete engine core — graph precompute, economy, storage tiers, solver, power, event-driven resolution, and the eleven action reducers — and the simulator on top of it, ending in a playable game in the terminal.

**Architecture:** `packages/engine` stays pure: it declares its own structural content types so it never imports `@manufactory/content`, and every numeric zone stays in its lane — exact BigInt rationals only in the load-time graph precompute, `float64` for clocks/allocation/rates, `Decimal` for stockpiles and costs. The solver is a demand-pull waterfall over a priority list, wrapped in an inner item-state fixed point and an outer power equilibrium. `resolve` integrates straight lines between discrete events. `apps/sim` is a separate workspace package that may use Node builtins freely and drives the identical reducers the HTTP API will call in Phase 3.

**Tech Stack:** Node 22 LTS, TypeScript 5.6 strict, pnpm 10, Turborepo 2, vitest 4, fast-check 3, break_infinity.js, `@manufactory/rational`, Ink 5 + React 18 (simulator only).

**Spec:** `docs/superpowers/specs/2026-09-01-engine-core-design.md`

**Predecessor plan:** `docs/superpowers/plans/2026-09-01-phase-0-foundations.md` — read it for what already exists. Do not re-plan any of it.

## Global Constraints

- **Runtime:** Node 22 LTS. TypeScript `strict: true` plus `noUncheckedIndexedAccess`. (Spec A.5)
- **License:** Everything is GPL-3.0. (Spec D2)
- **Engine purity:** `packages/engine/src/**` may import only `@manufactory/rational`, `break_infinity.js`, and its own relative modules. No `Date.now()`, no `Math.random`, no `fetch`, no filesystem, and **no `@manufactory/content`**. Enforced by the ESLint rule from Phase 0 Task 4, which ignores `packages/engine/**/*.test.ts` (Phase 0 ruling R2) — so engine *test* files may import `@manufactory/content` and `node:*`. (Spec A.2, A.5)
- **`apps/sim` is exempt.** It is a separate workspace package and may import Node builtins, `@manufactory/content`, Ink, and React freely.
- **Numeric zones (spec A.4):** BigInt rationals live *only* inside the graph precompute (Task 3) and are converted to `float64` at its boundary. Clocks, satisfaction, allocation fractions, and per-second rates are `float64`. Stockpiles, build costs, and lifetime totals are `Decimal`. **A `Decimal` never enters a solve; a `Rational` never leaves the precompute.**
- **Determinism (spec A.5, E.4):** No `Math.pow`, `Math.exp`, or `Math.log` in any state-affecting path. Cost curves use integer exponentiation by squaring (`n` is always an integer). Softcaps are piecewise-linear, never a power law. The ladder multiplier is `step^floor(n / interval)` — a *stepped* integer exponent, per spec B.3. `packages/engine/src/numbers/format.ts` already uses `Math.pow`; it is display-only and exempt. **Do not copy that pattern into `economy/`.**
- **Module system:** ESM throughout. Workspace packages are source-only (`"main": "./src/index.ts"`).
- **Test runner:** vitest. Every task ends with tests passing and a commit.
- **Commit trailer:** every commit message ends with the two lines shown in each task's commit step.

## Scope

Phase 1 of the five-phase build order in spec F.2. It ends when `sim play` can run the fixture factory, buy machines, reorder priorities, warp time forward and produce sane numbers, and when `sim run` reports time-to-tier under all four policies.

**Explicitly not in Phase 1:** the HTTP API, Postgres, auth, the web client (Phases 3–4); the calibrated B.5 vertical slice and validator checks 8–10 (Phase 2 — Phase 1 uses and extends the Phase 0 fixture bundle); overclocking (spec D3 lever 4 — it has no action in spec D.1's set); Power Storage purchase (spec 6.2 — likewise no action in D.1, so `powerBank` is carried in state and serialization but stays zero); disruptions and pollution (Spec 2).

## Controller rulings

These resolve genuine ambiguities in the spec. They are binding. Each task that depends on one restates it.

**Ruling R5 — machine capacity is pooled per `(lane, machineClass)` and distributed proportionally.**
Original spec section 4.2 computes `capacity[R] = machineCount[R] × baseRate[R]` as though machines are owned per-recipe, while spec B.2 scopes the cost counter and the ladder to `(lane, class, mark)`. Both cannot be true. Resolution:

```
installedMachines[lane][class] = Σ_mark installed[lane][class][mark]
installedUnits[lane][class]    = Σ_mark installed[lane][class][mark] × rateMultiplier(mark)
assignedFraction[R]            = assignment[R] / installedMachines[lane][class]
capacityUnits[R] = assignedFraction[R] × installedUnits[lane][class] × multipliers[R]
```

The player buys machines into a lane-class and assigns integer counts of them to recipes. Marks are fungible and pooled, so the engine never tracks which physical mark runs which recipe, and a mark upgrade automatically lifts every recipe in the lane-class. Assignment across a lane-class must never exceed `installedMachines`; unassigned machines are idle and draw no power. This keeps spec pillar 3 (no management surface) intact.

**Ruling R6 — cyclic recipes are forbidden in Phase 1, not solved.**
Spec section 4.3 explicitly permits this ("v1 may forbid cyclic recipes entirely and flag them as unselectable") and spec 17.2 leaves it open. Phase 0's validator already detects cycles via Tarjan SCC. Phase 1 marks every recipe inside a non-trivial SCC unselectable, reports it, and excludes it from the solve. The outer waterfall does not change when SCC support is added later. **This ruling is load-bearing for Task 9:** because the live recipe graph is a DAG, the FULL-backpressure constraint can be discharged exactly by a single reverse-topological throttle sweep instead of a damped iteration.

**Ruling R7 — tier progression is milestone delivery, resolved automatically inside `resolve`.**
Spec F.2 puts milestones in Phase 1 and `sim run` must report time-to-tier, but spec D.1's action set has exactly eleven actions and none of them is `DELIVER`. Deliveries and contracts as a *player-facing* surface belong to Spec 2. Resolution: a milestone is content (`milestones[]`, authored in Task 1, calibrated in Phase 2). When the next tier's requirement is satisfiable from **liquid** stock (`stored + quantum`, never `bound`), `resolve` spends it through the liquid spend order and advances `state.tier`, recording a `milestone` event. This keeps the action set at eleven and — critically — preserves spec D4's reasoning, because storage and Quantum Storage caps still gate whether a milestone can ever be banked, exactly as the D4 exploit narrative requires.

**Ruling R8 — `reserve[itemId] = p` becomes a synthetic priority entry.**
Spec 3.3 and 4.1 say a reserve "diverts that share of production to storage even when downstream demand exists," but do not say where in the waterfall it sits. Resolution: for each item with `reserve > 0`, the solver injects a synthetic `guaranteed` entry with `targetRate = p × (unconstrained production rate of that item at full clock)`, placed immediately after the power entry. `percent` is clamped to `[0, 0.5]` by `SET_RESERVE` so a reserve can never starve the list. Nothing consumes the reserved output, so it banks — which is exactly the stated intent — and the waterfall needs no new machinery.

## File Structure

| File | Responsibility |
|---|---|
| `packages/content/src/schema.ts` | **Modified** — adds `costRatio`, `storage`, `quantumStorage`, `softcaps`, `tap`, `milestones`, `start`, `baseGridCapacityMw`, `offlineCapHours` |
| `packages/content/src/load.ts` | **Modified** — `checkReferences` covers the new blocks |
| `packages/content/bundles/fixture/*.yaml` | **Modified/added** — real values for the new blocks |
| `packages/engine/src/content/types.ts` | Engine-side structural content types; no import of `@manufactory/content` |
| `packages/engine/src/content/index.ts` | Sub-barrel |
| `packages/engine/src/graph/index-content.ts` | `indexContent` — id maps, per-second rates, liveness, SCC exclusion, topological order |
| `packages/engine/src/graph/expand.ts` | Per-unit expansion vectors and raw-cost traces — the only rational code |
| `packages/engine/src/graph/index.ts` | Sub-barrel |
| `packages/engine/src/state/prng.ts` | xoshiro128** seeded PRNG, integer ops only |
| `packages/engine/src/state/world.ts` | `WorldState`, accessors, `initialWorld` |
| `packages/engine/src/state/serialize.ts` | Canonical JSON serialization |
| `packages/engine/src/state/index.ts` | Sub-barrel |
| `packages/engine/src/economy/curves.ts` | Integer exponentiation, cost curves, ladder, softcaps, level costs |
| `packages/engine/src/economy/capacity.ts` | R5 pooling, multiplier stack, power draw |
| `packages/engine/src/economy/storage.ts` | Caps, the three tiers, fill and spend orders |
| `packages/engine/src/economy/index.ts` | Sub-barrel |
| `packages/engine/src/solve/waterfall.ts` | Requirement vectors, the waterfall, reserve floor, bottleneck |
| `packages/engine/src/solve/fixpoint.ts` | Item states, FULL throttle sweep, EMPTY pin fixed point |
| `packages/engine/src/solve/power.ts` | Grid equilibrium |
| `packages/engine/src/solve/index.ts` | `solve` entry point + sub-barrel |
| `packages/engine/src/resolve/index.ts` | Event-driven time advancement, timers, milestones, summary |
| `packages/engine/src/actions/types.ts` | `Action`, `Effect`, `ApplyResult` |
| `packages/engine/src/actions/machines.ts` | Reducers 1–5 |
| `packages/engine/src/actions/economy.ts` | Reducers 6–11 |
| `packages/engine/src/actions/index.ts` | `apply`, `applyBatch`, sub-barrel |
| `packages/engine/src/properties.test.ts` | Spec E.6 property suite |
| `packages/engine/src/fuzz.test.ts` | Random-state fuzzer |
| `apps/sim/src/bootstrap.ts` | Bundle load → indexed content → initial world |
| `apps/sim/src/policies/*.ts` | `optimal`, `greedy`, `casual`, `bottleneck` |
| `apps/sim/src/run.ts` | Batch runner + report |
| `apps/sim/src/play.tsx` | Ink terminal client |
| `apps/sim/src/commands.ts` | `sim play` command parser and `assert` grammar |
| `apps/sim/src/bin.ts` | CLI entry |

---

### Task 1: Content schema extensions and fixture values

**Files:**
- Modify: `packages/content/src/schema.ts`
- Modify: `packages/content/src/load.ts` (the `checkReferences` function)
- Modify: `packages/content/src/validate/graph.test.ts` (its hand-built `Bundle` literal)
- Modify: `packages/content/bundles/fixture/machines.yaml`
- Create: `packages/content/bundles/fixture/curves.yaml`, `packages/content/bundles/fixture/milestones.yaml`, `packages/content/bundles/fixture/start.yaml`
- Test: `packages/content/src/schema.phase1.test.ts`, `packages/content/src/load.phase1.test.ts`

**Interfaces:**
- Consumes: from `@manufactory/content` (Phase 0): `BundleSchema`, `type Bundle`, `CostEntrySchema`, `loadBundleDir(dir: string): Bundle`, `checkReferences(bundle: Bundle): ValidationIssue[]`, `type ValidationIssue = { check: number; severity: "error"; message: string }`, `validateBundle(bundle: Bundle): ValidationIssue[]`
- Produces: `Bundle` gains these **output-required, input-optional** fields (every one has a `.default()`, so every bundle authored in Phase 0 still parses):
  - `MachineClassSchema` gains `costRatio: number` (default `1.09`)
  - `storage: StorageCurve`, `quantumStorage: StorageCurve` where `StorageCurve = { capGrowth: number; costGrowth: number; baseCostItem: string | null; baseCostAmount: number; maxLevel: number }`
  - `softcaps: { ladder: Softcap; lane: Softcap; tap: Softcap; product: Softcap }` where `Softcap = { threshold: number; slope: number }`
  - `tap: { kickPerStack: number; durationSeconds: number; maxStacks: number; powerInjectionMw: number }`
  - `milestones: { tier: number; name: string; requires: CostEntry[]; laneMultipliers: Record<string, number> }[]` (default `[]`)
  - `start: { tier: number; machines: { lane: string; machineClass: string; mark: number; count: number }[]; assignments: Record<string, number>; priority: string[] }` (default all-empty)
  - `baseGridCapacityMw: number` (default `0`), `offlineCapHours: number` (default `8`)
  - `checkReferences` additionally validates milestone item and lane ids, `storage.baseCostItem`, `quantumStorage.baseCostItem`, and every id in `start`

Rationale for defaults rather than required fields: Phase 0's `schema.test.ts` and `load.test.ts` build minimal bundles that omit these blocks. `.default()` keeps the *input* type optional (those tests keep passing) while making the *output* type required (the engine can rely on the fields existing). Only `graph.test.ts`, which builds a `Bundle` value literal against the output type, needs updating.

`baseCostItem` is nullable because the schema-level default cannot name an item that exists in every bundle. `null` means a storage level costs nothing; the fixture and Phase 2's calibrated content both set a real item.

- [ ] **Step 1: Write the failing schema test**

`packages/content/src/schema.phase1.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BundleSchema } from "./schema.js";

const minimal = {
  version: "fixture.v1",
  lanes: [{ id: "iron", name: "Iron", order: 0, unlockTier: 0 }],
  items: [
    { id: "iron_ore", lane: "iron", tier: 0, name: "Iron Ore", baseStorageCap: 600, baseQuantumCap: 2400 },
  ],
  machineClasses: [
    {
      id: "miner",
      name: "Miner",
      ladder: { step: 1.5, interval: 10 },
      marks: [
        {
          mark: 1,
          name: "Miner Mk.1",
          rateMultiplier: 1,
          buildCostMultiplier: 1,
          powerDraw: 5,
          buildCost: [{ item: "iron_ore", amount: 10 }],
          unlockTier: 0,
        },
      ],
    },
  ],
  recipes: [
    {
      id: "mine_iron",
      name: "Iron Ore",
      lane: "iron",
      machineClass: "miner",
      inputs: [],
      outputs: [{ item: "iron_ore", rate: "60" }],
      unlockTier: 0,
    },
  ],
  pacing: {
    targetCollectionsToTier: [2, 5],
    activeHoursPerDay: 2.5,
    offlineCollectionsPerDay: 3,
    purchaseIntervalEarlySeconds: 120,
    purchaseIntervalLateSeconds: 1800,
    storageBindingCadence: 12,
  },
};

describe("Phase 1 bundle fields", () => {
  it("still accepts a Phase 0 bundle and fills every new field", () => {
    const parsed = BundleSchema.parse(minimal);
    expect(parsed.machineClasses[0]!.costRatio).toBe(1.09);
    expect(parsed.storage.capGrowth).toBe(1.6);
    expect(parsed.storage.baseCostItem).toBeNull();
    expect(parsed.quantumStorage.maxLevel).toBe(15);
    expect(parsed.softcaps.product.slope).toBe(0.2);
    expect(parsed.tap.maxStacks).toBe(10);
    expect(parsed.milestones).toEqual([]);
    expect(parsed.start).toEqual({ tier: 0, machines: [], assignments: {}, priority: [] });
    expect(parsed.baseGridCapacityMw).toBe(0);
    expect(parsed.offlineCapHours).toBe(8);
  });

  it("accepts authored values for every new field", () => {
    const parsed = BundleSchema.parse({
      ...minimal,
      machineClasses: [{ ...minimal.machineClasses[0]!, costRatio: 1.12 }],
      storage: {
        capGrowth: 1.5,
        costGrowth: 2,
        baseCostItem: "iron_ore",
        baseCostAmount: 50,
        maxLevel: 20,
      },
      milestones: [
        { tier: 1, name: "First", requires: [{ item: "iron_ore", amount: 200 }], laneMultipliers: { iron: 1.5 } },
      ],
      start: {
        tier: 0,
        machines: [{ lane: "iron", machineClass: "miner", mark: 1, count: 1 }],
        assignments: { mine_iron: 1 },
        priority: ["iron_ore"],
      },
      baseGridCapacityMw: 200,
      offlineCapHours: 8,
    });
    expect(parsed.machineClasses[0]!.costRatio).toBe(1.12);
    expect(parsed.milestones[0]!.laneMultipliers.iron).toBe(1.5);
    expect(parsed.start.machines[0]!.count).toBe(1);
    expect(parsed.baseGridCapacityMw).toBe(200);
  });

  it("rejects a cost ratio at or below 1 — r must exceed 1 or costs never inflate", () => {
    expect(() =>
      BundleSchema.parse({ ...minimal, machineClasses: [{ ...minimal.machineClasses[0]!, costRatio: 1 }] }),
    ).toThrow();
  });

  it("rejects a softcap slope outside (0, 1] — a softcap must slow growth, not stop or amplify it", () => {
    expect(() =>
      BundleSchema.parse({
        ...minimal,
        softcaps: {
          ladder: { threshold: 1000, slope: 0 },
          lane: { threshold: 50, slope: 0.25 },
          tap: { threshold: 2, slope: 0.25 },
          product: { threshold: 5000, slope: 0.2 },
        },
      }),
    ).toThrow();
  });

  it("rejects a milestone tier below 1 — tier 0 is the starting state, never delivered", () => {
    expect(() =>
      BundleSchema.parse({
        ...minimal,
        milestones: [{ tier: 0, name: "Bad", requires: [{ item: "iron_ore", amount: 1 }], laneMultipliers: {} }],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/content test schema.phase1`
Expected: FAIL — `parsed.machineClasses[0].costRatio` is `undefined`.

- [ ] **Step 3: Extend the schema**

In `packages/content/src/schema.ts`, add `costRatio` to `MachineClassSchema` (insert immediately after `ladder`):

```ts
export const MachineClassSchema = z.object({
  id: Id,
  name: z.string().min(1),
  ladder: LadderSchema,
  // Spec B.4: `r` is derived by the Phase 2 calibration script. Until then it is
  // authored, defaulting to spec D3's stated 1.09. Cost(n) = base * r^n, and n is
  // always an integer, so it is evaluated by exponentiation by squaring (spec E.4).
  costRatio: z.number().gt(1).default(1.09),
  marks: z.array(MarkSchema).min(1),
});
```

Then append these schemas immediately before `BundleSchema`:

```ts
// Spec B.4. Storage cap = baseStorageCap * capGrowth^level; a level costs
// baseCostAmount * costGrowth^level of baseCostItem. Quantum Storage uses the same
// shape but is scoped per lane, not per item, so one purchase lifts every item in
// the lane. `s`, `sc`, `q` and the QS cost curve are all derived by Phase 2's
// calibration; these are authored placeholders.
//
// baseCostItem is nullable because a schema-level default cannot name an item that
// exists in every bundle. null means levels are free — only the fixture and
// calibrated content set a real item.
export const StorageCurveSchema = z.object({
  capGrowth: z.number().gt(1),
  costGrowth: z.number().gt(1),
  baseCostItem: Id.nullable(),
  baseCostAmount: z.number().positive(),
  maxLevel: z.number().int().positive(),
});

// Spec D3: softcaps are piecewise-linear, not a power law, for the determinism
// reason in spec E.4. Above `threshold`, each further unit of multiplier counts for
// `slope` units. slope must be in (0, 1]: 0 would hard-cap (spec 16.6 forbids it)
// and > 1 would amplify.
export const SoftcapSchema = z.object({
  threshold: z.number().positive(),
  slope: z.number().gt(0).max(1),
});

export const SoftcapsSchema = z.object({
  ladder: SoftcapSchema,
  lane: SoftcapSchema,
  tap: SoftcapSchema,
  product: SoftcapSchema,
});

// Spec C.6: the kick is a step function, not a decaying curve, because continuously
// varying rates would break the piecewise-constant assumption the event model rests
// on. Stacks share one expiry timer.
export const TapSchema = z.object({
  kickPerStack: z.number().positive(),
  durationSeconds: z.number().positive(),
  maxStacks: z.number().int().positive(),
  powerInjectionMw: z.number().nonnegative(),
});

// Spec 10.1 and ruling R7. Requirements are paid from liquid stock (stored +
// quantum); `bound` is never touched, which is what keeps storage caps a real gate
// on milestones (spec D4).
export const MilestoneSchema = z.object({
  tier: z.number().int().min(1),
  name: z.string().min(1),
  requires: z.array(CostEntrySchema).min(1),
  // Spec D3 lever 3: a discrete, roughly x1.5 lane-wide multiplier granted on unlock.
  laneMultipliers: z.record(Id, z.number().positive()).default({}),
});

export const StartSchema = z.object({
  tier: z.number().int().min(0),
  machines: z
    .array(
      z.object({
        lane: Id,
        machineClass: Id,
        mark: z.number().int().min(1),
        count: z.number().int().positive(),
      }),
    )
    .default([]),
  assignments: z.record(Id, z.number().int().nonnegative()).default({}),
  priority: z.array(Id).default([]),
});
```

Then extend `BundleSchema`:

```ts
export const BundleSchema = z.object({
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
});
```

And add the inferred types beside the existing ones:

```ts
export type StorageCurve = z.infer<typeof StorageCurveSchema>;
export type Softcap = z.infer<typeof SoftcapSchema>;
export type Softcaps = z.infer<typeof SoftcapsSchema>;
export type TapConfig = z.infer<typeof TapSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type StartState = z.infer<typeof StartSchema>;
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `pnpm --filter @manufactory/content test schema.phase1`
Expected: PASS.

- [ ] **Step 5: Write the failing reference-check test**

`packages/content/src/load.phase1.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReferences, loadBundleDir } from "./load.js";
import { validateBundle } from "./validate/index.js";

const fixtureDir = fileURLToPath(new URL("../bundles/fixture", import.meta.url));

describe("checkReferences over the Phase 1 blocks", () => {
  it("passes on the fixture", () => {
    expect(checkReferences(loadBundleDir(fixtureDir))).toEqual([]);
  });

  it("flags a milestone requiring a missing item", () => {
    const b = loadBundleDir(fixtureDir);
    b.milestones[0]!.requires[0]!.item = "ghost";
    expect(checkReferences(b).some((i) => i.check === 2 && i.message.includes("ghost"))).toBe(true);
  });

  it("flags a milestone lane multiplier on a missing lane", () => {
    const b = loadBundleDir(fixtureDir);
    b.milestones[0]!.laneMultipliers = { ghost: 1.5 };
    expect(checkReferences(b).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("flags a storage curve cost item that does not exist", () => {
    const b = loadBundleDir(fixtureDir);
    b.storage.baseCostItem = "ghost";
    expect(checkReferences(b).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("accepts a null storage cost item", () => {
    const b = loadBundleDir(fixtureDir);
    b.storage.baseCostItem = null;
    expect(checkReferences(b)).toEqual([]);
  });

  it("flags a start machine in a missing lane and a start assignment to a missing recipe", () => {
    const b = loadBundleDir(fixtureDir);
    b.start.machines[0]!.lane = "ghost";
    b.start.assignments = { ...b.start.assignments, phantom_recipe: 1 };
    const issues = checkReferences(b);
    expect(issues.some((i) => i.message.includes("ghost"))).toBe(true);
    expect(issues.some((i) => i.message.includes("phantom_recipe"))).toBe(true);
  });

  it("flags a start machine mark the class does not define", () => {
    const b = loadBundleDir(fixtureDir);
    b.start.machines[0]!.mark = 9;
    expect(checkReferences(b).some((i) => i.message.includes("mk9"))).toBe(true);
  });

  it("flags a start priority entry naming a missing item", () => {
    const b = loadBundleDir(fixtureDir);
    b.start.priority = ["ghost"];
    expect(checkReferences(b).some((i) => i.message.includes("ghost"))).toBe(true);
  });
});

describe("the extended fixture", () => {
  it("passes every implemented validator check", () => {
    expect(validateBundle(loadBundleDir(fixtureDir))).toEqual([]);
  });

  it("carries the values the engine needs", () => {
    const b = loadBundleDir(fixtureDir);
    expect(b.baseGridCapacityMw).toBeGreaterThan(0);
    expect(b.milestones.length).toBeGreaterThanOrEqual(3);
    expect(b.start.machines.length).toBeGreaterThan(0);
    expect(b.storage.baseCostItem).not.toBeNull();
    expect(b.machineClasses.every((c) => c.costRatio > 1)).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @manufactory/content test load.phase1`
Expected: FAIL — `curves.yaml`, `milestones.yaml` and `start.yaml` do not exist yet, so `b.milestones[0]` is undefined.

- [ ] **Step 7: Extend `checkReferences`**

In `packages/content/src/load.ts`, inside `checkReferences`, immediately before the closing `return issues;`, insert:

```ts
  const recipeIds = new Set(bundle.recipes.map((r) => r.id));

  for (const [label, curve] of [
    ["storage", bundle.storage],
    ["quantumStorage", bundle.quantumStorage],
  ] as const) {
    if (curve.baseCostItem !== null && !itemIds.has(curve.baseCostItem)) {
      add(`${label} curve references missing item "${curve.baseCostItem}"`);
    }
  }

  for (const milestone of bundle.milestones) {
    for (const requirement of milestone.requires) {
      if (!itemIds.has(requirement.item)) {
        add(`milestone tier ${milestone.tier} requires missing item "${requirement.item}"`);
      }
    }
    for (const lane of Object.keys(milestone.laneMultipliers)) {
      if (!laneIds.has(lane)) {
        add(`milestone tier ${milestone.tier} multiplies missing lane "${lane}"`);
      }
    }
  }

  for (const machine of bundle.start.machines) {
    if (!laneIds.has(machine.lane)) add(`start machine references missing lane "${machine.lane}"`);
    const cls = bundle.machineClasses.find((c) => c.id === machine.machineClass);
    if (!cls) {
      add(`start machine references missing machine class "${machine.machineClass}"`);
    } else if (!cls.marks.some((m) => m.mark === machine.mark)) {
      add(`start machine "${machine.machineClass}" has no mk${machine.mark}`);
    }
  }
  for (const recipeId of Object.keys(bundle.start.assignments)) {
    if (!recipeIds.has(recipeId)) add(`start assignment references missing recipe "${recipeId}"`);
  }
  for (const itemId of bundle.start.priority) {
    if (!itemIds.has(itemId)) add(`start priority references missing item "${itemId}"`);
  }
```

Note: `laneIds` and `itemIds` are already in scope from the Phase 0 body of this function; `recipeIds` is new because Phase 0 only built a list, not a set.

- [ ] **Step 8: Author the fixture's new blocks**

`packages/content/bundles/fixture/curves.yaml`:

```yaml
# Spec B.4. These are authored placeholders; the Phase 2 calibration script derives
# them from `pacing`. Phase 1 only needs values that are self-consistent and that
# make the fixture playable.
storage:
  capGrowth: 1.6
  costGrowth: 2.0
  baseCostItem: iron_plate
  baseCostAmount: 50
  maxLevel: 20

quantumStorage:
  capGrowth: 1.6
  costGrowth: 2.5
  baseCostItem: iron_plate
  baseCostAmount: 500
  maxLevel: 15

# Spec D3: applied per multiplier category and again on the product, so neither one
# system nor the four stacking can drive r_eff below 1. Piecewise-linear (spec E.4).
softcaps:
  ladder: { threshold: 1000, slope: 0.25 }
  lane: { threshold: 50, slope: 0.25 }
  tap: { threshold: 2, slope: 0.25 }
  product: { threshold: 5000, slope: 0.2 }

# Spec C.6 and spec 16.4: 10 stacks at +5% is x1.5 at full stack, inside the stated
# 1.5-2x active-versus-idle target.
tap:
  kickPerStack: 0.05
  durationSeconds: 30
  maxStacks: 10
  powerInjectionMw: 25

# The HUB allowance. Without it a fresh world has zero generation and every recipe
# sits at powerRatio 0 until the tier-3 Fuel Generator unlocks.
baseGridCapacityMw: 200
offlineCapHours: 8
```

`packages/content/bundles/fixture/milestones.yaml`:

```yaml
# Ruling R7: delivered automatically by `resolve` out of liquid stock. Numbers are
# placeholders; Phase 2's calibration solves them against `pacing`.
milestones:
  - tier: 1
    name: Iron Foundations
    requires: [{ item: iron_plate, amount: 200 }]
    laneMultipliers: { iron: 1.5 }
  - tier: 2
    name: Oil Access
    requires: [{ item: iron_plate, amount: 2000 }]
    laneMultipliers: { iron: 1.5, oil: 1.5 }
  - tier: 3
    name: Refining
    requires: [{ item: iron_plate, amount: 20000 }, { item: plastic, amount: 500 }]
    laneMultipliers: { oil: 1.5 }
```

`packages/content/bundles/fixture/start.yaml`:

```yaml
# A fresh world needs enough machines to produce the items its first build costs are
# denominated in; otherwise nothing can ever be bought.
start:
  tier: 0
  machines:
    - { lane: iron, machineClass: miner, mark: 1, count: 2 }
    - { lane: iron, machineClass: smelter, mark: 1, count: 2 }
    - { lane: iron, machineClass: constructor, mark: 1, count: 1 }
  assignments:
    mine_iron: 2
    smelt_iron: 2
    make_plate: 1
  priority: [iron_plate, iron_ingot, iron_ore]
```

In `packages/content/bundles/fixture/machines.yaml`, add a `costRatio` line to each of the six classes, immediately after its `ladder` line. For example the miner becomes:

```yaml
  - id: miner
    name: Miner
    ladder: { step: 1.5, interval: 10 }
    costRatio: 1.09
```

Use `costRatio: 1.09` for `miner`, `smelter`, `constructor`, and `generator`; use `costRatio: 1.12` for `extractor` and `refinery` so the fixture exercises a non-default ratio.

- [ ] **Step 9: Update the Phase 0 `graph.test.ts` bundle literal**

`packages/content/src/validate/graph.test.ts` builds a `Bundle` *value*, so the new output-required fields must be present. In its `bundle()` function, add `costRatio: 1.09` to the `miner` machine class object, and add these fields to the returned object immediately after `recipes: [...]`:

```ts
    storage: { capGrowth: 1.6, costGrowth: 2, baseCostItem: null, baseCostAmount: 50, maxLevel: 20 },
    quantumStorage: { capGrowth: 1.6, costGrowth: 2.5, baseCostItem: null, baseCostAmount: 500, maxLevel: 15 },
    softcaps: {
      ladder: { threshold: 1000, slope: 0.25 },
      lane: { threshold: 50, slope: 0.25 },
      tap: { threshold: 2, slope: 0.25 },
      product: { threshold: 5000, slope: 0.2 },
    },
    tap: { kickPerStack: 0.05, durationSeconds: 30, maxStacks: 10, powerInjectionMw: 25 },
    milestones: [],
    start: { tier: 0, machines: [], assignments: {}, priority: [] },
    baseGridCapacityMw: 0,
    offlineCapHours: 8,
```

- [ ] **Step 10: Run the whole content suite and the CLI**

Run:

```bash
pnpm --filter @manufactory/content test
pnpm typecheck
pnpm content:check
```

Expected: all tests PASS, typecheck exits 0, and `content:check` still prints `fixture.v1: 2 lanes, 7 items, 7 recipes, 6 machine classes` with a checksum. The checksum will differ from Phase 0's — that is correct, the bundle changed.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Extend the content bundle with the Phase 1 economy blocks

Adds costRatio, storage and Quantum Storage curves, piecewise-linear
softcaps, the tap step function, milestones, the starting state, the HUB
power allowance, and the offline cap. Every field has a default so Phase
0's minimal test bundles still parse; the fixture authors real values.
checkReferences now covers the new blocks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 2: Engine content types and the indexed graph

**Files:**
- Create: `packages/engine/src/content/types.ts`, `packages/engine/src/content/index.ts`
- Create: `packages/engine/src/graph/index-content.ts`, `packages/engine/src/graph/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/graph/index-content.test.ts`

**Interfaces:**
- Consumes: nothing from other Phase 1 tasks. In the *test only* (permitted — the lint rule ignores `*.test.ts` per Phase 0 ruling R2): `loadBundleDir` from `@manufactory/content` and `node:url`.
- Produces, from `@manufactory/engine`:
  - Types mirroring the bundle: `LaneId`, `ItemId`, `RecipeId`, `MachineClassId` (all `string`), `LadderDef`, `CostEntryDef`, `MarkDef`, `MachineClassDef`, `RecipePartDef`, `RecipeDef`, `LaneDef`, `ItemDef`, `StorageCurveDef`, `SoftcapDef`, `SoftcapsDef`, `TapDef`, `MilestoneDef`, `StartDef`, `PacingDef`, `ContentBundle`
  - `const POWER_ITEM = "__power__"`
  - `interface IndexedRecipe { def: RecipeDef; lane: LaneId; machineClass: MachineClassId; outputPerSecond: Map<ItemId, number>; inputPerSecond: Map<ItemId, number>; primaryOutput: ItemId; inCycle: boolean }`
  - `interface IndexedContent` with fields `bundle`, `lanes`, `items`, `machineClasses`, `recipes`, `itemIds`, `stockItemIds`, `recipeIds`, `producersOf`, `consumersOf`, `recipesByLaneClass`, `cyclicRecipes`, `topologicalItems`, `milestoneByTier`, `maxTier`, `defaultActiveRecipe`, `offlineCapMs`
  - `indexContent(bundle: ContentBundle): IndexedContent`
  - `laneClassKey(lane: LaneId, machineClass: MachineClassId): string`
  - `getMark(content: IndexedContent, machineClass: MachineClassId, mark: number): MarkDef | undefined`
  - `isLiveRecipe(content: IndexedContent, recipeId: RecipeId, tier: number, activeRecipe: Readonly<Record<ItemId, RecipeId>>): boolean`

The engine declares these types itself rather than importing `@manufactory/content`, because spec A.2's purity rule forbids the import. TypeScript's structural typing makes `Bundle` assignable to `ContentBundle`; Task 15 adds a compile-time check of that in `apps/sim`, where both are visible.

**Ruling R6 applies here:** every recipe inside a non-trivial strongly connected component is collected into `cyclicRecipes` and is never live. Cycles are detected here rather than trusted from the validator so the engine is self-contained.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/graph/index-content.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM, type ContentBundle } from "../content/types.js";
import { getMark, indexContent, isLiveRecipe, laneClassKey } from "./index-content.js";

const fixtureDir = fileURLToPath(
  new URL("../../../content/bundles/fixture", import.meta.url),
);

function fixture(): ContentBundle {
  return loadBundleDir(fixtureDir);
}

describe("indexContent", () => {
  it("indexes every lane, item, class and recipe by id", () => {
    const c = indexContent(fixture());
    expect(c.lanes.get("iron")!.name).toBe("Iron");
    expect(c.items.get("iron_plate")!.tier).toBe(1);
    expect(c.machineClasses.get("constructor")!.costRatio).toBe(1.09);
    expect(c.recipes.get("make_plate")!.def.name).toBe("Iron Plate");
  });

  it("converts authored per-minute rates to per-second floats", () => {
    const c = indexContent(fixture());
    // mine_iron: 60/min -> 1/s.  make_plate: 30/min in, 20/min out -> 0.5/s, 1/3/s.
    expect(c.recipes.get("mine_iron")!.outputPerSecond.get("iron_ore")).toBe(1);
    expect(c.recipes.get("make_plate")!.inputPerSecond.get("iron_ingot")).toBe(0.5);
    expect(c.recipes.get("make_plate")!.outputPerSecond.get("iron_plate")).toBeCloseTo(1 / 3, 12);
  });

  it("gives a generator the synthetic power item as its primary output", () => {
    const c = indexContent(fixture());
    const burn = c.recipes.get("burn_fuel")!;
    expect(burn.primaryOutput).toBe(POWER_ITEM);
    // 250 MW is a standing output, not a per-minute rate, so it is not divided by 60.
    expect(burn.outputPerSecond.get(POWER_ITEM)).toBe(250);
    expect(burn.inputPerSecond.get("fuel")).toBeCloseTo(20 / 60, 12);
  });

  it("puts the power item in itemIds but not in stockItemIds", () => {
    const c = indexContent(fixture());
    expect(c.itemIds).toContain(POWER_ITEM);
    expect(c.stockItemIds).not.toContain(POWER_ITEM);
    expect(c.stockItemIds).toHaveLength(c.bundle.items.length);
  });

  it("maps producers and consumers, counting byproducts as production", () => {
    const c = indexContent(fixture());
    expect(c.producersOf.get("heavy_oil_residue")).toEqual(["refine_plastic"]);
    expect(c.consumersOf.get("heavy_oil_residue")).toEqual(["residual_fuel"]);
    expect(c.producersOf.get(POWER_ITEM)).toEqual(["burn_fuel"]);
  });

  it("groups recipes by lane and class", () => {
    const c = indexContent(fixture());
    expect(c.recipesByLaneClass.get(laneClassKey("oil", "refinery"))!.sort()).toEqual([
      "refine_plastic",
      "residual_fuel",
    ]);
  });

  it("orders items so producers come before consumers", () => {
    const c = indexContent(fixture());
    const at = (id: string) => c.topologicalItems.indexOf(id);
    expect(at("iron_ore")).toBeLessThan(at("iron_ingot"));
    expect(at("iron_ingot")).toBeLessThan(at("iron_plate"));
    expect(at("crude_oil")).toBeLessThan(at("heavy_oil_residue"));
    expect(at("heavy_oil_residue")).toBeLessThan(at("fuel"));
    expect(at("fuel")).toBeLessThan(at(POWER_ITEM));
    expect(c.topologicalItems).toHaveLength(c.itemIds.length);
  });

  it("finds no cycles in the acyclic fixture", () => {
    expect(indexContent(fixture()).cyclicRecipes.size).toBe(0);
  });

  it("marks every recipe of a genuine cycle as cyclic and never live (ruling R6)", () => {
    const b = fixture();
    // Recycled Plastic / Recycled Rubber in miniature: plastic <-> residue.
    b.recipes.push({
      id: "recycle_plastic",
      name: "Recycled Plastic",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      outputs: [{ item: "plastic", rate: "20", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 2,
    });
    b.recipes.push({
      id: "recycle_residue",
      name: "Recycled Residue",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "plastic", rate: "20", byproduct: false }],
      outputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 2,
    });
    const c = indexContent(b);
    expect(c.cyclicRecipes.has("recycle_plastic")).toBe(true);
    expect(c.cyclicRecipes.has("recycle_residue")).toBe(true);
    expect(c.cyclicRecipes.has("make_plate")).toBe(false);
    expect(isLiveRecipe(c, "recycle_plastic", 9, { plastic: "recycle_plastic" })).toBe(false);
  });

  it("picks the earliest-declared non-alternate recipe as each item's default", () => {
    const c = indexContent(fixture());
    expect(c.defaultActiveRecipe.iron_plate).toBe("make_plate");
    expect(c.defaultActiveRecipe[POWER_ITEM]).toBe("burn_fuel");
  });

  it("reports a recipe live only when unlocked, acyclic, and selected", () => {
    const c = indexContent(fixture());
    const active = { ...c.defaultActiveRecipe };
    expect(isLiveRecipe(c, "make_plate", 0, active)).toBe(true);
    expect(isLiveRecipe(c, "refine_plastic", 1, active)).toBe(false); // unlockTier 2
    expect(isLiveRecipe(c, "refine_plastic", 2, active)).toBe(true);
    expect(isLiveRecipe(c, "make_plate", 0, { ...active, iron_plate: "other" })).toBe(false);
  });

  it("indexes milestones and derives maxTier and the offline cap", () => {
    const c = indexContent(fixture());
    expect(c.milestoneByTier.get(2)!.name).toBe("Oil Access");
    expect(c.maxTier).toBe(3);
    expect(c.offlineCapMs).toBe(8 * 60 * 60 * 1000);
  });

  it("rejects a recipe whose machine class does not exist", () => {
    const b = fixture();
    b.recipes[0]!.machineClass = "ghost";
    expect(() => indexContent(b)).toThrow(/ghost/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test index-content`
Expected: FAIL — `Cannot find module '../content/types.js'`.

`@manufactory/content` must be a dev dependency of the engine for this test to resolve. Add to `packages/engine/package.json` under `devDependencies`: `"@manufactory/content": "workspace:*"`, then run `pnpm install`. It is a *dev* dependency deliberately: shipped engine code must never import it.

- [ ] **Step 3: Write the content types**

`packages/engine/src/content/types.ts`:

```ts
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
```

`packages/engine/src/content/index.ts`:

```ts
export * from "./types.js";
```

- [ ] **Step 4: Write the indexer**

`packages/engine/src/graph/index-content.ts`:

```ts
// Spec C.3's precompute, part one: turn an authored bundle into indexed structures
// the solver can walk in constant time.
//
// Authored rates are exact rational strings per minute (spec A.4 zone 1). They are
// parsed exactly here and converted to per-second float64 once, at this boundary,
// because that is the only place a rational is allowed to become a float.
import { parseRational, toApproximateNumber } from "@manufactory/rational";
import {
  POWER_ITEM,
  type ContentBundle,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type MarkDef,
  type MilestoneDef,
  type RecipeDef,
  type RecipeId,
} from "../content/types.js";

export interface IndexedRecipe {
  def: RecipeDef;
  lane: LaneId;
  machineClass: MachineClassId;
  /** Items per second produced per machine-unit at clock 1, including byproducts. */
  outputPerSecond: Map<ItemId, number>;
  /** Items per second consumed per machine-unit at clock 1. */
  inputPerSecond: Map<ItemId, number>;
  /**
   * The output this recipe is *selected* for. First non-byproduct output; POWER_ITEM
   * for a generator. Spec 4.4 makes recipe selection per-item, so a recipe is live
   * only while it is the active recipe for its primary output.
   */
  primaryOutput: ItemId;
  /** Ruling R6: inside a non-trivial SCC, therefore never live in Phase 1. */
  inCycle: boolean;
}

export interface IndexedContent {
  bundle: ContentBundle;
  lanes: Map<LaneId, ContentBundle["lanes"][number]>;
  items: Map<ItemId, ContentBundle["items"][number]>;
  machineClasses: Map<MachineClassId, ContentBundle["machineClasses"][number]>;
  recipes: Map<RecipeId, IndexedRecipe>;
  /** Every item id in authored order, plus POWER_ITEM last. */
  itemIds: ItemId[];
  /** Items that occupy storage. `itemIds` minus POWER_ITEM. */
  stockItemIds: ItemId[];
  recipeIds: RecipeId[];
  producersOf: Map<ItemId, RecipeId[]>;
  consumersOf: Map<ItemId, RecipeId[]>;
  recipesByLaneClass: Map<string, RecipeId[]>;
  cyclicRecipes: Set<RecipeId>;
  /** Items ordered so every producer of an item precedes it. Acyclic recipes only. */
  topologicalItems: ItemId[];
  milestoneByTier: Map<number, MilestoneDef>;
  maxTier: number;
  defaultActiveRecipe: Record<ItemId, RecipeId>;
  offlineCapMs: number;
}

export function laneClassKey(lane: LaneId, machineClass: MachineClassId): string {
  return `${lane}::${machineClass}`;
}

export function getMark(
  content: IndexedContent,
  machineClass: MachineClassId,
  mark: number,
): MarkDef | undefined {
  return content.machineClasses.get(machineClass)?.marks.find((m) => m.mark === mark);
}

export function isLiveRecipe(
  content: IndexedContent,
  recipeId: RecipeId,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): boolean {
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return false;
  if (recipe.inCycle) return false;
  if (recipe.def.unlockTier > tier) return false;
  return activeRecipe[recipe.primaryOutput] === recipeId;
}

/** Authored rates are per minute; the engine works per second everywhere. */
function ratePerSecond(rate: string): number {
  const exact = parseRational(rate);
  return toApproximateNumber(exact) / 60;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Tarjan's SCC, iteratively. Nodes are recipes; R depends on S when R consumes an
 * item S produces. Iterative rather than recursive because a blown call stack in the
 * engine is a far worse failure mode than a slightly longer function.
 */
function findCyclicRecipes(recipes: IndexedRecipe[]): Set<RecipeId> {
  const producersOf = new Map<ItemId, RecipeId[]>();
  for (const recipe of recipes) {
    for (const item of recipe.outputPerSecond.keys()) push(producersOf, item, recipe.def.id);
  }
  const edges = new Map<RecipeId, RecipeId[]>();
  for (const recipe of recipes) {
    const deps = new Set<RecipeId>();
    for (const item of recipe.inputPerSecond.keys()) {
      for (const producer of producersOf.get(item) ?? []) deps.add(producer);
    }
    edges.set(recipe.def.id, [...deps]);
  }

  const index = new Map<RecipeId, number>();
  const low = new Map<RecipeId, number>();
  const onStack = new Set<RecipeId>();
  const stack: RecipeId[] = [];
  const cyclic = new Set<RecipeId>();
  let counter = 0;

  for (const root of recipes.map((r) => r.def.id)) {
    if (index.has(root)) continue;
    const frames: { node: RecipeId; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const children = edges.get(frame.node) ?? [];
      if (frame.next < children.length) {
        const child = children[frame.next]!;
        frame.next += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          frames.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: RecipeId[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        const selfLoop =
          component.length === 1 && (edges.get(component[0]!) ?? []).includes(component[0]!);
        if (component.length > 1 || selfLoop) for (const id of component) cyclic.add(id);
      }
    }
  }
  return cyclic;
}

/**
 * Kahn's algorithm over the item graph, restricted to acyclic recipes. Ties are
 * broken by authored order so the result is stable across runs (spec A.5's canonical
 * ordering rule).
 */
function topologicalItems(itemIds: ItemId[], recipes: IndexedRecipe[]): ItemId[] {
  const rank = new Map<ItemId, number>(itemIds.map((id, i) => [id, i]));
  const dependsOn = new Map<ItemId, Set<ItemId>>(itemIds.map((id) => [id, new Set<ItemId>()]));
  const dependents = new Map<ItemId, Set<ItemId>>(itemIds.map((id) => [id, new Set<ItemId>()]));

  for (const recipe of recipes) {
    if (recipe.inCycle) continue;
    for (const out of recipe.outputPerSecond.keys()) {
      for (const input of recipe.inputPerSecond.keys()) {
        if (input === out) continue;
        dependsOn.get(out)!.add(input);
        dependents.get(input)!.add(out);
      }
    }
  }

  const ready = itemIds.filter((id) => dependsOn.get(id)!.size === 0);
  ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
  const order: ItemId[] = [];
  const remaining = new Map<ItemId, number>(itemIds.map((id) => [id, dependsOn.get(id)!.size]));

  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    const freed: ItemId[] = [];
    for (const dependent of dependents.get(next)!) {
      const left = remaining.get(dependent)! - 1;
      remaining.set(dependent, left);
      if (left === 0) freed.push(dependent);
    }
    freed.sort((a, b) => rank.get(a)! - rank.get(b)!);
    for (const id of freed) ready.push(id);
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
  }

  // Anything left is in a cycle the recipe-level SCC pass did not exclude; append it
  // in authored order so the array always covers every item.
  for (const id of itemIds) if (!order.includes(id)) order.push(id);
  return order;
}

export function indexContent(bundle: ContentBundle): IndexedContent {
  const lanes = new Map(bundle.lanes.map((l) => [l.id, l]));
  const items = new Map(bundle.items.map((i) => [i.id, i]));
  const machineClasses = new Map(bundle.machineClasses.map((m) => [m.id, m]));

  const indexedRecipes: IndexedRecipe[] = bundle.recipes.map((def) => {
    if (!lanes.has(def.lane)) throw new Error(`recipe "${def.id}": unknown lane "${def.lane}"`);
    if (!machineClasses.has(def.machineClass)) {
      throw new Error(`recipe "${def.id}": unknown machine class "${def.machineClass}"`);
    }

    const outputPerSecond = new Map<ItemId, number>();
    for (const part of def.outputs) {
      if (!items.has(part.item)) throw new Error(`recipe "${def.id}": unknown item "${part.item}"`);
      outputPerSecond.set(part.item, ratePerSecond(part.rate));
    }
    // Megawatts are a standing output, not a per-minute flow, so powerOutput is used
    // as authored rather than divided by 60.
    if (def.powerOutput > 0) outputPerSecond.set(POWER_ITEM, def.powerOutput);

    const inputPerSecond = new Map<ItemId, number>();
    for (const part of def.inputs) {
      if (!items.has(part.item)) throw new Error(`recipe "${def.id}": unknown item "${part.item}"`);
      inputPerSecond.set(part.item, ratePerSecond(part.rate));
    }

    const primary = def.outputs.find((o) => !o.byproduct)?.item;
    const primaryOutput = primary ?? (def.powerOutput > 0 ? POWER_ITEM : undefined);
    if (primaryOutput === undefined) {
      throw new Error(`recipe "${def.id}": has neither a non-byproduct output nor power output`);
    }

    return {
      def,
      lane: def.lane,
      machineClass: def.machineClass,
      outputPerSecond,
      inputPerSecond,
      primaryOutput,
      inCycle: false,
    };
  });

  const cyclicRecipes = findCyclicRecipes(indexedRecipes);
  for (const recipe of indexedRecipes) recipe.inCycle = cyclicRecipes.has(recipe.def.id);

  const recipes = new Map(indexedRecipes.map((r) => [r.def.id, r]));
  const itemIds = [...bundle.items.map((i) => i.id), POWER_ITEM];
  const stockItemIds = bundle.items.map((i) => i.id);

  const producersOf = new Map<ItemId, RecipeId[]>();
  const consumersOf = new Map<ItemId, RecipeId[]>();
  const recipesByLaneClass = new Map<string, RecipeId[]>();
  for (const recipe of indexedRecipes) {
    for (const item of recipe.outputPerSecond.keys()) push(producersOf, item, recipe.def.id);
    for (const item of recipe.inputPerSecond.keys()) push(consumersOf, item, recipe.def.id);
    push(recipesByLaneClass, laneClassKey(recipe.lane, recipe.machineClass), recipe.def.id);
  }

  // Spec 4.4: one active recipe per output item. The default is the first authored
  // non-alternate recipe for that item, falling back to the first of any kind.
  const defaultActiveRecipe: Record<ItemId, RecipeId> = {};
  for (const item of itemIds) {
    const candidates = indexedRecipes.filter((r) => r.primaryOutput === item && !r.inCycle);
    const chosen = candidates.find((r) => !r.def.isAlternate) ?? candidates[0];
    if (chosen) defaultActiveRecipe[item] = chosen.def.id;
  }

  const milestoneByTier = new Map(bundle.milestones.map((m) => [m.tier, m]));
  const maxTier = bundle.milestones.reduce((acc, m) => Math.max(acc, m.tier), 0);

  return {
    bundle,
    lanes,
    items,
    machineClasses,
    recipes,
    itemIds,
    stockItemIds,
    recipeIds: indexedRecipes.map((r) => r.def.id),
    producersOf,
    consumersOf,
    recipesByLaneClass,
    cyclicRecipes,
    topologicalItems: topologicalItems(itemIds, indexedRecipes),
    milestoneByTier,
    maxTier,
    defaultActiveRecipe,
    offlineCapMs: bundle.offlineCapHours * 60 * 60 * 1000,
  };
}
```

`packages/engine/src/graph/index.ts`:

```ts
export * from "./index-content.js";
```

- [ ] **Step 5: Rewrite the package barrel**

`packages/engine/src/index.ts`:

```ts
export * from "./numbers/decimal.js";
export * from "./numbers/format.js";
export * from "./content/index.js";
export * from "./graph/index.js";
```

- [ ] **Step 6: Run the tests, lint, and typecheck**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint
pnpm typecheck
```

Expected: all PASS. `pnpm lint` must be clean — if it flags the `@manufactory/content` import in `index-content.test.ts`, the Phase 0 boundary rule is missing its `ignores: ["packages/engine/**/*.test.ts"]` entry (Phase 0 ruling R2); add it to the engine block in `eslint.config.js`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the engine content types and the indexed graph

The engine declares its own structural view of a bundle rather than
importing @manufactory/content, which spec A.2 forbids. Authored rational
rates are parsed exactly and converted to per-second float64 once, at this
boundary. Generators produce a synthetic power item so spec C.4's
priority-entry-1 power needs no special case in the waterfall. Ruling R6:
recipes inside a non-trivial SCC are marked and never live.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 3: Per-unit expansion vectors

**Files:**
- Create: `packages/engine/src/graph/expand.ts`
- Modify: `packages/engine/src/graph/index.ts`
- Test: `packages/engine/src/graph/expand.test.ts`

**Interfaces:**
- Consumes: `indexContent`, `type IndexedContent`, `type IndexedRecipe`, `laneClassKey`, `POWER_ITEM`, `type ItemId`, `type RecipeId`, `type ContentBundle` (Task 2); `parseRational`, `multiply`, `divide`, `add`, `of`, `toApproximateNumber`, `ZERO`, `ONE`, `type Rational` from `@manufactory/rational`
- Produces, from `@manufactory/engine`:
  - `interface ExpansionVectors { key: string; unitsPerItem: Map<ItemId, number>; directInputs: Map<ItemId, Map<ItemId, number>>; perUnit: Map<ItemId, Map<RecipeId, number>>; rawCost: Map<ItemId, Map<ItemId, number>> }`
  - `computeExpansion(content: IndexedContent, tier: number, activeRecipe: Readonly<Record<ItemId, RecipeId>>): ExpansionVectors`
  - `expansionKey(content: IndexedContent, tier: number, activeRecipe: Readonly<Record<ItemId, RecipeId>>): string`
  - `clearExpansionCache(): void` (test hook)

Spec A.4 zone 1: this is the **only** module allowed to use `@manufactory/rational`. Ratios are composed exactly across the whole graph and converted to `float64` exactly once, at the return. The cache is keyed by `(contentVersion, tier, activeRecipeSet)` per spec A.4 and is a plain memo — same inputs give the same outputs, so it introduces no hidden state that could vary a save.

`unitsPerItem[i]` is machine-units of `i`'s active recipe needed per 1 item/s of `i`. `directInputs[i][j]` is units of `j` consumed per unit of `i`. Task 8's per-pass walk composes these with cuts. `perUnit[i]` is the *uncut* full expansion — machine-units of every upstream recipe per unit/s of `i` — and `rawCost[i]` is the extraction-item trace that spec F.1's Handbook "traces back to" readout and `sim play`'s `explain` both render.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/graph/expand.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { beforeEach, describe, expect, it } from "vitest";
import { POWER_ITEM, type ContentBundle } from "../content/types.js";
import { clearExpansionCache, computeExpansion, expansionKey } from "./expand.js";
import { indexContent } from "./index-content.js";

const fixtureDir = fileURLToPath(
  new URL("../../../content/bundles/fixture", import.meta.url),
);
function fixture(): ContentBundle {
  return loadBundleDir(fixtureDir);
}

beforeEach(() => clearExpansionCache());

describe("computeExpansion", () => {
  it("computes machine-units per item per second", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // mine_iron makes 1 ore/s per unit -> 1 unit per ore/s.
    expect(e.unitsPerItem.get("iron_ore")).toBeCloseTo(1, 12);
    // smelt_iron makes 0.5 ingot/s per unit -> 2 units per ingot/s.
    expect(e.unitsPerItem.get("iron_ingot")).toBeCloseTo(2, 12);
    // make_plate makes 1/3 plate/s per unit -> 3 units per plate/s.
    expect(e.unitsPerItem.get("iron_plate")).toBeCloseTo(3, 12);
  });

  it("computes direct input requirements per unit of output", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // One plate needs 30 ingot/min per 20 plate/min = 1.5 ingot.
    expect(e.directInputs.get("iron_plate")!.get("iron_ingot")).toBeCloseTo(1.5, 12);
    // One ingot needs 30 ore/min per 30 ingot/min = 1 ore.
    expect(e.directInputs.get("iron_ingot")!.get("iron_ore")).toBeCloseTo(1, 12);
    expect(e.directInputs.get("iron_ore")!.size).toBe(0);
  });

  it("composes the full per-unit recipe vector across the chain", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    const v = e.perUnit.get("iron_plate")!;
    // 1 plate/s needs 3 make_plate units; those pull 1.5 ingot/s, needing 3
    // smelt_iron units; those pull 1.5 ore/s, needing 1.5 mine_iron units.
    expect(v.get("make_plate")).toBeCloseTo(3, 12);
    expect(v.get("smelt_iron")).toBeCloseTo(3, 12);
    expect(v.get("mine_iron")).toBeCloseTo(1.5, 12);
    expect(v.size).toBe(3);
  });

  it("traces raw extraction cost per unit", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // 1 plate = 1.5 ingot = 1.5 ore.
    expect(e.rawCost.get("iron_plate")!.get("iron_ore")).toBeCloseTo(1.5, 12);
    expect(e.rawCost.get("iron_ore")!.get("iron_ore")).toBeCloseTo(1, 12);
  });

  it("expands power back through the fuel chain", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // burn_fuel: 250 MW per unit -> 1/250 units per MW. It pulls 20 fuel/min =
    // 1/3 fuel/s per unit, so 1 MW pulls 1/750 fuel/s.
    expect(e.unitsPerItem.get(POWER_ITEM)).toBeCloseTo(1 / 250, 12);
    expect(e.perUnit.get(POWER_ITEM)!.get("burn_fuel")).toBeCloseTo(1 / 250, 12);
    // residual_fuel makes 40 fuel/min = 2/3 fuel/s per unit -> 1.5 units per fuel/s.
    // 1 MW needs 1/750 fuel/s -> 1.5/750 = 0.002 residual_fuel units.
    expect(e.perUnit.get(POWER_ITEM)!.get("residual_fuel")).toBeCloseTo(0.002, 12);
  });

  it("is exact where floats would drift — 1/3 composed three deep", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // 1 plate/s pulls 1.5 ore/s exactly; a float chain through 20/60 and 30/60
    // would leave a last-digit residue. Exact rationals mean this is dead on.
    expect(e.rawCost.get("iron_plate")!.get("iron_ore")).toBe(1.5);
  });

  it("stops at items whose recipe is locked at the given tier", () => {
    const c = indexContent(fixture());
    const early = computeExpansion(c, 0, c.defaultActiveRecipe);
    expect(early.unitsPerItem.has("plastic")).toBe(false);
    expect(early.perUnit.has("plastic")).toBe(false);
    const late = computeExpansion(c, 3, c.defaultActiveRecipe);
    expect(late.unitsPerItem.has("plastic")).toBe(true);
  });

  it("keys the cache on content version, tier, and the active recipe set", () => {
    const c = indexContent(fixture());
    const a = expansionKey(c, 2, c.defaultActiveRecipe);
    expect(a).toContain("fixture.v1");
    expect(expansionKey(c, 3, c.defaultActiveRecipe)).not.toBe(a);
    expect(expansionKey(c, 2, { ...c.defaultActiveRecipe, iron_plate: "other" })).not.toBe(a);
  });

  it("returns the identical object for a repeated call", () => {
    const c = indexContent(fixture());
    expect(computeExpansion(c, 9, c.defaultActiveRecipe)).toBe(
      computeExpansion(c, 9, c.defaultActiveRecipe),
    );
  });

  it("excludes cyclic recipes entirely (ruling R6)", () => {
    const b = fixture();
    b.recipes.push({
      id: "recycle_plastic",
      name: "Recycled Plastic",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      outputs: [{ item: "plastic", rate: "20", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 2,
    });
    b.recipes.push({
      id: "recycle_residue",
      name: "Recycled Residue",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "plastic", rate: "20", byproduct: false }],
      outputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 2,
    });
    const c = indexContent(b);
    const e = computeExpansion(c, 9, {
      ...c.defaultActiveRecipe,
      plastic: "recycle_plastic",
      heavy_oil_residue: "recycle_residue",
    });
    // Both are cyclic, so neither is live and neither item expands.
    expect(e.perUnit.has("plastic")).toBe(false);
    expect(e.perUnit.has("heavy_oil_residue")).toBe(false);
    // The acyclic rest of the graph is unaffected.
    expect(e.perUnit.get("iron_plate")!.get("mine_iron")).toBeCloseTo(1.5, 12);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test expand`
Expected: FAIL — `Cannot find module './expand.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/graph/expand.ts`:

```ts
// Spec A.4 zone 1, and spec C.3's precompute. This is the ONLY module in the engine
// permitted to touch @manufactory/rational.
//
// Ratios must be exact or allocation drifts across a deep graph: 20/60 and 30/60
// composed three deep in float64 leaves a residue that shows up as a phantom
// bottleneck. So the whole composition runs in BigInt rationals and converts to
// float64 exactly once, on the way out. Nothing here runs per solve — the result is
// memoized on (contentVersion, tier, activeRecipeSet), which changes only when the
// player selects a different recipe or unlocks a tier.
import {
  ZERO,
  add,
  divide,
  multiply,
  of,
  parseRational,
  toApproximateNumber,
  type Rational,
} from "@manufactory/rational";
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "./index-content.js";

export interface ExpansionVectors {
  key: string;
  /** Machine-units of the active recipe needed per 1 item/s of the key item. */
  unitsPerItem: Map<ItemId, number>;
  /** Units of the inner item consumed per 1 unit of the outer item. */
  directInputs: Map<ItemId, Map<ItemId, number>>;
  /** Uncut full expansion: machine-units of every upstream recipe per 1 item/s. */
  perUnit: Map<ItemId, Map<RecipeId, number>>;
  /** Extraction-item trace per 1 unit. Spec F.1's Handbook "traces back to". */
  rawCost: Map<ItemId, Map<ItemId, number>>;
}

export function expansionKey(
  content: IndexedContent,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): string {
  const pairs = Object.keys(activeRecipe)
    .sort()
    .map((item) => `${item}=${activeRecipe[item]}`)
    .join(",");
  return `${content.bundle.version}|t${tier}|${pairs}`;
}

const CACHE_LIMIT = 16;
const cache = new Map<string, ExpansionVectors>();

/** Test hook. Never called by shipped code. */
export function clearExpansionCache(): void {
  cache.clear();
}

function exactRatePerSecond(rate: string): Rational {
  return divide(parseRational(rate), of(60n));
}

export function computeExpansion(
  content: IndexedContent,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): ExpansionVectors {
  const key = expansionKey(content, tier, activeRecipe);
  const hit = cache.get(key);
  if (hit) return hit;

  // Exact per-item intermediates, all Rational.
  const unitsExact = new Map<ItemId, Rational>();
  const directExact = new Map<ItemId, Map<ItemId, Rational>>();

  for (const itemId of content.itemIds) {
    const recipeId = activeRecipe[itemId];
    if (recipeId === undefined) continue;
    if (!isLiveRecipe(content, recipeId, tier, activeRecipe)) continue;
    const recipe = content.recipes.get(recipeId)!;

    // Output rate of the primary item, exactly. Power is a standing megawatt figure
    // rather than a per-minute flow, so it is not divided by 60.
    let outPerUnit: Rational;
    if (itemId === POWER_ITEM) {
      outPerUnit = of(BigInt(Math.round(recipe.def.powerOutput * 1_000_000)), 1_000_000n);
    } else {
      const part = recipe.def.outputs.find((o) => o.item === itemId);
      if (!part) continue;
      outPerUnit = exactRatePerSecond(part.rate);
    }
    if (outPerUnit.numerator === 0n) continue;

    const units = divide(of(1n), outPerUnit);
    unitsExact.set(itemId, units);

    const direct = new Map<ItemId, Rational>();
    for (const part of recipe.def.inputs) {
      const inPerUnit = exactRatePerSecond(part.rate);
      // Units of `part.item` per 1 unit of `itemId`.
      direct.set(part.item, add(direct.get(part.item) ?? ZERO, divide(inPerUnit, outPerUnit)));
    }
    directExact.set(itemId, direct);
  }

  // Compose the full vectors in topological order, so every input is already done by
  // the time its consumer is reached. Ruling R6 guarantees this order exists.
  const perUnitExact = new Map<ItemId, Map<RecipeId, Rational>>();
  const rawExact = new Map<ItemId, Map<ItemId, Rational>>();

  const mergeScaled = <K>(
    into: Map<K, Rational>,
    from: Map<K, Rational> | undefined,
    scale: Rational,
  ): void => {
    if (!from) return;
    for (const [k, v] of from) into.set(k, add(into.get(k) ?? ZERO, multiply(v, scale)));
  };

  for (const itemId of content.topologicalItems) {
    const units = unitsExact.get(itemId);
    if (units === undefined) continue;
    const recipeId = activeRecipe[itemId]!;
    const direct = directExact.get(itemId) ?? new Map<ItemId, Rational>();

    const vector = new Map<RecipeId, Rational>([[recipeId, units]]);
    const raw = new Map<ItemId, Rational>();
    let hasUpstream = false;

    for (const [inputId, perUnitOfInput] of direct) {
      if (unitsExact.has(inputId)) {
        hasUpstream = true;
        mergeScaled(vector, perUnitExact.get(inputId), perUnitOfInput);
        mergeScaled(raw, rawExact.get(inputId), perUnitOfInput);
      } else {
        // Not produced by any live recipe at this tier: treat it as a raw input.
        raw.set(inputId, add(raw.get(inputId) ?? ZERO, perUnitOfInput));
      }
    }
    // An extraction recipe has no inputs at all, so the item is its own raw cost.
    if (direct.size === 0 && !hasUpstream) raw.set(itemId, of(1n));

    perUnitExact.set(itemId, vector);
    rawExact.set(itemId, raw);
  }

  // The single float boundary (spec A.4). Nothing downstream ever sees a Rational.
  const toFloatMap = <K>(source: Map<K, Rational>): Map<K, number> => {
    const out = new Map<K, number>();
    for (const [k, v] of source) out.set(k, toApproximateNumber(v));
    return out;
  };

  const result: ExpansionVectors = {
    key,
    unitsPerItem: toFloatMap(unitsExact),
    directInputs: new Map([...directExact].map(([k, v]) => [k, toFloatMap(v)])),
    perUnit: new Map([...perUnitExact].map(([k, v]) => [k, toFloatMap(v)])),
    rawCost: new Map([...rawExact].map(([k, v]) => [k, toFloatMap(v)])),
  };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, result);
  return result;
}
```

- [ ] **Step 4: Export it**

`packages/engine/src/graph/index.ts`:

```ts
export * from "./index-content.js";
export * from "./expand.js";
```

- [ ] **Step 5: Run the tests, lint, and typecheck**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

If `of(1n)` does not accept a single argument in the vendored package, use `of(1n, 1n)`; the vendored `of(n, d?)` signature is documented in Phase 0 Task 1's Interfaces block.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add per-unit expansion vectors

Spec A.4 zone 1: the only module in the engine that touches BigInt
rationals. Composes machine-unit and raw-extraction vectors exactly across
the whole graph and converts to float64 once, on the way out, then
memoizes on (contentVersion, tier, activeRecipeSet). Composing 20/60 and
30/60 three deep in float64 leaves a residue that reads as a phantom
bottleneck; this is why the exactness is worth the BigInt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 4: The PRNG, `WorldState`, and canonical serialization

**Files:**
- Create: `packages/engine/src/state/prng.ts`, `packages/engine/src/state/world.ts`, `packages/engine/src/state/serialize.ts`, `packages/engine/src/state/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/state/prng.test.ts`, `packages/engine/src/state/world.test.ts`, `packages/engine/src/state/serialize.test.ts`

**Interfaces:**
- Consumes: `D`, `toCanonical`, `fromCanonical`, `type Dec`, `DECIMAL_ZERO` (Phase 0 Task 2); `indexContent`, `type IndexedContent`, `POWER_ITEM`, `type ItemId`, `type LaneId`, `type MachineClassId`, `type RecipeId` (Task 2)
- Produces, from `@manufactory/engine`:
  - `interface PrngState { readonly a: number; readonly b: number; readonly c: number; readonly d: number }`
  - `makePrng(seed: number): PrngState`
  - `nextUint32(state: PrngState): { value: number; state: PrngState }`
  - `nextFloat(state: PrngState): { value: number; state: PrngState }` — in `[0, 1)`
  - `type PriorityKind = "power" | "item"`, `type PriorityMode = "guaranteed" | "share"`
  - `interface PriorityEntry { id: string; kind: PriorityKind; itemId: ItemId | null; mode: PriorityMode; share: number; targetRate: number | null; paused: boolean }`
  - `type TimerKind = "tapExpiry"`, `interface Timer { id: string; kind: TimerKind; fireAt: number }`
  - `interface WorldState { schemaVersion: number; contentVersion: string; seed: PrngState; tier: number; installed: Record<LaneId, Record<MachineClassId, number[]>>; assignment: Record<RecipeId, number>; activeRecipe: Record<ItemId, RecipeId>; stored: Record<ItemId, Dec>; quantum: Record<ItemId, Dec>; bound: Record<ItemId, Dec>; storageLevel: Record<ItemId, number>; qsLevel: Record<LaneId, number>; reserve: Record<ItemId, number>; priority: PriorityEntry[]; powerBank: Dec; tapStacks: number; timers: Timer[]; lifetime: Record<ItemId, Dec>; lastResolvedAt: number }`
  - `const WORLD_SCHEMA_VERSION = 1`, `const POWER_ENTRY_ID = "power"`
  - `initialWorld(content: IndexedContent, seed: number, nowMs: number): WorldState`
  - `installedAt(state: WorldState, lane: LaneId, machineClass: MachineClassId, mark: number): number`
  - `withInstalled(state: WorldState, lane: LaneId, machineClass: MachineClassId, mark: number, count: number): WorldState`
  - `installedMachines(state: WorldState, lane: LaneId, machineClass: MachineClassId): number`
  - `assignedTotal(content: IndexedContent, state: WorldState, lane: LaneId, machineClass: MachineClassId): number`
  - `serializeWorld(state: WorldState): string`
  - `deserializeWorld(text: string): WorldState`

Spec C.1 lists the state shape. Two fields are added to it here and the reasons are worth stating: `tier` (ruling R7 needs somewhere to record milestone progress) and `tapStacks` (spec C.6's step function needs a stack count, and its expiry lives in `timers`). `powerBank` is listed in C.1, carried here, and always zero — spec 6.2's Power Storage is a purchasable with no action in spec D.1's set of eleven, so it lands with Spec 2.

Spec A.5: the PRNG is seeded, explicit, and part of the save. xoshiro128\*\* is used because every step is integer arithmetic (`Math.imul`, shifts, XOR) — no transcendentals — so the stream is byte-identical on every platform, which spec E.4's replay comparison depends on.

- [ ] **Step 1: Write the failing PRNG test**

`packages/engine/src/state/prng.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makePrng, nextFloat, nextUint32 } from "./prng.js";

describe("makePrng", () => {
  it("is a pure function of the seed", () => {
    expect(makePrng(42)).toEqual(makePrng(42));
    expect(makePrng(42)).not.toEqual(makePrng(43));
  });

  it("never produces the all-zero state, which would be a fixed point", () => {
    const s = makePrng(0);
    expect(s.a | s.b | s.c | s.d).not.toBe(0);
  });
});

describe("nextUint32", () => {
  it("returns unsigned 32-bit integers", () => {
    let state = makePrng(7);
    for (let i = 0; i < 500; i += 1) {
      const step = nextUint32(state);
      expect(Number.isInteger(step.value)).toBe(true);
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThanOrEqual(0xffffffff);
      state = step.state;
    }
  });

  it("is deterministic - the same seed replays the same stream", () => {
    const draw = (seed: number, n: number): number[] => {
      let state = makePrng(seed);
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const step = nextUint32(state);
        out.push(step.value);
        state = step.state;
      }
      return out;
    };
    expect(draw(1234, 20)).toEqual(draw(1234, 20));
    expect(draw(1234, 20)).not.toEqual(draw(1235, 20));
  });

  it("does not mutate the state it is given", () => {
    const state = makePrng(99);
    const snapshot = { ...state };
    nextUint32(state);
    expect(state).toEqual(snapshot);
  });
});

describe("nextFloat", () => {
  it("stays in [0, 1) and covers the range", () => {
    let state = makePrng(5);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 2000; i += 1) {
      const step = nextFloat(state);
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(1);
      min = Math.min(min, step.value);
      max = Math.max(max, step.value);
      state = step.state;
    }
    expect(min).toBeLessThan(0.02);
    expect(max).toBeGreaterThan(0.98);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test prng`
Expected: FAIL — `Cannot find module './prng.js'`.

- [ ] **Step 3: Write the PRNG**

`packages/engine/src/state/prng.ts`:

```ts
// Spec A.5: no Math.random anywhere in the engine. A seeded PRNG is passed
// explicitly and its state is part of the save, so a replay reproduces a session
// exactly (spec E.4).
//
// xoshiro128** with a splitmix32 seeder. Every operation is integer arithmetic --
// Math.imul, shifts, XOR -- so the stream is byte-identical on every platform and
// Node version. No transcendentals, per spec E.4's libm hazard.

export interface PrngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

function splitmix32(seed: number): { value: number; seed: number } {
  const advanced = (seed + 0x9e3779b9) | 0;
  let x = advanced;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return { value: x >>> 0, seed: advanced };
}

export function makePrng(seed: number): PrngState {
  let s = seed | 0;
  const draw = (): number => {
    const step = splitmix32(s);
    s = step.seed;
    return step.value;
  };
  const a = draw();
  const b = draw();
  const c = draw();
  const d = draw();
  // The all-zero state is a fixed point of xoshiro; nudge it if it ever appears.
  if ((a | b | c | d) === 0) return { a: 1, b: 2, c: 3, d: 4 };
  return { a, b, c, d };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function nextUint32(state: PrngState): { value: number; state: PrngState } {
  const value = Math.imul(rotl(Math.imul(state.b, 5) >>> 0, 7), 9) >>> 0;
  const t = (state.b << 9) >>> 0;
  let c = (state.c ^ state.a) >>> 0;
  let d = (state.d ^ state.b) >>> 0;
  const b = (state.b ^ c) >>> 0;
  const a = (state.a ^ d) >>> 0;
  c = (c ^ t) >>> 0;
  d = rotl(d, 11);
  return { value, state: { a, b, c, d } };
}

export function nextFloat(state: PrngState): { value: number; state: PrngState } {
  const step = nextUint32(state);
  // Divide by 2^32 rather than multiplying by a decimal literal: exact in float64.
  return { value: step.value / 4294967296, state: step.state };
}
```

- [ ] **Step 4: Run the PRNG test to verify it passes**

Run: `pnpm --filter @manufactory/engine test prng`
Expected: PASS.

- [ ] **Step 5: Write the failing world test**

`packages/engine/src/state/world.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM } from "../content/types.js";
import { indexContent } from "../graph/index-content.js";
import {
  POWER_ENTRY_ID,
  WORLD_SCHEMA_VERSION,
  assignedTotal,
  initialWorld,
  installedAt,
  installedMachines,
  withInstalled,
} from "./world.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

describe("initialWorld", () => {
  it("stamps the schema and content version and the clock it was given", () => {
    const w = initialWorld(content, 42, 1_000);
    expect(w.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(w.contentVersion).toBe("fixture.v1");
    expect(w.lastResolvedAt).toBe(1_000);
    expect(w.tier).toBe(0);
  });

  it("installs the authored starting machines and assignments", () => {
    const w = initialWorld(content, 42, 0);
    expect(installedAt(w, "iron", "miner", 1)).toBe(2);
    expect(installedAt(w, "iron", "constructor", 1)).toBe(1);
    expect(installedMachines(w, "iron", "smelter")).toBe(2);
    expect(w.assignment.mine_iron).toBe(2);
    expect(w.assignment.make_plate).toBe(1);
    expect(assignedTotal(content, w, "iron", "miner")).toBe(2);
  });

  it("pins power to position 1 of the priority list (spec C.4)", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.priority[0]!.id).toBe(POWER_ENTRY_ID);
    expect(w.priority[0]!.kind).toBe("power");
    expect(w.priority[0]!.itemId).toBe(POWER_ITEM);
    expect(w.priority[0]!.mode).toBe("guaranteed");
    expect(w.priority[0]!.targetRate).toBeNull();
  });

  it("builds the rest of the priority list from the authored start block", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.priority.slice(1).map((e) => e.itemId)).toEqual([
      "iron_plate",
      "iron_ingot",
      "iron_ore",
    ]);
    expect(w.priority.every((e) => e.mode === "guaranteed" && !e.paused)).toBe(true);
  });

  it("zeroes every stockpile, level, and reserve", () => {
    const w = initialWorld(content, 42, 0);
    for (const id of content.stockItemIds) {
      expect(w.stored[id]!.toNumber()).toBe(0);
      expect(w.quantum[id]!.toNumber()).toBe(0);
      expect(w.bound[id]!.toNumber()).toBe(0);
      expect(w.lifetime[id]!.toNumber()).toBe(0);
      expect(w.storageLevel[id]).toBe(0);
      expect(w.reserve[id]).toBe(0);
    }
    expect(w.powerBank.toNumber()).toBe(0);
    expect(w.tapStacks).toBe(0);
    expect(w.timers).toEqual([]);
    for (const lane of content.lanes.keys()) expect(w.qsLevel[lane]).toBe(0);
  });

  it("does not give the power item a stockpile", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.stored[POWER_ITEM]).toBeUndefined();
  });

  it("selects the default recipe for every item", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.activeRecipe.iron_plate).toBe("make_plate");
    expect(w.activeRecipe[POWER_ITEM]).toBe("burn_fuel");
  });

  it("seeds the PRNG from the seed argument", () => {
    expect(initialWorld(content, 7, 0).seed).toEqual(initialWorld(content, 7, 0).seed);
    expect(initialWorld(content, 7, 0).seed).not.toEqual(initialWorld(content, 8, 0).seed);
  });
});

describe("withInstalled", () => {
  it("returns a new state and leaves the original untouched", () => {
    const w = initialWorld(content, 1, 0);
    const next = withInstalled(w, "iron", "miner", 2, 5);
    expect(installedAt(next, "iron", "miner", 2)).toBe(5);
    expect(installedAt(w, "iron", "miner", 2)).toBe(0);
    expect(installedAt(next, "iron", "miner", 1)).toBe(2);
    expect(installedMachines(next, "iron", "miner")).toBe(7);
  });

  it("creates the lane and class buckets on demand", () => {
    const w = initialWorld(content, 1, 0);
    const next = withInstalled(w, "oil", "refinery", 1, 3);
    expect(installedAt(next, "oil", "refinery", 1)).toBe(3);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test world`
Expected: FAIL — `Cannot find module './world.js'`.

- [ ] **Step 7: Write the world module**

`packages/engine/src/state/world.ts`:

```ts
// Spec C.1's state shape, plus two fields C.1 does not list and the reason for each:
//   tier       -- ruling R7 records milestone progress here.
//   tapStacks  -- spec C.6's step function needs a stack count; its expiry is a
//                 timer, so the two together are the whole tap state.
// powerBank is listed in C.1 and carried here, but stays zero in Phase 1: spec 6.2's
// Power Storage is a purchasable and spec D.1's action set has no way to buy one, so
// it lands with Spec 2.
import { D, DECIMAL_ZERO, type Dec } from "../numbers/decimal.js";
import {
  POWER_ITEM,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type RecipeId,
} from "../content/types.js";
import { laneClassKey, type IndexedContent } from "../graph/index-content.js";
import { makePrng, type PrngState } from "./prng.js";

export const WORLD_SCHEMA_VERSION = 1;
export const POWER_ENTRY_ID = "power";

export type PriorityKind = "power" | "item";
export type PriorityMode = "guaranteed" | "share";

export interface PriorityEntry {
  id: string;
  kind: PriorityKind;
  itemId: ItemId | null;
  mode: PriorityMode;
  /** Weight within the share group. Ignored while mode is "guaranteed". */
  share: number;
  /** Items per second ceiling; null means unbounded. */
  targetRate: number | null;
  paused: boolean;
}

export type TimerKind = "tapExpiry";

export interface Timer {
  id: string;
  kind: TimerKind;
  /** Absolute world time in ms, on the same clock as lastResolvedAt. */
  fireAt: number;
}

export interface WorldState {
  schemaVersion: number;
  contentVersion: string;
  seed: PrngState;
  tier: number;
  /** installed[lane][class][mark - 1]. Spec B.2's single counter. */
  installed: Record<LaneId, Record<MachineClassId, number[]>>;
  assignment: Record<RecipeId, number>;
  activeRecipe: Record<ItemId, RecipeId>;
  stored: Record<ItemId, Dec>;
  quantum: Record<ItemId, Dec>;
  /** Above the QS cap. Spendable on builds only (spec D4). */
  bound: Record<ItemId, Dec>;
  storageLevel: Record<ItemId, number>;
  qsLevel: Record<LaneId, number>;
  reserve: Record<ItemId, number>;
  priority: PriorityEntry[];
  powerBank: Dec;
  tapStacks: number;
  /** Sorted by fireAt, ties broken by id (spec A.5's canonical event ordering). */
  timers: Timer[];
  lifetime: Record<ItemId, Dec>;
  lastResolvedAt: number;
}

export function installedAt(
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
  mark: number,
): number {
  return state.installed[lane]?.[machineClass]?.[mark - 1] ?? 0;
}

export function installedMachines(
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const marks = state.installed[lane]?.[machineClass];
  if (!marks) return 0;
  let total = 0;
  for (const count of marks) total += count ?? 0;
  return total;
}

export function withInstalled(
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
  mark: number,
  count: number,
): WorldState {
  const laneBucket = { ...(state.installed[lane] ?? {}) };
  const marks = [...(laneBucket[machineClass] ?? [])];
  while (marks.length < mark) marks.push(0);
  marks[mark - 1] = count;
  laneBucket[machineClass] = marks;
  return { ...state, installed: { ...state.installed, [lane]: laneBucket } };
}

export function assignedTotal(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  let total = 0;
  for (const recipeId of content.recipesByLaneClass.get(laneClassKey(lane, machineClass)) ?? []) {
    total += state.assignment[recipeId] ?? 0;
  }
  return total;
}

export function initialWorld(content: IndexedContent, seed: number, nowMs: number): WorldState {
  const stored: Record<ItemId, Dec> = {};
  const quantum: Record<ItemId, Dec> = {};
  const bound: Record<ItemId, Dec> = {};
  const lifetime: Record<ItemId, Dec> = {};
  const storageLevel: Record<ItemId, number> = {};
  const reserve: Record<ItemId, number> = {};
  for (const id of content.stockItemIds) {
    stored[id] = DECIMAL_ZERO;
    quantum[id] = DECIMAL_ZERO;
    bound[id] = DECIMAL_ZERO;
    lifetime[id] = DECIMAL_ZERO;
    storageLevel[id] = 0;
    reserve[id] = 0;
  }

  const qsLevel: Record<LaneId, number> = {};
  for (const laneId of content.lanes.keys()) qsLevel[laneId] = 0;

  let state: WorldState = {
    schemaVersion: WORLD_SCHEMA_VERSION,
    contentVersion: content.bundle.version,
    seed: makePrng(seed),
    tier: content.bundle.start.tier,
    installed: {},
    assignment: { ...content.bundle.start.assignments },
    activeRecipe: { ...content.defaultActiveRecipe },
    stored,
    quantum,
    bound,
    storageLevel,
    qsLevel,
    reserve,
    // Spec C.4: power sits at position 1 by default. It is an ordinary entry the
    // player may move, so nothing downstream assumes index 0.
    priority: [
      {
        id: POWER_ENTRY_ID,
        kind: "power",
        itemId: POWER_ITEM,
        mode: "guaranteed",
        share: 1,
        targetRate: null,
        paused: false,
      },
      ...content.bundle.start.priority.map((itemId) => ({
        id: `item:${itemId}`,
        kind: "item" as const,
        itemId,
        mode: "guaranteed" as const,
        share: 1,
        targetRate: null,
        paused: false,
      })),
    ],
    powerBank: D(0),
    tapStacks: 0,
    timers: [],
    lifetime,
    lastResolvedAt: nowMs,
  };

  for (const machine of content.bundle.start.machines) {
    state = withInstalled(
      state,
      machine.lane,
      machine.machineClass,
      machine.mark,
      installedAt(state, machine.lane, machine.machineClass, machine.mark) + machine.count,
    );
  }
  return state;
}
```

- [ ] **Step 8: Run the world test to verify it passes**

Run: `pnpm --filter @manufactory/engine test world`
Expected: PASS.

- [ ] **Step 9: Write the failing serialization test**

`packages/engine/src/state/serialize.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { deserializeWorld, serializeWorld } from "./serialize.js";
import { initialWorld, type WorldState } from "./world.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

function populated(): WorldState {
  const w = initialWorld(content, 42, 1_700_000_000_000);
  return {
    ...w,
    tier: 2,
    stored: { ...w.stored, iron_plate: D("1.2345e678"), iron_ore: D(500) },
    bound: { ...w.bound, iron_plate: D("4.01e9") },
    tapStacks: 3,
    timers: [{ id: "tap", kind: "tapExpiry", fireAt: 1_700_000_030_000 }],
    lifetime: { ...w.lifetime, iron_plate: D("9.87e12") },
  };
}

describe("serializeWorld", () => {
  it("round-trips every field", () => {
    const w = populated();
    const back = deserializeWorld(serializeWorld(w));
    expect(back.schemaVersion).toBe(w.schemaVersion);
    expect(back.contentVersion).toBe(w.contentVersion);
    expect(back.tier).toBe(2);
    expect(back.seed).toEqual(w.seed);
    expect(back.installed).toEqual(w.installed);
    expect(back.assignment).toEqual(w.assignment);
    expect(back.activeRecipe).toEqual(w.activeRecipe);
    expect(back.priority).toEqual(w.priority);
    expect(back.timers).toEqual(w.timers);
    expect(back.tapStacks).toBe(3);
    expect(back.lastResolvedAt).toBe(w.lastResolvedAt);
  });

  it("round-trips magnitudes far past float64 exactly", () => {
    const back = deserializeWorld(serializeWorld(populated()));
    expect(back.stored.iron_plate!.toString()).toBe(D("1.2345e678").toString());
    expect(back.bound.iron_plate!.toString()).toBe(D("4.01e9").toString());
    expect(back.lifetime.iron_plate!.toString()).toBe(D("9.87e12").toString());
  });

  it("writes Decimals as canonical strings, never as JSON numbers", () => {
    const text = serializeWorld(populated());
    expect(text).toContain('"iron_plate":"1.2345e678"');
    expect(text).not.toContain("1.2345e+678");
  });

  it("is byte-stable across repeated calls", () => {
    const w = populated();
    expect(serializeWorld(w)).toBe(serializeWorld(w));
  });

  it("does not depend on key insertion order", () => {
    const w = populated();
    const shuffled: WorldState = { ...w, stored: { iron_ore: w.stored.iron_ore!, ...w.stored } };
    expect(serializeWorld(shuffled)).toBe(serializeWorld(w));
  });

  it("is idempotent under a second round trip", () => {
    const once = serializeWorld(populated());
    expect(serializeWorld(deserializeWorld(once))).toBe(once);
  });

  it("rejects a payload from a different schema version", () => {
    const text = serializeWorld(populated()).replace('"schemaVersion":1', '"schemaVersion":99');
    expect(() => deserializeWorld(text)).toThrow(/schema version/i);
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test serialize`
Expected: FAIL — `Cannot find module './serialize.js'`.

- [ ] **Step 11: Write the serializer**

`packages/engine/src/state/serialize.ts`:

```ts
// Spec A.5: Decimals persist as canonical strings, never as JSON numbers, and the
// output must be byte-stable so two processes agree on a save's identity. Object
// keys are emitted in sorted order for that reason; arrays keep their order, which
// is meaningful for `priority` and for `installed`'s per-mark counts.
import { fromCanonical, toCanonical, type Dec } from "../numbers/decimal.js";
import type { ItemId, LaneId } from "../content/types.js";
import { WORLD_SCHEMA_VERSION, type WorldState } from "./world.js";

function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

function encodeDecimals(record: Record<string, Dec>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of sortedKeys(record)) out[key] = toCanonical(record[key]!);
  return out;
}

function decodeDecimals(record: Record<string, string>): Record<string, Dec> {
  const out: Record<string, Dec> = {};
  for (const key of sortedKeys(record)) out[key] = fromCanonical(record[key]!);
  return out;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of sortedKeys(record)) out[key] = record[key]!;
  return out;
}

function sortInstalled(installed: WorldState["installed"]): Record<string, Record<string, number[]>> {
  const out: Record<string, Record<string, number[]>> = {};
  for (const lane of sortedKeys(installed)) out[lane] = sortRecord(installed[lane]!);
  return out;
}

export function serializeWorld(state: WorldState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    contentVersion: state.contentVersion,
    seed: state.seed,
    tier: state.tier,
    installed: sortInstalled(state.installed),
    assignment: sortRecord(state.assignment),
    activeRecipe: sortRecord(state.activeRecipe),
    stored: encodeDecimals(state.stored),
    quantum: encodeDecimals(state.quantum),
    bound: encodeDecimals(state.bound),
    storageLevel: sortRecord(state.storageLevel),
    qsLevel: sortRecord(state.qsLevel),
    reserve: sortRecord(state.reserve),
    priority: state.priority,
    powerBank: toCanonical(state.powerBank),
    tapStacks: state.tapStacks,
    timers: state.timers,
    lifetime: encodeDecimals(state.lifetime),
    lastResolvedAt: state.lastResolvedAt,
  });
}

interface WirePayload {
  schemaVersion: number;
  contentVersion: string;
  seed: WorldState["seed"];
  tier: number;
  installed: Record<LaneId, Record<string, number[]>>;
  assignment: Record<string, number>;
  activeRecipe: Record<ItemId, string>;
  stored: Record<string, string>;
  quantum: Record<string, string>;
  bound: Record<string, string>;
  storageLevel: Record<string, number>;
  qsLevel: Record<string, number>;
  reserve: Record<string, number>;
  priority: WorldState["priority"];
  powerBank: string;
  tapStacks: number;
  timers: WorldState["timers"];
  lifetime: Record<string, string>;
  lastResolvedAt: number;
}

export function deserializeWorld(text: string): WorldState {
  const wire = JSON.parse(text) as WirePayload;
  if (wire.schemaVersion !== WORLD_SCHEMA_VERSION) {
    throw new Error(
      `unsupported world schema version ${wire.schemaVersion}, expected ${WORLD_SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: wire.schemaVersion,
    contentVersion: wire.contentVersion,
    seed: wire.seed,
    tier: wire.tier,
    installed: wire.installed,
    assignment: wire.assignment,
    activeRecipe: wire.activeRecipe,
    stored: decodeDecimals(wire.stored),
    quantum: decodeDecimals(wire.quantum),
    bound: decodeDecimals(wire.bound),
    storageLevel: wire.storageLevel,
    qsLevel: wire.qsLevel,
    reserve: wire.reserve,
    priority: wire.priority,
    powerBank: fromCanonical(wire.powerBank),
    tapStacks: wire.tapStacks,
    timers: wire.timers,
    lifetime: decodeDecimals(wire.lifetime),
    lastResolvedAt: wire.lastResolvedAt,
  };
}
```

- [ ] **Step 12: Export the sub-barrel and add it to the package barrel**

`packages/engine/src/state/index.ts`:

```ts
export * from "./prng.js";
export * from "./world.js";
export * from "./serialize.js";
```

Add one line to `packages/engine/src/index.ts`, after the `graph` line:

```ts
export * from "./state/index.js";
```

- [ ] **Step 13: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the seeded PRNG, WorldState, and canonical serialization

xoshiro128** with a splitmix32 seeder: integer arithmetic only, so the
stream is byte-identical across platforms and Node versions, which spec
E.4's replay comparison depends on. WorldState follows spec C.1 and adds
tier (ruling R7) and tapStacks (spec C.6). Serialization emits Decimals as
canonical strings and sorts object keys so a save is byte-stable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 5: Cost curves, the purchase ladder, and softcaps

**Files:**
- Create: `packages/engine/src/economy/curves.ts`, `packages/engine/src/economy/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/economy/curves.test.ts`

**Interfaces:**
- Consumes: `D`, `type Dec`, `DECIMAL_ZERO` (Phase 0 Task 2); `type SoftcapDef`, `type StorageCurveDef`, `type ItemId`, `type LaneId`, `type MachineClassId` (Task 2); `type IndexedContent`, `getMark` (Task 2); `type WorldState`, `installedAt` (Task 4)
- Produces, from `@manufactory/engine`:
  - `powIntNumber(base: number, exponent: number): number`
  - `powIntDecimal(base: number, exponent: number): Dec`
  - `softcap(value: number, cap: SoftcapDef): number`
  - `ladderInput(content: IndexedContent, state: WorldState, lane: LaneId, machineClass: MachineClassId): number`
  - `ladderMultiplier(content: IndexedContent, state: WorldState, lane: LaneId, machineClass: MachineClassId): number`
  - `laneMultiplier(content: IndexedContent, tier: number, lane: LaneId): number`
  - `tapMultiplier(content: IndexedContent, state: WorldState): number`
  - `combinedMultiplier(content: IndexedContent, parts: readonly number[]): number`
  - `machineCostRange(content: IndexedContent, machineClass: MachineClassId, mark: number, fromCount: number, count: number): Map<ItemId, Dec>`
  - `levelCostRange(curve: StorageCurveDef, fromLevel: number, levels: number): Map<ItemId, Dec>`
  - `capAtLevel(base: number, curve: StorageCurveDef, level: number): Dec`

Three determinism rules from spec E.4 govern this whole file and there is no exception to any of them:

1. **Cost curves are `base × r^n` with integer `n`**, so they are evaluated by exponentiation by squaring. `Math.pow` is libm-dependent and varies by platform and Node version; squaring is `×` only, which IEEE-754 guarantees identically everywhere.
2. **The ladder multiplier is stepped, not continuous.** Spec B.3 authors it as "×1.5 every 10 machines", which is `step^floor(n / interval)` — an integer exponent again. A continuous `step^(n/interval)` would need a fractional power and is forbidden.
3. **Softcaps are piecewise-linear, not a power law** (spec D3 says so explicitly, for this reason). Above `threshold`, each further unit counts for `slope` units.

Spec B.2: the ladder counts **mark-weighted** equivalents, `Σ_mark installed[mark] × rateMultiplier(mark)`. Spec C.0 derives why this is mandatory rather than cosmetic — counting raw machines would collapse the ladder from ×5.06 to ×1.5 when 45 Mk1 consolidate into 15 Mk2, output would drop 3.4×, and nobody would ever upgrade.

`MarkDef.buildCost` is the authored **absolute** cost at `n = 0` for that mark. `MarkDef.buildCostMultiplier` is metadata for spec C.0's pace analysis and Phase 2's validator check 8; the engine reads `buildCost` directly and never multiplies by it.

`r_eff = r / m` is deliberately **not** implemented here. Computing `m` per machine needs `step^(1/interval)`, a fractional power. It is a reporting figure only, so it lives in `apps/sim/src/report.ts` (Task 15) where `Math.pow` is allowed.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/economy/curves.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import {
  capAtLevel,
  combinedMultiplier,
  ladderInput,
  ladderMultiplier,
  laneMultiplier,
  levelCostRange,
  machineCostRange,
  powIntDecimal,
  powIntNumber,
  softcap,
  tapMultiplier,
} from "./curves.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

describe("powIntNumber", () => {
  it("is exact on exact inputs", () => {
    expect(powIntNumber(2, 10)).toBe(1024);
    expect(powIntNumber(3, 5)).toBe(243);
    expect(powIntNumber(1.5, 2)).toBe(2.25);
  });

  it("returns 1 for exponent 0, including base 0", () => {
    expect(powIntNumber(1.09, 0)).toBe(1);
    expect(powIntNumber(0, 0)).toBe(1);
  });

  it("matches the hand-computed value of 1.09^10", () => {
    // 1.09^2 = 1.1881, ^4 = 1.41158161, ^5 = 1.5386239549, ^10 = 2.3673636746
    expect(powIntNumber(1.09, 10)).toBeCloseTo(2.3673636746, 9);
  });

  it("rejects a negative or non-integer exponent", () => {
    expect(() => powIntNumber(2, -1)).toThrow();
    expect(() => powIntNumber(2, 1.5)).toThrow();
  });
});

describe("powIntDecimal", () => {
  it("agrees with powIntNumber inside float64 range", () => {
    expect(powIntDecimal(2, 10).toNumber()).toBe(1024);
    expect(powIntDecimal(1.09, 10).toNumber()).toBeCloseTo(2.3673636746, 9);
  });

  it("survives magnitudes float64 cannot hold", () => {
    // 1.09^10000 is roughly 1e371, comfortably past float64's 1.8e308.
    expect(powIntDecimal(1.09, 10000).exponent).toBeGreaterThan(350);
    expect(Number.isFinite(powIntDecimal(1.09, 10000).exponent)).toBe(true);
  });

  it("is bitwise repeatable, which LIFO refund symmetry depends on", () => {
    expect(powIntDecimal(1.09, 137).toString()).toBe(powIntDecimal(1.09, 137).toString());
  });
});

describe("softcap", () => {
  it("passes values below the threshold straight through", () => {
    expect(softcap(30, { threshold: 50, slope: 0.25 })).toBe(30);
    expect(softcap(50, { threshold: 50, slope: 0.25 })).toBe(50);
  });

  it("charges the slope above the threshold", () => {
    // 50 + (100 - 50) * 0.25 = 62.5
    expect(softcap(100, { threshold: 50, slope: 0.25 })).toBe(62.5);
    // 50 + (250 - 50) * 0.25 = 100
    expect(softcap(250, { threshold: 50, slope: 0.25 })).toBe(100);
  });

  it("stays monotonic — a softcap slows growth, it never caps or reverses it", () => {
    const cap = { threshold: 50, slope: 0.25 };
    let previous = 0;
    for (let x = 0; x < 500; x += 7) {
      const y = softcap(x, cap);
      expect(y).toBeGreaterThan(previous);
      previous = y;
    }
  });
});

describe("ladderInput and ladderMultiplier", () => {
  function stacked(): WorldState {
    // 8 Mk1 (rate x1) + 4 Mk2 (rate x3) = 12 machines, 20 mark-weighted units.
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "iron", "miner", 1, 8);
    w = withInstalled(w, "iron", "miner", 2, 4);
    return w;
  }

  it("weights the count by each mark's rate multiplier (spec B.2, C.0)", () => {
    expect(ladderInput(content, stacked(), "iron", "miner")).toBe(20);
  });

  it("steps the multiplier every `interval` weighted machines", () => {
    // ladder is x1.5 every 10; floor(20 / 10) = 2, so 1.5^2 = 2.25.
    expect(ladderMultiplier(content, stacked(), "iron", "miner")).toBeCloseTo(2.25, 12);
  });

  it("is 1 below the first threshold — the fixture starts with 2 miners", () => {
    const w = initialWorld(content, 1, 0);
    expect(ladderInput(content, w, "iron", "miner")).toBe(2);
    expect(ladderMultiplier(content, w, "iron", "miner")).toBe(1);
  });

  it("does not reset when a mark upgrade consolidates machines (spec B.2)", () => {
    // 45 Mk1 -> ladderInput 45 -> floor(4.5) = 4 -> 1.5^4 = 5.0625.
    // 15 Mk2 -> ladderInput 45 -> identical. That is the whole point.
    let raw = initialWorld(content, 1, 0);
    raw = withInstalled(raw, "iron", "miner", 1, 45);
    let upgraded = initialWorld(content, 1, 0);
    upgraded = withInstalled(upgraded, "iron", "miner", 1, 0);
    upgraded = withInstalled(upgraded, "iron", "miner", 2, 15);
    expect(ladderInput(content, raw, "iron", "miner")).toBe(45);
    expect(ladderInput(content, upgraded, "iron", "miner")).toBe(45);
    expect(ladderMultiplier(content, upgraded, "iron", "miner")).toBeCloseTo(5.0625, 12);
  });

  it("returns 1 for a lane-class with nothing installed", () => {
    expect(ladderMultiplier(content, initialWorld(content, 1, 0), "oil", "refinery")).toBe(1);
  });
});

describe("laneMultiplier", () => {
  it("is 1 before any milestone", () => {
    expect(laneMultiplier(content, 0, "iron")).toBe(1);
  });

  it("compounds every unlocked milestone's lane grant", () => {
    // Tier 1 grants iron x1.5; tier 2 grants iron x1.5 and oil x1.5.
    expect(laneMultiplier(content, 1, "iron")).toBeCloseTo(1.5, 12);
    expect(laneMultiplier(content, 2, "iron")).toBeCloseTo(2.25, 12);
    expect(laneMultiplier(content, 2, "oil")).toBeCloseTo(1.5, 12);
    // Tier 3 grants oil x1.5 again and nothing to iron.
    expect(laneMultiplier(content, 3, "iron")).toBeCloseTo(2.25, 12);
    expect(laneMultiplier(content, 3, "oil")).toBeCloseTo(2.25, 12);
  });
});

describe("tapMultiplier", () => {
  it("is 1 with no stacks", () => {
    expect(tapMultiplier(content, initialWorld(content, 1, 0))).toBe(1);
  });

  it("adds kickPerStack per stack as a step, not a curve (spec C.6)", () => {
    const w = { ...initialWorld(content, 1, 0), tapStacks: 3 };
    // 1 + 3 * 0.05 = 1.15
    expect(tapMultiplier(content, w)).toBeCloseTo(1.15, 12);
  });

  it("clamps to maxStacks, landing at spec 16.4's 1.5x active hour", () => {
    const w = { ...initialWorld(content, 1, 0), tapStacks: 99 };
    expect(tapMultiplier(content, w)).toBeCloseTo(1.5, 12);
  });
});

describe("combinedMultiplier", () => {
  it("multiplies the parts when the product is under the threshold", () => {
    // 2.25 * 2.25 * 1.5 = 7.59375, well under the product threshold of 5000.
    expect(combinedMultiplier(content, [2.25, 2.25, 1.5])).toBeCloseTo(7.59375, 12);
  });

  it("applies the product softcap on top of the per-category ones (spec D3)", () => {
    // 100 * 100 = 10000 > 5000, so 5000 + (10000 - 5000) * 0.2 = 6000.
    expect(combinedMultiplier(content, [100, 100])).toBeCloseTo(6000, 9);
  });

  it("is 1 for an empty stack", () => {
    expect(combinedMultiplier(content, [])).toBe(1);
  });
});

describe("machineCostRange", () => {
  it("sums the geometric run of costs for a batch purchase", () => {
    // Constructor mk1 costs 20 iron_plate at n=0, r = 1.09.
    // n=0, count=3: 20 * (1 + 1.09 + 1.1881) = 20 * 3.2781 = 65.562
    const cost = machineCostRange(content, "constructor", 1, 0, 3);
    expect(cost.get("iron_plate")!.toNumber()).toBeCloseTo(65.562, 6);
  });

  it("charges more further up the curve", () => {
    // n=3, count=2: 20 * (1.09^3 + 1.09^4) = 20 * (1.295029 + 1.41158161)
    //             = 20 * 2.70661061 = 54.1322122
    const cost = machineCostRange(content, "constructor", 1, 3, 2);
    expect(cost.get("iron_plate")!.toNumber()).toBeCloseTo(54.1322122, 6);
  });

  it("is bitwise symmetric, which LIFO dismantle refunds depend on (spec D4)", () => {
    const bought = machineCostRange(content, "constructor", 1, 0, 3);
    const refunded = machineCostRange(content, "constructor", 1, 0, 3);
    expect(refunded.get("iron_plate")!.toString()).toBe(bought.get("iron_plate")!.toString());
  });

  it("uses the mark's own absolute build cost, so the curve resets per mark", () => {
    // Miner mk1 costs 10 plate, mk2 costs 30. Both start at n=0 on their own curve.
    expect(machineCostRange(content, "miner", 1, 0, 1).get("iron_plate")!.toNumber()).toBe(10);
    expect(machineCostRange(content, "miner", 2, 0, 1).get("iron_plate")!.toNumber()).toBe(30);
  });

  it("uses the class's own cost ratio", () => {
    // Refinery mk1 costs 120 plate at r = 1.12. n=0, count=2: 120 * (1 + 1.12) = 254.4
    const cost = machineCostRange(content, "refinery", 1, 0, 2);
    expect(cost.get("iron_plate")!.toNumber()).toBeCloseTo(254.4, 6);
  });

  it("returns an empty map for a zero count", () => {
    expect(machineCostRange(content, "miner", 1, 0, 0).size).toBe(0);
  });

  it("throws on an unknown class or mark, rather than silently costing nothing", () => {
    expect(() => machineCostRange(content, "ghost", 1, 0, 1)).toThrow(/ghost/);
    expect(() => machineCostRange(content, "miner", 9, 0, 1)).toThrow(/mk9/);
  });
});

describe("levelCostRange and capAtLevel", () => {
  it("sums the geometric run of level costs", () => {
    // storage: baseCostAmount 50, costGrowth 2. Levels 0..2: 50 * (1 + 2 + 4) = 350
    const cost = levelCostRange(content.bundle.storage, 0, 3);
    expect(cost.get("iron_plate")!.toNumber()).toBeCloseTo(350, 9);
    // Levels 2..3: 50 * (4 + 8) = 600
    expect(levelCostRange(content.bundle.storage, 2, 2).get("iron_plate")!.toNumber()).toBeCloseTo(
      600,
      9,
    );
  });

  it("costs nothing when the curve names no item", () => {
    const free = { ...content.bundle.storage, baseCostItem: null };
    expect(levelCostRange(free, 0, 5).size).toBe(0);
  });

  it("grows the cap geometrically per level", () => {
    // 600 * 1.6^2 = 1536
    expect(capAtLevel(600, content.bundle.storage, 2).toNumber()).toBeCloseTo(1536, 6);
    expect(capAtLevel(600, content.bundle.storage, 0).toNumber()).toBe(600);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test curves`
Expected: FAIL — `Cannot find module './curves.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/economy/curves.ts`:

```ts
// Spec D3's four levers, and the determinism rules spec E.4 imposes on them.
//
// Math.pow, exp and log are libm-dependent and vary by platform and Node version.
// A game built on r^n walks straight into that, so every exponent here is an
// integer and every power is evaluated by squaring, which is `*` only. Softcaps are
// piecewise-linear rather than T*(M/T)^p for the same reason. The formatter in
// numbers/format.ts uses Math.pow; it is display-only and exempt. Nothing in this
// file may follow its example.
import { D, DECIMAL_ZERO, type Dec } from "../numbers/decimal.js";
import type {
  ItemId,
  LaneId,
  MachineClassId,
  SoftcapDef,
  StorageCurveDef,
} from "../content/types.js";
import { getMark, type IndexedContent } from "../graph/index-content.js";
import { installedAt, type WorldState } from "../state/world.js";

function assertExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new Error(`exponent must be a non-negative integer, got ${exponent}`);
  }
}

/** base^exponent by squaring, in float64. Exact and platform-stable. */
export function powIntNumber(base: number, exponent: number): number {
  assertExponent(exponent);
  let result = 1;
  let factor = base;
  let n = exponent;
  while (n > 0) {
    if ((n & 1) === 1) result *= factor;
    factor *= factor;
    n >>>= 1;
  }
  return result;
}

/** base^exponent by squaring, in Decimal. Costs reach 1e600 and beyond. */
export function powIntDecimal(base: number, exponent: number): Dec {
  assertExponent(exponent);
  let result = D(1);
  let factor = D(base);
  let n = exponent;
  while (n > 0) {
    if ((n & 1) === 1) result = result.times(factor);
    factor = factor.times(factor);
    n >>>= 1;
  }
  return result;
}

/**
 * Spec D3: applied per multiplier category and again on the product, so neither one
 * system nor the four stacking can drive r_eff below 1. Piecewise-linear, so it is
 * monotonic (it never hard-caps, which spec 16.6 forbids) and deterministic.
 */
export function softcap(value: number, cap: SoftcapDef): number {
  if (value <= cap.threshold) return value;
  return cap.threshold + (value - cap.threshold) * cap.slope;
}

/**
 * Spec B.2: the ladder counts mark-weighted equivalents, not raw machines. Spec C.0
 * derives why: counting raw machines would collapse the ladder on consolidation and
 * nobody would ever buy a mark upgrade.
 */
export function ladderInput(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return 0;
  let total = 0;
  for (const mark of cls.marks) {
    total += installedAt(state, lane, machineClass, mark.mark) * mark.rateMultiplier;
  }
  return total;
}

/**
 * Spec B.3: stepped, not continuous. `step^floor(n / interval)` keeps a visible
 * threshold to grind toward and keeps the exponent an integer.
 */
export function ladderMultiplier(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return 1;
  const steps = Math.floor(ladderInput(content, state, lane, machineClass) / cls.ladder.interval);
  const raw = powIntNumber(cls.ladder.step, Math.max(0, steps));
  return softcap(raw, content.bundle.softcaps.ladder);
}

/** Spec D3 lever 3: discrete lane-wide grants, compounded over unlocked milestones. */
export function laneMultiplier(
  content: IndexedContent,
  tier: number,
  lane: LaneId,
): number {
  let product = 1;
  for (const milestone of content.bundle.milestones) {
    if (milestone.tier > tier) continue;
    product *= milestone.laneMultipliers[lane] ?? 1;
  }
  return softcap(product, content.bundle.softcaps.lane);
}

/**
 * Spec C.6: a step function, not a decaying curve. Continuously varying rates would
 * break the piecewise-constant assumption the whole event model rests on.
 */
export function tapMultiplier(content: IndexedContent, state: WorldState): number {
  const tap = content.bundle.tap;
  const stacks = Math.max(0, Math.min(state.tapStacks, tap.maxStacks));
  return softcap(1 + stacks * tap.kickPerStack, content.bundle.softcaps.tap);
}

/** The product softcap from spec D3, applied on top of the per-category ones. */
export function combinedMultiplier(
  content: IndexedContent,
  parts: readonly number[],
): number {
  let product = 1;
  for (const part of parts) product *= part;
  return softcap(product, content.bundle.softcaps.product);
}

/**
 * cost(n) = base * r^n, summed over [fromCount, fromCount + count).
 *
 * Evaluated as the closed-form geometric sum base * r^from * (r^count - 1)/(r - 1),
 * which matters for more than speed: buying `count` machines starting at n and
 * refunding those same `count` machines both call this with identical arguments, so
 * the two results are bitwise equal and spec D4's LIFO symmetry is exact rather
 * than approximate.
 *
 * `mark.buildCost` is the absolute cost at n = 0 for that mark, so the curve resets
 * on a new mark, which is the staircase in spec D3. `mark.buildCostMultiplier` is
 * metadata for spec C.0's pace analysis and is deliberately not read here.
 */
export function machineCostRange(
  content: IndexedContent,
  machineClass: MachineClassId,
  mark: number,
  fromCount: number,
  count: number,
): Map<ItemId, Dec> {
  const out = new Map<ItemId, Dec>();
  if (count <= 0) return out;

  const cls = content.machineClasses.get(machineClass);
  if (!cls) throw new Error(`unknown machine class "${machineClass}"`);
  const markDef = getMark(content, machineClass, mark);
  if (!markDef) throw new Error(`machine class "${machineClass}" has no mk${mark}`);

  const r = cls.costRatio;
  const runs = powIntDecimal(r, count).minus(1).div(r - 1);
  const offset = powIntDecimal(r, fromCount);
  const factor = offset.times(runs);

  for (const entry of markDef.buildCost) {
    const amount = D(entry.amount).times(factor);
    out.set(entry.item, (out.get(entry.item) ?? DECIMAL_ZERO).plus(amount));
  }
  return out;
}

/** The same geometric sum for storage and Quantum Storage levels (spec B.4). */
export function levelCostRange(
  curve: StorageCurveDef,
  fromLevel: number,
  levels: number,
): Map<ItemId, Dec> {
  const out = new Map<ItemId, Dec>();
  if (levels <= 0 || curve.baseCostItem === null) return out;
  const runs = powIntDecimal(curve.costGrowth, levels).minus(1).div(curve.costGrowth - 1);
  const factor = powIntDecimal(curve.costGrowth, fromLevel).times(runs);
  out.set(curve.baseCostItem, D(curve.baseCostAmount).times(factor));
  return out;
}

/** cap = base * capGrowth^level (spec 3.3, B.4). */
export function capAtLevel(base: number, curve: StorageCurveDef, level: number): Dec {
  return D(base).times(powIntDecimal(curve.capGrowth, level));
}
```

- [ ] **Step 4: Export it**

`packages/engine/src/economy/index.ts`:

```ts
export * from "./curves.js";
```

Add one line to `packages/engine/src/index.ts`, after the `state` line:

```ts
export * from "./economy/index.js";
```

- [ ] **Step 5: Run the tests, lint, and typecheck**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS. `pnpm lint` must show no `Math.pow` in `economy/`.

- [ ] **Step 6: Verify no transcendental slipped in**

Run:

```bash
grep -rnE "Math\.(pow|exp|log)" packages/engine/src --include="*.ts" | grep -v "numbers/format.ts"
```

Expected: no output. `numbers/format.ts` is the one permitted exception (display only, spec E.4).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add cost curves, the purchase ladder, and piecewise-linear softcaps

Spec E.4's determinism rules in code: every exponent is an integer and
every power is evaluated by squaring, so cost curves are byte-identical
across platforms; softcaps are piecewise-linear rather than a power law.
The ladder is mark-weighted per spec B.2 so a mark upgrade never costs the
player their multiplier. Build costs use the geometric closed form so a
LIFO refund is bitwise equal to what was paid.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 6: Machine capacity — pooling, the multiplier stack, and power draw

**Files:**
- Create: `packages/engine/src/economy/capacity.ts`
- Modify: `packages/engine/src/economy/index.ts`
- Test: `packages/engine/src/economy/capacity.test.ts`

**Interfaces:**
- Consumes: `type IndexedContent`, `isLiveRecipe`, `laneClassKey`, `POWER_ITEM`, `type ItemId`, `type LaneId`, `type MachineClassId`, `type RecipeId` (Task 2); `type WorldState`, `installedAt`, `installedMachines` (Task 4); `ladderMultiplier`, `laneMultiplier`, `tapMultiplier`, `combinedMultiplier` (Task 5)
- Produces, from `@manufactory/engine`:
  - `interface CapacityTable { unitsByRecipe: Map<RecipeId, number>; machinesByRecipe: Map<RecipeId, number>; drawPerMachine: Map<string, number>; multiplierByRecipe: Map<RecipeId, number>; unitsPerMachine: Map<RecipeId, number> }`
  - `installedUnits(content: IndexedContent, state: WorldState, lane: LaneId, machineClass: MachineClassId): number`
  - `bestUnlockedMark(content: IndexedContent, machineClass: MachineClassId, tier: number): number | null`
  - `computeCapacity(content: IndexedContent, state: WorldState): CapacityTable`
  - `unconstrainedRate(content: IndexedContent, capacity: CapacityTable, itemId: ItemId): number`
  - `powerDemandMw(content: IndexedContent, capacity: CapacityTable, state: WorldState, clocks: ReadonlyMap<RecipeId, number>): number`
  - `powerSupplyMw(content: IndexedContent, capacity: CapacityTable, clocks: ReadonlyMap<RecipeId, number>): number`

**Ruling R5 is implemented here and nowhere else.** Original spec section 4.2 computes `capacity[R] = machineCount[R] × baseRate[R]` as though machines are owned per-recipe, while spec B.2 scopes the cost counter and the ladder to `(lane, class, mark)`. Both cannot be true. The resolution:

```
installedMachines[lane][class] = Σ_mark installed[lane][class][mark]
installedUnits[lane][class]    = Σ_mark installed[lane][class][mark] × rateMultiplier(mark)
assignedFraction[R]            = assignment[R] / installedMachines[lane][class]
unitsByRecipe[R] = assignedFraction[R] × installedUnits[lane][class] × multiplierByRecipe[R]
```

Marks are fungible and pooled, so the engine never tracks which physical mark runs which recipe and a mark upgrade automatically lifts every recipe in the lane-class. Unassigned machines are idle and draw no power — which is why `drawPerMachine` is charged against `machinesByRecipe`, the *assigned* machine count, rather than against the whole pool.

`multiplierByRecipe[R] = combinedMultiplier([ladder, lane, tap])`, so spec D3's product softcap applies on top of the per-category softcaps already applied inside each part.

A "machine-unit" is the unit the whole solver works in: one Mk1 machine at clock 1 with no multipliers. Recipe output in items/second is `unitsByRecipe[R] × outputPerSecond[R][item] × clock[R]`.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/economy/capacity.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM } from "../content/types.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import {
  bestUnlockedMark,
  computeCapacity,
  installedUnits,
  powerDemandMw,
  powerSupplyMw,
  unconstrainedRate,
} from "./capacity.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** 8 Mk1 miners (rate x1) plus 4 Mk2 (rate x3): 12 machines, 20 mark-weighted units. */
function pooled(): WorldState {
  let w = initialWorld(content, 1, 0);
  w = withInstalled(w, "iron", "miner", 1, 8);
  w = withInstalled(w, "iron", "miner", 2, 4);
  return { ...w, assignment: { ...w.assignment, mine_iron: 9 } };
}

describe("installedUnits", () => {
  it("weights each mark by its rate multiplier (ruling R5)", () => {
    expect(installedUnits(content, pooled(), "iron", "miner")).toBe(20);
  });

  it("is zero for an empty lane-class", () => {
    expect(installedUnits(content, initialWorld(content, 1, 0), "oil", "refinery")).toBe(0);
  });
});

describe("computeCapacity", () => {
  it("distributes the pooled units by assigned fraction (ruling R5)", () => {
    const cap = computeCapacity(content, pooled());
    // 9 of 12 machines assigned -> 0.75 of 20 units = 15, times the ladder x2.25
    // (ladderInput 20, interval 10, step 1.5) = 33.75.
    expect(cap.machinesByRecipe.get("mine_iron")).toBe(9);
    expect(cap.multiplierByRecipe.get("mine_iron")).toBeCloseTo(2.25, 12);
    expect(cap.unitsByRecipe.get("mine_iron")).toBeCloseTo(33.75, 9);
  });

  it("reports units per additional machine, for bottleneck arithmetic", () => {
    const cap = computeCapacity(content, pooled());
    // One more machine at the best unlocked mark. At tier 0 only Mk1 is unlocked,
    // so rateMultiplier 1 x the 2.25 ladder = 2.25 units per machine.
    expect(cap.unitsPerMachine.get("mine_iron")).toBeCloseTo(2.25, 12);
  });

  it("averages power draw over the pool, per machine (ruling R5)", () => {
    const cap = computeCapacity(content, pooled());
    // (8 x 5 MW + 4 x 15 MW) / 12 machines = 100/12 MW per machine.
    expect(cap.drawPerMachine.get("iron::miner")).toBeCloseTo(100 / 12, 12);
  });

  it("gives an unassigned recipe zero capacity", () => {
    const w = { ...pooled(), assignment: { mine_iron: 0 } };
    expect(computeCapacity(content, w).unitsByRecipe.get("mine_iron")).toBe(0);
  });

  it("gives a locked recipe no capacity even when machines are assigned", () => {
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "oil", "refinery", 1, 4);
    w = { ...w, assignment: { ...w.assignment, refine_plastic: 4 } };
    // refine_plastic unlocks at tier 2; the world is at tier 0.
    expect(computeCapacity(content, w).unitsByRecipe.has("refine_plastic")).toBe(false);
    expect(computeCapacity(content, { ...w, tier: 2 }).unitsByRecipe.get("refine_plastic")).toBe(4);
  });

  it("gives a deselected recipe no capacity (spec 4.4)", () => {
    const w = pooled();
    const deselected = { ...w, activeRecipe: { ...w.activeRecipe, iron_ore: "nothing" } };
    expect(computeCapacity(content, deselected).unitsByRecipe.has("mine_iron")).toBe(false);
  });

  it("scales with the lane multiplier once milestones land", () => {
    const cap = computeCapacity(content, { ...pooled(), tier: 1 });
    // ladder 2.25 x lane 1.5 = 3.375; 15 base units -> 50.625.
    expect(cap.multiplierByRecipe.get("mine_iron")).toBeCloseTo(3.375, 12);
    expect(cap.unitsByRecipe.get("mine_iron")).toBeCloseTo(50.625, 9);
  });

  it("scales with the tap kick", () => {
    const cap = computeCapacity(content, { ...pooled(), tapStacks: 10 });
    // ladder 2.25 x tap 1.5 = 3.375.
    expect(cap.multiplierByRecipe.get("mine_iron")).toBeCloseTo(3.375, 12);
  });
});

describe("bestUnlockedMark", () => {
  it("returns the highest mark unlocked at the tier", () => {
    expect(bestUnlockedMark(content, "miner", 0)).toBe(1);
    expect(bestUnlockedMark(content, "miner", 1)).toBe(2);
    expect(bestUnlockedMark(content, "miner", 5)).toBe(2);
  });

  it("returns null when nothing is unlocked yet", () => {
    expect(bestUnlockedMark(content, "generator", 0)).toBeNull();
    expect(bestUnlockedMark(content, "generator", 3)).toBe(1);
  });
});

describe("unconstrainedRate", () => {
  it("is total production at clock 1 across every live producer", () => {
    const cap = computeCapacity(content, pooled());
    // 33.75 units x 1 ore/s per unit = 33.75 ore/s.
    expect(unconstrainedRate(content, cap, "iron_ore")).toBeCloseTo(33.75, 9);
  });
});

describe("power", () => {
  it("charges draw against assigned machines, weighted by clock", () => {
    const w = pooled();
    const cap = computeCapacity(content, w);
    const clocks = new Map([["mine_iron", 1]]);
    // 9 machines x 100/12 MW = 75 MW at clock 1.
    expect(powerDemandMw(content, cap, w, clocks)).toBeCloseTo(75, 9);
    expect(powerDemandMw(content, cap, w, new Map([["mine_iron", 0.5]]))).toBeCloseTo(37.5, 9);
  });

  it("charges nothing for idle machines", () => {
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "iron", "miner", 1, 10);
    w = { ...w, assignment: { mine_iron: 0 } };
    const cap = computeCapacity(content, w);
    expect(powerDemandMw(content, cap, w, new Map([["mine_iron", 1]]))).toBe(0);
  });

  it("sums generator output plus the HUB allowance and the tap injection", () => {
    let w = initialWorld(content, 1, 3);
    w = { ...w, tier: 3 };
    w = withInstalled(w, "oil", "generator", 1, 2);
    w = { ...w, assignment: { ...w.assignment, burn_fuel: 2 } };
    const cap = computeCapacity(content, w);
    // 2 units x 250 MW at clock 1 = 500, plus the fixture's 200 MW HUB allowance.
    expect(powerSupplyMw(content, cap, new Map([["burn_fuel", 1]]))).toBeCloseTo(700, 9);
    expect(powerSupplyMw(content, cap, new Map([["burn_fuel", 0.4]]))).toBeCloseTo(400, 9);
  });

  it("counts the power item as a generator output, not a stockpile", () => {
    expect(content.stockItemIds).not.toContain(POWER_ITEM);
  });
});
```

Note on the `powerSupplyMw` expectations: the second case is `2 × 250 × 0.4 = 200`, plus the 200 MW HUB allowance, so 400.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test capacity`
Expected: FAIL — `Cannot find module './capacity.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/economy/capacity.ts`:

```ts
// Ruling R5: machine capacity is pooled per (lane, machineClass) and distributed
// proportionally by assignment.
//
// Original spec section 4.2 computes capacity[R] = machineCount[R] * baseRate[R] as
// though machines are owned per-recipe, while spec B.2 scopes the cost counter and
// the ladder to (lane, class, mark). Both cannot hold. Pooling resolves it: the
// player buys machines into a lane-class and assigns integer counts of them to
// recipes, marks are fungible so a mark upgrade lifts every recipe in the
// lane-class at once, and pillar 3's "no management surface" survives.
//
// The solver's unit of capacity is the machine-unit: one Mk1 machine at clock 1 with
// no multipliers. Output in items/second is
//   unitsByRecipe[R] * outputPerSecond[R][item] * clock[R].
import type { ItemId, LaneId, MachineClassId, RecipeId } from "../content/types.js";
import { POWER_ITEM } from "../content/types.js";
import { isLiveRecipe, laneClassKey, type IndexedContent } from "../graph/index-content.js";
import { installedAt, installedMachines, type WorldState } from "../state/world.js";
import { combinedMultiplier, ladderMultiplier, laneMultiplier, tapMultiplier } from "./curves.js";

export interface CapacityTable {
  /** Machine-units available to each live recipe, multipliers already applied. */
  unitsByRecipe: Map<RecipeId, number>;
  /** Physical machines assigned to each live recipe. Drives power draw. */
  machinesByRecipe: Map<RecipeId, number>;
  /** Mean MW per machine for each `lane::class`, over the whole installed pool. */
  drawPerMachine: Map<string, number>;
  /** The combined multiplier stack applied to each live recipe. */
  multiplierByRecipe: Map<RecipeId, number>;
  /** Machine-units one additional machine would add. Bottleneck arithmetic. */
  unitsPerMachine: Map<RecipeId, number>;
}

export function installedUnits(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return 0;
  let total = 0;
  for (const mark of cls.marks) {
    total += installedAt(state, lane, machineClass, mark.mark) * mark.rateMultiplier;
  }
  return total;
}

/** Highest mark of a class the player has unlocked at `tier`, or null if none. */
export function bestUnlockedMark(
  content: IndexedContent,
  machineClass: MachineClassId,
  tier: number,
): number | null {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return null;
  let best: number | null = null;
  for (const mark of cls.marks) {
    if (mark.unlockTier <= tier && (best === null || mark.mark > best)) best = mark.mark;
  }
  return best;
}

export function computeCapacity(content: IndexedContent, state: WorldState): CapacityTable {
  const unitsByRecipe = new Map<RecipeId, number>();
  const machinesByRecipe = new Map<RecipeId, number>();
  const drawPerMachine = new Map<string, number>();
  const multiplierByRecipe = new Map<RecipeId, number>();
  const unitsPerMachine = new Map<RecipeId, number>();

  for (const recipeId of content.recipeIds) {
    if (!isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) continue;
    const recipe = content.recipes.get(recipeId)!;
    const { lane, machineClass } = recipe;
    const key = laneClassKey(lane, machineClass);

    const machines = installedMachines(state, lane, machineClass);
    const units = installedUnits(content, state, lane, machineClass);

    if (!drawPerMachine.has(key)) {
      const cls = content.machineClasses.get(machineClass)!;
      let totalDraw = 0;
      for (const mark of cls.marks) {
        totalDraw += installedAt(state, lane, machineClass, mark.mark) * mark.powerDraw;
      }
      drawPerMachine.set(key, machines > 0 ? totalDraw / machines : 0);
    }

    const multiplier = combinedMultiplier(content, [
      ladderMultiplier(content, state, lane, machineClass),
      laneMultiplier(content, state.tier, lane),
      tapMultiplier(content, state),
    ]);
    multiplierByRecipe.set(recipeId, multiplier);

    const assigned = state.assignment[recipeId] ?? 0;
    machinesByRecipe.set(recipeId, assigned);

    // Unassigned machines are idle: no capacity, no draw.
    const fraction = machines > 0 ? assigned / machines : 0;
    unitsByRecipe.set(recipeId, fraction * units * multiplier);

    const bestMark = bestUnlockedMark(content, machineClass, state.tier);
    const perMachineRate =
      bestMark === null
        ? 0
        : (content.machineClasses.get(machineClass)!.marks.find((m) => m.mark === bestMark)
            ?.rateMultiplier ?? 0);
    unitsPerMachine.set(recipeId, perMachineRate * multiplier);
  }

  return { unitsByRecipe, machinesByRecipe, drawPerMachine, multiplierByRecipe, unitsPerMachine };
}

/** Production of `itemId` in items/second if every live producer ran at clock 1. */
export function unconstrainedRate(
  content: IndexedContent,
  capacity: CapacityTable,
  itemId: ItemId,
): number {
  let total = 0;
  for (const recipeId of content.producersOf.get(itemId) ?? []) {
    const units = capacity.unitsByRecipe.get(recipeId);
    if (units === undefined) continue;
    total += units * (content.recipes.get(recipeId)!.outputPerSecond.get(itemId) ?? 0);
  }
  return total;
}

/** Spec 6.1: grid demand = sum of draw x clock over every assigned machine. */
export function powerDemandMw(
  content: IndexedContent,
  capacity: CapacityTable,
  _state: WorldState,
  clocks: ReadonlyMap<RecipeId, number>,
): number {
  let demand = 0;
  for (const [recipeId, machines] of capacity.machinesByRecipe) {
    if (machines <= 0) continue;
    const recipe = content.recipes.get(recipeId)!;
    // A generator's own draw is zero in content, but excluding power producers here
    // as well makes the death-spiral exemption in solve/power.ts symmetric.
    if (recipe.def.powerOutput > 0) continue;
    const perMachine = capacity.drawPerMachine.get(laneClassKey(recipe.lane, recipe.machineClass)) ?? 0;
    demand += machines * perMachine * (clocks.get(recipeId) ?? 0);
  }
  return demand;
}

/**
 * Spec 6.1 and 6.3: grid capacity = generator output, plus the HUB allowance so a
 * fresh world is not stalled at ratio 0, plus the tap injection from spec section 7
 * while any tap stack is live.
 */
export function powerSupplyMw(
  content: IndexedContent,
  capacity: CapacityTable,
  clocks: ReadonlyMap<RecipeId, number>,
): number {
  let supply = content.bundle.baseGridCapacityMw;
  for (const recipeId of content.producersOf.get(POWER_ITEM) ?? []) {
    const units = capacity.unitsByRecipe.get(recipeId);
    if (units === undefined) continue;
    const perUnit = content.recipes.get(recipeId)!.outputPerSecond.get(POWER_ITEM) ?? 0;
    supply += units * perUnit * (clocks.get(recipeId) ?? 0);
  }
  return supply;
}
```

Note: `powerSupplyMw` does not add the tap injection — the tap's power contribution is applied in Task 10's power loop, where `state` is in scope, so that this function stays a pure read of the capacity table. The comment above names both sources; Task 10 supplies the second.

- [ ] **Step 4: Correct the comment and export**

Replace the doc comment on `powerSupplyMw` with:

```ts
/**
 * Spec 6.1 and 6.3: grid capacity = generator output plus the HUB allowance, so a
 * fresh world is not stalled at ratio 0 before the first generator unlocks. The tap
 * injection from spec section 7 is added by the power loop in solve/power.ts, which
 * has the tap state in scope.
 */
```

`packages/engine/src/economy/index.ts`:

```ts
export * from "./curves.js";
export * from "./capacity.js";
```

- [ ] **Step 5: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Pool machine capacity per lane-class (ruling R5)

Original spec 4.2 owns machines per recipe while spec B.2 scopes the cost
counter and ladder to (lane, class, mark); both cannot hold. Machines are
pooled per lane-class and distributed by assigned fraction, marks are
fungible and mark-weighted, and unassigned machines are idle and draw no
power. A mark upgrade therefore lifts every recipe in the lane-class with
no per-recipe bookkeeping, keeping pillar 3 intact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 7: Storage, Quantum Storage, and the `bound` tier

**Files:**
- Create: `packages/engine/src/economy/storage.ts`
- Modify: `packages/engine/src/economy/index.ts`
- Test: `packages/engine/src/economy/storage.test.ts`

**Interfaces:**
- Consumes: `D`, `DECIMAL_ZERO`, `type Dec` (Phase 0 Task 2); `type IndexedContent`, `type ItemId` (Task 2); `type WorldState` (Task 4); `capAtLevel` (Task 5)
- Produces, from `@manufactory/engine`:
  - `type ItemStateTag = "EMPTY" | "FLOWING" | "FULL"`
  - `storageCap(content: IndexedContent, state: WorldState, itemId: ItemId): Dec`
  - `quantumCap(content: IndexedContent, state: WorldState, itemId: ItemId): Dec`
  - `liquid(state: WorldState, itemId: ItemId): Dec`
  - `liquidCap(content: IndexedContent, state: WorldState, itemId: ItemId): Dec`
  - `itemStateTag(content: IndexedContent, state: WorldState, itemId: ItemId): ItemStateTag`
  - `depositProduction(content: IndexedContent, state: WorldState, itemId: ItemId, amount: Dec): { state: WorldState; overflow: Dec }`
  - `drainLiquid(state: WorldState, itemId: ItemId, amount: Dec): { state: WorldState; shortfall: Dec }`
  - `depositRefund(content: IndexedContent, state: WorldState, itemId: ItemId, amount: Dec): WorldState`
  - `settleBound(content: IndexedContent, state: WorldState): WorldState`
  - `canAffordBuild(state: WorldState, costs: ReadonlyMap<ItemId, Dec>): boolean`
  - `canAffordLiquid(state: WorldState, costs: ReadonlyMap<ItemId, Dec>): boolean`
  - `spendForBuild(content: IndexedContent, state: WorldState, costs: ReadonlyMap<ItemId, Dec>): WorldState | null`
  - `spendFromLiquid(content: IndexedContent, state: WorldState, costs: ReadonlyMap<ItemId, Dec>): WorldState | null`

Spec C.5's orders, in full, and they are not symmetric:

```
production overflow →  stored → quantum → BACKPRESSURE   (bound is never created here)
dismantle refund   →  quantum (to cap) → bound (uncapped)
spend on builds    →  bound → quantum → stored           (liquid preserved last)
spend on delivery, →  stored → quantum                    (bound never touched)
  contracts, sink
```

Two consequences are load-bearing and must survive review:

**`bound` is only ever created by a refund.** Spec D4: dismantling ignores the QS cap so materials are never destroyed, but the resulting bulge above the cap can only be re-instantiated into machines, never decohered back into spendable stock. That is what closes the exploit in D4 — a full-stack refund is roughly 10× the marginal cost of the next machine at r = 1.09, so without this rule storage caps would stop gating deliveries, milestones, contracts, and the AWESOME Sink.

**`spendFromLiquid` never touches `bound`.** Ruling R7's milestone delivery calls it, and Spec 2's contracts and sink will call the same function. `spendForBuild` spends `bound` *first* — spending the restricted resource before the liquid one is both player-favourable and the intuitive reading.

`settleBound` implements "whenever `quantum < cap && bound > 0`, bound flows down automatically". It must be idempotent, because Task 11's `resolve` calls it at the head of every loop iteration and the `resolve(s, 2t) ≡ resolve(resolve(s, t), t)` property depends on that.

Spec C.2's three item states: `EMPTY` when `liquid == 0` (consumption clamps to production), `FULL` when `liquid >= liquidCap` (production clamps to consumption), `FLOWING` in between (net rate is free). `FULL` means storage **and** Quantum Storage are both at cap, per D4's fill order — which `liquid >= liquidCap` expresses exactly, because the fill order guarantees `stored` reaches its cap before `quantum` takes anything.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/economy/storage.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, type WorldState } from "../state/world.js";
import {
  canAffordBuild,
  canAffordLiquid,
  depositProduction,
  depositRefund,
  drainLiquid,
  itemStateTag,
  liquid,
  liquidCap,
  quantumCap,
  settleBound,
  spendForBuild,
  spendFromLiquid,
  storageCap,
} from "./storage.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

function world(over: Partial<WorldState> = {}): WorldState {
  return { ...initialWorld(content, 1, 0), ...over };
}

describe("caps", () => {
  it("reads the item's base storage cap at level 0", () => {
    // iron_ore baseStorageCap 600, baseQuantumCap 2400.
    expect(storageCap(content, world(), "iron_ore").toNumber()).toBe(600);
    expect(quantumCap(content, world(), "iron_ore").toNumber()).toBe(2400);
    expect(liquidCap(content, world(), "iron_ore").toNumber()).toBe(3000);
  });

  it("grows storage geometrically with the per-item level", () => {
    const w = world({ storageLevel: { iron_ore: 2 } });
    // 600 * 1.6^2 = 1536
    expect(storageCap(content, w, "iron_ore").toNumber()).toBeCloseTo(1536, 6);
  });

  it("grows Quantum Storage per lane, lifting every item in it (spec B.4)", () => {
    const w = world({ qsLevel: { iron: 1, oil: 0 } });
    // iron_ore 2400 * 1.6 = 3840; iron_ingot 1600 * 1.6 = 2560; oil untouched.
    expect(quantumCap(content, w, "iron_ore").toNumber()).toBeCloseTo(3840, 6);
    expect(quantumCap(content, w, "iron_ingot").toNumber()).toBeCloseTo(2560, 6);
    expect(quantumCap(content, w, "crude_oil").toNumber()).toBe(1600);
  });
});

describe("itemStateTag (spec C.2)", () => {
  it("is EMPTY at zero", () => {
    expect(itemStateTag(content, world(), "iron_ore")).toBe("EMPTY");
  });

  it("is FLOWING between zero and the combined cap", () => {
    const w = world({ stored: { ...world().stored, iron_ore: D(100) } });
    expect(itemStateTag(content, w, "iron_ore")).toBe("FLOWING");
  });

  it("is FLOWING while storage is full but Quantum Storage has room", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(600) },
      quantum: { ...world().quantum, iron_ore: D(1000) },
    });
    expect(itemStateTag(content, w, "iron_ore")).toBe("FLOWING");
  });

  it("is FULL only when storage and Quantum Storage are both at cap (spec C.2)", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(600) },
      quantum: { ...world().quantum, iron_ore: D(2400) },
    });
    expect(liquid(w, "iron_ore").toNumber()).toBe(3000);
    expect(itemStateTag(content, w, "iron_ore")).toBe("FULL");
  });
});

describe("depositProduction (spec C.5 fill order)", () => {
  it("fills storage first", () => {
    const r = depositProduction(content, world(), "iron_ore", D(500));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(500);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(0);
    expect(r.overflow.toNumber()).toBe(0);
  });

  it("spills into Quantum Storage once storage is at cap", () => {
    const r = depositProduction(content, world(), "iron_ore", D(1000));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(600);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(400);
    expect(r.overflow.toNumber()).toBe(0);
  });

  it("backpressures once both are at cap, and never creates bound", () => {
    const r = depositProduction(content, world(), "iron_ore", D(5000));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(600);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(r.state.bound.iron_ore!.toNumber()).toBe(0);
    expect(r.overflow.toNumber()).toBe(2000);
  });
});

describe("depositRefund (spec C.5, D4)", () => {
  it("fills Quantum Storage to its cap first", () => {
    const w = depositRefund(content, world(), "iron_ore", D(1000));
    expect(w.quantum.iron_ore!.toNumber()).toBe(1000);
    expect(w.bound.iron_ore!.toNumber()).toBe(0);
    expect(w.stored.iron_ore!.toNumber()).toBe(0);
  });

  it("puts the excess in bound, uncapped, so a dismantle never destroys material", () => {
    const w = depositRefund(content, world(), "iron_ore", D("4.01e9"));
    expect(w.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(w.bound.iron_ore!.toNumber()).toBeCloseTo(4.01e9 - 2400, 0);
  });

  it("holds spec E.6's invariant: bound > 0 implies quantum is at cap", () => {
    const w = depositRefund(content, world(), "iron_ore", D(1e6));
    expect(w.bound.iron_ore!.gt(0)).toBe(true);
    expect(w.quantum.iron_ore!.toNumber()).toBe(quantumCap(content, w, "iron_ore").toNumber());
  });
});

describe("settleBound", () => {
  it("flows bound down as room opens beneath it (spec D4)", () => {
    const start = world({
      quantum: { ...world().quantum, iron_ore: D(1000) },
      bound: { ...world().bound, iron_ore: D(5000) },
    });
    const settled = settleBound(content, start);
    expect(settled.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(settled.bound.iron_ore!.toNumber()).toBe(3600);
  });

  it("is idempotent, which resolve's split-invariance depends on", () => {
    const once = settleBound(
      content,
      world({ quantum: { ...world().quantum, iron_ore: D(0) }, bound: { ...world().bound, iron_ore: D(5000) } }),
    );
    const twice = settleBound(content, once);
    expect(twice.quantum.iron_ore!.toString()).toBe(once.quantum.iron_ore!.toString());
    expect(twice.bound.iron_ore!.toString()).toBe(once.bound.iron_ore!.toString());
  });

  it("does nothing when bound is zero", () => {
    const w = world();
    expect(settleBound(content, w).bound.iron_ore!.toNumber()).toBe(0);
  });
});

describe("drainLiquid", () => {
  it("takes from storage first, then Quantum Storage", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(100) },
      quantum: { ...world().quantum, iron_ore: D(500) },
    });
    const r = drainLiquid(w, "iron_ore", D(300));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(0);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(300);
    expect(r.shortfall.toNumber()).toBe(0);
  });

  it("never touches bound and reports the shortfall", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(50) },
      bound: { ...world().bound, iron_ore: D(1e6) },
    });
    const r = drainLiquid(w, "iron_ore", D(200));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(0);
    expect(r.state.bound.iron_ore!.toNumber()).toBe(1e6);
    expect(r.shortfall.toNumber()).toBe(150);
  });
});

describe("spendForBuild (spec C.5)", () => {
  it("spends bound first, then quantum, then stored", () => {
    const w = world({
      stored: { ...world().stored, iron_plate: D(100) },
      quantum: { ...world().quantum, iron_plate: D(200) },
      bound: { ...world().bound, iron_plate: D(50) },
    });
    const next = spendForBuild(content, w, new Map([["iron_plate", D(220)]]))!;
    expect(next.bound.iron_plate!.toNumber()).toBe(0);
    expect(next.quantum.iron_plate!.toNumber()).toBe(30);
    expect(next.stored.iron_plate!.toNumber()).toBe(100);
  });

  it("returns null and changes nothing when the total is short", () => {
    const w = world({ stored: { ...world().stored, iron_plate: D(10) } });
    expect(spendForBuild(content, w, new Map([["iron_plate", D(11)]]))).toBeNull();
  });

  it("lets a build be paid for entirely out of bound (spec D4)", () => {
    const w = world({ bound: { ...world().bound, iron_plate: D(1e6) } });
    expect(canAffordBuild(w, new Map([["iron_plate", D(500)]]))).toBe(true);
    const next = spendForBuild(content, w, new Map([["iron_plate", D(500)]]))!;
    expect(next.bound.iron_plate!.toNumber()).toBe(1e6 - 500);
  });
});

describe("spendFromLiquid (spec C.5, D4)", () => {
  it("spends stored then quantum", () => {
    const w = world({
      stored: { ...world().stored, iron_plate: D(100) },
      quantum: { ...world().quantum, iron_plate: D(200) },
    });
    const next = spendFromLiquid(content, w, new Map([["iron_plate", D(250)]]))!;
    expect(next.stored.iron_plate!.toNumber()).toBe(0);
    expect(next.quantum.iron_plate!.toNumber()).toBe(50);
  });

  it("refuses to spend bound, closing the D4 dismantle-before-delivery exploit", () => {
    const w = world({ bound: { ...world().bound, iron_plate: D("4.01e9") } });
    expect(canAffordLiquid(w, new Map([["iron_plate", D(1000)]]))).toBe(false);
    expect(spendFromLiquid(content, w, new Map([["iron_plate", D(1000)]]))).toBeNull();
    // The same cost is payable as a build, because bound is re-instantiable.
    expect(canAffordBuild(w, new Map([["iron_plate", D(1000)]]))).toBe(true);
  });

  it("settles bound downward after freeing quantum room", () => {
    const w = world({
      stored: { ...world().stored, iron_plate: D(300) },
      quantum: { ...world().quantum, iron_plate: D(1200) },
      bound: { ...world().bound, iron_plate: D(5000) },
    });
    // iron_plate baseQuantumCap is 1200, so quantum is at cap and bound is legal.
    const next = spendFromLiquid(content, w, new Map([["iron_plate", D(300)]]))!;
    expect(next.stored.iron_plate!.toNumber()).toBe(0);
    // 300 came out of stored, quantum is still at its 1200 cap, bound unchanged.
    expect(next.quantum.iron_plate!.toNumber()).toBe(1200);
    expect(next.bound.iron_plate!.toNumber()).toBe(5000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test storage`
Expected: FAIL — `Cannot find module './storage.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/economy/storage.ts`:

```ts
// Spec C.5 and D4. Three tiers, four orders, and they are deliberately not
// symmetric:
//
//   production overflow -> stored -> quantum -> BACKPRESSURE   (never creates bound)
//   dismantle refund    -> quantum (to cap) -> bound (uncapped)
//   spend on builds     -> bound -> quantum -> stored          (liquid preserved)
//   spend on delivery,  -> stored -> quantum                   (bound untouchable)
//     contracts, sink
//
// The asymmetry is the whole mechanism. Dismantling ignores the QS cap so materials
// are never destroyed, but the bulge above the cap stays bound as machine matter --
// re-instantiable, never decoherable back into spendable stock. Without that rule a
// player buys 200 machines under the cap, dismantles them all, banks 4.1B plate in
// Quantum Storage, and delivers it: storage caps stop gating milestones, contracts
// and the sink entirely. A full-stack refund is the geometric sum base*(r^n-1)/(r-1),
// roughly 10x the marginal cost of the next machine at r = 1.09.
import { D, DECIMAL_ZERO, type Dec } from "../numbers/decimal.js";
import type { ItemId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { WorldState } from "../state/world.js";
import { capAtLevel } from "./curves.js";

/** Spec C.2's three item states. */
export type ItemStateTag = "EMPTY" | "FLOWING" | "FULL";

export function storageCap(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): Dec {
  const item = content.items.get(itemId);
  if (!item) return DECIMAL_ZERO;
  return capAtLevel(item.baseStorageCap, content.bundle.storage, state.storageLevel[itemId] ?? 0);
}

/** Spec B.4: Quantum Storage is purchased per lane, so one level lifts every item. */
export function quantumCap(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): Dec {
  const item = content.items.get(itemId);
  if (!item) return DECIMAL_ZERO;
  return capAtLevel(
    item.baseQuantumCap,
    content.bundle.quantumStorage,
    state.qsLevel[item.lane] ?? 0,
  );
}

/** Spendable-on-anything stock. `bound` is deliberately excluded. */
export function liquid(state: WorldState, itemId: ItemId): Dec {
  return (state.stored[itemId] ?? DECIMAL_ZERO).plus(state.quantum[itemId] ?? DECIMAL_ZERO);
}

export function liquidCap(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): Dec {
  return storageCap(content, state, itemId).plus(quantumCap(content, state, itemId));
}

/**
 * Spec C.2. FULL means storage AND Quantum Storage are both at cap; because the fill
 * order always tops up `stored` before `quantum` takes anything, `liquid >= liquidCap`
 * expresses exactly that.
 */
export function itemStateTag(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): ItemStateTag {
  const have = liquid(state, itemId);
  if (have.lte(0)) return "EMPTY";
  if (have.gte(liquidCap(content, state, itemId))) return "FULL";
  return "FLOWING";
}

function withItem(
  state: WorldState,
  field: "stored" | "quantum" | "bound",
  itemId: ItemId,
  value: Dec,
): WorldState {
  return { ...state, [field]: { ...state[field], [itemId]: value } };
}

/** Spec C.5: stored -> quantum -> backpressure. `overflow` is what did not fit. */
export function depositProduction(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  amount: Dec,
): { state: WorldState; overflow: Dec } {
  if (amount.lte(0)) return { state, overflow: DECIMAL_ZERO };
  let remaining = amount;
  let next = state;

  const storedRoom = storageCap(content, next, itemId).minus(next.stored[itemId] ?? DECIMAL_ZERO);
  if (storedRoom.gt(0)) {
    const take = remaining.lt(storedRoom) ? remaining : storedRoom;
    next = withItem(next, "stored", itemId, (next.stored[itemId] ?? DECIMAL_ZERO).plus(take));
    remaining = remaining.minus(take);
  }

  const quantumRoom = quantumCap(content, next, itemId).minus(next.quantum[itemId] ?? DECIMAL_ZERO);
  if (remaining.gt(0) && quantumRoom.gt(0)) {
    const take = remaining.lt(quantumRoom) ? remaining : quantumRoom;
    next = withItem(next, "quantum", itemId, (next.quantum[itemId] ?? DECIMAL_ZERO).plus(take));
    remaining = remaining.minus(take);
  }

  // Anything left is backpressure. It is never turned into bound: bound exists only
  // as the residue of a dismantle (spec D4).
  return { state: next, overflow: remaining.gt(0) ? remaining : DECIMAL_ZERO };
}

/** Ordinary consumption: stored -> quantum, mirroring the deposit order. */
export function drainLiquid(
  state: WorldState,
  itemId: ItemId,
  amount: Dec,
): { state: WorldState; shortfall: Dec } {
  if (amount.lte(0)) return { state, shortfall: DECIMAL_ZERO };
  let remaining = amount;
  let next = state;

  for (const field of ["stored", "quantum"] as const) {
    const have = next[field][itemId] ?? DECIMAL_ZERO;
    if (have.lte(0)) continue;
    const take = remaining.lt(have) ? remaining : have;
    next = withItem(next, field, itemId, have.minus(take));
    remaining = remaining.minus(take);
    if (remaining.lte(0)) break;
  }
  return { state: next, shortfall: remaining.gt(0) ? remaining : DECIMAL_ZERO };
}

/** Spec C.5 and D4: a refund fills Quantum Storage to its cap, then binds the rest. */
export function depositRefund(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  amount: Dec,
): WorldState {
  if (amount.lte(0)) return state;
  let remaining = amount;
  let next = state;

  const room = quantumCap(content, next, itemId).minus(next.quantum[itemId] ?? DECIMAL_ZERO);
  if (room.gt(0)) {
    const take = remaining.lt(room) ? remaining : room;
    next = withItem(next, "quantum", itemId, (next.quantum[itemId] ?? DECIMAL_ZERO).plus(take));
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    next = withItem(next, "bound", itemId, (next.bound[itemId] ?? DECIMAL_ZERO).plus(remaining));
  }
  return next;
}

/**
 * Spec D4: "whenever quantum < cap && bound > 0, bound flows down automatically".
 * Idempotent by construction, which resolve's split-invariance in Task 11 depends on.
 */
export function settleBound(content: IndexedContent, state: WorldState): WorldState {
  let next = state;
  for (const itemId of content.stockItemIds) {
    const bound = next.bound[itemId] ?? DECIMAL_ZERO;
    if (bound.lte(0)) continue;
    const room = quantumCap(content, next, itemId).minus(next.quantum[itemId] ?? DECIMAL_ZERO);
    if (room.lte(0)) continue;
    const move = bound.lt(room) ? bound : room;
    next = withItem(next, "quantum", itemId, (next.quantum[itemId] ?? DECIMAL_ZERO).plus(move));
    next = withItem(next, "bound", itemId, bound.minus(move));
  }
  return next;
}

function totalFor(state: WorldState, itemId: ItemId, includeBound: boolean): Dec {
  const base = liquid(state, itemId);
  return includeBound ? base.plus(state.bound[itemId] ?? DECIMAL_ZERO) : base;
}

export function canAffordBuild(state: WorldState, costs: ReadonlyMap<ItemId, Dec>): boolean {
  for (const [itemId, amount] of costs) {
    if (totalFor(state, itemId, true).lt(amount)) return false;
  }
  return true;
}

export function canAffordLiquid(state: WorldState, costs: ReadonlyMap<ItemId, Dec>): boolean {
  for (const [itemId, amount] of costs) {
    if (totalFor(state, itemId, false).lt(amount)) return false;
  }
  return true;
}

function spendInOrder(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
  order: readonly ("stored" | "quantum" | "bound")[],
  affordable: boolean,
): WorldState | null {
  if (!affordable) return null;
  let next = state;
  for (const [itemId, amount] of costs) {
    let remaining = amount;
    for (const field of order) {
      if (remaining.lte(0)) break;
      const have = next[field][itemId] ?? DECIMAL_ZERO;
      if (have.lte(0)) continue;
      const take = remaining.lt(have) ? remaining : have;
      next = withItem(next, field, itemId, have.minus(take));
      remaining = remaining.minus(take);
    }
    // Guarded by the affordability check above; a residue here would mean a bug in
    // the Decimal comparison, so fail loudly rather than silently giving it away.
    if (remaining.gt(0)) return null;
  }
  return settleBound(content, next);
}

/** Spec C.5: builds spend the restricted resource first, preserving liquid stock. */
export function spendForBuild(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
): WorldState | null {
  return spendInOrder(content, state, costs, ["bound", "quantum", "stored"], canAffordBuild(state, costs));
}

/**
 * Spec C.5: deliveries, contracts and the sink spend liquid only. Ruling R7's
 * milestone delivery calls this, and Spec 2's contracts will call the same function.
 */
export function spendFromLiquid(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
): WorldState | null {
  return spendInOrder(content, state, costs, ["stored", "quantum"], canAffordLiquid(state, costs));
}
```

- [ ] **Step 4: Export it**

`packages/engine/src/economy/index.ts`:

```ts
export * from "./curves.js";
export * from "./capacity.js";
export * from "./storage.js";
```

- [ ] **Step 5: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS. If the `D` import in `storage.ts` is reported unused, remove it — the file may only need `DECIMAL_ZERO`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add storage, Quantum Storage, and the bound tier

Spec C.5's four orders, deliberately asymmetric. Production fills storage
then Quantum Storage then backpressures, never creating bound; a dismantle
refund fills Quantum Storage to cap and binds the rest; builds spend bound
first; deliveries never touch bound at all. That last rule is what closes
spec D4's exploit, where 200 machines bought under the cap and dismantled
would otherwise bank 4.1B plate and make storage caps stop gating
milestones entirely.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 8: The waterfall allocation

**Files:**
- Create: `packages/engine/src/solve/waterfall.ts`, `packages/engine/src/solve/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/solve/waterfall.test.ts`

**Interfaces:**
- Consumes: `type IndexedContent`, `type ItemId`, `type RecipeId`, `POWER_ITEM` (Task 2); `type ExpansionVectors`, `computeExpansion` (Task 3); `type WorldState`, `type PriorityEntry` (Task 4); `type CapacityTable`, `unconstrainedRate` (Task 6)
- Produces, from `@manufactory/engine`:
  - `const RESERVE_FLOOR = 0.02`
  - `interface EntryAllocation { entryId: string; itemId: ItemId; requested: number; allocated: number; limitedBy: RecipeId | null; limitingPerUnit: number; runnerUpRate: number }`
  - `interface WaterfallResult { usedUnits: Map<RecipeId, number>; remainingUnits: Map<RecipeId, number>; entries: EntryAllocation[]; allocations: Map<RecipeId, Map<string, number>> }`
  - `requirementVector(content: IndexedContent, vectors: ExpansionVectors, activeRecipe: Readonly<Record<ItemId, RecipeId>>, itemId: ItemId, pinnedEmpty: ReadonlySet<ItemId>, memo: Map<ItemId, Map<RecipeId, number>>): Map<RecipeId, number>`
  - `effectivePriority(content: IndexedContent, state: WorldState, capacity: CapacityTable, powerTargetRate: number): PriorityEntry[]`
  - `interface WaterfallArgs { content: IndexedContent; vectors: ExpansionVectors; activeRecipe: Readonly<Record<ItemId, RecipeId>>; capacityUnits: ReadonlyMap<RecipeId, number>; entries: readonly PriorityEntry[]; pinnedEmpty: ReadonlySet<ItemId>; reserveFloor: number }`
  - `runWaterfall(args: WaterfallArgs): WaterfallResult`

This is original spec section 4.2's demand-pull waterfall, with `remaining[R]` depleted as each target takes its share. Four things about it need stating up front:

**The expansion is cut at items that are not pinned EMPTY.** Spec C.2: an item with stock can supply a target faster than it is produced — the stock drains at `demand − production` and hitting zero is a discrete event the event loop already looks for. So the requirement vector traverses *through* an item only when that item is pinned EMPTY, where consumption is genuinely clamped to production. Everywhere else the walk stops. This is what makes the pin set meaningful and is why Task 9's fixed point exists at all.

**Capacity is in machine-units.** `capacityUnits[R]` comes from Task 6's `CapacityTable.unitsByRecipe`, and `requirementVector` returns machine-units of each recipe per one item/second of the target. `remaining[R] / vector[R]` is therefore an achievable item/second rate, and the minimum over the vector is the target's ceiling.

**Ties break by authored recipe order.** Spec A.5 demands canonical ordering so two processes never disagree about which recipe bound a target. The vector is walked in `content.recipeIds` order.

**Power is an ordinary entry (spec C.4).** It targets the synthetic `POWER_ITEM`, so generators get first call on fuel through the same waterfall the player already understands, with no power special case here. Its `targetRate` is supplied by Task 10's power loop through `effectivePriority`'s `powerTargetRate` argument, because grid demand is only known once clocks are.

**Ruling R8** puts reserves in as synthetic entries: `reserve[i] = p` becomes a `guaranteed` entry for item `i` at `targetRate = p × unconstrainedRate(i)`, inserted immediately after the power entry. Nothing consumes the reserved output, so it banks — which is exactly spec 3.3's "divert that share of production to storage even when downstream demand exists" — and the waterfall needs no new machinery.

The **reserve floor** from spec 4.2 ("reserve a small fraction, suggest 2%, of every contested intermediate for targets below the waterline") runs as two phases. Phase A allocates over `capacity × (1 − reserveFloor)` for *contested* recipes (those appearing in two or more entries' vectors) and full capacity otherwise. Phase B then re-runs, in priority order, over everything still unused — but only for entries that got exactly zero in Phase A. That gives a starved low-priority target a real, small slice rather than a hard 0%, without inventing throughput.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/solve/waterfall.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM } from "../content/types.js";
import { computeExpansion } from "../graph/expand.js";
import { indexContent } from "../graph/index-content.js";
import { computeCapacity } from "../economy/capacity.js";
import { initialWorld, withInstalled, type PriorityEntry, type WorldState } from "../state/world.js";
import {
  RESERVE_FLOOR,
  effectivePriority,
  requirementVector,
  runWaterfall,
} from "./waterfall.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** The fixture start: 2 miners, 2 smelters, 1 constructor, all Mk1, ladder x1. */
function base(): WorldState {
  return initialWorld(content, 1, 0);
}

function vectorsFor(state: WorldState) {
  return computeExpansion(content, state.tier, state.activeRecipe);
}

const ALL_EMPTY = new Set(["iron_ore", "iron_ingot", "iron_plate"]);

function entry(itemId: string, over: Partial<PriorityEntry> = {}): PriorityEntry {
  return {
    id: `item:${itemId}`,
    kind: "item",
    itemId,
    mode: "guaranteed",
    share: 1,
    targetRate: null,
    paused: false,
    ...over,
  };
}

describe("requirementVector", () => {
  it("traverses through every pinned-EMPTY input", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      "iron_plate",
      ALL_EMPTY,
      new Map(),
    );
    // 3 make_plate units per plate/s; they pull 1.5 ingot/s needing 3 smelt units;
    // those pull 1.5 ore/s needing 1.5 mine units.
    expect(v.get("make_plate")).toBeCloseTo(3, 12);
    expect(v.get("smelt_iron")).toBeCloseTo(3, 12);
    expect(v.get("mine_iron")).toBeCloseTo(1.5, 12);
    expect(v.size).toBe(3);
  });

  it("cuts at an item that has stock, because stock can cover the deficit", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      "iron_plate",
      new Set(["iron_ingot"]),
      new Map(),
    );
    // iron_ingot is pinned so we walk into it, but iron_ore is not, so it is cut.
    expect(v.get("make_plate")).toBeCloseTo(3, 12);
    expect(v.get("smelt_iron")).toBeCloseTo(3, 12);
    expect(v.has("mine_iron")).toBe(false);
  });

  it("stops at the target itself when nothing upstream is pinned", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      "iron_plate",
      new Set(),
      new Map(),
    );
    expect([...v.keys()]).toEqual(["make_plate"]);
  });

  it("is empty for an item with no live recipe", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      POWER_ITEM,
      ALL_EMPTY,
      new Map(),
    );
    // burn_fuel unlocks at tier 3; the world is at tier 0.
    expect(v.size).toBe(0);
  });
});

describe("runWaterfall — one target, no reserve floor", () => {
  it("depletes capacity down the chain and names the binding recipe", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });

    // Capacity is 1 constructor unit, 2 smelter units, 2 miner units.
    // Ratios: make_plate 1/3, smelt_iron 2/3, mine_iron 2/1.5. The constructor binds.
    const allocation = result.entries[0]!;
    expect(allocation.allocated).toBeCloseTo(1 / 3, 12);
    expect(allocation.limitedBy).toBe("make_plate");
    expect(allocation.limitingPerUnit).toBeCloseTo(3, 12);
    expect(allocation.runnerUpRate).toBeCloseTo(2 / 3, 12);

    expect(result.usedUnits.get("make_plate")).toBeCloseTo(1, 12);
    expect(result.usedUnits.get("smelt_iron")).toBeCloseTo(1, 12);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(0.5, 12);
    expect(result.remainingUnits.get("make_plate")).toBeCloseTo(0, 12);
    expect(result.remainingUnits.get("smelt_iron")).toBeCloseTo(1, 12);
  });

  it("records the per-entry split that drives the split-bar UI (spec 4.2)", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate"), entry("iron_ingot")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    const smelt = result.allocations.get("smelt_iron")!;
    // iron_plate takes 1 smelter unit; iron_ingot then takes the remaining 1.
    expect(smelt.get("item:iron_plate")).toBeCloseTo(1, 12);
    expect(smelt.get("item:iron_ingot")).toBeCloseTo(1, 12);
  });

  it("honours a target rate cap and reports no limiting recipe when it is the cap", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate", { targetRate: 0.1 })],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries[0]!.allocated).toBeCloseTo(0.1, 12);
    expect(result.entries[0]!.limitedBy).toBeNull();
  });

  it("skips paused entries entirely", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate", { paused: true }), entry("iron_ingot")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.itemId).toBe("iron_ingot");
    // The whole smelter capacity is now free for ingots: 2 units / 2 per ingot/s = 1.
    expect(result.entries[0]!.allocated).toBeCloseTo(1, 12);
  });
});

describe("runWaterfall — the reserve floor", () => {
  it("holds back 2% of contested capacity and hands it to a starved entry", () => {
    // 8 smelters (ladderInput 8, still under the interval of 10, so ladder x1) and
    // the 2 starting miners. iron_ingot will consume every miner unit in phase A.
    let state = base();
    state = withInstalled(state, "iron", "smelter", 1, 8);
    state = { ...state, assignment: { ...state.assignment, smelt_iron: 8 } };
    const capacity = computeCapacity(content, state);
    expect(capacity.unitsByRecipe.get("smelt_iron")).toBeCloseTo(8, 12);
    expect(capacity.unitsByRecipe.get("mine_iron")).toBeCloseTo(2, 12);

    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_ingot"), entry("iron_ore")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: RESERVE_FLOOR,
    });

    // mine_iron is contested, so phase A sees 2 * 0.98 = 1.96 units. iron_ingot
    // needs 1 mine unit per ingot/s and 2 smelt units, so it takes 1.96 ingot/s,
    // consuming 3.92 smelter units and all 1.96 available miner units.
    expect(result.entries[0]!.allocated).toBeCloseTo(1.96, 9);
    expect(result.entries[0]!.limitedBy).toBe("mine_iron");
    // iron_ore got nothing in phase A, so phase B gives it the held-back 0.04.
    expect(result.entries[1]!.allocated).toBeCloseTo(0.04, 9);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(2, 9);
  });

  it("does not tax an uncontested recipe", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: RESERVE_FLOOR,
    });
    // Every recipe appears in exactly one vector, so nothing is contested and the
    // answer matches the reserveFloor-0 case exactly.
    expect(result.entries[0]!.allocated).toBeCloseTo(1 / 3, 12);
  });
});

describe("runWaterfall — share mode", () => {
  it("scales the group proportionally to fit remaining capacity (spec 4.2)", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [
        entry("iron_ingot", { mode: "share", share: 3 }),
        entry("iron_ore", { mode: "share", share: 1 }),
      ],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });

    // Weights 0.75 / 0.25. Group vector: smelt 0.75*2 = 1.5, mine 0.75*1 + 0.25*1 = 1.
    // Ratios against 2 smelt and 2 mine units: 2/1.5 = 4/3 and 2/1 = 2. Scale = 4/3.
    expect(result.entries[0]!.allocated).toBeCloseTo(1, 12);
    expect(result.entries[1]!.allocated).toBeCloseTo(1 / 3, 12);
    expect(result.usedUnits.get("smelt_iron")).toBeCloseTo(2, 12);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(4 / 3, 12);
  });

  it("processes the whole group at the position of its first member", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [
        entry("iron_ore", { mode: "share", share: 1 }),
        entry("iron_plate"),
        entry("iron_ingot", { mode: "share", share: 1 }),
      ],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries.map((e) => e.itemId)).toEqual([
      "iron_ore",
      "iron_ingot",
      "iron_plate",
    ]);
  });
});

describe("effectivePriority", () => {
  it("overrides the power entry's target rate with the grid demand", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const entries = effectivePriority(content, state, capacity, 137);
    expect(entries[0]!.kind).toBe("power");
    expect(entries[0]!.targetRate).toBe(137);
  });

  it("injects a reserve entry right after power (ruling R8)", () => {
    const state = { ...base(), reserve: { ...base().reserve, iron_ore: 0.25 } };
    const capacity = computeCapacity(content, state);
    const entries = effectivePriority(content, state, capacity, 0);
    expect(entries[1]!.id).toBe("reserve:iron_ore");
    // Unconstrained ore production is 2 units x 1 ore/s = 2/s; 25% of it is 0.5/s.
    expect(entries[1]!.targetRate).toBeCloseTo(0.5, 12);
    expect(entries[2]!.itemId).toBe("iron_plate");
  });

  it("drops paused entries and adds no reserve entry at zero percent", () => {
    const state = base();
    const paused = {
      ...state,
      priority: state.priority.map((e) =>
        e.itemId === "iron_ingot" ? { ...e, paused: true } : e,
      ),
    };
    const entries = effectivePriority(content, paused, computeCapacity(content, paused), 0);
    expect(entries.some((e) => e.itemId === "iron_ingot")).toBe(false);
    expect(entries.some((e) => e.id.startsWith("reserve:"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test waterfall`
Expected: FAIL — `Cannot find module './waterfall.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/solve/waterfall.ts`:

```ts
// Original spec section 4.2's demand-pull waterfall, processed in priority order
// with remaining[R] depleted as each target takes its share.
//
// The one thing the original algorithm does not have is spec C.2's notion of stock.
// An item with stock can supply a target faster than it is produced -- the stock
// drains at (demand - production) and hitting zero is a discrete event the event
// loop already looks for. So the requirement walk traverses THROUGH an item only
// when that item is pinned EMPTY, where consumption really is clamped to
// production. Everywhere else it stops. That cut is what makes the pin set
// meaningful, and it is why solve/fixpoint.ts exists.
//
// Capacity is measured in machine-units (one Mk1 machine at clock 1, no
// multipliers), so remaining[R] / vector[R] is an achievable item/second rate.
import type { ItemId, RecipeId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { ExpansionVectors } from "../graph/expand.js";
import type { PriorityEntry, WorldState } from "../state/world.js";
import { unconstrainedRate, type CapacityTable } from "../economy/capacity.js";

/** Spec 4.2's suggested 2%. Keeps a low-priority target off a hard 0%. */
export const RESERVE_FLOOR = 0.02;

export interface EntryAllocation {
  entryId: string;
  itemId: ItemId;
  /** Infinity when the entry is unbounded. */
  requested: number;
  allocated: number;
  /** null when the entry got everything it asked for. */
  limitedBy: RecipeId | null;
  /** Machine-units of `limitedBy` per one item/second of `itemId`. */
  limitingPerUnit: number;
  /** What this entry could reach if `limitedBy` were cleared. Infinity if unbounded. */
  runnerUpRate: number;
}

export interface WaterfallResult {
  usedUnits: Map<RecipeId, number>;
  remainingUnits: Map<RecipeId, number>;
  entries: EntryAllocation[];
  /** recipe -> entryId -> machine-units. Drives spec 13.1's split bars. */
  allocations: Map<RecipeId, Map<string, number>>;
}

/**
 * Machine-units of each recipe needed per one item/second of `itemId`, cutting the
 * walk at every input that is not pinned EMPTY.
 *
 * `memo` must be created fresh per pass, because it is only valid for one pin set.
 */
export function requirementVector(
  content: IndexedContent,
  vectors: ExpansionVectors,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
  itemId: ItemId,
  pinnedEmpty: ReadonlySet<ItemId>,
  memo: Map<ItemId, Map<RecipeId, number>>,
): Map<RecipeId, number> {
  const cached = memo.get(itemId);
  if (cached) return cached;

  const units = vectors.unitsPerItem.get(itemId);
  const recipeId = activeRecipe[itemId];
  if (units === undefined || recipeId === undefined) {
    const empty = new Map<RecipeId, number>();
    memo.set(itemId, empty);
    return empty;
  }

  // Insert before recursing: ruling R6 excludes cycles, but a content bug must not
  // turn into an infinite recursion inside the engine.
  const vector = new Map<RecipeId, number>([[recipeId, units]]);
  memo.set(itemId, vector);

  for (const [inputId, perUnit] of vectors.directInputs.get(itemId) ?? []) {
    if (!pinnedEmpty.has(inputId)) continue;
    const sub = requirementVector(content, vectors, activeRecipe, inputId, pinnedEmpty, memo);
    for (const [subRecipe, subUnits] of sub) {
      vector.set(subRecipe, (vector.get(subRecipe) ?? 0) + subUnits * perUnit);
    }
  }
  return vector;
}

/**
 * Spec C.4 supplies the power entry's target rate from the grid demand, because
 * demand is only known once clocks are. Ruling R8 injects reserve entries.
 */
export function effectivePriority(
  content: IndexedContent,
  state: WorldState,
  capacity: CapacityTable,
  powerTargetRate: number,
): PriorityEntry[] {
  const live = state.priority
    .filter((entry) => !entry.paused)
    .map((entry) =>
      entry.kind === "power" ? { ...entry, targetRate: powerTargetRate } : entry,
    );

  const reserves: PriorityEntry[] = [];
  for (const itemId of content.stockItemIds) {
    const percent = state.reserve[itemId] ?? 0;
    if (percent <= 0) continue;
    reserves.push({
      id: `reserve:${itemId}`,
      kind: "item",
      itemId,
      mode: "guaranteed",
      share: 1,
      targetRate: percent * unconstrainedRate(content, capacity, itemId),
      paused: false,
    });
  }
  if (reserves.length === 0) return live;

  const powerIndex = live.findIndex((entry) => entry.kind === "power");
  const at = powerIndex >= 0 ? powerIndex + 1 : 0;
  return [...live.slice(0, at), ...reserves, ...live.slice(at)];
}

export interface WaterfallArgs {
  content: IndexedContent;
  vectors: ExpansionVectors;
  activeRecipe: Readonly<Record<ItemId, RecipeId>>;
  capacityUnits: ReadonlyMap<RecipeId, number>;
  entries: readonly PriorityEntry[];
  pinnedEmpty: ReadonlySet<ItemId>;
  reserveFloor: number;
}

interface Constraint {
  recipeId: RecipeId;
  ratio: number;
  perUnit: number;
}

/** Walks a vector in authored recipe order so ties break canonically (spec A.5). */
function constraints(
  content: IndexedContent,
  vector: ReadonlyMap<RecipeId, number>,
  remaining: ReadonlyMap<RecipeId, number>,
): Constraint[] {
  const out: Constraint[] = [];
  for (const recipeId of content.recipeIds) {
    const perUnit = vector.get(recipeId);
    if (perUnit === undefined || perUnit <= 0) continue;
    out.push({ recipeId, ratio: (remaining.get(recipeId) ?? 0) / perUnit, perUnit });
  }
  return out;
}

function bestTwo(list: readonly Constraint[]): { best: Constraint | null; runnerUp: number } {
  let best: Constraint | null = null;
  let runnerUp = Number.POSITIVE_INFINITY;
  for (const candidate of list) {
    if (best === null || candidate.ratio < best.ratio) {
      if (best !== null) runnerUp = Math.min(runnerUp, best.ratio);
      best = candidate;
    } else {
      runnerUp = Math.min(runnerUp, candidate.ratio);
    }
  }
  return { best, runnerUp };
}

export function runWaterfall(args: WaterfallArgs): WaterfallResult {
  const { content, vectors, activeRecipe, capacityUnits, entries, pinnedEmpty, reserveFloor } = args;

  const live = entries.filter((entry) => !entry.paused);
  const memo = new Map<ItemId, Map<RecipeId, number>>();
  const vectorOf = new Map<string, Map<RecipeId, number>>();
  for (const entry of live) {
    vectorOf.set(
      entry.id,
      entry.itemId === null
        ? new Map<RecipeId, number>()
        : requirementVector(content, vectors, activeRecipe, entry.itemId, pinnedEmpty, memo),
    );
  }

  // A recipe is contested when two or more entries pull through it. Only contested
  // capacity is taxed by the reserve floor (spec 4.2).
  const touchCount = new Map<RecipeId, number>();
  for (const vector of vectorOf.values()) {
    for (const recipeId of vector.keys()) {
      touchCount.set(recipeId, (touchCount.get(recipeId) ?? 0) + 1);
    }
  }

  const usedUnits = new Map<RecipeId, number>();
  const allocations = new Map<RecipeId, Map<string, number>>();
  const results = new Map<string, EntryAllocation>();
  for (const recipeId of capacityUnits.keys()) usedUnits.set(recipeId, 0);

  const commit = (entryId: string, vector: ReadonlyMap<RecipeId, number>, rate: number): void => {
    if (rate <= 0) return;
    for (const [recipeId, perUnit] of vector) {
      const units = rate * perUnit;
      usedUnits.set(recipeId, (usedUnits.get(recipeId) ?? 0) + units);
      const perEntry = allocations.get(recipeId) ?? new Map<string, number>();
      perEntry.set(entryId, (perEntry.get(entryId) ?? 0) + units);
      allocations.set(recipeId, perEntry);
    }
  };

  const runPass = (pool: ReadonlyMap<RecipeId, number>, only: ReadonlySet<string> | null): void => {
    const remaining = new Map(pool);
    const shareGroup = live.filter((entry) => entry.mode === "share");
    const shareHandled = new Set<string>();

    for (const entry of live) {
      if (only !== null && !only.has(entry.id)) continue;

      if (entry.mode === "share") {
        if (shareHandled.size > 0) continue;
        const members = shareGroup.filter((m) => only === null || only.has(m.id));
        if (members.length === 0) continue;

        let totalShare = 0;
        for (const member of members) totalShare += Math.max(0, member.share);
        if (totalShare <= 0) continue;

        // The group's combined draw at its authored weights, then one scalar.
        const groupVector = new Map<RecipeId, number>();
        const weightOf = new Map<string, number>();
        for (const member of members) {
          const weight = Math.max(0, member.share) / totalShare;
          weightOf.set(member.id, weight);
          for (const [recipeId, perUnit] of vectorOf.get(member.id)!) {
            groupVector.set(recipeId, (groupVector.get(recipeId) ?? 0) + weight * perUnit);
          }
        }

        const { best, runnerUp } = bestTwo(constraints(content, groupVector, remaining));
        let scale = best === null ? Number.POSITIVE_INFINITY : best.ratio;
        for (const member of members) {
          if (member.targetRate === null) continue;
          const weight = weightOf.get(member.id)!;
          if (weight > 0) scale = Math.min(scale, member.targetRate / weight);
        }
        if (!Number.isFinite(scale)) scale = 0;

        for (const [recipeId, perUnit] of groupVector) {
          remaining.set(recipeId, (remaining.get(recipeId) ?? 0) - scale * perUnit);
        }
        for (const member of members) {
          const weight = weightOf.get(member.id)!;
          const rate = weight * scale;
          commit(member.id, vectorOf.get(member.id)!, rate);
          const previous = results.get(member.id);
          results.set(member.id, {
            entryId: member.id,
            itemId: member.itemId ?? "",
            requested: member.targetRate ?? Number.POSITIVE_INFINITY,
            allocated: (previous?.allocated ?? 0) + rate,
            limitedBy: best?.recipeId ?? null,
            limitingPerUnit: (vectorOf.get(member.id)!.get(best?.recipeId ?? "") ?? 0),
            runnerUpRate: runnerUp,
          });
          shareHandled.add(member.id);
        }
        continue;
      }

      const vector = vectorOf.get(entry.id)!;
      const requested = entry.targetRate ?? Number.POSITIVE_INFINITY;
      const { best, runnerUp } = bestTwo(constraints(content, vector, remaining));
      const ceiling = best === null ? 0 : best.ratio;
      const allocated = Math.max(0, Math.min(requested, ceiling));

      for (const [recipeId, perUnit] of vector) {
        remaining.set(recipeId, (remaining.get(recipeId) ?? 0) - allocated * perUnit);
      }
      commit(entry.id, vector, allocated);

      const limited = best !== null && allocated < requested - 1e-12;
      const previous = results.get(entry.id);
      results.set(entry.id, {
        entryId: entry.id,
        itemId: entry.itemId ?? "",
        requested,
        allocated: (previous?.allocated ?? 0) + allocated,
        limitedBy: limited ? best.recipeId : null,
        limitingPerUnit: limited ? best.perUnit : 0,
        runnerUpRate: runnerUp,
      });
    }
  };

  // Phase A: contested recipes are taxed by the reserve floor.
  const phaseA = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    const contested = (touchCount.get(recipeId) ?? 0) >= 2;
    phaseA.set(recipeId, contested ? units * (1 - reserveFloor) : units);
  }
  runPass(phaseA, null);

  // Phase B: whatever is still unused, offered in priority order to the entries that
  // got exactly nothing. This is what keeps a low-priority target off a hard 0%.
  const starved = new Set<string>();
  for (const entry of live) {
    const result = results.get(entry.id);
    if (result && result.allocated <= 0 && vectorOf.get(entry.id)!.size > 0) starved.add(entry.id);
  }
  if (starved.size > 0) {
    const phaseB = new Map<RecipeId, number>();
    for (const [recipeId, units] of capacityUnits) {
      phaseB.set(recipeId, units - (usedUnits.get(recipeId) ?? 0));
    }
    runPass(phaseB, starved);
  }

  const remainingUnits = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    remainingUnits.set(recipeId, units - (usedUnits.get(recipeId) ?? 0));
  }

  return {
    usedUnits,
    remainingUnits,
    entries: live.map((entry) => results.get(entry.id)).filter((r): r is EntryAllocation => !!r),
    allocations,
  };
}
```

- [ ] **Step 4: Create the sub-barrel and register it**

`packages/engine/src/solve/index.ts`:

```ts
export * from "./waterfall.js";
```

Add one line to `packages/engine/src/index.ts`, after the `economy` line:

```ts
export * from "./solve/index.js";
```

- [ ] **Step 5: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

If the share-group test reports the group at the wrong list position, check that `runPass` iterates `live` (the full ordered list) and short-circuits on `shareHandled`, rather than iterating `shareGroup`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the waterfall allocation over the priority list

Spec 4.2's demand-pull waterfall, with spec C.2's stock model folded in:
the requirement walk traverses through an item only when it is pinned
EMPTY, and cuts everywhere else, because an item with stock can supply a
target faster than it is produced. Ties break by authored recipe order per
spec A.5. Share entries are grouped and scaled by one scalar. The 2%
reserve floor runs as a second pass over untouched capacity, so a starved
low-priority target reads as small rather than broken. Power is an
ordinary entry targeting the synthetic power item (spec C.4).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 9: Item states and the constraint-pinning fixed point

**Files:**
- Create: `packages/engine/src/solve/fixpoint.ts`
- Modify: `packages/engine/src/solve/index.ts`
- Test: `packages/engine/src/solve/fixpoint.test.ts`

**Interfaces:**
- Consumes: `type IndexedContent`, `type ItemId`, `type RecipeId`, `POWER_ITEM` (Task 2); `type ExpansionVectors`, `computeExpansion` (Task 3); `type WorldState`, `type PriorityEntry` (Task 4); `computeCapacity` (Task 6); `itemStateTag`, `liquid`, `type ItemStateTag` (Task 7); `runWaterfall`, `effectivePriority`, `RESERVE_FLOOR`, `type WaterfallResult` (Task 8)
- Produces, from `@manufactory/engine`:
  - `const FLOW_TOLERANCE = 1e-9`
  - `interface ItemFlow { production: number; consumption: number; net: number }`
  - `computeFlows(content: IndexedContent, capacityUnits: ReadonlyMap<RecipeId, number>, clocks: ReadonlyMap<RecipeId, number>): Map<ItemId, ItemFlow>`
  - `interface SolvePassArgs { content: IndexedContent; vectors: ExpansionVectors; state: WorldState; capacityUnits: ReadonlyMap<RecipeId, number>; entries: readonly PriorityEntry[]; pinnedEmpty: ReadonlySet<ItemId>; reserveFloor: number }`
  - `interface SolvePassResult { clocks: Map<RecipeId, number>; waterfall: WaterfallResult; flows: Map<ItemId, ItemFlow>; itemStates: Map<ItemId, ItemStateTag> }`
  - `solvePass(args: SolvePassArgs): SolvePassResult`
  - `interface SolveItemsArgs extends SolvePassArgs { seedPins: boolean }` — note `pinnedEmpty` is ignored by `solveItems`, which derives its own
  - `interface SolveItemsResult { pass: SolvePassResult; passes: number; pinOrder: ItemId[]; pinnedEmpty: Set<ItemId> }`
  - `solveItems(args: Omit<SolvePassArgs, "pinnedEmpty"> & { seedPins: boolean }): SolveItemsResult`

Spec C.2 gives three item states and spec C.3 the fixed point that reconciles them. This task implements both, and the shape it takes rests on **ruling R6**: because cyclic recipes are excluded, the live recipe graph is a DAG, and that makes the two halves of the constraint set behave very differently.

**The FULL half is discharged exactly, inside a single pass.** An item at cap must satisfy `production ≤ consumption` (producers backpressure — spec 3.3 is explicit that they throttle rather than waste). After the waterfall, the pass walks items in **reverse topological order** — consumers before producers — and for each FULL item whose production exceeds its consumption, scales every live producer's clock by `consumption / production`. Downstream-first is what makes one sweep enough: throttling the producers of item *i* lowers consumption of *i*'s inputs, which are upstream and therefore still ahead in the walk; and a later upstream throttle can only lower a downstream item's production further, which relaxes an already-satisfied constraint rather than breaking it. In a graph with cycles this would need a damped iteration; R6 buys the exact single sweep.

**The EMPTY half is what the outer loop discovers.** An item with no stock must satisfy `consumption ≤ production`, enforced structurally by making the requirement walk traverse through it. Spec C.3's loop:

```
1. assume every item FLOWING
2. solve
3. find violations  (stored = 0 with net < 0, or stored = cap with net > 0)
4. none? done.
5. pin the worst violator, goto 2
```

Each iteration pins at least one item and pins are never removed, so it terminates in **≤ |items| passes** — a real bound, and Task 14's property suite asserts it on random states. The hard stop in the loop is `content.itemIds.length`.

`seedPins` pre-pins every item with `liquid == 0`. That is not a guess: no stock means `consumption ≤ production` is already true of the world, so the pin can only add a constraint that physically holds. It is conservative — it can add pins the discovery loop would not have found, never remove one — and it makes the priority order rather than luck decide which target gets scarce upstream capacity, which is what the player expects from a priority list. `solve()` in Task 10 seeds by default; the property test runs unseeded, because that is where the `≤ |items|` bound is genuinely exercised.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/solve/fixpoint.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { computeExpansion } from "../graph/expand.js";
import { indexContent } from "../graph/index-content.js";
import { computeCapacity } from "../economy/capacity.js";
import { liquidCap } from "../economy/storage.js";
import { initialWorld, type WorldState } from "../state/world.js";
import { effectivePriority } from "./waterfall.js";
import { computeFlows, solveItems, solvePass } from "./fixpoint.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** Float64 noise budget for rate comparisons. */
const FLOATING_SLACK = 1e-9;

function setup(state: WorldState) {
  const capacity = computeCapacity(content, state);
  return {
    content,
    vectors: computeExpansion(content, state.tier, state.activeRecipe),
    state,
    capacityUnits: capacity.unitsByRecipe,
    entries: effectivePriority(content, state, capacity, 0),
    reserveFloor: 0,
  };
}

describe("computeFlows", () => {
  it("adds up production and consumption across every live recipe", () => {
    const state = initialWorld(content, 1, 0);
    const capacity = computeCapacity(content, state);
    const clocks = new Map([
      ["mine_iron", 1],
      ["smelt_iron", 1],
      ["make_plate", 1],
    ]);
    const flows = computeFlows(content, capacity.unitsByRecipe, clocks);
    // 2 miner units x 1 ore/s = 2 produced; 2 smelter units x 0.5 ore/s = 1 consumed.
    expect(flows.get("iron_ore")!.production).toBeCloseTo(2, 12);
    expect(flows.get("iron_ore")!.consumption).toBeCloseTo(1, 12);
    expect(flows.get("iron_ore")!.net).toBeCloseTo(1, 12);
    // 2 smelter units x 0.5 ingot/s = 1; 1 constructor unit x 0.5 ingot/s = 0.5.
    expect(flows.get("iron_ingot")!.net).toBeCloseTo(0.5, 12);
    // 1 constructor unit x 1/3 plate/s.
    expect(flows.get("iron_plate")!.production).toBeCloseTo(1 / 3, 12);
  });
});

describe("solvePass — the FULL throttle sweep", () => {
  it("throttles producers of an item at cap so its net rate is zero (spec C.2)", () => {
    const base = initialWorld(content, 1, 0);
    // iron_ingot at its combined cap: baseStorageCap 400 + baseQuantumCap 1600.
    const full: WorldState = {
      ...base,
      stored: { ...base.stored, iron_ingot: D(400) },
      quantum: { ...base.quantum, iron_ingot: D(1600) },
    };
    expect(liquidCap(content, full, "iron_ingot").toNumber()).toBe(2000);

    const args = setup(full);
    const pinned = new Set(["iron_ore", "iron_plate"]);
    const result = solvePass({ ...args, pinnedEmpty: pinned });

    // Before the sweep the smelters would run at clock 1, making 1 ingot/s while the
    // constructor consumes 0.5/s. The sweep halves them.
    expect(result.clocks.get("make_plate")).toBeCloseTo(1, 12);
    expect(result.clocks.get("smelt_iron")).toBeCloseTo(0.5, 12);
    expect(result.clocks.get("mine_iron")).toBeCloseTo(1, 12);

    expect(result.flows.get("iron_ingot")!.net).toBeCloseTo(0, 9);
    // Ore: 2/s produced, 2 smelter units x 0.5 clock x 0.5 ore/s = 0.5/s consumed.
    expect(result.flows.get("iron_ore")!.net).toBeCloseTo(1.5, 9);
    expect(result.itemStates.get("iron_ingot")).toBe("FULL");
    expect(result.itemStates.get("iron_ore")).toBe("EMPTY");
  });

  it("leaves a FULL item alone when it is already draining", () => {
    const base = initialWorld(content, 1, 0);
    const full: WorldState = {
      ...base,
      stored: { ...base.stored, iron_ore: D(600) },
      quantum: { ...base.quantum, iron_ore: D(2400) },
      // No miners assigned, so ore is consumed and never produced.
      assignment: { ...base.assignment, mine_iron: 0 },
    };
    const args = setup(full);
    const result = solvePass({ ...args, pinnedEmpty: new Set(["iron_ingot", "iron_plate"]) });
    expect(result.flows.get("iron_ore")!.net).toBeLessThanOrEqual(0);
  });

  it("never leaves an item at cap with a positive net rate (spec E.6)", () => {
    const base = initialWorld(content, 1, 0);
    for (const itemId of ["iron_ore", "iron_ingot", "iron_plate"]) {
      const cap = liquidCap(content, base, itemId);
      const full: WorldState = { ...base, quantum: { ...base.quantum, [itemId]: cap } };
      const args = setup(full);
      const result = solveItems({ ...args, seedPins: true });
      expect(result.pass.flows.get(itemId)!.net).toBeLessThanOrEqual(FLOATING_SLACK);
    }
  });
});

describe("solveItems — the EMPTY fixed point (spec C.3)", () => {
  it("discovers the pins one at a time when unseeded", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: false });
    // Every stockpile is zero, so consumption must be clamped to production for any
    // item something pulls through.
    expect(result.passes).toBeGreaterThanOrEqual(1);
    expect(result.pass.flows.get("iron_ingot")!.net).toBeGreaterThanOrEqual(-FLOATING_SLACK);
    expect(result.pass.flows.get("iron_ore")!.net).toBeGreaterThanOrEqual(-FLOATING_SLACK);
  });

  it("terminates within |items| passes", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: false });
    expect(result.passes).toBeLessThanOrEqual(content.itemIds.length);
  });

  it("seeds every empty item and converges in a single pass", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: true });
    expect(result.passes).toBe(1);
    expect(result.pinnedEmpty.has("iron_ore")).toBe(true);
    expect(result.pinnedEmpty.has("iron_ingot")).toBe(true);
  });

  it("does not pin an item that has stock to draw on", () => {
    const base = initialWorld(content, 1, 0);
    const withStock: WorldState = { ...base, stored: { ...base.stored, iron_ingot: D(500) } };
    const result = solveItems({ ...setup(withStock), seedPins: true });
    expect(result.pinnedEmpty.has("iron_ingot")).toBe(false);
    expect(result.pass.itemStates.get("iron_ingot")).toBe("FLOWING");
  });

  it("lets a stocked item drain faster than it is produced (spec C.2)", () => {
    const base = initialWorld(content, 1, 0);
    // No smelters at all, but a bank of ingots: the constructor should still run.
    const draining: WorldState = {
      ...base,
      stored: { ...base.stored, iron_ingot: D(5000) },
      assignment: { ...base.assignment, smelt_iron: 0 },
    };
    const result = solveItems({ ...setup(draining), seedPins: true });
    expect(result.pass.clocks.get("make_plate")).toBeCloseTo(1, 12);
    expect(result.pass.flows.get("iron_ingot")!.net).toBeCloseTo(-0.5, 12);
  });

  it("records the order pins were added, for the explain command", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: false });
    expect(Array.isArray(result.pinOrder)).toBe(true);
    expect(new Set(result.pinOrder).size).toBe(result.pinOrder.length);
  });

  it("agrees with the unseeded fixed point on the fixture start state", () => {
    const state = initialWorld(content, 1, 0);
    const seeded = solveItems({ ...setup(state), seedPins: true });
    const unseeded = solveItems({ ...setup(state), seedPins: false });
    for (const itemId of content.stockItemIds) {
      expect(seeded.pass.flows.get(itemId)!.net).toBeCloseTo(
        unseeded.pass.flows.get(itemId)!.net,
        9,
      );
    }
  });

  it("never produces a NaN or infinite rate", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: true });
    for (const flow of result.pass.flows.values()) {
      expect(Number.isFinite(flow.production)).toBe(true);
      expect(Number.isFinite(flow.consumption)).toBe(true);
      expect(Number.isFinite(flow.net)).toBe(true);
    }
    for (const clock of result.pass.clocks.values()) {
      expect(clock).toBeGreaterThanOrEqual(0);
      expect(clock).toBeLessThanOrEqual(1 + FLOATING_SLACK);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test fixpoint`
Expected: FAIL — `Cannot find module './fixpoint.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/solve/fixpoint.ts`:

```ts
// Spec C.2's three item states and spec C.3's fixed point.
//
// The two halves of the constraint set behave differently, and ruling R6 is why.
// Cyclic recipes are excluded, so the live recipe graph is a DAG:
//
//   FULL  (liquid at cap, production must not exceed consumption)
//         Discharged exactly inside one pass, by walking items in reverse
//         topological order -- consumers before producers -- and scaling each FULL
//         item's producers by consumption/production. Downstream-first is what makes
//         a single sweep enough: throttling i's producers lowers consumption of i's
//         inputs, which are still ahead in the walk, and a later upstream throttle
//         can only lower a downstream item's production further, which relaxes an
//         already-satisfied constraint. With cycles this would need damped
//         iteration.
//
//   EMPTY (no stock, consumption must not exceed production)
//         Enforced structurally by making the requirement walk traverse through the
//         item. Discovered by spec C.3's loop, which pins at least one item per
//         iteration and never unpins, so it terminates in <= |items| passes.
import type { ItemId, RecipeId } from "../content/types.js";
import { POWER_ITEM } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { ExpansionVectors } from "../graph/expand.js";
import type { PriorityEntry, WorldState } from "../state/world.js";
import { itemStateTag, liquid, type ItemStateTag } from "../economy/storage.js";
import { runWaterfall, type WaterfallResult } from "./waterfall.js";

/** Rates below this are treated as zero. Comfortably above float64 noise. */
export const FLOW_TOLERANCE = 1e-9;

export interface ItemFlow {
  production: number;
  consumption: number;
  net: number;
}

export function computeFlows(
  content: IndexedContent,
  capacityUnits: ReadonlyMap<RecipeId, number>,
  clocks: ReadonlyMap<RecipeId, number>,
): Map<ItemId, ItemFlow> {
  const flows = new Map<ItemId, ItemFlow>();
  const bump = (itemId: ItemId, produced: number, consumed: number): void => {
    const current = flows.get(itemId) ?? { production: 0, consumption: 0, net: 0 };
    current.production += produced;
    current.consumption += consumed;
    current.net = current.production - current.consumption;
    flows.set(itemId, current);
  };

  for (const itemId of content.itemIds) bump(itemId, 0, 0);

  for (const [recipeId, units] of capacityUnits) {
    const rate = units * (clocks.get(recipeId) ?? 0);
    if (rate === 0) continue;
    const recipe = content.recipes.get(recipeId)!;
    for (const [itemId, perSecond] of recipe.outputPerSecond) bump(itemId, rate * perSecond, 0);
    for (const [itemId, perSecond] of recipe.inputPerSecond) bump(itemId, 0, rate * perSecond);
  }
  return flows;
}

export interface SolvePassArgs {
  content: IndexedContent;
  vectors: ExpansionVectors;
  state: WorldState;
  capacityUnits: ReadonlyMap<RecipeId, number>;
  entries: readonly PriorityEntry[];
  pinnedEmpty: ReadonlySet<ItemId>;
  reserveFloor: number;
}

export interface SolvePassResult {
  clocks: Map<RecipeId, number>;
  waterfall: WaterfallResult;
  flows: Map<ItemId, ItemFlow>;
  itemStates: Map<ItemId, ItemStateTag>;
}

export function solvePass(args: SolvePassArgs): SolvePassResult {
  const { content, vectors, state, capacityUnits, entries, pinnedEmpty, reserveFloor } = args;

  const waterfall = runWaterfall({
    content,
    vectors,
    activeRecipe: state.activeRecipe,
    capacityUnits,
    entries,
    pinnedEmpty,
    reserveFloor,
  });

  const clocks = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    clocks.set(recipeId, units > 0 ? (waterfall.usedUnits.get(recipeId) ?? 0) / units : 0);
  }

  const itemStates = new Map<ItemId, ItemStateTag>();
  for (const itemId of content.stockItemIds) {
    itemStates.set(itemId, itemStateTag(content, state, itemId));
  }

  // Spec 3.3's backpressure, discharged in one downstream-first sweep (ruling R6).
  for (let i = content.topologicalItems.length - 1; i >= 0; i -= 1) {
    const itemId = content.topologicalItems[i]!;
    if (itemId === POWER_ITEM) continue;
    if (itemStates.get(itemId) !== "FULL") continue;

    const flows = computeFlows(content, capacityUnits, clocks);
    const flow = flows.get(itemId);
    if (!flow) continue;
    if (flow.production <= flow.consumption + FLOW_TOLERANCE) continue;
    if (flow.production <= 0) continue;

    const factor = flow.consumption / flow.production;
    for (const recipeId of content.producersOf.get(itemId) ?? []) {
      const clock = clocks.get(recipeId);
      if (clock === undefined) continue;
      clocks.set(recipeId, clock * factor);
    }
  }

  return { clocks, waterfall, flows: computeFlows(content, capacityUnits, clocks), itemStates };
}

export interface SolveItemsResult {
  pass: SolvePassResult;
  passes: number;
  pinOrder: ItemId[];
  pinnedEmpty: Set<ItemId>;
}

/**
 * Spec C.3's loop. `seedPins` pre-pins every item with no stock -- not a guess, but
 * a fact about the state: no stock means consumption cannot exceed production, so
 * the pin only asserts something already true. It is conservative (it can add pins
 * the loop would not have found, never remove one) and it makes the priority order
 * decide which target gets scarce upstream capacity rather than leaving it to the
 * order production happens to be pulled in.
 */
export function solveItems(
  args: Omit<SolvePassArgs, "pinnedEmpty"> & { seedPins: boolean },
): SolveItemsResult {
  const { content, state, seedPins } = args;

  const pinnedEmpty = new Set<ItemId>();
  const pinOrder: ItemId[] = [];
  if (seedPins) {
    for (const itemId of content.stockItemIds) {
      if (liquid(state, itemId).lte(0)) {
        pinnedEmpty.add(itemId);
        pinOrder.push(itemId);
      }
    }
  }

  // Each iteration pins at least one item and pins are never removed, so this is a
  // hard bound rather than a hope (spec C.3).
  const limit = content.itemIds.length;
  let pass = solvePass({ ...args, pinnedEmpty });
  let passes = 1;

  while (passes < limit) {
    let worst: ItemId | null = null;
    let worstNet = -FLOW_TOLERANCE;
    for (const itemId of content.stockItemIds) {
      if (pinnedEmpty.has(itemId)) continue;
      if (!liquid(state, itemId).lte(0)) continue;
      const net = pass.flows.get(itemId)?.net ?? 0;
      if (net < worstNet) {
        worstNet = net;
        worst = itemId;
      }
    }
    if (worst === null) break;

    pinnedEmpty.add(worst);
    pinOrder.push(worst);
    pass = solvePass({ ...args, pinnedEmpty });
    passes += 1;
  }

  return { pass, passes, pinOrder, pinnedEmpty };
}
```

- [ ] **Step 4: Export it**

`packages/engine/src/solve/index.ts`:

```ts
export * from "./waterfall.js";
export * from "./fixpoint.js";
```

- [ ] **Step 5: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

If the FULL sweep test shows `smelt_iron` at a clock other than 0.5, check that `itemStates` is computed once before the sweep (a FULL item stays FULL for the whole sweep — the *state* does not change mid-solve, only the clocks do).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add item states and the constraint-pinning fixed point

Spec C.2's three states and spec C.3's loop. Ruling R6 makes the live
recipe graph a DAG, which lets the FULL half be discharged exactly by one
reverse-topological throttle sweep rather than a damped iteration: walking
consumers before producers means a later upstream throttle can only relax
an already-satisfied constraint. The EMPTY half is the discovery loop,
which pins at least one item per iteration and never unpins, so it
terminates in at most |items| passes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 10: Power equilibrium, bottleneck reporting, and the `solve` entry point

**Files:**
- Create: `packages/engine/src/solve/power.ts`, `packages/engine/src/solve/bottleneck.ts`, `packages/engine/src/solve/solve.ts`
- Modify: `packages/engine/src/solve/index.ts`
- Test: `packages/engine/src/solve/solve.test.ts`

**Interfaces:**
- Consumes: `type IndexedContent`, `type ItemId`, `type RecipeId`, `POWER_ITEM` (Task 2); `computeExpansion` (Task 3); `type WorldState` (Task 4); `computeCapacity`, `powerDemandMw`, `powerSupplyMw`, `bestUnlockedMark`, `type CapacityTable` (Task 6); `type ItemStateTag` (Task 7); `effectivePriority`, `RESERVE_FLOOR`, `type EntryAllocation` (Task 8); `solveItems`, `computeFlows`, `type ItemFlow` (Task 9)
- Produces, from `@manufactory/engine`:
  - `const POWER_PASSES = 8`, `const POWER_TOLERANCE = 1e-12`
  - `interface PowerReport { demandMw: number; fullDemandMw: number; supplyMw: number; ratio: number; passes: number }`
  - `type Bottleneck = { kind: "recipe"; recipeId: RecipeId; limitingTarget: string; machinesToClear: number } | { kind: "power"; limitingTarget: string; generatorRecipeId: RecipeId | null; machinesToClear: number } | null`
  - `computeBottleneck(content: IndexedContent, capacity: CapacityTable, entries: readonly EntryAllocation[], power: PowerReport, tier: number, activeRecipe: Readonly<Record<ItemId, RecipeId>>): Bottleneck`
  - `interface Solution { clocks: Map<RecipeId, number>; itemRates: Map<ItemId, ItemFlow>; itemStates: Map<ItemId, ItemStateTag>; allocations: Map<RecipeId, Map<string, number>>; entries: EntryAllocation[]; bottleneck: Bottleneck; power: PowerReport; capacity: CapacityTable; passes: number; pinOrder: ItemId[]; pinnedEmpty: Set<ItemId> }`
  - `interface SolveOptions { seedPins?: boolean; reserveFloor?: number }`
  - `solve(state: WorldState, content: IndexedContent, options?: SolveOptions): Solution`

Spec C.4 makes power the **outer** loop and item states the inner one. Three things about the implementation need stating, because two of them are deliberate departures:

**The ratio is computed against full-power demand, not against the already-scaled demand.** Spec 6.1 writes `powerRatio = min(1, capacity / demand)`, and spec C.4 adds damping to keep that from oscillating. It oscillates because `demand` there is measured at the current ratio: if demand at ratio 1 is 300 MW against 200 MW of capacity, the naive update gives 0.667, then demand falls to 200, then the update gives 1, then 0.667 again. The fixed point of the naive iteration is `sqrt(capacity/fullDemand)`, which is *wrong* — at that ratio the grid still draws more than it can supply. Measuring against full-power demand instead gives `ratio = capacity / fullDemand` directly, which is the correct equilibrium and needs no damping. It converges in two passes when supply does not depend on the ratio and three when generators are fed through the graph — exactly spec C.4's "2–3 passes".

**`powerRatio` scales the capacity of consuming recipes only.** Generators (`powerOutput > 0`) are exempt. This is spec C.4's fix for the power death spiral: generators consume fuel drawn from the graph, so if a brownout throttled generators too, capacity would fall, deepening the brownout, unrecoverably, and hardest while offline — violating pillar 1. Together with power sitting at priority position 1, the spiral cannot start on its own, and a player who deliberately deprioritizes power is told exactly what they did by the bottleneck report.

**Clocks are reported absolute.** Inside the loop the waterfall runs against scaled capacity, so its clocks are relative to that. `absoluteClock = scaledClock × ratio` for consumers and `= scaledClock` for generators. Item flows are unaffected either way, since `scaledCapacity × scaledClock = baseCapacity × absoluteClock`.

Spec 4.5 requires `bottleneck` as **first-class solver output**, never derived by the UI: the single recipe that limited the highest-priority target, plus how many machines would clear it. `machinesToClear` is the count that would make some *other* recipe the binding constraint — "6 more constructors clears it" — computed from the runner-up ratio the waterfall already recorded. When power is binding, the bottleneck is power-shaped instead and names a generator purchase.

The tap's power injection (spec section 7) is added to supply while any tap stack is live. Spec 7 wants it to scale more slowly than the production kick; Phase 1 keeps it flat at `tap.powerInjectionMw`, and Phase 2's calibration gives it a curve.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/solve/solve.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import { solve } from "./solve.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const NO_FLOOR = { reserveFloor: 0 };

/** 60 Mk1 miners: 300 MW of draw against the fixture's 200 MW HUB allowance. */
function brownout(tier: number): WorldState {
  let w = initialWorld(content, 1, 0);
  w = { ...w, tier };
  w = withInstalled(w, "iron", "miner", 1, 60);
  return { ...w, assignment: { ...w.assignment, mine_iron: 60 } };
}

describe("solve — the healthy case", () => {
  it("runs everything at full clock when the grid has headroom", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.power.ratio).toBe(1);
    // 2 miners x 5 + 2 smelters x 4 + 1 constructor x 4 = 22 MW.
    expect(sol.power.demandMw).toBeCloseTo(22, 9);
    expect(sol.power.supplyMw).toBeCloseTo(200, 9);
    expect(sol.clocks.get("make_plate")).toBeCloseTo(1, 12);
    expect(sol.clocks.get("smelt_iron")).toBeCloseTo(1, 12);
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(1, 12);
  });

  it("reports item rates and states", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.itemRates.get("iron_plate")!.net).toBeCloseTo(1 / 3, 9);
    expect(sol.itemRates.get("iron_ingot")!.net).toBeCloseTo(0.5, 9);
    expect(sol.itemRates.get("iron_ore")!.net).toBeCloseTo(1, 9);
    expect(sol.itemStates.get("iron_ore")).toBe("EMPTY");
  });

  it("names the binding recipe and the machines that would clear it (spec 4.5)", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      // Runner-up is smelt_iron at 2/3 plate/s against 1/3 achieved. Closing that
      // needs (2/3 - 1/3) x 3 = 1 more constructor unit, and one machine is one unit.
      machinesToClear: 1,
    });
  });

  it("quotes more machines when the runner-up is further away", () => {
    let w = initialWorld(content, 1, 0);
    // 8 smelters keeps ladderInput under the interval of 10, so the ladder stays x1.
    w = withInstalled(w, "iron", "smelter", 1, 8);
    w = { ...w, assignment: { ...w.assignment, smelt_iron: 8 } };
    // Only the plate entry, so nothing else competes for miner or smelter capacity.
    w = { ...w, priority: w.priority.filter((e) => e.itemId !== "iron_ingot" && e.itemId !== "iron_ore") };
    const sol = solve(w, content, NO_FLOOR);
    // Ratios: make_plate 1/3, smelt_iron 8/3, mine_iron 2/1.5 = 4/3. Runner-up is
    // mine_iron at 4/3. (4/3 - 1/3) x 3 = 3 constructor units, one per machine.
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 3,
    });
  });
});

describe("solve — power equilibrium (spec C.4)", () => {
  it("settles at capacity over full-power demand, not at a square root", () => {
    const sol = solve(brownout(0), content, NO_FLOOR);
    // Full-power demand: 60 x 5 + 2 x 4 + 1 x 4 = 312 MW against 200 MW of supply.
    expect(sol.power.fullDemandMw).toBeCloseTo(312, 6);
    expect(sol.power.supplyMw).toBeCloseTo(200, 9);
    expect(sol.power.ratio).toBeCloseTo(200 / 312, 9);
    // At equilibrium the grid draws exactly what it can supply.
    expect(sol.power.demandMw).toBeCloseTo(200, 6);
  });

  it("converges within the 2 to 3 passes spec C.4 predicts", () => {
    expect(solve(brownout(0), content, NO_FLOOR).power.passes).toBeLessThanOrEqual(3);
  });

  it("reports absolute clocks, scaled by the ratio", () => {
    const sol = solve(brownout(0), content, NO_FLOOR);
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(200 / 312, 9);
    expect(sol.clocks.get("smelt_iron")).toBeCloseTo(200 / 312, 9);
  });

  it("surfaces a power-shaped bottleneck and a generator purchase (spec 4.5)", () => {
    const sol = solve(brownout(3), content, NO_FLOOR);
    expect(sol.bottleneck!.kind).toBe("power");
    if (sol.bottleneck!.kind !== "power") throw new Error("unreachable");
    // burn_fuel makes 250 MW per unit; at tier 3 the oil lane carries a x1.5 x x1.5
    // milestone multiplier, so one generator machine is 2.25 units = 562.5 MW.
    // The deficit is 312 - 200 = 112 MW, so one machine covers it.
    expect(sol.bottleneck.generatorRecipeId).toBe("burn_fuel");
    expect(sol.bottleneck.machinesToClear).toBe(1);
  });

  it("reports no generator to buy when none is unlocked", () => {
    const sol = solve(brownout(0), content, NO_FLOOR);
    if (sol.bottleneck!.kind !== "power") throw new Error("expected a power bottleneck");
    expect(sol.bottleneck.generatorRecipeId).toBeNull();
    expect(sol.bottleneck.machinesToClear).toBe(0);
  });

  it("exempts generators from the ratio, so a brownout cannot spiral (spec C.4)", () => {
    let w = brownout(3);
    w = withInstalled(w, "oil", "generator", 1, 1);
    w = { ...w, assignment: { ...w.assignment, burn_fuel: 1 } };
    // A stocked fuel buffer at its cap, so the generator draws from stock rather
    // than needing the whole oil chain built.
    w = {
      ...w,
      stored: { ...w.stored, fuel: D(200) },
      quantum: { ...w.quantum, fuel: D(800) },
    };
    const sol = solve(w, content, NO_FLOOR);
    // One generator machine is 2.25 units x 250 MW = 562.5 MW of headroom, so the
    // grid recovers: supply 200 + 312 = 512 against 312 of demand.
    expect(sol.power.ratio).toBe(1);
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(1, 9);
    // The generator throttles itself to the demand it is asked for: 312 / 562.5.
    expect(sol.clocks.get("burn_fuel")).toBeCloseTo(312 / 562.5, 6);
    expect(sol.power.supplyMw).toBeCloseTo(512, 6);
  });
});

describe("solve — options and shape", () => {
  it("seeds the pin set by default and reports the pass count", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.pinnedEmpty.has("iron_ore")).toBe(true);
    expect(sol.passes).toBe(1);
  });

  it("honours seedPins: false", () => {
    const sol = solve(initialWorld(content, 1, 0), content, { ...NO_FLOOR, seedPins: false });
    expect(sol.passes).toBeLessThanOrEqual(content.itemIds.length);
  });

  it("applies the 2% reserve floor by default", () => {
    const sol = solve(initialWorld(content, 1, 0), content);
    // mine_iron and smelt_iron are contested, so 2% of each sits idle.
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(0.98, 9);
    expect(sol.clocks.get("make_plate")).toBeCloseTo(1, 9);
  });

  it("exposes the capacity table it solved against", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.capacity.unitsByRecipe.get("mine_iron")).toBeCloseTo(2, 12);
  });

  it("is a pure function — solving twice gives identical numbers", () => {
    const w = brownout(3);
    const a = solve(w, content, NO_FLOOR);
    const b = solve(w, content, NO_FLOOR);
    expect(a.power.ratio).toBe(b.power.ratio);
    for (const [recipeId, clock] of a.clocks) expect(b.clocks.get(recipeId)).toBe(clock);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test solve.test`
Expected: FAIL — `Cannot find module './solve.js'`.

- [ ] **Step 3: Write the power module**

`packages/engine/src/solve/power.ts`:

```ts
// Spec C.4's outer loop.
//
// Spec 6.1 writes powerRatio = min(1, capacity / demand) and spec C.4 adds damping
// to stop it oscillating. It oscillates because `demand` there is measured at the
// current ratio: 300 MW of draw against 200 MW gives 0.667, then demand falls to
// 200, then the update gives 1, then 0.667 again. Worse, the naive iteration's fixed
// point is sqrt(capacity/fullDemand), at which the grid still draws more than it can
// supply. Measuring against FULL-POWER demand gives ratio = capacity / fullDemand
// directly -- the correct equilibrium, and no damping required. Two passes when
// supply is ratio-independent, three when generators are fed through the graph,
// which is exactly the 2-3 spec C.4 predicts.
//
// powerRatio scales consuming recipes only. Generators are exempt, which is spec
// C.4's fix for the death spiral: generators burn fuel drawn from the graph, so
// throttling them in a brownout would cut capacity, deepen the brownout, and never
// recover -- hardest while offline, violating pillar 1.
import type { RecipeId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { CapacityTable } from "../economy/capacity.js";

export const POWER_PASSES = 8;
export const POWER_TOLERANCE = 1e-12;

export interface PowerReport {
  /** Megawatts actually drawn at the settled ratio. */
  demandMw: number;
  /** Megawatts the same factory would draw at ratio 1. */
  fullDemandMw: number;
  supplyMw: number;
  ratio: number;
  passes: number;
}

export function isGenerator(content: IndexedContent, recipeId: RecipeId): boolean {
  return (content.recipes.get(recipeId)?.def.powerOutput ?? 0) > 0;
}

/** A copy of the table with consuming recipes' capacity scaled by the grid ratio. */
export function scaleCapacityByRatio(
  content: IndexedContent,
  capacity: CapacityTable,
  ratio: number,
): CapacityTable {
  const unitsByRecipe = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacity.unitsByRecipe) {
    unitsByRecipe.set(recipeId, isGenerator(content, recipeId) ? units : units * ratio);
  }
  return { ...capacity, unitsByRecipe };
}

/** Undoes the scaling, so reported clocks are fractions of nameplate speed. */
export function absoluteClocks(
  content: IndexedContent,
  scaled: ReadonlyMap<RecipeId, number>,
  ratio: number,
): Map<RecipeId, number> {
  const out = new Map<RecipeId, number>();
  for (const [recipeId, clock] of scaled) {
    out.set(recipeId, isGenerator(content, recipeId) ? clock : clock * ratio);
  }
  return out;
}
```

- [ ] **Step 4: Write the bottleneck module**

`packages/engine/src/solve/bottleneck.ts`:

```ts
// Spec 4.5: the solver returns the bottleneck as first-class output, never something
// the UI derives. Exactly one row per lane carries the treatment, so what is
// returned is the recipe limiting the HIGHEST-PRIORITY limited target -- marking
// every row under 100% teaches players to ignore the marking.
//
// machinesToClear is the count that would make some other recipe the binding
// constraint, which is what "6 more constructors clears it" means. The waterfall
// already recorded the runner-up ratio, so no second solve is needed.
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import type { CapacityTable } from "../economy/capacity.js";
import type { EntryAllocation } from "./waterfall.js";
import type { PowerReport } from "./power.js";

export type Bottleneck =
  | { kind: "recipe"; recipeId: RecipeId; limitingTarget: string; machinesToClear: number }
  | {
      kind: "power";
      limitingTarget: string;
      generatorRecipeId: RecipeId | null;
      machinesToClear: number;
    }
  | null;

function machinesToClearRecipe(capacity: CapacityTable, entry: EntryAllocation): number {
  const recipeId = entry.limitedBy;
  if (recipeId === null) return 0;
  const goal = Math.min(entry.runnerUpRate, entry.requested);
  // An unbounded target with no runner-up has no natural "cleared" point, so quote
  // what a 10% lift would take rather than reporting nothing.
  const target = Number.isFinite(goal) ? goal : entry.allocated * 1.1;
  const shortfallUnits = Math.max(0, target - entry.allocated) * entry.limitingPerUnit;
  const perMachine = capacity.unitsPerMachine.get(recipeId) ?? 0;
  if (perMachine <= 0) return 1;
  return Math.max(1, Math.ceil(shortfallUnits / perMachine));
}

export function computeBottleneck(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  power: PowerReport,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): Bottleneck {
  const firstLimited = entries.find((entry) => entry.limitedBy !== null) ?? null;

  // Spec 4.5: when the grid is what binds, the bottleneck surfaces on the power bar
  // with a generator purchase instead of a recipe.
  if (power.ratio < 1 - 1e-9) {
    const generatorId = activeRecipe[POWER_ITEM];
    const live =
      generatorId !== undefined && isLiveRecipe(content, generatorId, tier, activeRecipe)
        ? generatorId
        : null;

    let machines = 0;
    if (live !== null) {
      const perUnitMw = content.recipes.get(live)!.outputPerSecond.get(POWER_ITEM) ?? 0;
      const perMachineMw = (capacity.unitsPerMachine.get(live) ?? 0) * perUnitMw;
      const deficit = Math.max(0, power.fullDemandMw - power.supplyMw);
      machines = perMachineMw > 0 ? Math.max(1, Math.ceil(deficit / perMachineMw)) : 0;
    }
    return {
      kind: "power",
      limitingTarget: firstLimited?.entryId ?? (entries[0]?.entryId ?? ""),
      generatorRecipeId: live,
      machinesToClear: machines,
    };
  }

  if (firstLimited === null || firstLimited.limitedBy === null) return null;
  return {
    kind: "recipe",
    recipeId: firstLimited.limitedBy,
    limitingTarget: firstLimited.entryId,
    machinesToClear: machinesToClearRecipe(capacity, firstLimited),
  };
}
```

- [ ] **Step 5: Write the solve entry point**

`packages/engine/src/solve/solve.ts`:

```ts
// solve(state, content) -> { clocks, allocations, itemRates, bottleneck, power }
//
// Spec C.3's cost model: ~44 recipes x ~10 priority targets is ~440 operations per
// waterfall pass, x a few item-state passes, x 2-3 power passes. Microseconds. An
// 8-hour resolve with 20 events is 20 of those.
import type { ItemId, RecipeId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import { computeExpansion } from "../graph/expand.js";
import { computeCapacity, powerDemandMw, powerSupplyMw } from "../economy/capacity.js";
import type { CapacityTable } from "../economy/capacity.js";
import type { ItemStateTag } from "../economy/storage.js";
import type { WorldState } from "../state/world.js";
import { effectivePriority, RESERVE_FLOOR, type EntryAllocation } from "./waterfall.js";
import { solveItems, type ItemFlow } from "./fixpoint.js";
import {
  POWER_PASSES,
  POWER_TOLERANCE,
  absoluteClocks,
  scaleCapacityByRatio,
  type PowerReport,
} from "./power.js";
import { computeBottleneck, type Bottleneck } from "./bottleneck.js";

export interface Solution {
  /** Fraction of nameplate speed, per recipe. Absolute, not ratio-relative. */
  clocks: Map<RecipeId, number>;
  itemRates: Map<ItemId, ItemFlow>;
  itemStates: Map<ItemId, ItemStateTag>;
  /** recipe -> entryId -> machine-units. Spec 13.1's split bars. */
  allocations: Map<RecipeId, Map<string, number>>;
  entries: EntryAllocation[];
  bottleneck: Bottleneck;
  power: PowerReport;
  capacity: CapacityTable;
  passes: number;
  pinOrder: ItemId[];
  pinnedEmpty: Set<ItemId>;
}

export interface SolveOptions {
  seedPins?: boolean;
  reserveFloor?: number;
}

export function solve(
  state: WorldState,
  content: IndexedContent,
  options: SolveOptions = {},
): Solution {
  const seedPins = options.seedPins ?? true;
  const reserveFloor = options.reserveFloor ?? RESERVE_FLOOR;

  const capacity = computeCapacity(content, state);
  const vectors = computeExpansion(content, state.tier, state.activeRecipe);
  // Spec section 7: the tap injects power into the grid while a stack is live.
  const tapInjectionMw = state.tapStacks > 0 ? content.bundle.tap.powerInjectionMw : 0;

  let ratio = 1;
  let demandTargetMw = 0;
  let passes = 0;

  let items = solveItems({
    content,
    vectors,
    state,
    capacityUnits: scaleCapacityByRatio(content, capacity, ratio).unitsByRecipe,
    entries: effectivePriority(content, state, capacity, demandTargetMw),
    reserveFloor,
    seedPins,
  });
  let fullDemandMw = 0;
  let supplyMw = 0;

  for (;;) {
    passes += 1;
    const absolute = absoluteClocks(content, items.pass.clocks, ratio);

    // Demand measured at the scaled clocks is what the factory WOULD draw at ratio 1
    // with this allocation pattern. That is the quantity the equilibrium is against.
    fullDemandMw = powerDemandMw(content, capacity, state, items.pass.clocks);
    supplyMw = powerSupplyMw(content, capacity, absolute) + tapInjectionMw;

    const nextRatio = fullDemandMw <= 0 ? 1 : Math.min(1, supplyMw / fullDemandMw);
    const settled =
      passes >= 2 &&
      Math.abs(nextRatio - ratio) < POWER_TOLERANCE &&
      Math.abs(fullDemandMw - demandTargetMw) <= POWER_TOLERANCE * (1 + Math.abs(fullDemandMw));
    // Break without touching `ratio`: `items` was solved at the current ratio, so
    // reporting a different one would make the clocks and the grid disagree. When
    // `settled` fires the two are within POWER_TOLERANCE anyway.
    if (settled || passes >= POWER_PASSES) break;

    ratio = nextRatio;
    demandTargetMw = fullDemandMw;
    items = solveItems({
      content,
      vectors,
      state,
      capacityUnits: scaleCapacityByRatio(content, capacity, ratio).unitsByRecipe,
      entries: effectivePriority(content, state, capacity, demandTargetMw),
      reserveFloor,
      seedPins,
    });
  }

  const clocks = absoluteClocks(content, items.pass.clocks, ratio);
  const power: PowerReport = {
    demandMw: fullDemandMw * ratio,
    fullDemandMw,
    supplyMw,
    ratio,
    passes,
  };

  return {
    clocks,
    itemRates: items.pass.flows,
    itemStates: items.pass.itemStates,
    allocations: items.pass.waterfall.allocations,
    entries: items.pass.waterfall.entries,
    bottleneck: computeBottleneck(
      content,
      capacity,
      items.pass.waterfall.entries,
      power,
      state.tier,
      state.activeRecipe,
    ),
    power,
    capacity,
    passes: items.passes,
    pinOrder: items.pinOrder,
    pinnedEmpty: items.pinnedEmpty,
  };
}
```

- [ ] **Step 6: Export everything**

`packages/engine/src/solve/index.ts`:

```ts
export * from "./waterfall.js";
export * from "./fixpoint.js";
export * from "./power.js";
export * from "./bottleneck.js";
export * from "./solve.js";
```

- [ ] **Step 7: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

If the brownout ratio comes out as roughly 0.8 rather than 0.641, `fullDemandMw` is being measured from the absolute clocks instead of the scaled ones — that is precisely the square-root fixed point the module comment warns about.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add power equilibrium, bottleneck reporting, and the solve entry point

Spec C.4's outer loop, with one deliberate departure: the ratio is
computed against full-power demand rather than against demand already
scaled by the current ratio. The naive form oscillates and its fixed point
is sqrt(capacity/fullDemand), at which the grid still overdraws; measuring
against full-power demand lands on capacity/fullDemand directly and needs
no damping, converging in the 2-3 passes spec C.4 predicts. Generators are
exempt from the ratio, so a brownout cannot spiral. Bottleneck is
first-class solver output per spec 4.5, naming the recipe limiting the
highest-priority target and the machines that would clear it, or a
generator purchase when the grid is what binds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 11: Event-driven `resolve`

**Files:**
- Create: `packages/engine/src/resolve/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/resolve/resolve.test.ts`

**Interfaces:**
- Consumes: `D`, `DECIMAL_ZERO`, `toCanonical`, `type Dec` (Phase 0 Task 2); `type IndexedContent`, `type ItemId` (Task 2); `type WorldState`, `type Timer` (Task 4); `liquid`, `liquidCap`, `depositProduction`, `drainLiquid`, `settleBound`, `canAffordLiquid`, `spendFromLiquid`, `itemStateTag` (Task 7); `solve`, `type Solution` (Task 10)
- Produces, from `@manufactory/engine`:
  - `const MAX_EVENTS = 10000`, `const EPSILON_MS = 1e-6`, `const COARSE_STEP_MS = 60000`
  - `type ResolveEventKind = "fill" | "drain" | "timer" | "milestone" | "guard"`
  - `interface ResolveEvent { kind: ResolveEventKind; atMs: number; itemId?: ItemId; tier?: number; timerId?: string }`
  - `interface ResolveSummary { elapsedMs: number; simulatedMs: number; skippedMs: number; produced: Record<ItemId, string>; filled: { itemId: ItemId; atMs: number }[]; stalled: ItemId[]; tiersUnlocked: number[]; events: number; guardTripped: boolean }`
  - `interface ResolveResult { state: WorldState; events: ResolveEvent[]; summary: ResolveSummary }`
  - `nextMilestoneCost(content: IndexedContent, state: WorldState): Map<ItemId, Dec> | null`
  - `settle(content: IndexedContent, state: WorldState, nowMs: number, events: ResolveEvent[]): WorldState`
  - `resolve(state: WorldState, content: IndexedContent, elapsedMs: number): ResolveResult`

Spec C.7's loop, integrating straight lines between discontinuities. The single most important property in the whole engine is spec E.6's

```
resolve(s, 2t) ≡ resolve(resolve(s, t), t)
```

because offline and online resolution cannot disagree if it holds. Four design rules make it true, and none of them is optional:

1. **Applying an event never stores a mode flag.** A fill is nothing but "the stockpile is now at cap"; the next solve reads that from the state and pins the item FULL on its own. If the loop instead recorded "this item is backpressured", a split at exactly that instant would carry the flag across in one path and re-derive it in the other, and the two could differ.
2. **`settle` is idempotent and runs at the head of every iteration**, including the first and the one that breaks the loop. It flows `bound` down, clamps, and delivers any milestone whose requirement is met. Splitting at an instant where a milestone completes therefore gives the same result whether it is applied at the tail of the first half or the head of the second.
3. **Timers carry absolute fire times** on the same clock as `lastResolvedAt`, and the loop tracks an explicit `cursor` starting from `state.lastResolvedAt`. A split leaves `lastResolvedAt` exactly where the second call expects it.
4. **`lastResolvedAt` advances by the full `elapsedMs`**, not by the capped amount. The offline cap limits *simulation*, not the clock.

The one place the property genuinely does not hold is when `2t > offlineCapMs`, because the cap is applied per call. Task 14's property test therefore uses windows well under 8 hours, and the plan says so rather than pretending otherwise.

Ruling R7's milestone delivery lives in `settle`: when the next tier's requirement is satisfiable from **liquid** stock, it is spent through `spendFromLiquid` and the tier advances. `bound` is never touched, so storage and Quantum Storage caps still gate whether a milestone can ever be banked — which is exactly what spec D4's exploit narrative requires.

Spec C.7's two guards are both required, "without them a player can craft an oscillating factory that denies service to the server": `MAX_EVENTS` caps event-driven steps, after which the loop falls back to coarse fixed steps of `COARSE_STEP_MS`; `EPSILON_MS` stops Zeno subdivision.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/resolve/resolve.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D, fromCanonical } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { liquid, liquidCap } from "../economy/storage.js";
import { initialWorld, type WorldState } from "../state/world.js";
import { COARSE_STEP_MS, EPSILON_MS, MAX_EVENTS, resolve } from "./index.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

const START = 1_700_000_000_000;
const base = (): WorldState => initialWorld(content, 42, START);

describe("guards", () => {
  it("exports the values spec C.7 names", () => {
    expect(MAX_EVENTS).toBe(10_000);
    expect(EPSILON_MS).toBe(1e-6);
    expect(COARSE_STEP_MS).toBe(60_000);
  });
});

describe("resolve — a window with no events", () => {
  it("integrates straight lines", () => {
    const r = resolve(base(), content, 60_000);
    // With the default 2% reserve floor the fixture start runs mine and smelt at
    // clock 0.98 and the constructor at 1.
    //   ore   net = 2*0.98*1 - 2*0.98*0.5 = 0.98/s   -> 58.8 in 60s
    //   ingot net = 2*0.98*0.5 - 1*1*0.5  = 0.48/s   -> 28.8
    //   plate net = 1*1*(1/3)             = 1/3 /s   -> 20
    expect(liquid(r.state, "iron_ore").toNumber()).toBeCloseTo(58.8, 6);
    expect(liquid(r.state, "iron_ingot").toNumber()).toBeCloseTo(28.8, 6);
    expect(liquid(r.state, "iron_plate").toNumber()).toBeCloseTo(20, 6);
    expect(r.state.tier).toBe(0);
  });

  it("accumulates gross lifetime production, not net", () => {
    const r = resolve(base(), content, 60_000);
    // Gross ore production is 1.96/s even though 0.98/s is consumed downstream.
    expect(r.state.lifetime.iron_ore!.toNumber()).toBeCloseTo(117.6, 6);
    expect(r.state.lifetime.iron_ingot!.toNumber()).toBeCloseTo(58.8, 6);
  });

  it("reports what was produced during the window, not the lifetime total", () => {
    const first = resolve(base(), content, 60_000);
    const second = resolve(first.state, content, 60_000);
    // The second window produced another 20 plate; lifetime is now 40.
    expect(fromCanonical(second.summary.produced.iron_plate!).toNumber()).toBeCloseTo(20, 6);
    expect(second.state.lifetime.iron_plate!.toNumber()).toBeCloseTo(40, 6);
  });

  it("advances the clock and reports the window", () => {
    const r = resolve(base(), content, 60_000);
    expect(r.state.lastResolvedAt).toBe(START + 60_000);
    expect(r.summary.elapsedMs).toBe(60_000);
    expect(r.summary.simulatedMs).toBe(60_000);
    expect(r.summary.skippedMs).toBe(0);
    expect(r.summary.guardTripped).toBe(false);
  });

  it("is a no-op for zero or negative elapsed time", () => {
    for (const elapsed of [0, -5_000]) {
      const r = resolve(base(), content, elapsed);
      expect(liquid(r.state, "iron_plate").toNumber()).toBe(0);
      expect(r.state.lastResolvedAt).toBe(START);
    }
  });
});

describe("resolve — discrete events", () => {
  it("stops at a fill and backpressures afterwards", () => {
    const start = base();
    const primed: WorldState = { ...start, stored: { ...start.stored, iron_ore: D(2_900) } };
    // Ore cap is 600 storage + 2400 quantum = 3000; net 0.98/s fills it in ~102s.
    const r = resolve(primed, content, 200_000);
    expect(r.summary.filled.some((f) => f.itemId === "iron_ore")).toBe(true);
    expect(liquid(r.state, "iron_ore").toNumber()).toBeCloseTo(3_000, 6);
    expect(liquidCap(content, r.state, "iron_ore").toNumber()).toBe(3_000);
    expect(r.events.some((e) => e.kind === "fill" && e.itemId === "iron_ore")).toBe(true);
  });

  it("delivers a milestone out of liquid stock and advances the tier (ruling R7)", () => {
    // Tier 1 needs 200 iron_plate; production is 1/3 per second, so 600 seconds.
    const r = resolve(base(), content, 700_000);
    expect(r.state.tier).toBe(1);
    expect(r.summary.tiersUnlocked).toEqual([1]);
    const milestone = r.events.find((e) => e.kind === "milestone");
    expect(milestone).toBeDefined();
    expect(milestone!.atMs).toBeGreaterThan(START + 599_000);
    expect(milestone!.atMs).toBeLessThan(START + 601_000);
    // The 200 plate was spent on delivery, then 100s at the tier-1 rate. The iron
    // lane multiplier is now x1.5, so the constructor makes 1.5 * (1/3) = 0.5/s.
    expect(liquid(r.state, "iron_plate").toNumber()).toBeCloseTo(50, 4);
  });

  it("never spends bound stock on a milestone (spec D4)", () => {
    const start = base();
    const rich: WorldState = { ...start, bound: { ...start.bound, iron_plate: D("1e9") } };
    const r = resolve(rich, content, 1_000);
    // A second of production is nowhere near 200 plate, and the 1e9 bound cannot
    // help, so the tier must not move.
    expect(r.state.tier).toBe(0);
    expect(r.state.bound.iron_plate!.toString()).toBe(D("1e9").toString());
  });

  it("fires a tap expiry timer and drops the stacks", () => {
    const start = base();
    const tapped: WorldState = {
      ...start,
      tapStacks: 5,
      timers: [{ id: "tap", kind: "tapExpiry", fireAt: START + 30_000 }],
    };
    const r = resolve(tapped, content, 60_000);
    expect(r.state.tapStacks).toBe(0);
    expect(r.state.timers).toEqual([]);
    expect(r.events.some((e) => e.kind === "timer" && e.timerId === "tap")).toBe(true);
  });

  it("keeps a timer that has not come due", () => {
    const start = base();
    const tapped: WorldState = {
      ...start,
      tapStacks: 5,
      timers: [{ id: "tap", kind: "tapExpiry", fireAt: START + 90_000 }],
    };
    const r = resolve(tapped, content, 60_000);
    expect(r.state.tapStacks).toBe(5);
    expect(r.state.timers).toHaveLength(1);
  });
});

describe("resolve — the offline cap", () => {
  it("simulates at most the cap but advances the clock by the whole window", () => {
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const r = resolve(base(), content, twentyFourHours);
    expect(r.summary.simulatedMs).toBe(content.offlineCapMs);
    expect(r.summary.skippedMs).toBe(twentyFourHours - content.offlineCapMs);
    expect(r.state.lastResolvedAt).toBe(START + twentyFourHours);
  });

  it("discards timers that expired during the unsimulated gap", () => {
    const start = base();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const tapped: WorldState = {
      ...start,
      tapStacks: 5,
      timers: [{ id: "tap", kind: "tapExpiry", fireAt: START + 30_000 }],
    };
    const r = resolve(tapped, content, twentyFourHours);
    expect(r.state.timers).toEqual([]);
    expect(r.state.tapStacks).toBe(0);
  });
});

describe("resolve — split invariance (spec E.6)", () => {
  const halves = [60_000, 300_000, 350_000, 1_800_000];

  it.each(halves)("resolve(s, 2*%i) matches resolve(resolve(s, t), t)", (t) => {
    const whole = resolve(base(), content, 2 * t);
    const first = resolve(base(), content, t);
    const split = resolve(first.state, content, t);

    // Discrete state must match exactly (spec E.4).
    expect(split.state.tier).toBe(whole.state.tier);
    expect(split.state.installed).toEqual(whole.state.installed);
    expect(split.state.storageLevel).toEqual(whole.state.storageLevel);
    expect(split.state.qsLevel).toEqual(whole.state.qsLevel);
    expect(split.state.timers).toEqual(whole.state.timers);
    expect(split.state.tapStacks).toBe(whole.state.tapStacks);
    expect(split.state.lastResolvedAt).toBe(whole.state.lastResolvedAt);

    // Magnitudes match within spec E.4's relative tolerance.
    for (const itemId of content.stockItemIds) {
      for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
        const a = whole.state[field][itemId]!.toNumber();
        const b = split.state[field][itemId]!.toNumber();
        const scale = Math.max(1, Math.abs(a));
        expect(Math.abs(a - b) / scale).toBeLessThan(1e-9);
      }
    }
  });

  it("agrees when the split lands exactly on the milestone instant", () => {
    // The tier-1 milestone completes at exactly 600 seconds.
    const whole = resolve(base(), content, 600_000);
    const split = resolve(resolve(base(), content, 300_000).state, content, 300_000);
    expect(split.state.tier).toBe(whole.state.tier);
    expect(liquid(split.state, "iron_plate").toNumber()).toBeCloseTo(
      liquid(whole.state, "iron_plate").toNumber(),
      6,
    );
  });
});

describe("resolve — invariants", () => {
  it("never produces a negative stockpile or a NaN over a long window", () => {
    const r = resolve(base(), content, 8 * 60 * 60 * 1000);
    for (const itemId of content.stockItemIds) {
      for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
        const value = r.state[field][itemId]!;
        expect(Number.isNaN(value.toNumber())).toBe(false);
        expect(value.gte(0)).toBe(true);
      }
    }
  });

  it("never leaves an item above its combined cap", () => {
    const r = resolve(base(), content, 8 * 60 * 60 * 1000);
    for (const itemId of content.stockItemIds) {
      expect(liquid(r.state, itemId).lte(liquidCap(content, r.state, itemId).plus(1e-6))).toBe(true);
    }
  });

  it("does not trip the guards on a legitimate factory", () => {
    const r = resolve(base(), content, 8 * 60 * 60 * 1000);
    expect(r.summary.guardTripped).toBe(false);
    expect(r.summary.events).toBeLessThan(MAX_EVENTS);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test resolve`
Expected: FAIL — `Cannot find module './index.js'` under `resolve/`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/resolve/index.ts`:

```ts
// Spec C.7. The only time function in the engine.
//
// The property that matters most (spec E.6) is
//     resolve(s, 2t) === resolve(resolve(s, t), t)
// because offline and online resolution cannot disagree if it holds. Four rules
// make it true:
//
//  1. Applying an event never stores a mode flag. A fill is only "the stockpile is
//     now at cap"; the next solve re-derives FULL from the state. A stored flag
//     would cross a split in one path and be re-derived in the other.
//  2. settle() is idempotent and runs at the head of EVERY iteration, including the
//     first and the one that breaks the loop. A milestone completing exactly at the
//     split instant is therefore applied once, in either arrangement.
//  3. Timers carry absolute fire times on the same clock as lastResolvedAt, and the
//     loop tracks an explicit cursor from state.lastResolvedAt.
//  4. lastResolvedAt advances by the full elapsedMs. The offline cap limits
//     simulation, not the clock.
//
// The property genuinely fails when 2t exceeds offlineCapMs, because the cap is per
// call; the property test stays well under it.
import { D, DECIMAL_ZERO, toCanonical, type Dec } from "../numbers/decimal.js";
import type { ItemId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import {
  canAffordLiquid,
  depositProduction,
  drainLiquid,
  itemStateTag,
  liquid,
  liquidCap,
  settleBound,
  spendFromLiquid,
} from "../economy/storage.js";
import type { WorldState } from "../state/world.js";
import { solve, type Solution } from "../solve/solve.js";

/** Spec C.7 and D.5: bounds the cost of one resolve, so it cannot be a DoS vector. */
export const MAX_EVENTS = 10_000;
/** Spec C.7: stops Zeno subdivision. One nanosecond. */
export const EPSILON_MS = 1e-6;
/** The fixed step the loop falls back to once MAX_EVENTS is spent. */
export const COARSE_STEP_MS = 60_000;

export type ResolveEventKind = "fill" | "drain" | "timer" | "milestone" | "guard";

export interface ResolveEvent {
  kind: ResolveEventKind;
  atMs: number;
  itemId?: ItemId;
  tier?: number;
  timerId?: string;
}

export interface ResolveSummary {
  elapsedMs: number;
  simulatedMs: number;
  skippedMs: number;
  /** Lifetime totals after the window, as canonical strings. */
  produced: Record<ItemId, string>;
  filled: { itemId: ItemId; atMs: number }[];
  /** Items sitting empty with nothing arriving. Spec C.7's "what stalled". */
  stalled: ItemId[];
  tiersUnlocked: number[];
  events: number;
  guardTripped: boolean;
}

export interface ResolveResult {
  state: WorldState;
  events: ResolveEvent[];
  summary: ResolveSummary;
}

/** The next tier's delivery requirement, or null when there is no next tier. */
export function nextMilestoneCost(
  content: IndexedContent,
  state: WorldState,
): Map<ItemId, Dec> | null {
  const milestone = content.milestoneByTier.get(state.tier + 1);
  if (!milestone) return null;
  const costs = new Map<ItemId, Dec>();
  for (const requirement of milestone.requires) {
    costs.set(requirement.item, (costs.get(requirement.item) ?? DECIMAL_ZERO).plus(D(requirement.amount)));
  }
  return costs;
}

function clampNonNegative(state: WorldState, content: IndexedContent): WorldState {
  let next = state;
  for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
    let changed = false;
    const bucket: Record<ItemId, Dec> = { ...next[field] };
    for (const itemId of content.stockItemIds) {
      const value = bucket[itemId] ?? DECIMAL_ZERO;
      if (value.lt(0)) {
        bucket[itemId] = DECIMAL_ZERO;
        changed = true;
      } else if (bucket[itemId] === undefined) {
        bucket[itemId] = DECIMAL_ZERO;
        changed = true;
      }
    }
    if (changed) next = { ...next, [field]: bucket };
  }
  return next;
}

/**
 * Idempotent state normalization: bound flows down as room opens (spec D4), values
 * are clamped, and every milestone whose requirement is met is delivered out of
 * liquid stock (ruling R7). Called at the head of every loop iteration, which is
 * what makes a split at a milestone instant safe.
 */
export function settle(
  content: IndexedContent,
  state: WorldState,
  nowMs: number,
  events: ResolveEvent[],
): WorldState {
  let next = clampNonNegative(settleBound(content, state), content);

  for (;;) {
    const costs = nextMilestoneCost(content, next);
    if (costs === null) break;
    if (!canAffordLiquid(next, costs)) break;
    const spent = spendFromLiquid(content, next, costs);
    if (spent === null) break;
    next = { ...spent, tier: next.tier + 1 };
    events.push({ kind: "milestone", atMs: nowMs, tier: next.tier });
  }
  return next;
}

function fireDueTimers(
  state: WorldState,
  cursorMs: number,
  events: ResolveEvent[],
): WorldState {
  const due = state.timers.filter((timer) => timer.fireAt <= cursorMs);
  if (due.length === 0) return state;

  // Spec A.5's canonical event ordering: by time, ties broken by a stable id.
  due.sort((a, b) => (a.fireAt === b.fireAt ? (a.id < b.id ? -1 : 1) : a.fireAt - b.fireAt));

  let next = state;
  for (const timer of due) {
    if (timer.kind === "tapExpiry") next = { ...next, tapStacks: 0 };
    events.push({ kind: "timer", atMs: timer.fireAt, timerId: timer.id });
  }
  return { ...next, timers: next.timers.filter((timer) => timer.fireAt > cursorMs) };
}

interface NextEvent {
  dtMs: number;
  kind: ResolveEventKind | null;
  itemId?: ItemId;
}

function nextDiscontinuity(
  content: IndexedContent,
  state: WorldState,
  solution: Solution,
  cursorMs: number,
): NextEvent {
  let best: NextEvent = { dtMs: Number.POSITIVE_INFINITY, kind: null };
  const consider = (dtMs: number, kind: ResolveEventKind, itemId?: ItemId): void => {
    if (dtMs > 0 && dtMs < best.dtMs) best = { dtMs, kind, itemId };
  };

  for (const itemId of content.stockItemIds) {
    const net = solution.itemRates.get(itemId)?.net ?? 0;
    if (!Number.isFinite(net) || net === 0) continue;
    const have = liquid(state, itemId);
    if (net > 0) {
      const room = liquidCap(content, state, itemId).minus(have);
      if (room.gt(0)) consider(room.div(net).toNumber() * 1000, "fill", itemId);
    } else if (have.gt(0)) {
      consider(have.div(-net).toNumber() * 1000, "drain", itemId);
    }
  }

  for (const timer of state.timers) consider(timer.fireAt - cursorMs, "timer");

  // Ruling R7: the milestone completes when every required item has been banked, so
  // its time is the max over requirements, and it never arrives if any is falling.
  const costs = nextMilestoneCost(content, state);
  if (costs !== null) {
    let worst = 0;
    let reachable = true;
    for (const [itemId, needed] of costs) {
      const have = liquid(state, itemId);
      if (have.gte(needed)) continue;
      const net = solution.itemRates.get(itemId)?.net ?? 0;
      if (net <= 0) {
        reachable = false;
        break;
      }
      worst = Math.max(worst, needed.minus(have).div(net).toNumber() * 1000);
    }
    if (reachable && worst > 0) consider(worst, "milestone");
  }

  return best;
}

function integrate(
  content: IndexedContent,
  state: WorldState,
  solution: Solution,
  dtMs: number,
): WorldState {
  const seconds = dtMs / 1000;
  let next = state;
  const lifetime: Record<ItemId, Dec> = { ...next.lifetime };

  for (const itemId of content.stockItemIds) {
    const flow = solution.itemRates.get(itemId);
    if (!flow) continue;

    if (flow.production > 0) {
      lifetime[itemId] = (lifetime[itemId] ?? DECIMAL_ZERO).plus(D(flow.production * seconds));
    }
    if (flow.net > 0) {
      // Overflow should be zero: the solver already throttled producers of a FULL
      // item. Anything left is backpressure and is deliberately not banked.
      next = depositProduction(content, next, itemId, D(flow.net * seconds)).state;
    } else if (flow.net < 0) {
      next = drainLiquid(next, itemId, D(-flow.net * seconds)).state;
    }
  }
  return { ...next, lifetime };
}

export function resolve(
  state: WorldState,
  content: IndexedContent,
  elapsedMs: number,
): ResolveResult {
  const events: ResolveEvent[] = [];
  const elapsed = Math.max(0, elapsedMs);
  const simulated = Math.min(elapsed, content.offlineCapMs);
  const skipped = elapsed - simulated;

  // Time past the cap is not simulated, but it did pass: start the cursor after it
  // and retire anything that expired in the gap.
  let cursor = state.lastResolvedAt + skipped;
  let current = fireDueTimers(state, cursor, events);

  const startingTier = current.tier;
  const startingLifetime: Record<ItemId, Dec> = { ...current.lifetime };
  const filled: { itemId: ItemId; atMs: number }[] = [];

  let remaining = simulated;
  let steps = 0;
  let guardTripped = false;
  const hardStop = MAX_EVENTS + Math.ceil(content.offlineCapMs / COARSE_STEP_MS) + 2;

  for (;;) {
    current = settle(content, current, cursor, events);
    if (remaining <= 0 || steps >= hardStop) break;

    const coarse = steps >= MAX_EVENTS;
    if (coarse && !guardTripped) {
      guardTripped = true;
      events.push({ kind: "guard", atMs: cursor });
    }
    steps += 1;

    const solution = solve(current, content);
    let dtMs: number;
    let fired: NextEvent | null = null;
    if (coarse) {
      dtMs = Math.min(remaining, COARSE_STEP_MS);
    } else {
      fired = nextDiscontinuity(content, current, solution, cursor);
      dtMs = Math.min(remaining, fired.dtMs);
      if (!(dtMs > EPSILON_MS)) dtMs = EPSILON_MS;
      dtMs = Math.min(dtMs, remaining);
    }

    current = integrate(content, current, solution, dtMs);
    cursor += dtMs;
    remaining -= dtMs;

    if (fired !== null && fired.kind !== null && fired.dtMs <= dtMs + EPSILON_MS) {
      if (fired.kind === "fill" && fired.itemId !== undefined) {
        events.push({ kind: "fill", atMs: cursor, itemId: fired.itemId });
        filled.push({ itemId: fired.itemId, atMs: cursor });
      } else if (fired.kind === "drain" && fired.itemId !== undefined) {
        events.push({ kind: "drain", atMs: cursor, itemId: fired.itemId });
      }
    }

    current = fireDueTimers(current, cursor, events);
  }

  // What was produced during THIS window, which is what the "while you were away"
  // report means -- not the lifetime total.
  const produced: Record<ItemId, string> = {};
  for (const itemId of content.stockItemIds) {
    const before = startingLifetime[itemId] ?? DECIMAL_ZERO;
    const after = current.lifetime[itemId] ?? DECIMAL_ZERO;
    produced[itemId] = toCanonical(after.minus(before));
  }

  const finalSolution = solve(current, content);
  const stalled: ItemId[] = [];
  for (const itemId of content.stockItemIds) {
    if (itemStateTag(content, current, itemId) !== "EMPTY") continue;
    if ((content.consumersOf.get(itemId) ?? []).length === 0) continue;
    if ((finalSolution.itemRates.get(itemId)?.production ?? 0) > 0) continue;
    stalled.push(itemId);
  }

  const tiersUnlocked: number[] = [];
  for (let tier = startingTier + 1; tier <= current.tier; tier += 1) tiersUnlocked.push(tier);

  return {
    state: { ...current, lastResolvedAt: state.lastResolvedAt + elapsed },
    events,
    summary: {
      elapsedMs: elapsed,
      simulatedMs: simulated,
      skippedMs: skipped,
      produced,
      filled,
      stalled,
      tiersUnlocked,
      events: events.length,
      guardTripped,
    },
  };
}
```

- [ ] **Step 4: Register the barrel**

Add one line to `packages/engine/src/index.ts`, after the `solve` line:

```ts
export * from "./resolve/index.js";
```

- [ ] **Step 5: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

If the split-invariance test fails on `tier`, the milestone is being delivered somewhere other than `settle` — check that nothing in `integrate` or the event handling advances the tier.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add event-driven resolve

Spec C.7's loop: solve, find the next discontinuity, integrate a straight
line to it, repeat. Built so spec E.6's resolve(s, 2t) = resolve(resolve(s,
t), t) holds -- applying an event stores no mode flag, settle() is
idempotent and runs at the head of every iteration including the last,
timers carry absolute fire times, and lastResolvedAt advances by the full
window while the offline cap limits only simulation. Ruling R7's milestone
delivery lives in settle and spends liquid stock only, so storage caps
still gate tiers exactly as spec D4 requires. MAX_EVENTS and EPSILON guard
against an oscillating factory denying service.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

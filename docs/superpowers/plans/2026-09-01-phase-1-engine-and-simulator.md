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

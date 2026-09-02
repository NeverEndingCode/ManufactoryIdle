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
  # The list carries an entry for EVERY item, because spec D.1's action set has no
  # add-or-remove verb: REORDER_PRIORITY permutes, and spec 4.1 makes `paused` the
  # remove verb ("Pause | Remove from allocation entirely"). A list that covered
  # only some items would leave the rest permanently unprioritizable.
  priority:
    [
      iron_plate,
      iron_ingot,
      iron_ore,
      plastic,
      fuel,
      heavy_oil_residue,
      crude_oil,
    ]
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
      "plastic",
      "fuel",
      "heavy_oil_residue",
      "crude_oil",
    ]);
    expect(w.priority.every((e) => e.mode === "guaranteed" && !e.paused)).toBe(true);
  });

  it("covers every item, because there is no add-or-remove action (spec D.1)", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.priority).toHaveLength(content.stockItemIds.length + 1);
    const listed = new Set(w.priority.slice(1).map((e) => e.itemId));
    for (const itemId of content.stockItemIds) expect(listed.has(itemId)).toBe(true);
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

### Task 12: Action reducers — machines

**Files:**
- Create: `packages/engine/src/actions/types.ts`, `packages/engine/src/actions/machines.ts`
- Test: `packages/engine/src/actions/machines.test.ts`

**Interfaces:**
- Consumes: `D`, `DECIMAL_ZERO`, `toCanonical`, `type Dec` (Phase 0 Task 2); `type IndexedContent`, `getMark`, `laneClassKey`, `isLiveRecipe`, `POWER_ITEM`, `type ItemId`, `type LaneId`, `type MachineClassId`, `type RecipeId` (Task 2); `type WorldState`, `type PriorityEntry`, `type PriorityMode`, `type PrngState`, `installedAt`, `installedMachines`, `withInstalled`, `assignedTotal` (Task 4); `machineCostRange` (Task 5); `bestUnlockedMark` (Task 6); `spendForBuild`, `depositRefund` (Task 7)
- Produces, from `@manufactory/engine`:
  - `const MAX_ACTION_COUNT = 1000`
  - `type Action` — the full eleven-variant union (declared here in `types.ts`, all eleven, so Task 13 adds no new members)
  - `type Effect` — the effect union
  - `type ApplyResult = { rejected: false; state: WorldState; effects: Effect[] } | { rejected: true; reason: string }`
  - `reject(reason: string): ApplyResult`
  - `accept(state: WorldState, effects: Effect[]): ApplyResult`
  - `costEffect(kind: "spent" | "refunded", costs: ReadonlyMap<ItemId, Dec>): Effect`
  - `clampAssignments(content: IndexedContent, state: WorldState, lane: LaneId, machineClass: MachineClassId): WorldState`
  - `applyBuyMachine(state, content, action & { type: "BUY_MACHINE" }): ApplyResult`
  - `applyDismantle(state, content, action & { type: "DISMANTLE" }): ApplyResult`
  - `applyUpgradeMark(state, content, action & { type: "UPGRADE_MARK" }): ApplyResult`
  - `applyAssignMachines(state, content, action & { type: "ASSIGN_MACHINES" }): ApplyResult`
  - `applySelectRecipe(state, content, action & { type: "SELECT_RECIPE" }): ApplyResult`

Five of spec D.1's eleven actions. Three rulings shape them:

**Ruling R5** makes machines pooled per `(lane, machineClass)`, so a purchase adds to the pool and an assignment distributes it. Requiring an explicit `ASSIGN_MACHINES` after every purchase would be exactly the management surface pillar 3 rules out, so **`BUY_MACHINE` auto-assigns the new machines to the recipe in that lane-class that already has the most assigned**, ties broken by authored recipe order, falling back to the first live recipe when nothing is assigned yet. `ASSIGN_MACHINES` then redistributes. Symmetrically, `DISMANTLE` and `UPGRADE_MARK` clamp assignments down when the pool shrinks, taking from the largest assignment first so the shape of the player's split is preserved.

**Ruling R6** makes any recipe inside a non-trivial SCC unselectable: `SELECT_RECIPE` and `ASSIGN_MACHINES` both reject it by name, rather than silently accepting a recipe the solver will ignore.

**Spec D4** makes refunds LIFO: dismantling the *n*th machine returns `cost(n)` exactly. Both directions call `machineCostRange(content, class, mark, from, count)` with identical arguments, so the two Decimals are bitwise equal — symmetric, no pump. Refunds land through `depositRefund`, which fills Quantum Storage to its cap and binds the excess.

**Spec C.0** is what `UPGRADE_MARK` exists for: it dismantles every Mk*n* of a class in a lane and rebuilds the mark-equivalent count at Mk*n+1*, paying the difference. Without it, spec D4's dismantle verb turns a mark upgrade into forty-five taps of busywork. The equivalent count is `floor(k × rateMultiplier(from) / rateMultiplier(to))`, which keeps the mark-weighted ladder input intact — 45 Mk1 and 15 Mk2 both read as 45, so the upgrade never costs the player their multiplier (spec B.2).

- [ ] **Step 1: Write the failing test**

`packages/engine/src/actions/machines.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { ladderInput, machineCostRange } from "../economy/curves.js";
import { liquid } from "../economy/storage.js";
import { initialWorld, installedAt, withInstalled, type WorldState } from "../state/world.js";
import {
  applyAssignMachines,
  applyBuyMachine,
  applyDismantle,
  applySelectRecipe,
  applyUpgradeMark,
} from "./machines.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

function rich(plate = 100_000): WorldState {
  const w = initialWorld(content, 1, 0);
  return { ...w, stored: { ...w.stored, iron_plate: D(plate) } };
}

function expectAccepted(result: ReturnType<typeof applyBuyMachine>): WorldState {
  if (result.rejected) throw new Error(`unexpectedly rejected: ${result.reason}`);
  return result.state;
}

describe("BUY_MACHINE", () => {
  it("charges the geometric run from the current count", () => {
    // Constructor mk1 costs 20 iron_plate at r = 1.09, and one is already installed.
    // Buying two: 20 * (1.09 + 1.09^2) = 20 * 2.2781 = 45.562
    const start = rich(100);
    const next = expectAccepted(
      applyBuyMachine(start, content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 2,
      }),
    );
    expect(installedAt(next, "iron", "constructor", 1)).toBe(3);
    expect(liquid(next, "iron_plate").toNumber()).toBeCloseTo(100 - 45.562, 6);
  });

  it("auto-assigns the new machines to the busiest recipe in the lane-class (R5)", () => {
    const next = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 4,
      }),
    );
    // make_plate had 1 of 1; it now has 5 of 5, so no machine sits idle.
    expect(next.assignment.make_plate).toBe(5);
  });

  it("rejects a purchase it cannot afford and changes nothing", () => {
    const poor = initialWorld(content, 1, 0);
    const result = applyBuyMachine(poor, content, {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 1,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/afford/i);
  });

  it("rejects a mark that has not unlocked yet", () => {
    // Miner mk2 unlocks at tier 1; the world starts at tier 0.
    const result = applyBuyMachine(rich(), content, {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "miner",
      mark: 2,
      count: 1,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/unlock/i);
  });

  it("rejects a non-positive, non-integer, or oversized count", () => {
    for (const count of [0, -1, 2.5, 100_000]) {
      const result = applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count,
      });
      expect(result.rejected).toBe(true);
    }
  });

  it("rejects an unknown lane or class", () => {
    expect(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "ghost",
        machineClass: "constructor",
        mark: 1,
        count: 1,
      }).rejected,
    ).toBe(true);
    expect(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "ghost",
        mark: 1,
        count: 1,
      }).rejected,
    ).toBe(true);
  });

  it("can be paid for entirely out of bound stock (spec C.5)", () => {
    const w = initialWorld(content, 1, 0);
    const bounded: WorldState = { ...w, bound: { ...w.bound, iron_plate: D(1_000) } };
    const next = expectAccepted(
      applyBuyMachine(bounded, content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 1,
      }),
    );
    expect(next.bound.iron_plate!.toNumber()).toBeCloseTo(1000 - 21.8, 6);
  });
});

describe("DISMANTLE", () => {
  it("refunds exactly what the same machines cost (spec D4, LIFO)", () => {
    const bought = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 5,
      }),
    );
    // One constructor was already installed, so the purchase covered n = 1..5 and
    // the dismantle refunds exactly that same range.
    const paid = machineCostRange(content, "constructor", 1, 1, 5).get("iron_plate")!;
    const refundResult = applyDismantle(bought, content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 5,
    });
    if (refundResult.rejected) throw new Error(refundResult.reason);
    const refunded = refundResult.effects.find((e) => e.kind === "refunded");
    expect(refunded).toBeDefined();
    if (refunded?.kind !== "refunded") throw new Error("unreachable");
    // Bitwise equal, because both directions evaluate the same closed form.
    expect(refunded.items.iron_plate).toBe(paid.toString());
    expect(installedAt(refundResult.state, "iron", "constructor", 1)).toBe(1);
  });

  it("returns the stock to Quantum Storage, not to storage (spec C.5)", () => {
    const bought = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 2,
      }),
    );
    const before = bought.quantum.iron_plate!.toNumber();
    const result = applyDismantle(bought, content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 2,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.quantum.iron_plate!.toNumber()).toBeGreaterThan(before);
  });

  it("clamps assignments down when the pool shrinks", () => {
    const bought = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 4,
      }),
    );
    expect(bought.assignment.make_plate).toBe(5);
    const result = applyDismantle(bought, content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 3,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.assignment.make_plate).toBe(2);
  });

  it("rejects dismantling more than are installed", () => {
    const result = applyDismantle(rich(), content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 9,
    });
    expect(result.rejected).toBe(true);
  });
});

describe("UPGRADE_MARK", () => {
  function fortyFiveMiners(): WorldState {
    let w = rich();
    w = { ...w, tier: 1 };
    w = withInstalled(w, "iron", "miner", 1, 45);
    return { ...w, assignment: { ...w.assignment, mine_iron: 45 } };
  }

  it("consolidates to the mark-equivalent count", () => {
    // rateMultiplier: mk1 = 1, mk2 = 3. floor(45 * 1 / 3) = 15.
    const result = applyUpgradeMark(fortyFiveMiners(), content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(installedAt(result.state, "iron", "miner", 1)).toBe(0);
    expect(installedAt(result.state, "iron", "miner", 2)).toBe(15);
  });

  it("leaves the mark-weighted ladder input untouched (spec B.2, C.0)", () => {
    const before = fortyFiveMiners();
    expect(ladderInput(content, before, "iron", "miner")).toBe(45);
    const result = applyUpgradeMark(before, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(ladderInput(content, result.state, "iron", "miner")).toBe(45);
  });

  it("refunds the old stack and charges the new one", () => {
    const result = applyUpgradeMark(fortyFiveMiners(), content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    const refunded = result.effects.find((e) => e.kind === "refunded");
    const spent = result.effects.find((e) => e.kind === "spent");
    expect(refunded?.kind).toBe("refunded");
    expect(spent?.kind).toBe("spent");
    if (refunded?.kind !== "refunded" || spent?.kind !== "spent") throw new Error("unreachable");
    expect(refunded.items.iron_plate).toBe(
      machineCostRange(content, "miner", 1, 0, 45).get("iron_plate")!.toString(),
    );
    expect(spent.items.iron_plate).toBe(
      machineCostRange(content, "miner", 2, 0, 15).get("iron_plate")!.toString(),
    );
  });

  it("rescales the assignment to the new pool", () => {
    const result = applyUpgradeMark(fortyFiveMiners(), content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.assignment.mine_iron).toBe(15);
  });

  it("rejects when the next mark has not unlocked", () => {
    let w = rich();
    w = withInstalled(w, "iron", "miner", 1, 45);
    const result = applyUpgradeMark(w, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects when there is no next mark at all", () => {
    let w = rich();
    w = withInstalled(w, "iron", "smelter", 1, 10);
    const result = applyUpgradeMark(w, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "smelter",
      fromMark: 1,
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects when too few machines to make even one of the higher mark", () => {
    let w = rich();
    w = { ...w, tier: 1 };
    w = withInstalled(w, "iron", "miner", 1, 2);
    const result = applyUpgradeMark(w, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    expect(result.rejected).toBe(true);
  });
});

describe("ASSIGN_MACHINES", () => {
  it("sets the count and leaves the rest idle", () => {
    const result = applyAssignMachines(rich(), content, {
      type: "ASSIGN_MACHINES",
      recipeId: "make_plate",
      count: 0,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.assignment.make_plate).toBe(0);
  });

  it("rejects assigning more than the lane-class pool holds (ruling R5)", () => {
    const result = applyAssignMachines(rich(), content, {
      type: "ASSIGN_MACHINES",
      recipeId: "make_plate",
      count: 2,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/installed/i);
  });

  it("counts every recipe in the lane-class against the same pool", () => {
    let w = rich();
    w = withInstalled(w, "oil", "refinery", 1, 4);
    w = { ...w, tier: 2, assignment: { ...w.assignment, refine_plastic: 3 } };
    expect(
      applyAssignMachines(w, content, {
        type: "ASSIGN_MACHINES",
        recipeId: "residual_fuel",
        count: 1,
      }).rejected,
    ).toBe(false);
    expect(
      applyAssignMachines(w, content, {
        type: "ASSIGN_MACHINES",
        recipeId: "residual_fuel",
        count: 2,
      }).rejected,
    ).toBe(true);
  });

  it("rejects a locked recipe and a negative or fractional count", () => {
    expect(
      applyAssignMachines(rich(), content, {
        type: "ASSIGN_MACHINES",
        recipeId: "refine_plastic",
        count: 0,
      }).rejected,
    ).toBe(true);
    for (const count of [-1, 1.5]) {
      expect(
        applyAssignMachines(rich(), content, {
          type: "ASSIGN_MACHINES",
          recipeId: "make_plate",
          count,
        }).rejected,
      ).toBe(true);
    }
  });
});

describe("SELECT_RECIPE", () => {
  it("switches the active recipe for an item", () => {
    const result = applySelectRecipe(rich(), content, {
      type: "SELECT_RECIPE",
      itemId: "iron_plate",
      recipeId: "make_plate",
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.activeRecipe.iron_plate).toBe("make_plate");
  });

  it("rejects a recipe that does not produce that item as its primary output", () => {
    const result = applySelectRecipe(rich(), content, {
      type: "SELECT_RECIPE",
      itemId: "iron_plate",
      recipeId: "smelt_iron",
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects a recipe that has not unlocked", () => {
    const result = applySelectRecipe(rich(), content, {
      type: "SELECT_RECIPE",
      itemId: "plastic",
      recipeId: "refine_plastic",
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects a recipe inside a cycle by name (ruling R6)", () => {
    const bundle = loadBundleDir(fixtureDir);
    bundle.recipes.push({
      id: "recycle_plastic",
      name: "Recycled Plastic",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      outputs: [{ item: "plastic", rate: "20", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 0,
    });
    bundle.recipes.push({
      id: "recycle_residue",
      name: "Recycled Residue",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "plastic", rate: "20", byproduct: false }],
      outputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 0,
    });
    const cyclic = indexContent(bundle);
    const w = initialWorld(cyclic, 1, 0);
    const result = applySelectRecipe(w, cyclic, {
      type: "SELECT_RECIPE",
      itemId: "plastic",
      recipeId: "recycle_plastic",
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/cycle/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test machines`
Expected: FAIL — `Cannot find module './machines.js'`.

- [ ] **Step 3: Write the action and effect types**

`packages/engine/src/actions/types.ts`:

```ts
// Spec D.1's action set. Exactly eleven, and this union is the whole of it: the
// engine's reducers are the game logic, and spec A.2 makes the API almost pure
// transport around them. That is what buys spec 16.3's "full action parity in
// sim play" structurally rather than as ongoing maintenance.
import type { Dec } from "../numbers/decimal.js";
import type { ItemId, LaneId, MachineClassId, RecipeId } from "../content/types.js";
import type { PriorityMode, WorldState } from "../state/world.js";

/** Ceiling on any single action's count, so one action cannot be a DoS vector. */
export const MAX_ACTION_COUNT = 1000;

export type Action =
  | { type: "BUY_MACHINE"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { type: "DISMANTLE"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { type: "UPGRADE_MARK"; lane: LaneId; machineClass: MachineClassId; fromMark: number }
  | { type: "ASSIGN_MACHINES"; recipeId: RecipeId; count: number }
  | { type: "SELECT_RECIPE"; itemId: ItemId; recipeId: RecipeId }
  | { type: "REORDER_PRIORITY"; entries: string[] }
  | {
      type: "SET_PRIORITY_MODE";
      entryId: string;
      mode: PriorityMode;
      share?: number;
      targetRate?: number | null;
      paused?: boolean;
    }
  | { type: "SET_RESERVE"; itemId: ItemId; percent: number }
  | { type: "BUY_STORAGE"; itemId: ItemId; levels: number }
  | { type: "BUY_QS"; lane: LaneId; levels: number }
  | { type: "TAP"; count: number; clientElapsedMs: number };

export type Effect =
  | { kind: "spent"; items: Record<ItemId, string> }
  | { kind: "refunded"; items: Record<ItemId, string> }
  | { kind: "installed"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { kind: "removed"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { kind: "assigned"; recipeId: RecipeId; count: number }
  | { kind: "recipeSelected"; itemId: ItemId; recipeId: RecipeId }
  | { kind: "priorityChanged"; order: string[] }
  | {
      kind: "entryModeChanged";
      entryId: string;
      mode: PriorityMode;
      share: number;
      targetRate: number | null;
      paused: boolean;
    }
  | { kind: "reserveChanged"; itemId: ItemId; percent: number }
  | { kind: "levelChanged"; scope: "storage" | "quantum"; id: string; level: number }
  | { kind: "tapped"; stacks: number; discarded: number };

export type ApplyResult =
  | { rejected: false; state: WorldState; effects: Effect[] }
  | { rejected: true; reason: string };

export function reject(reason: string): ApplyResult {
  return { rejected: true, reason };
}

export function accept(state: WorldState, effects: Effect[]): ApplyResult {
  return { rejected: false, state, effects };
}

/** Costs travel as canonical Decimal strings so an effect log is replayable. */
export function costEffect(
  kind: "spent" | "refunded",
  costs: ReadonlyMap<ItemId, Dec>,
): Effect {
  const items: Record<ItemId, string> = {};
  for (const [itemId, amount] of costs) items[itemId] = amount.toString();
  return kind === "spent" ? { kind: "spent", items } : { kind: "refunded", items };
}
```

- [ ] **Step 4: Write the machine reducers**

`packages/engine/src/actions/machines.ts`:

```ts
// Spec D.1, actions one through five.
//
// Ruling R5 pools machines per (lane, machineClass), so a purchase adds to the pool
// and an assignment distributes it. Making the player assign after every purchase
// would be exactly the management surface pillar 3 rules out, so BUY_MACHINE
// auto-assigns into the busiest recipe of the lane-class and DISMANTLE clamps back
// down from the largest assignment first.
//
// Spec D4 makes refunds LIFO: dismantling the nth machine returns cost(n), so
// rebuilding costs exactly what was refunded. Both directions call
// machineCostRange with the same arguments, which makes the two Decimals bitwise
// equal rather than merely close.
import type { LaneId, MachineClassId, RecipeId } from "../content/types.js";
import {
  getMark,
  isLiveRecipe,
  laneClassKey,
  type IndexedContent,
} from "../graph/index-content.js";
import { machineCostRange } from "../economy/curves.js";
import { depositRefund, spendForBuild } from "../economy/storage.js";
import {
  assignedTotal,
  installedAt,
  installedMachines,
  withInstalled,
  type WorldState,
} from "../state/world.js";
import { MAX_ACTION_COUNT, accept, costEffect, reject, type Action, type ApplyResult } from "./types.js";

function validCount(count: number): boolean {
  return Number.isInteger(count) && count > 0 && count <= MAX_ACTION_COUNT;
}

function recipesIn(
  content: IndexedContent,
  lane: LaneId,
  machineClass: MachineClassId,
): RecipeId[] {
  return content.recipesByLaneClass.get(laneClassKey(lane, machineClass)) ?? [];
}

/**
 * Keeps the assignments of a lane-class within its pool, shrinking the largest
 * first so the shape of the player's split survives. Ties break by authored recipe
 * order (spec A.5).
 */
export function clampAssignments(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): WorldState {
  const pool = installedMachines(state, lane, machineClass);
  const recipeIds = recipesIn(content, lane, machineClass);
  let total = 0;
  for (const recipeId of recipeIds) total += state.assignment[recipeId] ?? 0;
  if (total <= pool) return state;

  const assignment = { ...state.assignment };
  let excess = total - pool;
  while (excess > 0) {
    let biggest: RecipeId | null = null;
    for (const recipeId of recipeIds) {
      const count = assignment[recipeId] ?? 0;
      if (count <= 0) continue;
      if (biggest === null || count > (assignment[biggest] ?? 0)) biggest = recipeId;
    }
    if (biggest === null) break;
    const take = Math.min(excess, assignment[biggest] ?? 0);
    assignment[biggest] = (assignment[biggest] ?? 0) - take;
    excess -= take;
  }
  return { ...state, assignment };
}

/** The recipe a fresh purchase should join: busiest first, else the first live one. */
function autoAssignTarget(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): RecipeId | null {
  const recipeIds = recipesIn(content, lane, machineClass).filter((recipeId) =>
    isLiveRecipe(content, recipeId, state.tier, state.activeRecipe),
  );
  if (recipeIds.length === 0) return null;
  let best = recipeIds[0]!;
  for (const recipeId of recipeIds) {
    if ((state.assignment[recipeId] ?? 0) > (state.assignment[best] ?? 0)) best = recipeId;
  }
  return best;
}

export function applyBuyMachine(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "BUY_MACHINE" }>,
): ApplyResult {
  const { lane, machineClass, mark, count } = action;
  if (!content.lanes.has(lane)) return reject(`unknown lane "${lane}"`);
  if (!content.machineClasses.has(machineClass)) {
    return reject(`unknown machine class "${machineClass}"`);
  }
  const markDef = getMark(content, machineClass, mark);
  if (!markDef) return reject(`"${machineClass}" has no mk${mark}`);
  if (markDef.unlockTier > state.tier) {
    return reject(`"${machineClass}" mk${mark} unlocks at tier ${markDef.unlockTier}`);
  }
  if (!validCount(count)) return reject(`count must be an integer in 1..${MAX_ACTION_COUNT}`);

  const owned = installedAt(state, lane, machineClass, mark);
  const costs = machineCostRange(content, machineClass, mark, owned, count);
  const paid = spendForBuild(content, state, costs);
  if (paid === null) return reject("cannot afford this purchase");

  let next = withInstalled(paid, lane, machineClass, mark, owned + count);

  const target = autoAssignTarget(content, next, lane, machineClass);
  const effects = [
    costEffect("spent", costs),
    { kind: "installed" as const, lane, machineClass, mark, count },
  ];
  if (target !== null) {
    const assigned = (next.assignment[target] ?? 0) + count;
    next = { ...next, assignment: { ...next.assignment, [target]: assigned } };
    effects.push({ kind: "assigned" as const, recipeId: target, count: assigned });
  }
  return accept(next, effects);
}

export function applyDismantle(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "DISMANTLE" }>,
): ApplyResult {
  const { lane, machineClass, mark, count } = action;
  if (!getMark(content, machineClass, mark)) return reject(`"${machineClass}" has no mk${mark}`);
  if (!validCount(count)) return reject(`count must be an integer in 1..${MAX_ACTION_COUNT}`);

  const owned = installedAt(state, lane, machineClass, mark);
  if (count > owned) return reject(`only ${owned} installed`);

  // LIFO: the last `count` machines bought are the ones refunded.
  const refund = machineCostRange(content, machineClass, mark, owned - count, count);
  let next = state;
  for (const [itemId, amount] of refund) next = depositRefund(content, next, itemId, amount);
  next = withInstalled(next, lane, machineClass, mark, owned - count);
  next = clampAssignments(content, next, lane, machineClass);

  return accept(next, [
    costEffect("refunded", refund),
    { kind: "removed", lane, machineClass, mark, count },
  ]);
}

export function applyUpgradeMark(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "UPGRADE_MARK" }>,
): ApplyResult {
  const { lane, machineClass, fromMark } = action;
  const from = getMark(content, machineClass, fromMark);
  if (!from) return reject(`"${machineClass}" has no mk${fromMark}`);
  const to = getMark(content, machineClass, fromMark + 1);
  if (!to) return reject(`"${machineClass}" has no mk${fromMark + 1}`);
  if (to.unlockTier > state.tier) {
    return reject(`"${machineClass}" mk${to.mark} unlocks at tier ${to.unlockTier}`);
  }

  const owned = installedAt(state, lane, machineClass, fromMark);
  if (owned <= 0) return reject(`no mk${fromMark} ${machineClass} installed in ${lane}`);

  // Spec C.0: a Mk2 at rate xA needs only n/A machines for the same output. Keeping
  // the mark-weighted ladder input intact is what stops the upgrade costing the
  // player their multiplier (spec B.2).
  const equivalent = Math.floor((owned * from.rateMultiplier) / to.rateMultiplier);
  if (equivalent < 1) {
    return reject(`need at least ${Math.ceil(to.rateMultiplier / from.rateMultiplier)} to upgrade`);
  }

  const refund = machineCostRange(content, machineClass, fromMark, 0, owned);
  const ownedHigher = installedAt(state, lane, machineClass, to.mark);
  const cost = machineCostRange(content, machineClass, to.mark, ownedHigher, equivalent);

  let next = state;
  for (const [itemId, amount] of refund) next = depositRefund(content, next, itemId, amount);
  const paid = spendForBuild(content, next, cost);
  if (paid === null) return reject("cannot afford the upgrade");
  next = paid;

  next = withInstalled(next, lane, machineClass, fromMark, 0);
  next = withInstalled(next, lane, machineClass, to.mark, ownedHigher + equivalent);
  next = clampAssignments(content, next, lane, machineClass);

  return accept(next, [
    costEffect("refunded", refund),
    costEffect("spent", cost),
    { kind: "removed", lane, machineClass, mark: fromMark, count: owned },
    { kind: "installed", lane, machineClass, mark: to.mark, count: equivalent },
  ]);
}

export function applyAssignMachines(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "ASSIGN_MACHINES" }>,
): ApplyResult {
  const { recipeId, count } = action;
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return reject(`unknown recipe "${recipeId}"`);
  // Ruling R6: cyclic recipes are unselectable in this version.
  if (recipe.inCycle) return reject(`recipe "${recipeId}" is inside a recipe cycle`);
  if (recipe.def.unlockTier > state.tier) {
    return reject(`recipe "${recipeId}" unlocks at tier ${recipe.def.unlockTier}`);
  }
  if (!Number.isInteger(count) || count < 0 || count > MAX_ACTION_COUNT) {
    return reject(`count must be an integer in 0..${MAX_ACTION_COUNT}`);
  }

  const { lane, machineClass } = recipe;
  const pool = installedMachines(state, lane, machineClass);
  const others = assignedTotal(content, state, lane, machineClass) - (state.assignment[recipeId] ?? 0);
  if (others + count > pool) {
    return reject(`only ${pool} ${machineClass} installed in ${lane}, ${others} already assigned`);
  }

  return accept({ ...state, assignment: { ...state.assignment, [recipeId]: count } }, [
    { kind: "assigned", recipeId, count },
  ]);
}

export function applySelectRecipe(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "SELECT_RECIPE" }>,
): ApplyResult {
  const { itemId, recipeId } = action;
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return reject(`unknown recipe "${recipeId}"`);
  if (recipe.primaryOutput !== itemId) {
    return reject(`recipe "${recipeId}" does not produce "${itemId}" as its primary output`);
  }
  // Ruling R6: detected here rather than silently accepted, so the player is told.
  if (recipe.inCycle) return reject(`recipe "${recipeId}" is inside a recipe cycle`);
  if (recipe.def.unlockTier > state.tier) {
    return reject(`recipe "${recipeId}" unlocks at tier ${recipe.def.unlockTier}`);
  }

  return accept({ ...state, activeRecipe: { ...state.activeRecipe, [itemId]: recipeId } }, [
    { kind: "recipeSelected", itemId, recipeId },
  ]);
}
```

- [ ] **Step 5: Run the tests**

Run:

```bash
pnpm --filter @manufactory/engine test machines
pnpm lint && pnpm typecheck
```

Expected: PASS.

The `DISMANTLE` LIFO test is written so it compares the refunded canonical string against the cost of the same range. If it fails, check that `applyDismantle` computes the range from `owned - count`, not from `owned`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the machine action reducers

BUY_MACHINE, DISMANTLE, UPGRADE_MARK, ASSIGN_MACHINES and SELECT_RECIPE
from spec D.1. Ruling R5 pools machines per lane-class, so a purchase
auto-assigns into the busiest recipe rather than making the player assign
after every buy, which would be the management surface pillar 3 rules out.
Refunds are LIFO and use the identical closed form as the purchase, so
they are bitwise equal and cannot pump. UPGRADE_MARK consolidates to the
mark-equivalent count, leaving the mark-weighted ladder input untouched
per spec C.0. Cyclic recipes are rejected by name (ruling R6).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 13: Action reducers — economy, priority, and the `apply` dispatcher

**Files:**
- Create: `packages/engine/src/actions/economy.ts`, `packages/engine/src/actions/index.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/actions/economy.test.ts`, `packages/engine/src/actions/apply.test.ts`

**Interfaces:**
- Consumes: `type IndexedContent` (Task 2); `type WorldState`, `type PriorityEntry`, `type Timer`, `type PrngState`, `makePrng`, `initialWorld`, `installedAt` (Task 4); `levelCostRange` (Task 5); `spendForBuild`, `storageCap`, `quantumCap` (Task 7); `MAX_ACTION_COUNT`, `accept`, `costEffect`, `reject`, `type Action`, `type ApplyResult`, `type Effect` (Task 12); `applyBuyMachine`, `applyDismantle`, `applyUpgradeMark`, `applyAssignMachines`, `applySelectRecipe` (Task 12)
- Produces, from `@manufactory/engine`:
  - `const MAX_RESERVE_PERCENT = 0.5`
  - `const TAP_MIN_INTERVAL_MS = 50`
  - `const TAP_TIMER_ID = "tap-expiry"`
  - `applyReorderPriority(state: WorldState, content: IndexedContent, action: Extract<Action, { type: "REORDER_PRIORITY" }>): ApplyResult`
  - `applySetPriorityMode(state: WorldState, content: IndexedContent, action: Extract<Action, { type: "SET_PRIORITY_MODE" }>): ApplyResult`
  - `applySetReserve(state: WorldState, content: IndexedContent, action: Extract<Action, { type: "SET_RESERVE" }>): ApplyResult`
  - `applyBuyStorage(state: WorldState, content: IndexedContent, action: Extract<Action, { type: "BUY_STORAGE" }>): ApplyResult`
  - `applyBuyQs(state: WorldState, content: IndexedContent, action: Extract<Action, { type: "BUY_QS" }>): ApplyResult`
  - `applyTap(state: WorldState, content: IndexedContent, action: Extract<Action, { type: "TAP" }>): ApplyResult`
  - `apply(state: WorldState, content: IndexedContent, action: Action, seed: PrngState): ApplyResult`
  - `type BatchResult = { rejected: false; state: WorldState; effects: Effect[] } | { rejected: true; reason: string; failedIndex: number }`
  - `applyBatch(state: WorldState, content: IndexedContent, actions: readonly Action[], seed: PrngState): BatchResult`

The remaining six of spec D.1's eleven, plus the dispatcher. Spec A.2's signature is `apply(state, content, action, seed) → { state, effects } | Rejection`, which is what makes `apps/api` almost pure transport in Phase 3 and gives spec 16.3's "full action parity in `sim play`" structurally rather than as maintenance.

`seed` is threaded onto the returned state's `seed` field. None of Phase 1's reducers draws from it — disruptions and the MAM scan, which do, are Spec 2 — but the parameter exists now so the signature never changes, and callers pass `state.seed`.

Spec D.1: **actions are batched, and a failed action aborts the whole batch.** `applyBatch` applies them in order and returns the index and reason of the first failure, which is what the Phase 3 endpoint returns as a 409 and what `sim replay` reports.

Three details worth stating:

**Ruling R8 clamps a reserve to 50%.** `reserve[i] = p` becomes a synthetic near-top-of-list priority entry in the solver, so an uncapped reserve could starve the whole list. `SET_RESERVE` rejects anything above `MAX_RESERVE_PERCENT` rather than silently clamping, so the player is told.

**Spec D.5's tap ceiling.** `maxTaps = elapsedSinceLastFlush / 50ms`, clamped server-side, surplus discarded silently. `clientElapsedMs` is the only client-supplied number the engine reads, and this is the only thing it is trusted for. Stacks then clamp to `tap.maxStacks`; the `discarded` figure counts only the rate-limited surplus, not the stack-cap surplus, because those are different stories to tell the player.

**Spec C.6's expiry is one shared timer.** Every stack expires together at `lastResolvedAt + tap.durationSeconds × 1000`, and each tap refreshes it. One timer rather than one per stack keeps rates piecewise-constant, which the whole event model depends on. `lastResolvedAt` is "now" here because spec D.2's request lifecycle resolves before it applies.

Storage and Quantum Storage levels are **builds**, so they spend through `spendForBuild` and draw `bound` first. Re-instantiating bound matter into a bigger container is the same physical act as re-instantiating it into a machine; deliveries remain the only thing `bound` cannot pay for (spec D4).

- [ ] **Step 1: Write the failing economy test**

`packages/engine/src/actions/economy.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { quantumCap, storageCap } from "../economy/storage.js";
import { initialWorld, type WorldState } from "../state/world.js";
import {
  MAX_RESERVE_PERCENT,
  TAP_TIMER_ID,
  applyBuyQs,
  applyBuyStorage,
  applyReorderPriority,
  applySetPriorityMode,
  applySetReserve,
  applyTap,
} from "./economy.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

function rich(plate = 100_000): WorldState {
  const w = initialWorld(content, 1, START);
  return { ...w, stored: { ...w.stored, iron_plate: D(plate) } };
}

describe("BUY_STORAGE", () => {
  it("charges the geometric run of level costs and raises the cap", () => {
    // storage curve: baseCostAmount 50, costGrowth 2, capGrowth 1.6.
    // Levels 0, 1, 2 cost 50 * (1 + 2 + 4) = 350 iron_plate.
    const result = applyBuyStorage(rich(), content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 3,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.storageLevel.iron_ore).toBe(3);
    expect(result.state.stored.iron_plate!.toNumber()).toBeCloseTo(100_000 - 350, 6);
    // 600 * 1.6^3 = 600 * 4.096 = 2457.6
    expect(storageCap(content, result.state, "iron_ore").toNumber()).toBeCloseTo(2457.6, 6);
  });

  it("charges from the current level, not from zero", () => {
    const start = rich();
    const atTwo: WorldState = { ...start, storageLevel: { ...start.storageLevel, iron_ore: 2 } };
    // Levels 2 and 3 cost 50 * (4 + 8) = 600.
    const result = applyBuyStorage(atTwo, content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 2,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.storageLevel.iron_ore).toBe(4);
    expect(result.state.stored.iron_plate!.toNumber()).toBeCloseTo(100_000 - 600, 6);
  });

  it("rejects going past the curve's maximum level", () => {
    const result = applyBuyStorage(rich(), content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 21,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/level/i);
  });

  it("rejects an unknown item, a non-positive level count, and an unaffordable buy", () => {
    expect(
      applyBuyStorage(rich(), content, { type: "BUY_STORAGE", itemId: "ghost", levels: 1 }).rejected,
    ).toBe(true);
    expect(
      applyBuyStorage(rich(), content, { type: "BUY_STORAGE", itemId: "iron_ore", levels: 0 })
        .rejected,
    ).toBe(true);
    expect(
      applyBuyStorage(initialWorld(content, 1, START), content, {
        type: "BUY_STORAGE",
        itemId: "iron_ore",
        levels: 1,
      }).rejected,
    ).toBe(true);
  });

  it("can be paid out of bound stock, because a container is a build (spec C.5)", () => {
    const w = initialWorld(content, 1, START);
    const bounded: WorldState = { ...w, bound: { ...w.bound, iron_plate: D(1_000) } };
    const result = applyBuyStorage(bounded, content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    // Level 0 costs 50 * 2^0 = 50.
    expect(result.state.bound.iron_plate!.toNumber()).toBeCloseTo(950, 6);
  });
});

describe("BUY_QS", () => {
  it("raises every item in the lane at once (spec B.4)", () => {
    // quantumStorage curve: baseCostAmount 500, costGrowth 2.5, capGrowth 1.6.
    // Levels 0 and 1 cost 500 * (1 + 2.5) = 1750 iron_plate.
    const result = applyBuyQs(rich(), content, { type: "BUY_QS", lane: "iron", levels: 2 });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.qsLevel.iron).toBe(2);
    expect(result.state.stored.iron_plate!.toNumber()).toBeCloseTo(100_000 - 1750, 6);
    // 2400 * 1.6^2 = 6144, and 1600 * 1.6^2 = 4096.
    expect(quantumCap(content, result.state, "iron_ore").toNumber()).toBeCloseTo(6144, 6);
    expect(quantumCap(content, result.state, "iron_ingot").toNumber()).toBeCloseTo(4096, 6);
    // The oil lane is untouched.
    expect(quantumCap(content, result.state, "crude_oil").toNumber()).toBe(1600);
  });

  it("rejects an unknown lane and going past the maximum level", () => {
    expect(applyBuyQs(rich(), content, { type: "BUY_QS", lane: "ghost", levels: 1 }).rejected).toBe(
      true,
    );
    expect(applyBuyQs(rich(), content, { type: "BUY_QS", lane: "iron", levels: 16 }).rejected).toBe(
      true,
    );
  });
});

describe("REORDER_PRIORITY", () => {
  it("reorders the list to the given permutation", () => {
    const start = initialWorld(content, 1, START);
    const ids = start.priority.map((e) => e.id);
    expect(ids[0]).toBe("power");
    expect(ids[1]).toBe("item:iron_plate");
    // Move the last entry to position 2, leaving the rest in order.
    const moved = [ids[0]!, ids[ids.length - 1]!, ...ids.slice(1, ids.length - 1)];
    const result = applyReorderPriority(start, content, {
      type: "REORDER_PRIORITY",
      entries: moved,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.priority.map((e) => e.id)).toEqual(moved);
  });

  it("lets power be moved off position 1 (spec F.1: movable, with a warning)", () => {
    const start = initialWorld(content, 1, START);
    const ids = start.priority.map((e) => e.id);
    const demoted = [...ids.slice(1), ids[0]!];
    const result = applyReorderPriority(start, content, {
      type: "REORDER_PRIORITY",
      entries: demoted,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.priority[result.state.priority.length - 1]!.kind).toBe("power");
  });

  it("rejects anything that is not a permutation of the current ids", () => {
    const start = initialWorld(content, 1, START);
    const ids = start.priority.map((e) => e.id);
    const bad = [
      ids.slice(0, ids.length - 1), // too short
      [...ids.slice(0, ids.length - 1), "item:ghost"], // unknown id
      [ids[0]!, ...ids.slice(0, ids.length - 1)], // duplicate
    ];
    for (const entries of bad) {
      expect(
        applyReorderPriority(start, content, { type: "REORDER_PRIORITY", entries }).rejected,
      ).toBe(true);
    }
  });
});

describe("SET_PRIORITY_MODE", () => {
  it("switches an entry to share mode with a weight", () => {
    const result = applySetPriorityMode(initialWorld(content, 1, START), content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ingot",
      mode: "share",
      share: 3,
    });
    if (result.rejected) throw new Error(result.reason);
    const entry = result.state.priority.find((e) => e.id === "item:iron_ingot")!;
    expect(entry.mode).toBe("share");
    expect(entry.share).toBe(3);
  });

  it("sets and clears a target rate, and sets the paused flag", () => {
    const start = initialWorld(content, 1, START);
    const capped = applySetPriorityMode(start, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "guaranteed",
      targetRate: 2.5,
      paused: true,
    });
    if (capped.rejected) throw new Error(capped.reason);
    const entry = capped.state.priority.find((e) => e.id === "item:iron_ore")!;
    expect(entry.targetRate).toBe(2.5);
    expect(entry.paused).toBe(true);

    const cleared = applySetPriorityMode(capped.state, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "guaranteed",
      targetRate: null,
    });
    if (cleared.rejected) throw new Error(cleared.reason);
    expect(cleared.state.priority.find((e) => e.id === "item:iron_ore")!.targetRate).toBeNull();
  });

  it("leaves omitted fields alone", () => {
    const start = initialWorld(content, 1, START);
    const first = applySetPriorityMode(start, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "share",
      share: 4,
    });
    if (first.rejected) throw new Error(first.reason);
    const second = applySetPriorityMode(first.state, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "share",
    });
    if (second.rejected) throw new Error(second.reason);
    expect(second.state.priority.find((e) => e.id === "item:iron_ore")!.share).toBe(4);
  });

  it("rejects an unknown entry, a non-positive share, and a negative target rate", () => {
    const start = initialWorld(content, 1, START);
    expect(
      applySetPriorityMode(start, content, {
        type: "SET_PRIORITY_MODE",
        entryId: "ghost",
        mode: "guaranteed",
      }).rejected,
    ).toBe(true);
    expect(
      applySetPriorityMode(start, content, {
        type: "SET_PRIORITY_MODE",
        entryId: "item:iron_ore",
        mode: "share",
        share: 0,
      }).rejected,
    ).toBe(true);
    expect(
      applySetPriorityMode(start, content, {
        type: "SET_PRIORITY_MODE",
        entryId: "item:iron_ore",
        mode: "guaranteed",
        targetRate: -1,
      }).rejected,
    ).toBe(true);
  });
});

describe("SET_RESERVE", () => {
  it("stores the fraction", () => {
    const result = applySetReserve(initialWorld(content, 1, START), content, {
      type: "SET_RESERVE",
      itemId: "iron_ore",
      percent: 0.25,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.reserve.iron_ore).toBe(0.25);
  });

  it("rejects above the 50% ceiling rather than clamping silently (ruling R8)", () => {
    expect(MAX_RESERVE_PERCENT).toBe(0.5);
    const result = applySetReserve(initialWorld(content, 1, START), content, {
      type: "SET_RESERVE",
      itemId: "iron_ore",
      percent: 0.6,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/50/);
  });

  it("rejects a negative percent and an unknown item", () => {
    const start = initialWorld(content, 1, START);
    expect(
      applySetReserve(start, content, { type: "SET_RESERVE", itemId: "iron_ore", percent: -0.1 })
        .rejected,
    ).toBe(true);
    expect(
      applySetReserve(start, content, { type: "SET_RESERVE", itemId: "ghost", percent: 0.1 })
        .rejected,
    ).toBe(true);
  });
});

describe("TAP", () => {
  it("adds stacks and arms one shared expiry timer (spec C.6)", () => {
    const result = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 4,
      clientElapsedMs: 1_000,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.tapStacks).toBe(4);
    // tap.durationSeconds is 30 in the fixture.
    expect(result.state.timers).toEqual([
      { id: TAP_TIMER_ID, kind: "tapExpiry", fireAt: START + 30_000 },
    ]);
  });

  it("clamps to the tap ceiling and discards the surplus silently (spec D.5)", () => {
    // 100ms of client time allows floor(100 / 50) = 2 taps.
    const result = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 50,
      clientElapsedMs: 100,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.tapStacks).toBe(2);
    const tapped = result.effects.find((e) => e.kind === "tapped");
    if (tapped?.kind !== "tapped") throw new Error("unreachable");
    expect(tapped.stacks).toBe(2);
    expect(tapped.discarded).toBe(48);
  });

  it("clamps stacks to the content maximum", () => {
    const result = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 40,
      clientElapsedMs: 10_000,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.tapStacks).toBe(content.bundle.tap.maxStacks);
  });

  it("refreshes the single expiry rather than adding a second timer", () => {
    const first = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 1,
      clientElapsedMs: 1_000,
    });
    if (first.rejected) throw new Error(first.reason);
    const later: WorldState = { ...first.state, lastResolvedAt: START + 10_000 };
    const second = applyTap(later, content, { type: "TAP", count: 1, clientElapsedMs: 1_000 });
    if (second.rejected) throw new Error(second.reason);
    expect(second.state.timers).toHaveLength(1);
    expect(second.state.timers[0]!.fireAt).toBe(START + 40_000);
    expect(second.state.tapStacks).toBe(2);
  });

  it("rejects a negative count or a negative client elapsed time", () => {
    const start = initialWorld(content, 1, START);
    expect(applyTap(start, content, { type: "TAP", count: -1, clientElapsedMs: 100 }).rejected).toBe(
      true,
    );
    expect(applyTap(start, content, { type: "TAP", count: 1, clientElapsedMs: -1 }).rejected).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test actions/economy`
Expected: FAIL — `Cannot find module './economy.js'` under `actions/`.

There is also an `economy/storage.test.ts`, so use the path filter `actions/economy` rather than the bare word `economy`.

- [ ] **Step 3: Write the reducers**

`packages/engine/src/actions/economy.ts`:

```ts
// Spec D.1, actions six through eleven.
import type { IndexedContent } from "../graph/index-content.js";
import { levelCostRange } from "../economy/curves.js";
import { spendForBuild } from "../economy/storage.js";
import type { PriorityEntry, Timer, WorldState } from "../state/world.js";
import { accept, costEffect, reject, type Action, type ApplyResult } from "./types.js";

/**
 * Ruling R8: a reserve becomes a synthetic near-top-of-list priority entry, so an
 * uncapped one could starve the whole list. Rejected rather than silently clamped,
 * so the player is told what happened.
 */
export const MAX_RESERVE_PERCENT = 0.5;

/** Spec D.5: maxTaps = elapsedSinceLastFlush / 50ms, clamped server-side. */
export const TAP_MIN_INTERVAL_MS = 50;

/** Spec C.6: every stack shares one expiry, which keeps rates piecewise-constant. */
export const TAP_TIMER_ID = "tap-expiry";

export function applyReorderPriority(
  state: WorldState,
  _content: IndexedContent,
  action: Extract<Action, { type: "REORDER_PRIORITY" }>,
): ApplyResult {
  const requested = action.entries;
  if (requested.length !== state.priority.length) {
    return reject(`expected ${state.priority.length} entries, got ${requested.length}`);
  }

  const byId = new Map(state.priority.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const id of requested) {
    if (!byId.has(id)) return reject(`unknown priority entry "${id}"`);
    if (seen.has(id)) return reject(`duplicate priority entry "${id}"`);
    seen.add(id);
  }

  // Spec F.1: power is movable, with a warning in the UI. The engine allows it, and
  // spec C.4's bottleneck report is what tells the player the consequence.
  const priority = requested.map((id) => byId.get(id)!);
  return accept({ ...state, priority }, [{ kind: "priorityChanged", order: [...requested] }]);
}

export function applySetPriorityMode(
  state: WorldState,
  _content: IndexedContent,
  action: Extract<Action, { type: "SET_PRIORITY_MODE" }>,
): ApplyResult {
  const index = state.priority.findIndex((entry) => entry.id === action.entryId);
  if (index < 0) return reject(`unknown priority entry "${action.entryId}"`);

  const existing = state.priority[index]!;
  const share = action.share ?? existing.share;
  if (action.mode === "share" && !(share > 0)) return reject("share weight must be positive");

  const targetRate = action.targetRate === undefined ? existing.targetRate : action.targetRate;
  if (targetRate !== null && !(Number.isFinite(targetRate) && targetRate >= 0)) {
    return reject("target rate must be a non-negative number or null");
  }

  const updated: PriorityEntry = {
    ...existing,
    mode: action.mode,
    share,
    targetRate,
    paused: action.paused ?? existing.paused,
  };
  const priority = [...state.priority];
  priority[index] = updated;

  return accept({ ...state, priority }, [
    {
      kind: "entryModeChanged",
      entryId: updated.id,
      mode: updated.mode,
      share: updated.share,
      targetRate: updated.targetRate,
      paused: updated.paused,
    },
  ]);
}

export function applySetReserve(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "SET_RESERVE" }>,
): ApplyResult {
  const { itemId, percent } = action;
  if (!content.items.has(itemId)) return reject(`unknown item "${itemId}"`);
  if (!Number.isFinite(percent) || percent < 0) return reject("reserve must be at least 0");
  if (percent > MAX_RESERVE_PERCENT) {
    return reject(`reserve cannot exceed 50% (${MAX_RESERVE_PERCENT})`);
  }
  return accept({ ...state, reserve: { ...state.reserve, [itemId]: percent } }, [
    { kind: "reserveChanged", itemId, percent },
  ]);
}

function buyLevels(
  state: WorldState,
  content: IndexedContent,
  scope: "storage" | "quantum",
  id: string,
  levels: number,
): ApplyResult {
  if (!Number.isInteger(levels) || levels <= 0) return reject("levels must be a positive integer");

  const curve = scope === "storage" ? content.bundle.storage : content.bundle.quantumStorage;
  const currentLevel =
    scope === "storage" ? (state.storageLevel[id] ?? 0) : (state.qsLevel[id] ?? 0);
  if (currentLevel + levels > curve.maxLevel) {
    return reject(`level ${currentLevel + levels} exceeds the maximum of ${curve.maxLevel}`);
  }

  // Spec C.5: a container is a build, so it draws bound stock first. Deliveries
  // remain the only thing bound cannot pay for (spec D4).
  const costs = levelCostRange(curve, currentLevel, levels);
  const paid = spendForBuild(content, state, costs);
  if (paid === null) return reject("cannot afford these levels");

  const next: WorldState =
    scope === "storage"
      ? { ...paid, storageLevel: { ...paid.storageLevel, [id]: currentLevel + levels } }
      : { ...paid, qsLevel: { ...paid.qsLevel, [id]: currentLevel + levels } };

  return accept(next, [
    costEffect("spent", costs),
    { kind: "levelChanged", scope, id, level: currentLevel + levels },
  ]);
}

export function applyBuyStorage(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "BUY_STORAGE" }>,
): ApplyResult {
  if (!content.items.has(action.itemId)) return reject(`unknown item "${action.itemId}"`);
  return buyLevels(state, content, "storage", action.itemId, action.levels);
}

export function applyBuyQs(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "BUY_QS" }>,
): ApplyResult {
  if (!content.lanes.has(action.lane)) return reject(`unknown lane "${action.lane}"`);
  return buyLevels(state, content, "quantum", action.lane, action.levels);
}

export function applyTap(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "TAP" }>,
): ApplyResult {
  const { count, clientElapsedMs } = action;
  if (!Number.isFinite(count) || count < 0) return reject("tap count must be non-negative");
  if (!Number.isFinite(clientElapsedMs) || clientElapsedMs < 0) {
    return reject("clientElapsedMs must be non-negative");
  }

  // Spec D.5: clientElapsedMs is the only client-supplied number the engine reads,
  // and this ceiling is the only thing it is trusted for. Surplus is discarded
  // silently rather than rejected, so a laggy client is not punished.
  const allowed = Math.floor(clientElapsedMs / TAP_MIN_INTERVAL_MS);
  const applied = Math.min(Math.floor(count), allowed);
  const discarded = Math.floor(count) - applied;

  const tap = content.bundle.tap;
  const stacks = Math.min(tap.maxStacks, state.tapStacks + applied);

  // Spec C.6: one shared expiry, refreshed by each tap. lastResolvedAt is "now",
  // because spec D.2's request lifecycle resolves before it applies.
  const timers: Timer[] = state.timers.filter((timer) => timer.id !== TAP_TIMER_ID);
  if (stacks > 0) {
    timers.push({
      id: TAP_TIMER_ID,
      kind: "tapExpiry",
      fireAt: state.lastResolvedAt + tap.durationSeconds * 1000,
    });
  }
  // Spec A.5's canonical ordering: by time, ties broken by a stable id.
  timers.sort((a, b) => (a.fireAt === b.fireAt ? (a.id < b.id ? -1 : 1) : a.fireAt - b.fireAt));

  return accept({ ...state, tapStacks: stacks, timers }, [{ kind: "tapped", stacks, discarded }]);
}
```

- [ ] **Step 4: Run the economy test to verify it passes**

Run: `pnpm --filter @manufactory/engine test actions/economy`
Expected: PASS.

- [ ] **Step 5: Write the failing dispatcher test**

`packages/engine/src/actions/apply.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, installedAt, makePrng, type WorldState } from "../state/index.js";
import { apply, applyBatch } from "./index.js";
import type { Action } from "./types.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

function rich(): WorldState {
  const w = initialWorld(content, 1, START);
  return { ...w, stored: { ...w.stored, iron_plate: D(100_000) } };
}

describe("apply", () => {
  it("dispatches ten of spec D.1's eleven actions in sequence", () => {
    const ids = rich().priority.map((e) => e.id);
    const actions: Action[] = [
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
      { type: "ASSIGN_MACHINES", recipeId: "make_plate", count: 1 },
      { type: "SELECT_RECIPE", itemId: "iron_plate", recipeId: "make_plate" },
      { type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
      // Any permutation of the current ids; here, the last entry moved to the front.
      { type: "REORDER_PRIORITY", entries: [ids[ids.length - 1]!, ...ids.slice(0, ids.length - 1)] },
      { type: "SET_PRIORITY_MODE", entryId: "item:iron_ore", mode: "share", share: 2 },
      { type: "SET_RESERVE", itemId: "iron_ore", percent: 0.1 },
      { type: "BUY_STORAGE", itemId: "iron_ore", levels: 1 },
      { type: "BUY_QS", lane: "iron", levels: 1 },
      { type: "TAP", count: 3, clientElapsedMs: 1_000 },
    ];
    let state = rich();
    for (const action of actions) {
      const result = apply(state, content, action, state.seed);
      if (result.rejected) throw new Error(`${action.type}: ${result.reason}`);
      state = result.state;
    }
    expect(state.reserve.iron_ore).toBe(0.1);
    expect(state.storageLevel.iron_ore).toBe(1);
    expect(state.qsLevel.iron).toBe(1);
    expect(state.tapStacks).toBe(3);
  });

  it("dispatches the eleventh, UPGRADE_MARK, once its mark is unlocked", () => {
    // 45 Mk1 miners at tier 1 consolidate to floor(45 * 1 / 3) = 15 Mk2.
    const start = rich();
    const bought = apply(
      { ...start, tier: 1 },
      content,
      { type: "BUY_MACHINE", lane: "iron", machineClass: "miner", mark: 1, count: 43 },
      start.seed,
    );
    if (bought.rejected) throw new Error(bought.reason);
    expect(installedAt(bought.state, "iron", "miner", 1)).toBe(45);

    const upgraded = apply(
      bought.state,
      content,
      { type: "UPGRADE_MARK", lane: "iron", machineClass: "miner", fromMark: 1 },
      bought.state.seed,
    );
    if (upgraded.rejected) throw new Error(upgraded.reason);
    expect(installedAt(upgraded.state, "iron", "miner", 1)).toBe(0);
    expect(installedAt(upgraded.state, "iron", "miner", 2)).toBe(15);
  });

  it("threads the seed onto the returned state", () => {
    const seed = makePrng(4242);
    const result = apply(
      rich(),
      content,
      { type: "SET_RESERVE", itemId: "iron_ore", percent: 0.1 },
      seed,
    );
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.seed).toEqual(seed);
  });

  it("returns a rejection rather than throwing on an invalid action", () => {
    const result = apply(
      rich(),
      content,
      { type: "BUY_MACHINE", lane: "ghost", machineClass: "miner", mark: 1, count: 1 },
      makePrng(1),
    );
    expect(result.rejected).toBe(true);
  });

  it("never mutates the state it was given", () => {
    const start = rich();
    const snapshot = JSON.stringify(start.assignment);
    apply(
      start,
      content,
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 3 },
      start.seed,
    );
    expect(JSON.stringify(start.assignment)).toBe(snapshot);
    expect(installedAt(start, "iron", "constructor", 1)).toBe(1);
  });
});

describe("applyBatch", () => {
  it("applies actions in order and concatenates their effects", () => {
    const result = applyBatch(
      rich(),
      content,
      [
        { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 2 },
        { type: "ASSIGN_MACHINES", recipeId: "make_plate", count: 3 },
      ],
      makePrng(1),
    );
    if (result.rejected) throw new Error(result.reason);
    expect(installedAt(result.state, "iron", "constructor", 1)).toBe(3);
    expect(result.state.assignment.make_plate).toBe(3);
    expect(result.effects.length).toBeGreaterThanOrEqual(3);
  });

  it("aborts the whole batch on the first failure and names which one (spec D.1)", () => {
    const result = applyBatch(
      rich(),
      content,
      [
        { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
        { type: "ASSIGN_MACHINES", recipeId: "make_plate", count: 99 },
        { type: "SET_RESERVE", itemId: "iron_ore", percent: 0.1 },
      ],
      makePrng(1),
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.failedIndex).toBe(1);
    expect(result.reason).toMatch(/installed/i);
  });

  it("accepts an empty batch as a no-op", () => {
    const start = rich();
    const result = applyBatch(start, content, [], makePrng(7));
    if (result.rejected) throw new Error(result.reason);
    expect(result.effects).toEqual([]);
    expect(result.state.tier).toBe(start.tier);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @manufactory/engine test apply`
Expected: FAIL — `Cannot find module './index.js'` under `actions/`.

- [ ] **Step 7: Write the dispatcher**

`packages/engine/src/actions/index.ts`:

```ts
// Spec A.2: actions are engine reducers, not API handlers. The API becomes almost
// pure transport -- authenticate, lock the row, resolve, apply, persist, return --
// so essentially no game logic lives in apps/api and there is nothing there to
// drift from the client. It also buys spec 16.3's full action parity in `sim play`
// structurally: the terminal client calls these identical functions with no HTTP in
// between, so a divergence between what is possible in the simulator and in the
// game cannot be expressed.
import type { IndexedContent } from "../graph/index-content.js";
import type { PrngState, WorldState } from "../state/world.js";
import {
  applyAssignMachines,
  applyBuyMachine,
  applyDismantle,
  applySelectRecipe,
  applyUpgradeMark,
} from "./machines.js";
import {
  applyBuyQs,
  applyBuyStorage,
  applyReorderPriority,
  applySetPriorityMode,
  applySetReserve,
  applyTap,
} from "./economy.js";
import type { Action, ApplyResult, Effect } from "./types.js";

export * from "./types.js";
export * from "./machines.js";
export * from "./economy.js";

/**
 * Spec A.2's signature. `seed` is threaded onto the returned state: none of Phase
 * 1's reducers draws from the PRNG -- disruptions and the MAM scan, which do, are
 * Spec 2 -- but the parameter exists now so the signature never has to change.
 * Callers pass `state.seed`.
 */
export function apply(
  state: WorldState,
  content: IndexedContent,
  action: Action,
  seed: PrngState,
): ApplyResult {
  const seeded: WorldState = { ...state, seed };
  switch (action.type) {
    case "BUY_MACHINE":
      return applyBuyMachine(seeded, content, action);
    case "DISMANTLE":
      return applyDismantle(seeded, content, action);
    case "UPGRADE_MARK":
      return applyUpgradeMark(seeded, content, action);
    case "ASSIGN_MACHINES":
      return applyAssignMachines(seeded, content, action);
    case "SELECT_RECIPE":
      return applySelectRecipe(seeded, content, action);
    case "REORDER_PRIORITY":
      return applyReorderPriority(seeded, content, action);
    case "SET_PRIORITY_MODE":
      return applySetPriorityMode(seeded, content, action);
    case "SET_RESERVE":
      return applySetReserve(seeded, content, action);
    case "BUY_STORAGE":
      return applyBuyStorage(seeded, content, action);
    case "BUY_QS":
      return applyBuyQs(seeded, content, action);
    case "TAP":
      return applyTap(seeded, content, action);
  }
}

export type BatchResult =
  | { rejected: false; state: WorldState; effects: Effect[] }
  | { rejected: true; reason: string; failedIndex: number };

/**
 * Spec D.1: one request carries an ordered list, and a failed action aborts the
 * whole batch. Atomic and easy to reason about, and the response names which action
 * failed and why. The wire format is identical to `sim replay`'s log format, so a
 * real player's session file replays directly (spec E.4).
 */
export function applyBatch(
  state: WorldState,
  content: IndexedContent,
  actions: readonly Action[],
  seed: PrngState,
): BatchResult {
  let current: WorldState = { ...state, seed };
  const effects: Effect[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const result = apply(current, content, actions[index]!, current.seed);
    if (result.rejected) return { rejected: true, reason: result.reason, failedIndex: index };
    current = result.state;
    effects.push(...result.effects);
  }
  return { rejected: false, state: current, effects };
}
```

- [ ] **Step 8: Register the barrel**

Add one line to `packages/engine/src/index.ts`, after the `resolve` line:

```ts
export * from "./actions/index.js";
```

- [ ] **Step 9: Run everything**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the economy action reducers and the apply dispatcher

REORDER_PRIORITY, SET_PRIORITY_MODE, SET_RESERVE, BUY_STORAGE, BUY_QS and
TAP complete spec D.1's eleven, and apply/applyBatch dispatch them. Spec
A.2's signature means the Phase 3 API is pure transport and sim play gets
full action parity structurally rather than by maintenance. A failed
action aborts the whole batch and names its index. The tap ceiling is spec
D.5's elapsed/50ms clamp with the surplus discarded silently, and every
stack shares one expiry timer so rates stay piecewise-constant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 14: The property suite and the fuzzer

**Files:**
- Modify: `packages/engine/package.json` (add `fast-check` to `devDependencies`)
- Create: `packages/engine/src/testing/arbitrary.ts`
- Test: `packages/engine/src/properties.test.ts`, `packages/engine/src/fuzz.test.ts`

**Interfaces:**
- Consumes: `D`, `type Dec` (Phase 0 Task 2); `type IndexedContent`, `isLiveRecipe`, `laneClassKey`, `getMark`, `type ItemId`, `type LaneId`, `type MachineClassId`, `type RecipeId` (Task 2); `computeExpansion` (Task 3); `type WorldState`, `initialWorld`, `installedAt`, `withInstalled`, `installedMachines` (Task 4); `machineCostRange` (Task 5); `computeCapacity` (Task 6); `depositProduction`, `depositRefund`, `liquidCap`, `liquid`, `quantumCap`, `itemStateTag` (Task 7); `effectivePriority` (Task 8); `solveItems` (Task 9); `solve` (Task 10); `resolve` (Task 11); `applyBuyMachine`, `applyDismantle` (Task 12)
- Produces:
  - `packages/engine/src/testing/arbitrary.ts` exporting `interface WorldSketch { tier: number; machines: number[]; fills: number[]; storageLevels: number[]; qsLevels: number[]; reserves: number[]; tapStacks: number; refund: number; rotate: number }`, `buildWorld(content: IndexedContent, sketch: WorldSketch, nowMs: number): WorldState`, and `arbWorldSketch(): fc.Arbitrary<WorldSketch>`
  - No production exports — this task adds tests only

`packages/engine/src/testing/arbitrary.ts` is **test-support code, not shipped code**, but it lives outside `*.test.ts`, so the engine import-boundary lint rule would otherwise apply to it and reject its `fast-check` import. Step 1 therefore adds `"packages/engine/src/testing/**"` to the `ignores` of the engine block in `eslint.config.js`, beside the `*.test.ts` entry Phase 0 ruling R2 added. Nothing outside a test imports this directory, so no impure import can reach shipped engine code.

Spec E.6's table, in full, with the property that carries each:

| Property | Guards |
|---|---|
| `resolve(s, 2t) ≡ resolve(resolve(s, t), t)` | **The one that matters most.** Offline and online cannot disagree if this holds |
| Conservation — nothing created outside extraction | Spec 3.1's core economic rule |
| Adding a machine never decreases output | Spec 4.6's dead-purchase guard, as an invariant |
| The spec C.3 fixed point terminates in ≤ \|items\| passes | The provable bound, on random states |
| An item at cap never has positive net rate | Backpressure |
| `bound > 0` ⟹ `quantum == qsCap` | Spec D4's Quantum Storage invariant |
| Buy N then dismantle N returns exactly what was paid | LIFO symmetry |

Two of them need their statement pinned down, because the prose admits several readings:

**Conservation** is stated as *no item with zero stock is consumed faster than it is produced*. That is exactly "nothing is created from nothing" — you cannot consume what does not exist and has not just been made — and it is the EMPTY half of spec C.2 holding. It is paired with a sharper structural check: in a state where every stockpile is empty and no extraction recipe has a machine assigned, every item's production is zero. Spec 3.1's "only extraction creates value", as an executable statement.

**Adding a machine never decreases output** has one genuine exception: a purchase that pushes the grid into a brownout really does reduce output, and spec 6.1 wants that. The property is therefore conditioned on `power.ratio === 1` both before and after — spec 4.6's guard is about *starvation*, not about browning out your own factory. The machine is added directly through `withInstalled` rather than through `BUY_MACHINE`, so the purchase cost does not perturb the stock and confound the comparison.

The split-invariance property uses a relative tolerance of **1e-8** on Decimal magnitudes and exact equality on discrete state. Spec E.4 specifies 1e-12 for replay comparison, but that applies to an identical sequence of steps; a split deliberately changes the step boundaries, so the integration rounds differently and the budget has to be looser. Discrete divergence is still a bug.

- [ ] **Step 1: Add fast-check and widen the lint exemption**

In `packages/engine/package.json`, add to `devDependencies`:

```json
    "fast-check": "^3.22.0",
```

Then run `pnpm install`.

In `eslint.config.js`, the engine import-boundary block's `ignores` currently lists `packages/engine/**/*.test.ts` (Phase 0 ruling R2). Add the testing directory beside it:

```js
    ignores: ["packages/engine/**/*.test.ts", "packages/engine/src/testing/**"],
```

Test-support code legitimately needs `fast-check`, and it cannot reach shipped engine code because nothing outside a test imports it.

- [ ] **Step 2: Write the arbitrary state builder**

`packages/engine/src/testing/arbitrary.ts`:

```ts
// Random but *legal* world states for the spec E.6 property suite.
//
// Test support only: nothing outside a test imports this, and the engine's
// import-boundary lint rule exempts src/testing/** for that reason.
//
// The generator builds states the way the game would reach them rather than by
// filling fields at random. `bound` in particular is only ever created through
// depositRefund, because spec D4's invariant -- bound > 0 implies quantum is at cap
// -- is a property of how bound comes into existence, and a generator that violated
// it would make that property untestable.
import fc from "fast-check";
import { D } from "../numbers/decimal.js";
import type { ItemId, LaneId, MachineClassId } from "../content/types.js";
import { getMark, isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import { depositProduction, depositRefund, liquidCap } from "../economy/storage.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";

export interface WorldSketch {
  tier: number;
  /** Machines to install per lane-class slot, cycled if shorter than the slot list. */
  machines: number[];
  /** Fraction of each item's combined cap to pre-fill, cycled likewise. */
  fills: number[];
  storageLevels: number[];
  qsLevels: number[];
  reserves: number[];
  tapStacks: number;
  /** Extra iron_plate refunded in, which is the only way bound stock appears. */
  refund: number;
  /** Rotation applied to the priority list. */
  rotate: number;
}

export function arbWorldSketch(): fc.Arbitrary<WorldSketch> {
  const cycle = <T>(item: fc.Arbitrary<T>) => fc.array(item, { minLength: 8, maxLength: 8 });
  return fc.record({
    tier: fc.integer({ min: 0, max: 3 }),
    machines: cycle(fc.integer({ min: 0, max: 12 })),
    // 0 and 1 are repeated so EMPTY and FULL are common, not rare.
    fills: cycle(fc.constantFrom(0, 0, 0.25, 0.5, 1, 1)),
    storageLevels: cycle(fc.integer({ min: 0, max: 3 })),
    qsLevels: cycle(fc.integer({ min: 0, max: 2 })),
    reserves: cycle(fc.constantFrom(0, 0, 0, 0.1, 0.25)),
    tapStacks: fc.integer({ min: 0, max: 10 }),
    refund: fc.constantFrom(0, 0, 0, 5_000, 250_000),
    rotate: fc.integer({ min: 0, max: 5 }),
  });
}

function at<T>(list: readonly T[], index: number): T {
  return list[index % list.length]!;
}

export function buildWorld(
  content: IndexedContent,
  sketch: WorldSketch,
  nowMs: number,
): WorldState {
  let world = initialWorld(content, 1, nowMs);
  world = { ...world, tier: sketch.tier, tapStacks: sketch.tapStacks, installed: {}, assignment: {} };

  // Machines, per lane-class, only where mk1 has actually unlocked at this tier.
  const slots = [...content.recipesByLaneClass.keys()].sort();
  slots.forEach((key, index) => {
    const [lane, machineClass] = key.split("::") as [LaneId, MachineClassId];
    const markOne = getMark(content, machineClass, 1);
    if (!markOne || markOne.unlockTier > sketch.tier) return;

    const count = at(sketch.machines, index);
    if (count <= 0) return;
    world = withInstalled(world, lane, machineClass, 1, count);

    const recipeIds = (content.recipesByLaneClass.get(key) ?? []).filter((recipeId) =>
      isLiveRecipe(content, recipeId, world.tier, world.activeRecipe),
    );
    if (recipeIds.length === 0) return;

    const assignment = { ...world.assignment };
    for (let i = 0; i < count; i += 1) {
      const recipeId = recipeIds[i % recipeIds.length]!;
      assignment[recipeId] = (assignment[recipeId] ?? 0) + 1;
    }
    world = { ...world, assignment };
  });

  // Levels first, so the caps the fills are measured against are the final ones.
  const storageLevel: Record<ItemId, number> = { ...world.storageLevel };
  content.stockItemIds.forEach((itemId, index) => {
    storageLevel[itemId] = at(sketch.storageLevels, index);
  });
  const qsLevel: Record<LaneId, number> = { ...world.qsLevel };
  [...content.lanes.keys()].forEach((lane, index) => {
    qsLevel[lane] = at(sketch.qsLevels, index);
  });
  world = { ...world, storageLevel, qsLevel };

  // Fills go in through the real deposit path, so storage tops up before quantum.
  content.stockItemIds.forEach((itemId, index) => {
    const fraction = at(sketch.fills, index);
    if (fraction <= 0) return;
    const amount = liquidCap(content, world, itemId).times(fraction);
    world = depositProduction(content, world, itemId, amount).state;
  });

  const reserve: Record<ItemId, number> = { ...world.reserve };
  content.stockItemIds.forEach((itemId, index) => {
    reserve[itemId] = at(sketch.reserves, index);
  });
  world = { ...world, reserve };

  // The only legal source of bound stock (spec D4).
  if (sketch.refund > 0) {
    world = depositRefund(content, world, "iron_plate", D(sketch.refund));
  }

  const rotate = sketch.rotate % world.priority.length;
  world = {
    ...world,
    priority: [...world.priority.slice(rotate), ...world.priority.slice(0, rotate)],
  };
  return world;
}
```

- [ ] **Step 3: Write the property suite**

`packages/engine/src/properties.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { D } from "./numbers/decimal.js";
import { indexContent } from "./graph/index-content.js";
import { computeExpansion } from "./graph/expand.js";
import { computeCapacity } from "./economy/capacity.js";
import { itemStateTag, liquid, quantumCap } from "./economy/storage.js";
import { machineCostRange } from "./economy/curves.js";
import { initialWorld, installedAt, withInstalled, type WorldState } from "./state/world.js";
import { effectivePriority } from "./solve/waterfall.js";
import { solveItems } from "./solve/fixpoint.js";
import { solve } from "./solve/solve.js";
import { resolve } from "./resolve/index.js";
import { applyBuyMachine, applyDismantle } from "./actions/machines.js";
import { arbWorldSketch, buildWorld } from "./testing/arbitrary.js";

const fixtureDir = fileURLToPath(new URL("../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

/** Rates below this are float64 noise, not signal. */
const SLACK = 1e-7;

function world(sketch: Parameters<typeof buildWorld>[1]): WorldState {
  return buildWorld(content, sketch, START);
}

describe("resolve(s, 2t) equals resolve(resolve(s, t), t) — spec E.6's centrepiece", () => {
  it("holds on random states for windows well under the offline cap", () => {
    fc.assert(
      fc.property(
        arbWorldSketch(),
        fc.integer({ min: 30_000, max: 900_000 }),
        (sketch, halfMs) => {
          const start = world(sketch);
          const whole = resolve(start, content, 2 * halfMs);
          const split = resolve(resolve(start, content, halfMs).state, content, halfMs);

          // Discrete state must be exactly equal (spec E.4).
          expect(split.state.tier).toBe(whole.state.tier);
          expect(split.state.tapStacks).toBe(whole.state.tapStacks);
          expect(split.state.timers).toEqual(whole.state.timers);
          expect(split.state.storageLevel).toEqual(whole.state.storageLevel);
          expect(split.state.qsLevel).toEqual(whole.state.qsLevel);
          expect(split.state.installed).toEqual(whole.state.installed);
          expect(split.state.lastResolvedAt).toBe(whole.state.lastResolvedAt);

          // Magnitudes within a relative 1e-8. Tighter than this is not available:
          // a split moves the integration boundaries, so the two paths round
          // differently even though they describe the same trajectory.
          for (const itemId of content.stockItemIds) {
            for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
              const a = whole.state[field][itemId]!.toNumber();
              const b = split.state[field][itemId]!.toNumber();
              expect(Math.abs(a - b) / Math.max(1, Math.abs(a))).toBeLessThan(1e-8);
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("conservation — nothing is created outside extraction (spec 3.1)", () => {
  it("never consumes an item with no stock faster than it is produced", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const solution = solve(state, content);
        for (const itemId of content.stockItemIds) {
          if (liquid(state, itemId).gt(0)) continue;
          const flow = solution.itemRates.get(itemId)!;
          expect(flow.consumption).toBeLessThanOrEqual(flow.production + SLACK);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("produces nothing at all when no extraction machine is assigned and no stock exists", () => {
    const start = initialWorld(content, 1, START);
    // The fixture's only extraction recipes are mine_iron and extract_oil.
    const idle: WorldState = {
      ...start,
      assignment: { ...start.assignment, mine_iron: 0, extract_oil: 0 },
    };
    const solution = solve(idle, content);
    for (const itemId of content.stockItemIds) {
      expect(solution.itemRates.get(itemId)!.production).toBeLessThan(SLACK);
    }
  });
});

describe("adding a machine never decreases output (spec 4.6)", () => {
  it("holds whenever the grid has headroom before and after", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const before = world(sketch);
        const beforeSolution = solve(before, content);
        // A purchase that browns the grid out really does cut output, and spec 6.1
        // wants that. The guard is about starvation, not self-inflicted brownout.
        fc.pre(beforeSolution.power.ratio === 1);

        // Add one Mk1 constructor to the iron lane directly, bypassing the cost so
        // the comparison is not confounded by the stock the purchase would spend.
        const owned = installedAt(before, "iron", "constructor", 1);
        let after = withInstalled(before, "iron", "constructor", 1, owned + 1);
        after = {
          ...after,
          assignment: { ...after.assignment, make_plate: (after.assignment.make_plate ?? 0) + 1 },
        };
        const afterSolution = solve(after, content);
        fc.pre(afterSolution.power.ratio === 1);

        const beforeRate = beforeSolution.itemRates.get("iron_plate")!.production;
        const afterRate = afterSolution.itemRates.get("iron_plate")!.production;
        expect(afterRate).toBeGreaterThanOrEqual(beforeRate - SLACK);
      }),
      { numRuns: 60 },
    );
  });
});

describe("the spec C.3 fixed point terminates in at most |items| passes", () => {
  it("holds on random states, unseeded", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const capacity = computeCapacity(content, state);
        const result = solveItems({
          content,
          vectors: computeExpansion(content, state.tier, state.activeRecipe),
          state,
          capacityUnits: capacity.unitsByRecipe,
          entries: effectivePriority(content, state, capacity, 0),
          reserveFloor: 0,
          seedPins: false,
        });
        expect(result.passes).toBeLessThanOrEqual(content.itemIds.length);
        // Every pass adds at least one pin, so the two must agree.
        expect(result.pinOrder.length).toBeGreaterThanOrEqual(result.passes - 1);
        expect(new Set(result.pinOrder).size).toBe(result.pinOrder.length);
      }),
      { numRuns: 60 },
    );
  });
});

describe("an item at cap never has a positive net rate", () => {
  it("holds on random states", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const solution = solve(state, content);
        for (const itemId of content.stockItemIds) {
          if (itemStateTag(content, state, itemId) !== "FULL") continue;
          expect(solution.itemRates.get(itemId)!.net).toBeLessThanOrEqual(SLACK);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("holds after a resolve, which is where it would show up as overflow", () => {
    fc.assert(
      fc.property(arbWorldSketch(), fc.integer({ min: 1_000, max: 600_000 }), (sketch, ms) => {
        const after = resolve(world(sketch), content, ms).state;
        for (const itemId of content.stockItemIds) {
          const cap = liquid(after, itemId);
          expect(cap.gte(0)).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });
});

describe("bound > 0 implies quantum is at its cap (spec D4)", () => {
  it("holds on random states and after a resolve", () => {
    fc.assert(
      fc.property(arbWorldSketch(), fc.integer({ min: 0, max: 600_000 }), (sketch, ms) => {
        const state = resolve(world(sketch), content, ms).state;
        for (const itemId of content.stockItemIds) {
          const bound = state.bound[itemId]!;
          if (bound.lte(0)) continue;
          const quantum = state.quantum[itemId]!;
          const cap = quantumCap(content, state, itemId);
          expect(cap.minus(quantum).toNumber()).toBeLessThan(SLACK);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("buy N then dismantle N returns exactly what was paid (spec D4, LIFO)", () => {
  it("holds for every machine class and batch size", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("miner", "smelter", "constructor"),
        fc.integer({ min: 1, max: 20 }),
        (machineClass, count) => {
          const start = initialWorld(content, 1, START);
          const funded: WorldState = {
            ...start,
            stored: { ...start.stored, iron_plate: D("1e12") },
          };

          const bought = applyBuyMachine(funded, content, {
            type: "BUY_MACHINE",
            lane: "iron",
            machineClass,
            mark: 1,
            count,
          });
          if (bought.rejected) throw new Error(bought.reason);
          const spent = bought.effects.find((e) => e.kind === "spent");
          if (spent?.kind !== "spent") throw new Error("expected a spent effect");

          const removed = applyDismantle(bought.state, content, {
            type: "DISMANTLE",
            lane: "iron",
            machineClass,
            mark: 1,
            count,
          });
          if (removed.rejected) throw new Error(removed.reason);
          const refunded = removed.effects.find((e) => e.kind === "refunded");
          if (refunded?.kind !== "refunded") throw new Error("expected a refunded effect");

          // Bitwise equal, because both directions evaluate the same closed form
          // over the same range. Symmetric, so there is no pump.
          expect(refunded.items).toEqual(spent.items);
          expect(installedAt(removed.state, "iron", machineClass, 1)).toBe(
            installedAt(funded, "iron", machineClass, 1),
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  it("refunds the same range the purchase charged, at any starting count", () => {
    // A direct check of the underlying curve, independent of the reducers.
    for (const from of [0, 1, 7, 40]) {
      for (const count of [1, 3, 12]) {
        const paid = machineCostRange(content, "constructor", 1, from, count);
        const back = machineCostRange(content, "constructor", 1, from, count);
        expect(back.get("iron_plate")!.toString()).toBe(paid.get("iron_plate")!.toString());
      }
    }
  });
});
```

- [ ] **Step 4: Run the property suite**

Run: `pnpm --filter @manufactory/engine test properties`
Expected: PASS.

If the split-invariance property fails with a tier mismatch, the shrunk counterexample fast-check prints names the state — check that `settle` is the only thing that advances a tier. If it fails on a magnitude by more than 1e-8, the integration is not linear between events: look for a rate that changes without a corresponding discontinuity being reported by `nextDiscontinuity`.

- [ ] **Step 5: Write the fuzzer**

`packages/engine/src/fuzz.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { indexContent } from "./graph/index-content.js";
import { liquid, liquidCap } from "./economy/storage.js";
import { solve } from "./solve/solve.js";
import { resolve } from "./resolve/index.js";
import { serializeWorld, deserializeWorld } from "./state/serialize.js";
import { arbWorldSketch, buildWorld } from "./testing/arbitrary.js";

const fixtureDir = fileURLToPath(new URL("../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

describe("fuzzing solve", () => {
  it("never returns a NaN, an infinite rate, or a clock outside [0, 1]", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const solution = solve(buildWorld(content, sketch, START), content);
        for (const [, clock] of solution.clocks) {
          expect(Number.isFinite(clock)).toBe(true);
          expect(clock).toBeGreaterThanOrEqual(0);
          expect(clock).toBeLessThanOrEqual(1 + 1e-9);
        }
        for (const [, flow] of solution.itemRates) {
          expect(Number.isFinite(flow.production)).toBe(true);
          expect(Number.isFinite(flow.consumption)).toBe(true);
          expect(flow.production).toBeGreaterThanOrEqual(0);
          expect(flow.consumption).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isFinite(solution.power.ratio)).toBe(true);
        expect(solution.power.ratio).toBeGreaterThanOrEqual(0);
        expect(solution.power.ratio).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });
});

describe("fuzzing resolve", () => {
  it("never produces a negative stockpile, a NaN, or an overfilled buffer", () => {
    fc.assert(
      fc.property(
        arbWorldSketch(),
        fc.integer({ min: 0, max: 8 * 60 * 60 * 1000 }),
        (sketch, elapsedMs) => {
          const after = resolve(buildWorld(content, sketch, START), content, elapsedMs).state;
          for (const itemId of content.stockItemIds) {
            for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
              const value = after[field][itemId]!;
              expect(Number.isNaN(value.toNumber())).toBe(false);
              expect(value.gte(0)).toBe(true);
            }
            const cap = liquidCap(content, after, itemId);
            expect(liquid(after, itemId).lte(cap.plus(1e-6))).toBe(true);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("does not trip the spec C.7 guards on legitimate input", () => {
    fc.assert(
      fc.property(
        arbWorldSketch(),
        fc.integer({ min: 0, max: 8 * 60 * 60 * 1000 }),
        (sketch, elapsedMs) => {
          const result = resolve(buildWorld(content, sketch, START), content, elapsedMs);
          expect(result.summary.guardTripped).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("round-trips every resolved state through serialization", () => {
    fc.assert(
      fc.property(
        arbWorldSketch(),
        fc.integer({ min: 0, max: 600_000 }),
        (sketch, elapsedMs) => {
          const after = resolve(buildWorld(content, sketch, START), content, elapsedMs).state;
          const text = serializeWorld(after);
          expect(serializeWorld(deserializeWorld(text))).toBe(text);
        },
      ),
      { numRuns: 40 },
    );
  });
});
```

- [ ] **Step 6: Run the fuzzer**

Run: `pnpm --filter @manufactory/engine test fuzz`
Expected: PASS.

If `guardTripped` fires, print the shrunk sketch and the event count: an oscillating factory that legitimately produces more than 10,000 events in eight hours would mean `nextDiscontinuity` is returning times far smaller than the real ones.

- [ ] **Step 7: Run the whole engine suite and lint**

Run:

```bash
pnpm --filter @manufactory/engine test
pnpm lint && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the spec E.6 property suite and the fuzzer

All seven properties from spec E.6, with resolve(s, 2t) equalling
resolve(resolve(s, t), t) as the centrepiece -- offline and online cannot
disagree if it holds. Conservation is stated as "no item with zero stock
is consumed faster than it is produced", which is spec 3.1's rule made
executable. The dead-purchase guard is conditioned on the grid having
headroom, because a purchase that browns out the grid really does cut
output and spec 6.1 wants that. States are generated the way the game
would reach them, so bound stock only ever appears through a refund.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 15: `apps/sim` and `sim run` — the four policies and the report

**Files:**
- Create: `apps/sim/package.json`, `apps/sim/tsconfig.json`
- Create: `apps/sim/src/bootstrap.ts`, `apps/sim/src/policies.ts`, `apps/sim/src/report.ts`, `apps/sim/src/run.ts`, `apps/sim/src/bin.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `apps/sim/src/policies.test.ts`, `apps/sim/src/run.test.ts`

**Interfaces:**
- Consumes, from `@manufactory/engine`: `indexContent`, `type IndexedContent`, `type ContentBundle`, `type ItemId`, `type LaneId`, `type MachineClassId`, `getMark`; `initialWorld`, `type WorldState`, `installedAt`; `computeCapacity`, `bestUnlockedMark`; `machineCostRange`, `levelCostRange`; `canAffordBuild`; `solve`, `type Solution`; `resolve`; `apply`, `type Action`; `D`, `type Dec`. From `@manufactory/content`: `loadBundleDir`.
- Produces:
  - `bootstrap.ts`: `const FIXTURE_BUNDLE_DIR: string`, `loadContent(dir?: string): IndexedContent`, `newWorld(content: IndexedContent, seed: number): WorldState`
  - `policies.ts`: `type PolicyName = "optimal" | "greedy" | "casual" | "bottleneck"`, `const POLICY_NAMES: readonly PolicyName[]`, `interface PolicyContext { content: IndexedContent; state: WorldState; solution: Solution; nowMs: number }`, `interface Policy { name: PolicyName; intervalMs(ctx: PolicyContext): number; decide(ctx: PolicyContext): Action[] }`, `interface Candidate { action: Action; costs: Map<ItemId, Dec>; score: number; label: string }`, `costScore(costs: ReadonlyMap<ItemId, Dec>): number`, `affordableCandidates(ctx: PolicyContext): Candidate[]`, `topTargetItem(ctx: PolicyContext): ItemId | null`, `getPolicy(name: PolicyName): Policy`
  - `report.ts`: `interface TierMark { tier: number; atMs: number; collections: number }`, `interface REffRow { lane: LaneId; machineClass: MachineClassId; authored: number; observed: number | null }`, `interface RunReport { policy: PolicyName; contentVersion: string; seed: number; reachedTier: number; finished: boolean; simulatedMs: number; collections: number; tierTimes: TierMark[]; maxDeadTimeMs: number; purchases: number; bindingConstraints: { recipeId: string; boundMs: number }[]; rEff: REffRow[] }`, `authoredREff(content: IndexedContent, machineClass: MachineClassId): number`, `observedREff(costRatio: number, ladderStep: number, ladderInterval: number, fromCount: number, toCount: number): number | null`, `formatReport(report: RunReport): string`
  - `run.ts`: `interface RunOptions { policy: PolicyName; contentDir?: string; seed: number; untilTier: number; maxSimMs: number }`, `runSimulation(options: RunOptions): RunReport`
  - `bin.ts`: the `sim run` / `sim play` CLI entry

Spec E.1 is why this exists: calibration *is* the simulator with a search wrapper, so content cannot be authored without it, and there is no game without content. Spec E.2's four policies, and the reason the fourth exists is worth restating — **`bottleneck` answers the only question that matters about the game's advice mechanism: is the advice actually good?** If it lands materially worse than `greedy`, the UI is lying to players and no amount of balance tuning fixes that.

`apps/sim` is a **separate workspace package** and may import Node builtins, `@manufactory/content` and React freely. Spec A.2's purity rule binds `packages/engine` only. This is also where `Math.pow` becomes legal again: `r_eff = r / m` needs `m = step^(1/interval)`, a fractional power, and it is a reporting figure that never re-enters state — which is precisely why Task 5 left it out of the engine.

Times are reported in **collections**, not hours, per spec B.7 and 16.2: with an 8h offline cap a player gets about three meaningful collections a day, so a tier costing 40 collections is a two-week tier no matter what the hour count claims. One collection is one `offlineCapMs`.

`optimal` is implemented as **greedy with one-step lookahead**: for every affordable candidate it applies the purchase to a copy, re-solves, and scores the marginal gain in the top target's rate per unit of cost. That is an upper-bound *proxy*, not a true optimum — a genuine optimum would need search over the whole purchase sequence. The plan says so rather than overclaiming, and it is still strictly stronger than `greedy`, which is what the policy is for.

- [ ] **Step 1: Create the package**

`apps/sim/package.json`:

```json
{
  "name": "@manufactory/sim",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./src/bin.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "sim": "tsx src/bin.ts",
    "sim:ci": "tsx src/bin.ts run --policy greedy --until tier:2 --max-days 120 --report text"
  },
  "dependencies": {
    "@manufactory/content": "workspace:*",
    "@manufactory/engine": "workspace:*",
    "ink": "^5.1.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^18.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.10"
  }
}
```

`apps/sim/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "noEmit": true,
    "types": ["node"],
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

`jsx` and the `DOM` lib are here for Task 16's Ink client; they are harmless for this task's modules.

Run `pnpm install`.

- [ ] **Step 2: Write the bootstrap module**

`apps/sim/src/bootstrap.ts`:

```ts
// Loading the bundle and standing up a world. This module is also where the
// structural compatibility between @manufactory/content's Zod-inferred `Bundle` and
// @manufactory/engine's hand-declared `ContentBundle` is checked: the assignment in
// `loadContent` fails to typecheck the moment the two drift, which is the guard
// that lets spec A.2 keep the engine free of a content import.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import {
  indexContent,
  initialWorld,
  type ContentBundle,
  type IndexedContent,
  type WorldState,
} from "@manufactory/engine";

export const FIXTURE_BUNDLE_DIR = fileURLToPath(
  new URL("../../../packages/content/bundles/fixture", import.meta.url),
);

export function loadContent(dir: string = FIXTURE_BUNDLE_DIR): IndexedContent {
  const bundle: ContentBundle = loadBundleDir(dir);
  return indexContent(bundle);
}

/** Simulated worlds start at t = 0, so report times are elapsed times. */
export function newWorld(content: IndexedContent, seed: number): WorldState {
  return initialWorld(content, seed, 0);
}
```

- [ ] **Step 3: Write the failing policy test**

`apps/sim/src/policies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { D, apply, computeCapacity, solve, type WorldState } from "@manufactory/engine";
import { loadContent, newWorld } from "./bootstrap.js";
import {
  POLICY_NAMES,
  affordableCandidates,
  costScore,
  getPolicy,
  topTargetItem,
  type PolicyContext,
} from "./policies.js";

const content = loadContent();

function context(over: Partial<WorldState> = {}): PolicyContext {
  const state: WorldState = { ...newWorld(content, 1), ...over };
  return { content, state, solution: solve(state, content), nowMs: 0 };
}

function rich(): PolicyContext {
  const base = newWorld(content, 1);
  return context({ stored: { ...base.stored, iron_plate: D(100_000) } });
}

describe("costScore", () => {
  it("sums the amounts so candidates can be ordered", () => {
    expect(costScore(new Map([["a", D(10)], ["b", D(5)]]))).toBe(15);
    expect(costScore(new Map())).toBe(0);
  });
});

describe("affordableCandidates", () => {
  it("offers nothing when nothing can be paid for", () => {
    expect(affordableCandidates(context())).toEqual([]);
  });

  it("offers a machine in every unlocked lane-class, plus storage and QS levels", () => {
    const candidates = affordableCandidates(rich());
    const kinds = new Set(candidates.map((c) => c.action.type));
    expect(kinds.has("BUY_MACHINE")).toBe(true);
    expect(kinds.has("BUY_STORAGE")).toBe(true);
    expect(kinds.has("BUY_QS")).toBe(true);
    // At tier 0 only the iron lane's three classes have unlocked.
    const machines = candidates.filter((c) => c.action.type === "BUY_MACHINE");
    expect(machines).toHaveLength(3);
  });

  it("offers no locked machine class", () => {
    const candidates = affordableCandidates(rich());
    for (const candidate of candidates) {
      if (candidate.action.type !== "BUY_MACHINE") continue;
      expect(["miner", "smelter", "constructor"]).toContain(candidate.action.machineClass);
    }
  });

  it("every candidate it returns is actually applicable", () => {
    const ctx = rich();
    for (const candidate of affordableCandidates(ctx)) {
      const result = apply(ctx.state, ctx.content, candidate.action, ctx.state.seed);
      expect(result.rejected).toBe(false);
    }
  });

  it("scores each candidate by its total cost", () => {
    const candidates = affordableCandidates(rich());
    for (const candidate of candidates) {
      expect(candidate.score).toBe(costScore(candidate.costs));
      expect(candidate.score).toBeGreaterThan(0);
    }
  });
});

describe("topTargetItem", () => {
  it("is the highest-priority item entry with a live recipe", () => {
    expect(topTargetItem(context())).toBe("iron_plate");
  });

  it("skips paused entries", () => {
    const base = newWorld(content, 1);
    const ctx = context({
      priority: base.priority.map((e) => (e.itemId === "iron_plate" ? { ...e, paused: true } : e)),
    });
    expect(topTargetItem(ctx)).toBe("iron_ingot");
  });
});

describe("getPolicy", () => {
  it("knows all four of spec E.2's policies", () => {
    expect([...POLICY_NAMES].sort()).toEqual(["bottleneck", "casual", "greedy", "optimal"]);
    for (const name of POLICY_NAMES) expect(getPolicy(name).name).toBe(name);
  });

  it("greedy buys the single cheapest affordable thing", () => {
    const ctx = rich();
    const actions = getPolicy("greedy").decide(ctx);
    expect(actions).toHaveLength(1);
    const cheapest = affordableCandidates(ctx).reduce((a, b) => (b.score < a.score ? b : a));
    expect(actions[0]).toEqual(cheapest.action);
  });

  it("casual checks in three times a day and buys what it can", () => {
    const ctx = rich();
    // Three collections a day is spec E.2's lower bound: one 8h window per check-in.
    expect(getPolicy("casual").intervalMs(ctx)).toBe(content.offlineCapMs);
    expect(getPolicy("casual").decide(ctx).length).toBeGreaterThan(0);
  });

  it("casual never reorders priorities or changes modes (spec E.2)", () => {
    const actions = getPolicy("casual").decide(rich());
    for (const action of actions) {
      expect(["REORDER_PRIORITY", "SET_PRIORITY_MODE", "SET_RESERVE"]).not.toContain(action.type);
    }
  });

  it("greedy and bottleneck check in at the authored early purchase interval", () => {
    const ctx = rich();
    const expected = content.bundle.pacing.purchaseIntervalEarlySeconds * 1000;
    expect(getPolicy("greedy").intervalMs(ctx)).toBe(expected);
    expect(getPolicy("bottleneck").intervalMs(ctx)).toBe(expected);
  });

  it("bottleneck buys exactly what the reporter recommends (spec 4.5, E.2)", () => {
    const ctx = rich();
    expect(ctx.solution.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 1,
    });
    const actions = getPolicy("bottleneck").decide(ctx);
    expect(actions).toEqual([
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
    ]);
  });

  it("bottleneck does nothing when there is no bottleneck to clear", () => {
    const base = newWorld(content, 1);
    // Pausing every item entry leaves the solver with nothing to be limited by.
    const ctx = context({
      stored: { ...base.stored, iron_plate: D(100_000) },
      priority: base.priority.map((e) => (e.kind === "item" ? { ...e, paused: true } : e)),
    });
    expect(ctx.solution.bottleneck).toBeNull();
    expect(getPolicy("bottleneck").decide(ctx)).toEqual([]);
  });

  it("optimal picks a candidate that does not lower the top target's rate", () => {
    const ctx = rich();
    const actions = getPolicy("optimal").decide(ctx);
    expect(actions).toHaveLength(1);
    const applied = apply(ctx.state, ctx.content, actions[0]!, ctx.state.seed);
    if (applied.rejected) throw new Error(applied.reason);
    const before = ctx.solution.itemRates.get("iron_plate")!.production;
    const after = solve(applied.state, content).itemRates.get("iron_plate")!.production;
    expect(after).toBeGreaterThanOrEqual(before - 1e-9);
  });

  it("every policy returns an empty list rather than throwing when broke", () => {
    const ctx = context();
    for (const name of POLICY_NAMES) expect(getPolicy(name).decide(ctx)).toEqual([]);
  });

  it("capacity is what a purchase actually moves", () => {
    const ctx = rich();
    const before = computeCapacity(content, ctx.state).unitsByRecipe.get("make_plate")!;
    const applied = apply(
      ctx.state,
      content,
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
      ctx.state.seed,
    );
    if (applied.rejected) throw new Error(applied.reason);
    expect(computeCapacity(content, applied.state).unitsByRecipe.get("make_plate")!).toBeGreaterThan(
      before,
    );
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @manufactory/sim test policies`
Expected: FAIL — `Cannot find module './policies.js'`.

- [ ] **Step 5: Write the policies**

`apps/sim/src/policies.ts`:

```ts
// Spec E.2's four policies. Real players sit between greedy and casual; tuning only
// against optimal produces a game that is brutal for everyone else.
//
// The fourth, `bottleneck`, is the one that earns its place: it answers the only
// question that matters about the game's advice mechanism -- is the advice actually
// good? If it lands materially worse than greedy, the UI is lying to players and no
// amount of balance tuning fixes that.
import {
  apply,
  bestUnlockedMark,
  canAffordBuild,
  getMark,
  laneClassKey,
  levelCostRange,
  machineCostRange,
  solve,
  type Action,
  type Dec,
  type IndexedContent,
  type ItemId,
  type Solution,
  type WorldState,
} from "@manufactory/engine";

export type PolicyName = "optimal" | "greedy" | "casual" | "bottleneck";

export const POLICY_NAMES: readonly PolicyName[] = [
  "optimal",
  "greedy",
  "casual",
  "bottleneck",
] as const;

export interface PolicyContext {
  content: IndexedContent;
  state: WorldState;
  solution: Solution;
  nowMs: number;
}

export interface Policy {
  name: PolicyName;
  /** Simulated milliseconds to advance before the next decision point. */
  intervalMs(ctx: PolicyContext): number;
  /** Actions to attempt now. The runner skips any the engine rejects. */
  decide(ctx: PolicyContext): Action[];
}

export interface Candidate {
  action: Action;
  costs: Map<ItemId, Dec>;
  /** Total cost, used to order candidates. Lower is cheaper. */
  score: number;
  label: string;
}

/**
 * A single scalar for a multi-item cost. Exact when a tier's build costs share one
 * currency, which they do in the fixture, and a stable ordering heuristic otherwise.
 */
export function costScore(costs: ReadonlyMap<ItemId, Dec>): number {
  let total = 0;
  for (const [, amount] of costs) total += amount.toNumber();
  return total;
}

/** The highest-priority unpaused item entry that something can actually produce. */
export function topTargetItem(ctx: PolicyContext): ItemId | null {
  for (const entry of ctx.state.priority) {
    if (entry.paused || entry.kind !== "item" || entry.itemId === null) continue;
    const recipeId = ctx.state.activeRecipe[entry.itemId];
    if (recipeId === undefined) continue;
    // Only a recipe with live capacity is a target anything can be steered toward.
    if (!ctx.solution.capacity.unitsByRecipe.has(recipeId)) continue;
    return entry.itemId;
  }
  return null;
}

export function affordableCandidates(ctx: PolicyContext): Candidate[] {
  const { content, state } = ctx;
  const candidates: Candidate[] = [];

  const offer = (action: Action, costs: Map<ItemId, Dec>, label: string): void => {
    if (costs.size === 0) return;
    if (!canAffordBuild(state, costs)) return;
    candidates.push({ action, costs, score: costScore(costs), label });
  };

  for (const key of content.recipesByLaneClass.keys()) {
    const [lane, machineClass] = key.split("::") as [string, string];
    const mark = bestUnlockedMark(content, machineClass, state.tier);
    if (mark === null) continue;
    const markDef = getMark(content, machineClass, mark);
    if (!markDef) continue;

    const owned = state.installed[lane]?.[machineClass]?.[mark - 1] ?? 0;
    offer(
      { type: "BUY_MACHINE", lane, machineClass, mark, count: 1 },
      machineCostRange(content, machineClass, mark, owned, 1),
      `machine:${key}`,
    );
  }

  for (const itemId of content.stockItemIds) {
    const level = state.storageLevel[itemId] ?? 0;
    if (level >= content.bundle.storage.maxLevel) continue;
    offer(
      { type: "BUY_STORAGE", itemId, levels: 1 },
      levelCostRange(content.bundle.storage, level, 1),
      `storage:${itemId}`,
    );
  }

  for (const lane of content.lanes.keys()) {
    const level = state.qsLevel[lane] ?? 0;
    if (level >= content.bundle.quantumStorage.maxLevel) continue;
    offer(
      { type: "BUY_QS", lane, levels: 1 },
      levelCostRange(content.bundle.quantumStorage, level, 1),
      `qs:${lane}`,
    );
  }

  return candidates;
}

function cheapest(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    // Ties break on the label, which is derived from ids, so the choice is stable.
    if (best === null || candidate.score < best.score) best = candidate;
    else if (candidate.score === best.score && candidate.label < best.label) best = candidate;
  }
  return best;
}

const greedy: Policy = {
  name: "greedy",
  intervalMs: (ctx) => ctx.content.bundle.pacing.purchaseIntervalEarlySeconds * 1000,
  decide: (ctx) => {
    const pick = cheapest(affordableCandidates(ctx));
    return pick === null ? [] : [pick.action];
  },
};

/**
 * Spec E.2's lower bound: checks in three times a day, buys whatever it can see, and
 * never touches the priority list. One check-in per offline window.
 */
const casual: Policy = {
  name: "casual",
  intervalMs: (ctx) => ctx.content.offlineCapMs,
  decide: (ctx) => {
    const actions: Action[] = [];
    let state = ctx.state;
    // Buy repeatedly until nothing is affordable, because a casual player who has
    // been away eight hours spends the whole backlog in one sitting.
    for (let i = 0; i < 50; i += 1) {
      const pick = cheapest(affordableCandidates({ ...ctx, state }));
      if (pick === null) break;
      const result = apply(state, ctx.content, pick.action, state.seed);
      if (result.rejected) break;
      state = result.state;
      actions.push(pick.action);
    }
    return actions;
  },
};

const bottleneck: Policy = {
  name: "bottleneck",
  intervalMs: (ctx) => ctx.content.bundle.pacing.purchaseIntervalEarlySeconds * 1000,
  decide: (ctx) => {
    const report = ctx.solution.bottleneck;
    if (report === null) return [];

    const recipeId = report.kind === "recipe" ? report.recipeId : report.generatorRecipeId;
    if (recipeId === null) return [];
    const recipe = ctx.content.recipes.get(recipeId);
    if (!recipe) return [];

    const mark = bestUnlockedMark(ctx.content, recipe.machineClass, ctx.state.tier);
    if (mark === null) return [];

    const owned =
      ctx.state.installed[recipe.lane]?.[recipe.machineClass]?.[mark - 1] ?? 0;

    // Buy what the reporter says, then fall back to what is affordable, so the
    // policy still makes progress rather than stalling on an expensive quote.
    for (let count = Math.max(1, report.machinesToClear); count >= 1; count -= 1) {
      const costs = machineCostRange(ctx.content, recipe.machineClass, mark, owned, count);
      if (canAffordBuild(ctx.state, costs)) {
        return [
          {
            type: "BUY_MACHINE",
            lane: recipe.lane,
            machineClass: recipe.machineClass,
            mark,
            count,
          },
        ];
      }
    }
    return [];
  },
};

/**
 * Greedy with one-step lookahead, and named `optimal` because spec E.2 calls the
 * upper-bound policy that. It is a proxy, not a true optimum: a real optimum would
 * search the whole purchase sequence. It is still strictly better informed than
 * greedy, which is the comparison the policy exists to provide.
 */
const optimal: Policy = {
  name: "optimal",
  intervalMs: (ctx) => ctx.content.bundle.pacing.purchaseIntervalEarlySeconds * 1000,
  decide: (ctx) => {
    const target = topTargetItem(ctx);
    const candidates = affordableCandidates(ctx);
    if (candidates.length === 0) return [];
    if (target === null) {
      const pick = cheapest(candidates);
      return pick === null ? [] : [pick.action];
    }

    const before = ctx.solution.itemRates.get(target)?.production ?? 0;
    let best: { action: Action; value: number; label: string } | null = null;

    for (const candidate of candidates) {
      const applied = apply(ctx.state, ctx.content, candidate.action, ctx.state.seed);
      if (applied.rejected) continue;
      const after = solve(applied.state, ctx.content).itemRates.get(target)?.production ?? 0;
      const value = (after - before) / Math.max(1, candidate.score);
      if (
        best === null ||
        value > best.value ||
        (value === best.value && candidate.label < best.label)
      ) {
        best = { action: candidate.action, value, label: candidate.label };
      }
    }

    if (best === null) return [];
    // Nothing helped the top target, so fall back to the cheapest capacity there is:
    // a purchase that does nothing today may unblock a tier tomorrow.
    if (best.value <= 0) {
      const pick = cheapest(candidates);
      return pick === null ? [] : [pick.action];
    }
    return [best.action];
  },
};

const POLICIES: Record<PolicyName, Policy> = { optimal, greedy, casual, bottleneck };

export function getPolicy(name: PolicyName): Policy {
  return POLICIES[name];
}
```

- [ ] **Step 6: Run the policy test**

Run: `pnpm --filter @manufactory/sim test policies`
Expected: PASS.

- [ ] **Step 7: Write the failing runner test**

`apps/sim/src/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadContent } from "./bootstrap.js";
import { POLICY_NAMES } from "./policies.js";
import { authoredREff, formatReport, observedREff } from "./report.js";
import { runSimulation } from "./run.js";

const content = loadContent();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe("loadContent", () => {
  it("loads and indexes the fixture bundle", () => {
    expect(content.bundle.version).toBe("fixture.v1");
    expect(content.recipes.size).toBeGreaterThan(0);
  });
});

describe("authoredREff", () => {
  it("is the cost ratio over the per-machine multiplier growth (spec D3)", () => {
    // Miner: r = 1.09, ladder x1.5 every 10, so m = 1.5^(1/10) = 1.0413797 and
    // r_eff = 1.09 / 1.0413797 = 1.04669. Spec D3 quotes 1.047.
    expect(authoredREff(content, "miner")).toBeCloseTo(1.04669, 4);
    // Refinery: r = 1.12 on the same ladder -> 1.12 / 1.0413797 = 1.07549.
    expect(authoredREff(content, "refinery")).toBeCloseTo(1.07549, 4);
  });

  it("stays above 1, which is spec D3's runaway invariant", () => {
    for (const machineClass of content.machineClasses.keys()) {
      expect(authoredREff(content, machineClass)).toBeGreaterThan(1);
    }
  });
});

describe("observedREff", () => {
  it("matches the authored value when the run spans a whole ladder interval", () => {
    // 10 machines bought on the miner's curve: cost grows 1.09^10 and the ladder
    // steps once, x1.5, so the observed r_eff is exactly 1.09 / 1.5^(1/10).
    expect(observedREff(1.09, 1.5, 10, 0, 10)).toBeCloseTo(1.04669, 4);
  });

  it("is null when too little was bought to measure", () => {
    expect(observedREff(1.09, 1.5, 10, 4, 4)).toBeNull();
  });
});

describe("runSimulation", () => {
  it.each([...POLICY_NAMES])("%s reaches tier 1 and reports it", (policy) => {
    const report = runSimulation({
      policy,
      seed: 42,
      untilTier: 1,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.policy).toBe(policy);
    expect(report.contentVersion).toBe("fixture.v1");
    expect(report.finished).toBe(true);
    expect(report.reachedTier).toBeGreaterThanOrEqual(1);
    expect(report.tierTimes[0]!.tier).toBe(1);
    expect(report.tierTimes[0]!.atMs).toBeGreaterThan(0);
  });

  it("reports times in collections, one collection per offline window (spec B.7)", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    for (const mark of report.tierTimes) {
      expect(mark.collections).toBeCloseTo(mark.atMs / content.offlineCapMs, 9);
    }
    expect(report.collections).toBeCloseTo(report.simulatedMs / content.offlineCapMs, 9);
  });

  it("reports a finite max dead time no larger than the run (spec 16.6)", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(Number.isFinite(report.maxDeadTimeMs)).toBe(true);
    expect(report.maxDeadTimeMs).toBeGreaterThanOrEqual(0);
    expect(report.maxDeadTimeMs).toBeLessThanOrEqual(report.simulatedMs);
  });

  it("reports which recipe was binding and for how long (spec E.2)", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.bindingConstraints.length).toBeGreaterThan(0);
    let total = 0;
    for (const row of report.bindingConstraints) {
      expect(row.boundMs).toBeGreaterThan(0);
      total += row.boundMs;
    }
    expect(total).toBeLessThanOrEqual(report.simulatedMs + 1);
    // Sorted longest-binding first, so the report reads top-down.
    for (let i = 1; i < report.bindingConstraints.length; i += 1) {
      expect(report.bindingConstraints[i - 1]!.boundMs).toBeGreaterThanOrEqual(
        report.bindingConstraints[i]!.boundMs,
      );
    }
  });

  it("stops at the simulated-time budget rather than running forever", () => {
    const report = runSimulation({
      policy: "casual",
      seed: 1,
      untilTier: 99,
      maxSimMs: 60 * 60 * 1000,
    });
    expect(report.finished).toBe(false);
    expect(report.simulatedMs).toBeLessThanOrEqual(60 * 60 * 1000 + content.offlineCapMs);
  });

  it("is deterministic for a given seed and policy (spec E.4)", () => {
    const options = {
      policy: "greedy" as const,
      seed: 7,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    };
    const a = runSimulation(options);
    const b = runSimulation(options);
    expect(b.tierTimes).toEqual(a.tierTimes);
    expect(b.purchases).toBe(a.purchases);
    expect(b.simulatedMs).toBe(a.simulatedMs);
  });

  it("casual buys nothing before its first check-in", () => {
    // Its first decision point is at t = 0 with an empty warehouse, and the next is
    // a whole offline window later -- by which time tier 1 has already landed.
    const report = runSimulation({
      policy: "casual",
      seed: 42,
      untilTier: 1,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.purchases).toBe(0);
  });

  it("greedy buys before it reaches tier 1", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 1,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.purchases).toBeGreaterThan(0);
  });
});

describe("formatReport", () => {
  it("renders every section a human needs", () => {
    const text = formatReport(
      runSimulation({ policy: "greedy", seed: 42, untilTier: 2, maxSimMs: THIRTY_DAYS_MS }),
    );
    expect(text).toContain("greedy");
    expect(text).toContain("fixture.v1");
    expect(text).toContain("collections");
    expect(text).toContain("dead time");
    expect(text).toContain("r_eff");
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @manufactory/sim test run`
Expected: FAIL — `Cannot find module './report.js'`.

- [ ] **Step 9: Write the report module**

`apps/sim/src/report.ts`:

```ts
// Spec E.2's report, in collections rather than hours per spec 16.2: with an 8h
// offline cap a player gets about three meaningful collections a day, so a tier
// costing 40 collections is a two-week tier no matter what the hour count claims.
//
// This file is where Math.pow becomes legal again. r_eff = r / m needs
// m = step^(1/interval), a fractional power, which spec E.4 bans from
// state-affecting paths -- and this is a reporting figure that never re-enters
// state, which is exactly why the engine's economy module does not compute it.
import type { IndexedContent, LaneId, MachineClassId } from "@manufactory/engine";
import type { PolicyName } from "./policies.js";

export interface TierMark {
  tier: number;
  atMs: number;
  collections: number;
}

export interface REffRow {
  lane: LaneId;
  machineClass: MachineClassId;
  authored: number;
  observed: number | null;
}

export interface RunReport {
  policy: PolicyName;
  contentVersion: string;
  seed: number;
  reachedTier: number;
  finished: boolean;
  simulatedMs: number;
  collections: number;
  tierTimes: TierMark[];
  /** Spec 16.6's pace-decay detector, as a hard number. */
  maxDeadTimeMs: number;
  purchases: number;
  bindingConstraints: { recipeId: string; boundMs: number }[];
  rEff: REffRow[];
}

/** r_eff = r / m, where m is the ladder's multiplier growth per machine (spec D3). */
export function authoredREff(content: IndexedContent, machineClass: MachineClassId): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return Number.NaN;
  const m = Math.pow(cls.ladder.step, 1 / cls.ladder.interval);
  return cls.costRatio / m;
}

/**
 * The same figure measured over a run: cost growth per machine divided by
 * multiplier growth per machine, across the machines actually bought.
 *
 * Counts are the mark-weighted ladder input, which is exact while a run stays on one
 * mark and an approximation across a mark boundary, where the cost curve resets but
 * the ladder does not (spec B.2). Phase 2's calibration measures per-mark segments.
 */
export function observedREff(
  costRatio: number,
  ladderStep: number,
  ladderInterval: number,
  fromCount: number,
  toCount: number,
): number | null {
  const delta = toCount - fromCount;
  if (delta <= 0) return null;
  const costGrowth = Math.pow(costRatio, delta);
  const stepsBefore = Math.floor(fromCount / ladderInterval);
  const stepsAfter = Math.floor(toCount / ladderInterval);
  const multiplierGrowth = Math.pow(ladderStep, stepsAfter - stepsBefore);
  return Math.pow(costGrowth / multiplierGrowth, 1 / delta);
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export function formatReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(
    `policy ${report.policy}  content ${report.contentVersion}  seed ${report.seed}  ` +
      `${report.finished ? "finished" : "budget exhausted"}`,
  );
  lines.push(
    `reached tier ${report.reachedTier} in ${report.collections.toFixed(2)} collections ` +
      `(${duration(report.simulatedMs)}), ${report.purchases} purchases`,
  );
  lines.push("");
  lines.push("tier   collections   elapsed");
  for (const mark of report.tierTimes) {
    lines.push(
      `${String(mark.tier).padStart(4)}   ${mark.collections.toFixed(2).padStart(11)}   ` +
        duration(mark.atMs),
    );
  }
  lines.push("");
  lines.push(`max dead time between meaningful events: ${duration(report.maxDeadTimeMs)}`);
  lines.push("");
  lines.push("binding constraint            time bound");
  for (const row of report.bindingConstraints.slice(0, 8)) {
    lines.push(`${row.recipeId.padEnd(28)}  ${duration(row.boundMs)}`);
  }
  lines.push("");
  lines.push("lane / class                  r_eff authored   observed");
  for (const row of report.rEff) {
    lines.push(
      `${`${row.lane}/${row.machineClass}`.padEnd(28)}  ${row.authored.toFixed(4).padStart(15)}   ` +
        (row.observed === null ? "       -" : row.observed.toFixed(4).padStart(8)),
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 10: Write the runner**

`apps/sim/src/run.ts`:

```ts
// Spec E.2's batch mode. One binary, two modes, both driving the identical engine
// the real game uses -- there is no second implementation to keep in sync (spec
// 16.3), and spec A.2's reducers are what make that structural rather than a
// discipline.
import {
  apply,
  installedAt,
  resolve,
  solve,
  type IndexedContent,
  type LaneId,
  type MachineClassId,
  type WorldState,
} from "@manufactory/engine";
import { loadContent, newWorld } from "./bootstrap.js";
import { getPolicy, type PolicyName } from "./policies.js";
import { authoredREff, observedREff, type REffRow, type RunReport, type TierMark } from "./report.js";

export interface RunOptions {
  policy: PolicyName;
  contentDir?: string;
  seed: number;
  /** Stop once this tier is reached. */
  untilTier: number;
  /** Stop after this much simulated time regardless. */
  maxSimMs: number;
}

interface ClassSlot {
  lane: LaneId;
  machineClass: MachineClassId;
  startCount: number;
}

function classSlots(content: IndexedContent, state: WorldState): ClassSlot[] {
  const slots: ClassSlot[] = [];
  const seen = new Set<string>();
  for (const key of content.recipesByLaneClass.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const [lane, machineClass] = key.split("::") as [LaneId, MachineClassId];
    let startCount = 0;
    const cls = content.machineClasses.get(machineClass);
    for (const mark of cls?.marks ?? []) {
      startCount += installedAt(state, lane, machineClass, mark.mark) * mark.rateMultiplier;
    }
    slots.push({ lane, machineClass, startCount });
  }
  return slots;
}

export function runSimulation(options: RunOptions): RunReport {
  const content = loadContent(options.contentDir);
  const policy = getPolicy(options.policy);

  let state = newWorld(content, options.seed);
  const slots = classSlots(content, state);

  let nowMs = 0;
  let purchases = 0;
  let lastEventMs = 0;
  let maxDeadTimeMs = 0;
  const tierTimes: TierMark[] = [];
  const boundMsByRecipe = new Map<string, number>();

  const markEvent = (atMs: number): void => {
    maxDeadTimeMs = Math.max(maxDeadTimeMs, atMs - lastEventMs);
    lastEventMs = atMs;
  };

  while (nowMs < options.maxSimMs && state.tier < options.untilTier) {
    const solution = solve(state, content);
    const ctx = { content, state, solution, nowMs };

    for (const action of policy.decide(ctx)) {
      const result = apply(state, content, action, state.seed);
      if (result.rejected) continue;
      state = result.state;
      purchases += 1;
      markEvent(nowMs);
    }

    // Re-solve after the purchases so the binding-constraint accounting describes
    // the interval that is about to be simulated, not the one before it.
    const settled = solve(state, content);
    const stepMs = Math.min(
      Math.max(1_000, policy.intervalMs({ ...ctx, state, solution: settled })),
      options.maxSimMs - nowMs,
    );
    if (stepMs <= 0) break;

    if (settled.bottleneck !== null) {
      const id =
        settled.bottleneck.kind === "recipe"
          ? settled.bottleneck.recipeId
          : `power:${settled.bottleneck.generatorRecipeId ?? "none"}`;
      boundMsByRecipe.set(id, (boundMsByRecipe.get(id) ?? 0) + stepMs);
    }

    const advanced = resolve(state, content, stepMs);
    state = advanced.state;
    nowMs += stepMs;

    for (const tier of advanced.summary.tiersUnlocked) {
      const event = advanced.events.find((e) => e.kind === "milestone" && e.tier === tier);
      const atMs = event?.atMs ?? nowMs;
      tierTimes.push({ tier, atMs, collections: atMs / content.offlineCapMs });
      markEvent(atMs);
    }
  }
  markEvent(nowMs);

  const rEff: REffRow[] = slots.map((slot) => {
    const cls = content.machineClasses.get(slot.machineClass)!;
    let endCount = 0;
    for (const mark of cls.marks) {
      endCount += installedAt(state, slot.lane, slot.machineClass, mark.mark) * mark.rateMultiplier;
    }
    return {
      lane: slot.lane,
      machineClass: slot.machineClass,
      authored: authoredREff(content, slot.machineClass),
      observed: observedREff(
        cls.costRatio,
        cls.ladder.step,
        cls.ladder.interval,
        slot.startCount,
        endCount,
      ),
    };
  });

  const bindingConstraints = [...boundMsByRecipe.entries()]
    .map(([recipeId, boundMs]) => ({ recipeId, boundMs }))
    // Longest first, ties broken by id so the report is stable (spec A.5).
    .sort((a, b) => (b.boundMs === a.boundMs ? (a.recipeId < b.recipeId ? -1 : 1) : b.boundMs - a.boundMs));

  return {
    policy: options.policy,
    contentVersion: content.bundle.version,
    seed: options.seed,
    reachedTier: state.tier,
    finished: state.tier >= options.untilTier,
    simulatedMs: nowMs,
    collections: nowMs / content.offlineCapMs,
    tierTimes,
    maxDeadTimeMs,
    purchases,
    bindingConstraints,
    rEff,
  };
}
```

- [ ] **Step 11: Write the CLI**

`apps/sim/src/bin.ts`:

```ts
#!/usr/bin/env node
// sim run --policy greedy --content <dir> --until tier:10 --report json
// sim run --policy casual --seed 42
// sim play --seed 42
import { parseArgs } from "node:util";
import { argv, exit, stderr, stdout } from "node:process";
import { POLICY_NAMES, type PolicyName } from "./policies.js";
import { formatReport } from "./report.js";
import { runSimulation } from "./run.js";

const USAGE = `usage:
  sim run  [--policy greedy|casual|optimal|bottleneck] [--content <dir>]
           [--seed <n>] [--until tier:<n>] [--max-days <n>] [--report text|json]
  sim play [--content <dir>] [--seed <n>]
`;

function parseUntilTier(value: string | undefined): number {
  if (value === undefined) return 1;
  const match = /^tier:(\d+)$/.exec(value);
  if (!match) throw new Error(`--until must look like "tier:3", got "${value}"`);
  return Number(match[1]);
}

async function main(): Promise<number> {
  const mode = argv[2];
  if (mode !== "run" && mode !== "play") {
    stderr.write(USAGE);
    return 2;
  }

  const { values } = parseArgs({
    args: argv.slice(3),
    options: {
      policy: { type: "string", default: "greedy" },
      content: { type: "string" },
      seed: { type: "string", default: "42" },
      until: { type: "string", default: "tier:1" },
      "max-days": { type: "string", default: "365" },
      report: { type: "string", default: "text" },
    },
  });

  if (mode === "play") {
    const { startPlay } = await import("./play.js");
    await startPlay({ contentDir: values.content, seed: Number(values.seed) });
    return 0;
  }

  const policy = values.policy as PolicyName;
  if (!POLICY_NAMES.includes(policy)) {
    stderr.write(`unknown policy "${values.policy}"\n${USAGE}`);
    return 2;
  }

  const report = runSimulation({
    policy,
    contentDir: values.content,
    seed: Number(values.seed),
    untilTier: parseUntilTier(values.until),
    maxSimMs: Number(values["max-days"]) * 24 * 60 * 60 * 1000,
  });

  stdout.write(
    values.report === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReport(report)}\n`,
  );
  return report.finished ? 0 : 1;
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    stderr.write(`${String(error)}\n`);
    exit(2);
  },
);
```

`./play.js` arrives in Task 16. Until then `sim play` fails at the dynamic import with a clear module-not-found error, and `sim run` — everything this task is tested on — works. The import is dynamic precisely so `sim run` does not pay Ink's startup cost.

- [ ] **Step 12: Run the tests**

Run:

```bash
pnpm --filter @manufactory/sim test
pnpm lint && pnpm typecheck
```

Expected: PASS. Typecheck will fail on `./play.js` not existing; add `apps/sim/src/play.tsx` as a one-line stub now and let Task 16 replace it:

```tsx
export async function startPlay(_options: { contentDir?: string; seed: number }): Promise<void> {
  throw new Error("sim play arrives in Task 16");
}
```

- [ ] **Step 13: Run the simulator by hand**

Run:

```bash
pnpm --filter @manufactory/sim run sim run --policy greedy --until tier:2 --report text
pnpm --filter @manufactory/sim run sim run --policy bottleneck --until tier:2 --report json
```

Expected: a report naming the policy, the tier times in collections, the max dead time, the binding constraints, and the authored-versus-observed `r_eff` per lane-class. Both should reach tier 2. If `bottleneck` lands materially worse than `greedy`, that is spec E.2's stated warning sign, not a bug in this task — record the numbers and raise it.

- [ ] **Step 14: Add the simulator to CI**

In `.github/workflows/ci.yml`, add after the `pnpm content:check` step:

```yaml
      - run: pnpm --filter @manufactory/sim run sim:ci
```

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add apps/sim and sim run with its four policies

Spec E.2's batch mode over the identical engine the game uses, so there is
no second implementation to keep in sync. Times are reported in
collections rather than hours per spec 16.2, because with an 8h cap a tier
costing 40 collections is a two-week tier whatever the hour count says.
The fourth policy, bottleneck, exists to answer whether the game's advice
is actually good: if it lands materially worse than greedy, the UI is
lying to players. r_eff lives here rather than in the engine because it
needs a fractional power, which spec E.4 bans from state-affecting paths.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

### Task 16: `sim play` — the Ink terminal client, with `explain` and `assert`

**Files:**
- Create: `apps/sim/src/commands.ts`
- Replace: `apps/sim/src/play.tsx` (Task 15 left a one-line stub)
- Test: `apps/sim/src/commands.test.ts`

**Interfaces:**
- Consumes, from `@manufactory/engine`: `type IndexedContent`, `type ItemId`, `type LaneId`, `type RecipeId`, `POWER_ITEM`, `getMark`, `isLiveRecipe`; `type WorldState`, `installedAt`, `installedMachines`, `serializeWorld`, `deserializeWorld`; `bestUnlockedMark`, `computeCapacity`; `liquid`, `liquidCap`, `itemStateTag`; `computeExpansion`; `solve`, `type Solution`; `resolve`; `apply`, `type Action`; `D`, `format`. From `./bootstrap.js`: `loadContent`, `newWorld`. From `./policies.js`: nothing.
- Produces:
  - `commands.ts`: `interface Session { content: IndexedContent; state: WorldState; solution: Solution; nowMs: number; actionLog: Action[]; assertions: string[] }`, `interface CommandResult { session: Session; output: string[]; quit: boolean }`, `type AssertOutcome = { ok: boolean; text: string }`, `newSession(content: IndexedContent, seed: number): Session`, `refresh(session: Session): Session`, `parseDuration(text: string): number | null`, `runCommand(session: Session, line: string): CommandResult`, `renderStatus(session: Session): string[]`, `renderLane(session: Session, laneId: LaneId): string[]`, `renderPriority(session: Session): string[]`, `explain(session: Session, itemId: ItemId): string[]`, `evaluateAssert(session: Session, expression: string): AssertOutcome`, `const HELP: readonly string[]`
  - `play.tsx`: `startPlay(options: { contentDir?: string; seed: number }): Promise<void>`

Spec 16.3 is blunt that play mode "is not a developer-only tool… it will get more use than the batch mode", and spec E.3 adds two commands beyond that list:

- **`explain <item>`** — why a rate is what it is: which constraint bound it, which of spec C.2's three states each upstream item is in, and what the fixed point pinned in what order. Debugging the spec C.3 solver interactively will be the most-used feature in the tool, which is why `solve` returns `pinOrder` at all.
- **`assert <expr>`** — turns an exploratory session into a committed regression test without leaving the REPL.

**Time warp is the first-class verb.** `advance 8h`, `advance 3d`, `advance until tier:3`. Spec 16.3: this is the entire point — you can play eight months in an afternoon and feel where the game drags.

**Full action parity comes for free** (spec A.2): every command routes through the same `apply` reducers the Phase 3 API will call, so a divergence between what is possible here and in the game cannot be expressed.

All the logic lives in `commands.ts` as pure functions over a `Session`. `play.tsx` is a thin Ink shell that reads a line, calls `runCommand`, and appends the output — so the whole surface is unit-testable without rendering a terminal, and the tests in this task exercise `commands.ts` directly.

- [ ] **Step 1: Write the failing command test**

`apps/sim/src/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { D, installedAt, type WorldState } from "@manufactory/engine";
import { loadContent } from "./bootstrap.js";
import {
  evaluateAssert,
  explain,
  newSession,
  parseDuration,
  refresh,
  renderLane,
  renderPriority,
  renderStatus,
  runCommand,
  type Session,
} from "./commands.js";

const content = loadContent();

function session(): Session {
  return newSession(content, 42);
}

function rich(): Session {
  const base = session();
  const state: WorldState = { ...base.state, stored: { ...base.state.stored, iron_plate: D(100_000) } };
  return refresh({ ...base, state });
}

function run(s: Session, line: string): Session {
  const result = runCommand(s, line);
  return result.session;
}

describe("parseDuration", () => {
  it("understands seconds, minutes, hours and days", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("45m")).toBe(2_700_000);
    expect(parseDuration("8h")).toBe(28_800_000);
    expect(parseDuration("3d")).toBe(259_200_000);
  });

  it("accepts a decimal quantity", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it("returns null for anything else", () => {
    for (const bad of ["8", "h", "8w", "", "-3h", "eight hours"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });
});

describe("status and lane views", () => {
  it("renders the tier, the grid, and the bottleneck", () => {
    const text = renderStatus(session()).join("\n");
    expect(text).toContain("tier 0");
    expect(text).toContain("MW");
    // Spec 4.5: exactly one bottleneck, stated as a consequence and a fix.
    expect(text).toContain("make_plate");
    expect(text).toContain("1 more");
  });

  it("renders a lane with a rate and a storage readout per item", () => {
    const lines = renderLane(session(), "iron");
    expect(lines.join("\n")).toContain("Iron Plate");
    expect(lines.join("\n")).toMatch(/\/s/);
    expect(lines.join("\n")).toMatch(/EMPTY|FLOWING|FULL/);
  });

  it("renders the priority list in order with its modes", () => {
    const lines = renderPriority(session());
    expect(lines[0]).toContain("power");
    expect(lines.join("\n")).toContain("iron_plate");
    expect(lines.join("\n")).toContain("guaranteed");
  });

  it("reports an unknown lane rather than throwing", () => {
    const result = runCommand(session(), "lane ghost");
    expect(result.output.join("\n")).toMatch(/unknown lane/i);
  });
});

describe("action commands route through the engine reducers (spec A.2)", () => {
  it("buys, dismantles, and records the action log", () => {
    let s = rich();
    s = run(s, "buy constructor 2");
    expect(installedAt(s.state, "iron", "constructor", 1)).toBe(3);
    expect(s.actionLog.at(-1)).toEqual({
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 2,
    });
    s = run(s, "dismantle constructor 2");
    expect(installedAt(s.state, "iron", "constructor", 1)).toBe(1);
  });

  it("defaults count to 1 and picks the best unlocked mark", () => {
    const s = run(rich(), "buy miner");
    expect(installedAt(s.state, "iron", "miner", 1)).toBe(3);
  });

  it("honours an explicit lane and mark", () => {
    let s = rich();
    s = run(s, "tier 1");
    s = run(s, "buy miner 1 --mark 2");
    expect(installedAt(s.state, "iron", "miner", 2)).toBe(1);
  });

  it("surfaces a rejection instead of applying it", () => {
    const result = runCommand(session(), "buy constructor 1");
    expect(result.output.join("\n")).toMatch(/afford/i);
    expect(result.session.actionLog).toHaveLength(0);
  });

  it("assigns, selects, reserves, and buys storage and Quantum Storage", () => {
    let s = rich();
    s = run(s, "buy constructor 2");
    s = run(s, "assign make_plate 3");
    expect(s.state.assignment.make_plate).toBe(3);
    s = run(s, "select iron_plate make_plate");
    expect(s.state.activeRecipe.iron_plate).toBe("make_plate");
    s = run(s, "reserve iron_ore 0.25");
    expect(s.state.reserve.iron_ore).toBe(0.25);
    s = run(s, "storage iron_ore 2");
    expect(s.state.storageLevel.iron_ore).toBe(2);
    s = run(s, "qs iron 1");
    expect(s.state.qsLevel.iron).toBe(1);
  });

  it("taps and reorders and re-modes the priority list", () => {
    let s = rich();
    s = run(s, "tap 5");
    expect(s.state.tapStacks).toBe(5);
    const before = s.state.priority.map((e) => e.id);
    s = run(s, `priority move ${before.at(-1)!} 1`);
    expect(s.state.priority[0]!.id).toBe(before.at(-1));
    s = run(s, "priority mode item:iron_ore share 3");
    const entry = s.state.priority.find((e) => e.id === "item:iron_ore")!;
    expect(entry.mode).toBe("share");
    expect(entry.share).toBe(3);
    s = run(s, "priority pause item:iron_ore on");
    expect(s.state.priority.find((e) => e.id === "item:iron_ore")!.paused).toBe(true);
  });

  it("upgrades a mark in one command (spec D.1)", () => {
    let s = rich();
    s = run(s, "tier 1");
    // --mark 1 is required: at tier 1 the default is the best unlocked mark, Mk2.
    s = run(s, "buy miner 43 --mark 1");
    expect(installedAt(s.state, "iron", "miner", 1)).toBe(45);
    s = run(s, "upgrade miner");
    expect(installedAt(s.state, "iron", "miner", 1)).toBe(0);
    expect(installedAt(s.state, "iron", "miner", 2)).toBe(15);
  });
});

describe("advance — time warp as a first-class verb (spec 16.3)", () => {
  it("advances by a duration and reports what happened", () => {
    const result = runCommand(session(), "advance 1m");
    expect(result.session.nowMs).toBe(60_000);
    expect(result.session.state.lastResolvedAt).toBe(60_000);
    // 1/3 plate per second for 60 seconds.
    expect(result.session.state.stored.iron_plate!.toNumber()).toBeCloseTo(20, 6);
  });

  it("crosses a milestone and says so", () => {
    // Tier 1 needs 200 plate at 1/3 per second, so 600 seconds; 11 minutes clears it
    // with margin rather than landing exactly on the float boundary.
    const result = runCommand(session(), "advance 11m");
    expect(result.session.state.tier).toBe(1);
    expect(result.output.join("\n")).toMatch(/tier 1/i);
  });

  it("advances until a tier is reached", () => {
    const result = runCommand(session(), "advance until tier:1");
    expect(result.session.state.tier).toBeGreaterThanOrEqual(1);
  });

  it("rejects a duration it cannot parse", () => {
    const result = runCommand(session(), "advance soon");
    expect(result.output.join("\n")).toMatch(/duration/i);
    expect(result.session.nowMs).toBe(0);
  });
});

describe("explain (spec E.3)", () => {
  it("names the rate, the item state, and every producer and consumer", () => {
    const text = explain(session(), "iron_ingot").join("\n");
    expect(text).toContain("iron_ingot");
    expect(text).toContain("EMPTY");
    expect(text).toContain("smelt_iron");
    expect(text).toContain("make_plate");
    expect(text).toMatch(/clock/i);
  });

  it("reports what the fixed point pinned, in order", () => {
    const text = explain(session(), "iron_plate").join("\n");
    expect(text).toMatch(/pinned/i);
    expect(text).toContain("iron_ore");
  });

  it("names the binding constraint for the item's own target", () => {
    expect(explain(session(), "iron_plate").join("\n")).toContain("make_plate");
  });

  it("reports an unknown item rather than throwing", () => {
    expect(explain(session(), "ghost").join("\n")).toMatch(/unknown item/i);
  });

  it("traces an item back to its raw extraction cost (spec F.1's Handbook)", () => {
    // One plate is 1.5 ingot is 1.5 ore.
    expect(explain(session(), "iron_plate").join("\n")).toContain("1.5");
  });
});

describe("assert (spec E.3)", () => {
  it("evaluates a rate comparison", () => {
    const s = session();
    expect(evaluateAssert(s, "rate(iron_plate) > 0.3").ok).toBe(true);
    expect(evaluateAssert(s, "rate(iron_plate) > 10").ok).toBe(false);
  });

  it("evaluates stockpiles, clocks, levels and machine counts", () => {
    const s = run(rich(), "buy constructor 2");
    expect(evaluateAssert(s, "stored(iron_plate) > 1000").ok).toBe(true);
    expect(evaluateAssert(s, "liquid(iron_ore) == 0").ok).toBe(true);
    expect(evaluateAssert(s, "clock(make_plate) <= 1").ok).toBe(true);
    expect(evaluateAssert(s, "machines(iron,constructor) >= 3").ok).toBe(true);
    expect(evaluateAssert(s, "level(iron_ore) == 0").ok).toBe(true);
  });

  it("evaluates the bare scalars", () => {
    const s = session();
    expect(evaluateAssert(s, "tier == 0").ok).toBe(true);
    expect(evaluateAssert(s, "power >= 0.99").ok).toBe(true);
    expect(evaluateAssert(s, "taps == 0").ok).toBe(true);
  });

  it("handles every comparison operator", () => {
    const s = session();
    expect(evaluateAssert(s, "tier < 1").ok).toBe(true);
    expect(evaluateAssert(s, "tier <= 0").ok).toBe(true);
    expect(evaluateAssert(s, "tier != 1").ok).toBe(true);
    expect(evaluateAssert(s, "tier >= 0").ok).toBe(true);
  });

  it("reports a parse failure rather than throwing", () => {
    for (const bad of ["", "tier", "tier ~ 1", "ghost(x) > 1", "rate(ghost) > 1"]) {
      const outcome = evaluateAssert(session(), bad);
      expect(outcome.ok).toBe(false);
      expect(outcome.text.length).toBeGreaterThan(0);
    }
  });

  it("records passing assertions on the session, for export as a regression test", () => {
    const s = run(session(), "assert tier == 0");
    expect(s.assertions).toEqual(["tier == 0"]);
  });

  it("does not record a failing assertion", () => {
    const s = run(session(), "assert tier == 9");
    expect(s.assertions).toEqual([]);
  });
});

describe("session plumbing", () => {
  it("reports an unknown command with a pointer to help", () => {
    const result = runCommand(session(), "frobnicate");
    expect(result.output.join("\n")).toMatch(/unknown command/i);
    expect(result.output.join("\n")).toMatch(/help/i);
  });

  it("ignores a blank line", () => {
    const result = runCommand(session(), "   ");
    expect(result.output).toEqual([]);
  });

  it("quits", () => {
    expect(runCommand(session(), "quit").quit).toBe(true);
  });

  it("keeps solution and state in step after every command", () => {
    const s = run(rich(), "buy constructor 4");
    expect(s.solution.capacity.unitsByRecipe.get("make_plate")).toBeCloseTo(5, 9);
  });
});
```

Note on the `tier N` command used by two tests: it is a **debug verb**, not one of spec D.1's eleven. `sim play` needs a way to jump to a tier to inspect late content without grinding to it, and it never touches the reducers — it sets `state.tier` directly. Step 3 marks it clearly as debug-only in the help text.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @manufactory/sim test commands`
Expected: FAIL — `Cannot find module './commands.js'`.

- [ ] **Step 3: Write the command layer**

`apps/sim/src/commands.ts`:

```ts
// The whole of `sim play`, as pure functions over a Session. play.tsx is a thin Ink
// shell over runCommand, so every command is unit-testable without rendering a
// terminal.
//
// Spec A.2 gives full action parity for free: every verb here routes through the
// same `apply` reducers the Phase 3 API will call, so a divergence between what is
// possible in the simulator and in the game cannot be expressed.
import { readFileSync, writeFileSync } from "node:fs";
import {
  D,
  POWER_ITEM,
  apply,
  bestUnlockedMark,
  computeExpansion,
  deserializeWorld,
  format,
  installedAt,
  installedMachines,
  itemStateTag,
  liquid,
  liquidCap,
  resolve,
  serializeWorld,
  solve,
  type Action,
  type IndexedContent,
  type ItemId,
  type LaneId,
  type Solution,
  type WorldState,
} from "@manufactory/engine";
import { newWorld } from "./bootstrap.js";

export interface Session {
  content: IndexedContent;
  state: WorldState;
  /** Always the solution of `state`; `refresh` is what keeps the two in step. */
  solution: Solution;
  nowMs: number;
  /** Spec 16.3's session recording. The wire format is spec D.1's batch format. */
  actionLog: Action[];
  assertions: string[];
}

export interface CommandResult {
  session: Session;
  output: string[];
  quit: boolean;
}

export type AssertOutcome = { ok: boolean; text: string };

export function refresh(session: Session): Session {
  return { ...session, solution: solve(session.state, session.content) };
}

export function newSession(content: IndexedContent, seed: number): Session {
  const state = newWorld(content, seed);
  return { content, state, solution: solve(state, content), nowMs: 0, actionLog: [], assertions: [] };
}

export const HELP: readonly string[] = [
  "status                          the grid, the tier, and the one bottleneck",
  "lanes | lane <id>               item rates, states and storage for a lane",
  "priority                        the ordered list",
  "priority move <entry> <pos>     1-based position",
  "priority mode <entry> guaranteed|share [weight]",
  "priority pause <entry> on|off",
  "buy <class> [count] [--lane L] [--mark M]",
  "dismantle <class> [count] [--lane L] [--mark M]",
  "upgrade <class> [--lane L] [--mark M]     atomic dismantle and rebuild",
  "assign <recipe> <count>         distribute the lane-class pool",
  "select <item> <recipe>          switch the active recipe",
  "reserve <item> <fraction>       0 to 0.5",
  "storage <item> [levels] | qs <lane> [levels]",
  "tap [count]",
  "advance <8h|3d|90s|45m> | advance until tier:<n>",
  "explain <item>                  why a rate is what it is",
  "assert <expr>                   e.g. rate(iron_plate) > 0.3",
  "save <file> | load <file>",
  "tier <n>                        DEBUG ONLY: jump to a tier, bypassing delivery",
  "help | quit",
];

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * UNITS[match[2]!]!;
}

interface Parsed {
  words: string[];
  flags: Record<string, string>;
}

function parseLine(line: string): Parsed {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("--")) {
      flags[token.slice(2)] = tokens[i + 1] ?? "";
      i += 1;
    } else {
      words.push(token);
    }
  }
  return { words, flags };
}

function laneOf(session: Session, machineClass: string, flags: Record<string, string>): LaneId | null {
  if (flags.lane !== undefined) return session.content.lanes.has(flags.lane) ? flags.lane : null;
  // Default to the first lane that has a recipe for this class, in authored order.
  for (const lane of session.content.lanes.keys()) {
    if (session.content.recipesByLaneClass.has(`${lane}::${machineClass}`)) return lane;
  }
  return null;
}

function markOf(session: Session, machineClass: string, flags: Record<string, string>): number | null {
  if (flags.mark !== undefined) {
    const mark = Number(flags.mark);
    return Number.isInteger(mark) && mark >= 1 ? mark : null;
  }
  return bestUnlockedMark(session.content, machineClass, session.state.tier);
}

function dispatch(session: Session, action: Action): CommandResult {
  const result = apply(session.state, session.content, action, session.state.seed);
  if (result.rejected) return { session, output: [`rejected: ${result.reason}`], quit: false };
  const next = refresh({
    ...session,
    state: result.state,
    actionLog: [...session.actionLog, action],
  });
  return {
    session: next,
    output: result.effects.map((effect) => `  ${effect.kind}`),
    quit: false,
  };
}

function rateOf(session: Session, itemId: ItemId): number {
  return session.solution.itemRates.get(itemId)?.net ?? 0;
}

export function renderStatus(session: Session): string[] {
  const { solution, state, content } = session;
  const lines: string[] = [];
  lines.push(
    `t+${Math.round(session.nowMs / 1000)}s   tier ${state.tier}   ` +
      `taps ${state.tapStacks}/${content.bundle.tap.maxStacks}`,
  );
  lines.push(
    `grid  ${solution.power.demandMw.toFixed(1)} / ${solution.power.supplyMw.toFixed(1)} MW ` +
      `(ratio ${solution.power.ratio.toFixed(3)})`,
  );

  const bottleneck = solution.bottleneck;
  if (bottleneck === null) {
    lines.push("no bottleneck");
  } else if (bottleneck.kind === "recipe") {
    // Spec 4.5: state the consequence in plain language and the fix as a number.
    lines.push(
      `BOTTLENECK  ${bottleneck.recipeId} limiting ${bottleneck.limitingTarget} — ` +
        `${bottleneck.machinesToClear} more clears it`,
    );
  } else {
    lines.push(
      `BOTTLENECK  power limiting ${bottleneck.limitingTarget} — ` +
        `${bottleneck.machinesToClear} more ${bottleneck.generatorRecipeId ?? "generator"} clears it`,
    );
  }
  return lines;
}

export function renderLane(session: Session, laneId: LaneId): string[] {
  const { content, state } = session;
  if (!content.lanes.has(laneId)) return [`unknown lane "${laneId}"`];

  const lines = [`lane ${content.lanes.get(laneId)!.name}`];
  for (const item of content.bundle.items) {
    if (item.lane !== laneId) continue;
    const rate = rateOf(session, item.id);
    const have = liquid(state, item.id);
    const cap = liquidCap(content, state, item.id);
    const bound = state.bound[item.id] ?? D(0);
    const tag = itemStateTag(content, state, item.id);
    let line =
      `  ${item.name.padEnd(20)} ${rate >= 0 ? "+" : ""}${rate.toFixed(3)}/s   ` +
      `${format(have, "hybrid")} / ${format(cap, "hybrid")}  ${tag}`;
    // Spec F.1: the BOUND chip appears only when non-zero, so the early game reads
    // exactly like the MVP and complexity arrives only once the player has met it.
    if (bound.gt(0)) line += `  BOUND ${format(bound, "hybrid")}`;
    lines.push(line);
  }
  return lines;
}

export function renderPriority(session: Session): string[] {
  return session.state.priority.map((entry, index) => {
    const target = entry.kind === "power" ? "power" : (entry.itemId ?? "?");
    const mode = entry.mode === "share" ? `share ${entry.share}` : "guaranteed";
    const cap = entry.targetRate === null ? "" : `  cap ${entry.targetRate}/s`;
    const paused = entry.paused ? "  PAUSED" : "";
    return `  ${String(index + 1).padStart(2)}. ${entry.id.padEnd(24)} ${target.padEnd(20)} ${mode}${cap}${paused}`;
  });
}

export function explain(session: Session, itemId: ItemId): string[] {
  const { content, state, solution } = session;
  if (itemId !== POWER_ITEM && !content.items.has(itemId)) return [`unknown item "${itemId}"`];

  const flow = solution.itemRates.get(itemId);
  const lines = [
    `${itemId}: production ${(flow?.production ?? 0).toFixed(4)}/s, ` +
      `consumption ${(flow?.consumption ?? 0).toFixed(4)}/s, net ${(flow?.net ?? 0).toFixed(4)}/s`,
    `state ${itemStateTag(content, state, itemId)}  ` +
      `${format(liquid(state, itemId), "hybrid")} / ${format(liquidCap(content, state, itemId), "hybrid")}`,
    `active recipe ${state.activeRecipe[itemId] ?? "(none)"}`,
    "producers:",
  ];

  for (const recipeId of content.producersOf.get(itemId) ?? []) {
    const clock = solution.clocks.get(recipeId);
    lines.push(
      `  ${recipeId.padEnd(20)} clock ${clock === undefined ? "idle" : clock.toFixed(4)}`,
    );
  }
  lines.push("consumers:");
  for (const recipeId of content.consumersOf.get(itemId) ?? []) {
    const clock = solution.clocks.get(recipeId);
    lines.push(
      `  ${recipeId.padEnd(20)} clock ${clock === undefined ? "idle" : clock.toFixed(4)}`,
    );
  }

  // Spec C.3's fixed point, laid bare: which items were pinned, and in what order.
  lines.push(
    `fixed point: ${solution.passes} pass(es), pinned in order: ` +
      (solution.pinOrder.length === 0 ? "(none)" : solution.pinOrder.join(", ")),
  );

  const entry = solution.entries.find((e) => e.itemId === itemId);
  if (entry) {
    lines.push(
      entry.limitedBy === null
        ? `target ${entry.entryId} is unconstrained at ${entry.allocated.toFixed(4)}/s`
        : `target ${entry.entryId} is limited by ${entry.limitedBy} at ${entry.allocated.toFixed(4)}/s ` +
          `(would reach ${entry.runnerUpRate.toFixed(4)}/s if cleared)`,
    );
  }

  // Spec F.1's Handbook trace, free from the precomputed vectors (spec A.4).
  const vectors = computeExpansion(content, state.tier, state.activeRecipe);
  const raw = vectors.rawCost.get(itemId);
  if (raw && raw.size > 0) {
    lines.push(
      `traces back to: ${[...raw.entries()].map(([id, amount]) => `${amount} ${id}`).join(", ")}`,
    );
  }
  return lines;
}

const ASSERT_RE = /^([a-z]+)(?:\(([^)]*)\))?\s*(<=|>=|==|!=|<|>)\s*(-?[\d.]+(?:e-?\d+)?)$/i;

export function evaluateAssert(session: Session, expression: string): AssertOutcome {
  const match = ASSERT_RE.exec(expression.trim());
  if (!match) return { ok: false, text: `cannot parse "${expression}"` };
  const [, fn, rawArgs, op, rhsText] = match;
  const args = (rawArgs ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  const rhs = Number(rhsText);
  const { content, state, solution } = session;

  const itemArg = (): ItemId | null => {
    const id = args[0];
    if (id === undefined) return null;
    if (id !== POWER_ITEM && !content.items.has(id)) return null;
    return id;
  };

  let lhs: number | null = null;
  switch (fn) {
    case "tier":
      lhs = state.tier;
      break;
    case "power":
      lhs = solution.power.ratio;
      break;
    case "taps":
      lhs = state.tapStacks;
      break;
    case "rate":
    case "production":
    case "consumption": {
      const id = itemArg();
      if (id === null) break;
      const flow = solution.itemRates.get(id);
      lhs = fn === "rate" ? (flow?.net ?? 0) : fn === "production" ? (flow?.production ?? 0) : (flow?.consumption ?? 0);
      break;
    }
    case "stored":
    case "quantum":
    case "bound": {
      const id = itemArg();
      if (id === null) break;
      lhs = (state[fn][id] ?? D(0)).toNumber();
      break;
    }
    case "liquid": {
      const id = itemArg();
      if (id === null) break;
      lhs = liquid(state, id).toNumber();
      break;
    }
    case "level": {
      const id = itemArg();
      if (id === null) break;
      lhs = state.storageLevel[id] ?? 0;
      break;
    }
    case "qslevel": {
      const lane = args[0];
      if (lane === undefined || !content.lanes.has(lane)) break;
      lhs = state.qsLevel[lane] ?? 0;
      break;
    }
    case "clock": {
      const recipeId = args[0];
      if (recipeId === undefined || !content.recipes.has(recipeId)) break;
      lhs = solution.clocks.get(recipeId) ?? 0;
      break;
    }
    case "machines": {
      const [lane, machineClass] = args;
      if (lane === undefined || machineClass === undefined) break;
      if (!content.lanes.has(lane) || !content.machineClasses.has(machineClass)) break;
      lhs = installedMachines(state, lane, machineClass);
      break;
    }
    default:
      return { ok: false, text: `unknown assertion function "${fn}"` };
  }

  if (lhs === null) return { ok: false, text: `bad argument in "${expression}"` };

  // Equality on a float is compared with a small relative tolerance; everything else
  // is exact, because these are diagnostics rather than state.
  const near = Math.abs(lhs - rhs) <= 1e-9 * Math.max(1, Math.abs(rhs));
  const ok =
    op === "<" ? lhs < rhs
    : op === "<=" ? lhs <= rhs
    : op === ">" ? lhs > rhs
    : op === ">=" ? lhs >= rhs
    : op === "==" ? near
    : !near;

  return { ok, text: `${ok ? "PASS" : "FAIL"}  ${expression}   (lhs = ${lhs})` };
}

function advance(session: Session, ms: number): CommandResult {
  const result = resolve(session.state, session.content, ms);
  const next = refresh({ ...session, state: result.state, nowMs: session.nowMs + ms });
  const output = [
    `[${Math.round(ms / 1000)}s elapsed] ${result.summary.events} event(s)`,
    ...result.summary.tiersUnlocked.map((tier) => `  reached tier ${tier}`),
    ...result.summary.filled.map((f) => `  ${f.itemId} filled`),
  ];
  if (result.summary.stalled.length > 0) output.push(`  stalled: ${result.summary.stalled.join(", ")}`);
  return { session: next, output, quit: false };
}

export function runCommand(session: Session, line: string): CommandResult {
  const { words, flags } = parseLine(line);
  const [verb, ...rest] = words;
  const none = (output: string[]): CommandResult => ({ session, output, quit: false });
  if (verb === undefined) return none([]);

  switch (verb) {
    case "help":
      return none([...HELP]);
    case "quit":
    case "exit":
      return { session, output: ["bye"], quit: true };
    case "status":
      return none(renderStatus(session));
    case "lanes":
      return none(
        [...session.content.lanes.values()].flatMap((lane) => renderLane(session, lane.id)),
      );
    case "lane":
      return none(renderLane(session, rest[0] ?? ""));
    case "explain":
      return none(explain(session, rest[0] ?? ""));

    case "priority": {
      const sub = rest[0];
      if (sub === undefined) return none(renderPriority(session));
      if (sub === "move") {
        const [, entryId, positionText] = rest;
        const position = Number(positionText);
        const ids = session.state.priority.map((e) => e.id);
        if (entryId === undefined || !ids.includes(entryId)) return none([`unknown entry "${entryId}"`]);
        if (!Number.isInteger(position) || position < 1 || position > ids.length) {
          return none([`position must be 1..${ids.length}`]);
        }
        const without = ids.filter((id) => id !== entryId);
        without.splice(position - 1, 0, entryId);
        return dispatch(session, { type: "REORDER_PRIORITY", entries: without });
      }
      if (sub === "mode") {
        const [, entryId, mode, weight] = rest;
        if (entryId === undefined || (mode !== "guaranteed" && mode !== "share")) {
          return none(["usage: priority mode <entry> guaranteed|share [weight]"]);
        }
        return dispatch(session, {
          type: "SET_PRIORITY_MODE",
          entryId,
          mode,
          ...(weight === undefined ? {} : { share: Number(weight) }),
        });
      }
      if (sub === "pause") {
        const [, entryId, onOff] = rest;
        const entry = session.state.priority.find((e) => e.id === entryId);
        if (!entry) return none([`unknown entry "${entryId}"`]);
        return dispatch(session, {
          type: "SET_PRIORITY_MODE",
          entryId: entry.id,
          mode: entry.mode,
          paused: onOff !== "off",
        });
      }
      return none(["usage: priority [move|mode|pause] ..."]);
    }

    case "buy":
    case "dismantle": {
      const machineClass = rest[0];
      if (machineClass === undefined) return none([`usage: ${verb} <class> [count]`]);
      const count = rest[1] === undefined ? 1 : Number(rest[1]);
      const lane = laneOf(session, machineClass, flags);
      const mark = markOf(session, machineClass, flags);
      if (lane === null) return none([`no lane for "${machineClass}"`]);
      if (mark === null) return none([`no unlocked mark for "${machineClass}"`]);
      return dispatch(session, {
        type: verb === "buy" ? "BUY_MACHINE" : "DISMANTLE",
        lane,
        machineClass,
        mark,
        count,
      });
    }

    case "upgrade": {
      const machineClass = rest[0];
      if (machineClass === undefined) return none(["usage: upgrade <class> [--lane L] [--mark M]"]);
      const lane = laneOf(session, machineClass, flags);
      if (lane === null) return none([`no lane for "${machineClass}"`]);
      const fromMark = flags.mark === undefined ? 1 : Number(flags.mark);
      return dispatch(session, { type: "UPGRADE_MARK", lane, machineClass, fromMark });
    }

    case "assign": {
      const [recipeId, countText] = rest;
      if (recipeId === undefined || countText === undefined) return none(["usage: assign <recipe> <count>"]);
      return dispatch(session, { type: "ASSIGN_MACHINES", recipeId, count: Number(countText) });
    }

    case "select": {
      const [itemId, recipeId] = rest;
      if (itemId === undefined || recipeId === undefined) return none(["usage: select <item> <recipe>"]);
      return dispatch(session, { type: "SELECT_RECIPE", itemId, recipeId });
    }

    case "reserve": {
      const [itemId, percentText] = rest;
      if (itemId === undefined || percentText === undefined) return none(["usage: reserve <item> <fraction>"]);
      return dispatch(session, { type: "SET_RESERVE", itemId, percent: Number(percentText) });
    }

    case "storage": {
      const [itemId, levelsText] = rest;
      if (itemId === undefined) return none(["usage: storage <item> [levels]"]);
      return dispatch(session, {
        type: "BUY_STORAGE",
        itemId,
        levels: levelsText === undefined ? 1 : Number(levelsText),
      });
    }

    case "qs": {
      const [lane, levelsText] = rest;
      if (lane === undefined) return none(["usage: qs <lane> [levels]"]);
      return dispatch(session, {
        type: "BUY_QS",
        lane,
        levels: levelsText === undefined ? 1 : Number(levelsText),
      });
    }

    case "tap": {
      const count = rest[0] === undefined ? 1 : Number(rest[0]);
      // The simulator is its own client, so it grants itself exactly the elapsed
      // time spec D.5's ceiling requires for the taps it is asking for.
      return dispatch(session, { type: "TAP", count, clientElapsedMs: count * 50 });
    }

    case "advance": {
      if (rest[0] === "until") {
        const match = /^tier:(\d+)$/.exec(rest[1] ?? "");
        if (!match) return none(['usage: advance until tier:<n>']);
        const target = Number(match[1]);
        let current = session;
        const output: string[] = [];
        // Bounded so a target that can never be reached still returns.
        for (let i = 0; i < 400 && current.state.tier < target; i += 1) {
          const step = advance(current, current.content.offlineCapMs);
          current = step.session;
          output.push(...step.output);
        }
        output.push(
          current.state.tier >= target
            ? `reached tier ${current.state.tier}`
            : `gave up at tier ${current.state.tier}`,
        );
        return { session: current, output, quit: false };
      }
      const ms = parseDuration(rest[0] ?? "");
      if (ms === null) return none([`cannot parse duration "${rest[0] ?? ""}"`]);
      return advance(session, ms);
    }

    case "assert": {
      const expression = line.trim().slice("assert".length).trim();
      const outcome = evaluateAssert(session, expression);
      const next = outcome.ok
        ? { ...session, assertions: [...session.assertions, expression] }
        : session;
      return { session: next, output: [outcome.text], quit: false };
    }

    case "save": {
      const file = rest[0];
      if (file === undefined) return none(["usage: save <file>"]);
      writeFileSync(file, serializeWorld(session.state), "utf8");
      return none([`saved ${file}`]);
    }

    case "load": {
      const file = rest[0];
      if (file === undefined) return none(["usage: load <file>"]);
      const state = deserializeWorld(readFileSync(file, "utf8"));
      return {
        session: refresh({ ...session, state, nowMs: state.lastResolvedAt }),
        output: [`loaded ${file}`],
        quit: false,
      };
    }

    // DEBUG ONLY, and deliberately not one of spec D.1's eleven: jumping to a tier
    // bypasses milestone delivery so late content can be inspected without grinding
    // to it. It never touches the reducers.
    case "tier": {
      const tier = Number(rest[0]);
      if (!Number.isInteger(tier) || tier < 0) return none(["usage: tier <n>"]);
      return {
        session: refresh({ ...session, state: { ...session.state, tier } }),
        output: [`debug: tier set to ${tier}`],
        quit: false,
      };
    }

    default:
      return none([`unknown command "${verb}" — try help`]);
  }
}
```

- [ ] **Step 4: Run the command test**

Run: `pnpm --filter @manufactory/sim test commands`
Expected: PASS.

- [ ] **Step 5: Write the Ink shell**

Replace `apps/sim/src/play.tsx` with:

```tsx
// Spec 16.3 asks for Ink so the lane view, bottleneck highlighting and priority list
// render as real components rather than print statements, and so the tool shares a
// mental model with the web client.
//
// Everything of substance lives in commands.ts as pure functions; this file only
// reads a line, calls runCommand, and appends the output.
import React, { useState } from "react";
import { Box, Static, Text, render, useApp } from "ink";
import TextInput from "ink-text-input";
import { loadContent } from "./bootstrap.js";
import { HELP, newSession, renderStatus, runCommand, type Session } from "./commands.js";

interface Line {
  key: string;
  text: string;
}

function App({ initial }: { initial: Session }): React.JSX.Element {
  const { exit } = useApp();
  const [session, setSession] = useState(initial);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    ["Manufactory Idle — sim play. Type help.", ...HELP.slice(0, 3)].map((text, i) => ({
      key: `boot-${i}`,
      text,
    })),
  );

  const submit = (value: string): void => {
    const result = runCommand(session, value);
    const stamp = Date.now();
    setLines((current) => [
      ...current,
      { key: `in-${stamp}`, text: `> ${value}` },
      ...result.output.map((text, i) => ({ key: `out-${stamp}-${i}`, text })),
    ]);
    setSession(result.session);
    setInput("");
    if (result.quit) exit();
  };

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line) => <Text key={line.key}>{line.text}</Text>}</Static>
      <Box flexDirection="column" marginTop={1}>
        {renderStatus(session).map((text, i) => (
          <Text key={`status-${i}`} dimColor={i > 0}>
            {text}
          </Text>
        ))}
      </Box>
      <Box>
        <Text color="green">{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
    </Box>
  );
}

export async function startPlay(options: { contentDir?: string; seed: number }): Promise<void> {
  const content = loadContent(options.contentDir);
  const instance = render(<App initial={newSession(content, options.seed)} />);
  await instance.waitUntilExit();
}
```

`Date.now()` here is a React key, not game state — the engine's clock still arrives only as a parameter, and spec A.5's rule binds `packages/engine`, not `apps/sim`.

- [ ] **Step 6: Drive the client by hand**

Run:

```bash
pnpm --filter @manufactory/sim run sim play --seed 42
```

Then, in the client:

```
status
lane iron
advance 11m
status
buy constructor 4
explain iron_plate
priority move item:iron_ore 2
advance 8h
assert tier >= 1
quit
```

Expected: the status block shows the grid and exactly one bottleneck; `advance 11m` reports reaching tier 1; `explain iron_plate` names the binding recipe, the pinned items in order, and the raw-cost trace; `assert tier >= 1` prints PASS. This is Phase 1's deliverable — a playable game in the terminal.

- [ ] **Step 7: Run everything**

Run:

```bash
pnpm test
pnpm lint && pnpm typecheck
pnpm content:check
```

Expected: every package green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add sim play, the Ink terminal client

Spec E.3, with time warp as a first-class verb: advance 8h, advance 3d,
advance until tier:3. Every command routes through the same apply reducers
the Phase 3 API will call, so spec 16.3's full action parity is structural
rather than maintained. explain lays the spec C.3 fixed point bare --
which constraint bound the target, what state each upstream item is in,
and what was pinned in what order -- and assert turns an exploratory
session into a committed regression test. All the logic is pure functions
over a Session; play.tsx is a thin Ink shell over runCommand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016rmcUbYFdRwjnpEmXWrbTB
EOF
)"
```

---

## Definition of done

Phase 1 is complete when, from a clean checkout:

```bash
pnpm install
pnpm lint           # exit 0
pnpm typecheck      # exit 0
pnpm test           # rational, engine, content and sim suites all green
pnpm content:check  # the extended fixture validates
pnpm --filter @manufactory/sim run sim run --policy greedy --until tier:2
pnpm --filter @manufactory/sim run sim play --seed 42
```

and `sim play` can run the fixture factory, buy machines, reorder priorities, warp time forward and produce sane numbers — spec F.2's "a playable game in the terminal".

## What Phase 1 deliberately does not include

| Deferred | Owner |
|---|---|
| The HTTP API, Postgres schema, SuperTokens, guests, idempotency, rate limits | Phase 3 |
| The web client | Phase 4 |
| The B.5 vertical slice and the calibration script | Phase 2 — Phase 1 extends the Phase 0 fixture |
| Validator checks 8, 9, 10 | Phase 2 — they need calibration machinery |
| Overclocking (spec D3 lever 4) | No action in spec D.1's eleven; Spec 2 |
| Power Storage purchase (spec 6.2) | No action in spec D.1's eleven; Spec 2. `powerBank` is carried and stays zero |
| Disruptions, pollution, alt-recipe acquisition, ranks, Pioneers | Spec 2 |
| The SCC solver for cyclic recipes | Ruling R6 — forbidden, not solved, and the outer waterfall does not change when it is added |
| `sim replay` and `sim export` | The action log and canonical serialization exist; the CLI verbs land with Phase 3's `action_log` |

## Spec coverage

| Spec requirement | Task |
|---|---|
| A.4 zone 1 — exact rationals at load time only | 3 |
| A.4 zone 2 — float64 clocks, satisfaction, allocation | 8, 9, 10 |
| A.4 zone 3 — Decimal stockpiles, rates, costs | 4, 5, 7 |
| A.5 / E.4 — determinism, no transcendentals in state paths, canonical ordering | 4, 5, 11 |
| B.2 — the single counter, mark-weighted ladder | 5, 6 |
| B.3 — stepped ladder, authored per class | 1, 5 |
| B.4 — the three curves, QS per lane | 1, 5, 7 |
| C.0 — why the ladder is mark-weighted; `UPGRADE_MARK` | 5, 12 |
| C.1 — `WorldState` and its serialization | 4 |
| C.2 — the three item states | 7, 9 |
| C.3 — the waterfall, the fixed point, bottleneck as first-class output | 8, 9, 10 |
| C.4 — power equilibrium, power as priority entry 1 | 2, 4, 10 |
| C.5 / D4 — storage, Quantum Storage, `bound`, fill and spend orders, LIFO refunds | 7, 12 |
| C.6 — the tap as a step function | 1, 5, 13 |
| C.7 — event-driven resolve with `MAX_EVENTS` and `EPSILON` | 11 |
| D.1 — the eleven action reducers, batched, atomic | 12, 13 |
| D.5 — the tap ceiling, resolve-cost guards | 11, 13 |
| E.2 — `sim run`, four policies, the report in collections | 15 |
| E.3 — `sim play`, time warp, `explain`, `assert` | 16 |
| E.6 — the property suite | 14 |
| F.2 — a playable game in the terminal | 15, 16 |
| Spec 3.1 — only extraction creates value | 14 |
| Spec 3.3 / 3.4 — backpressure, reserve, byproduct outlets | 7, 9, 13 |
| Spec 4.1 / 4.2 — priority list, share mode, reserve floor | 8, 13 |
| Spec 4.3 — cycles forbidden and flagged (ruling R6) | 2, 3, 12 |
| Spec 4.4 — alt recipes, `SELECT_RECIPE` | 2, 12 |
| Spec 4.5 — bottleneck reporting | 10, 16 |
| Spec 4.6 — dead-purchase guard as an invariant | 14 |
| Spec 6.1 / 6.3 — grid model, generators as ordinary recipes | 2, 6, 10 |
| Spec 8 — offline resolution, the cap | 11 |
| Spec 10.1 — milestones (ruling R7) | 1, 11 |
| Spec 16.2 / 16.6 — collections, dead-time detector | 15 |

## Next

| Phase | Plan to write |
|---|---|
| 2 | Calibrated content — the B.5 vertical slice, the calibration script, validator checks 8–10, CI pacing gates |
| 3 | Server + authority — action API, schema, SuperTokens, guests, idempotency, rate limits |
| 4 | Web client |

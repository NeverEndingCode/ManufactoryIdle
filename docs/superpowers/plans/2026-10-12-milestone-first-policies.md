# Milestone-First Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `greedy` and `optimal` keep the next milestone's items at the top of the priority list. The unused `pacing.storageBindingCadence` knob is removed. Pins are re-measured, with no recalibration.

**Architecture:** One exported helper in `apps/sim/src/policies.ts` returns a `REORDER_PRIORITY` action when the list is out of milestone-first order. `greedy` prepends it; `optimal` prepends it and runs its lookahead on the reordered state. The knob removal spans the content schema, the engine type, three bundles and the test fixtures. The schema is `.strict()`, so all of them change in one commit.

**Tech Stack:** TypeScript ESM, vitest, zod, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-12-milestone-first-policies-design.md`

## Global Constraints

- Work in `.claude/worktrees/phase-1-engine`, branch `policy-milestone-reorder` (cut from `origin/main` at `af8b35a`). Never in the top-level checkout.
- Never run `pnpm format`. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another, never concurrently, and never while a gate runs.
- `casual` and `bottleneck` must never emit `REORDER_PRIORITY` (spec E.2).
- `derived.yaml` is not regenerated (spec: "Pins, not recalibration").
- `bundles/calibration-fixture/` may change ONLY by removing `storageBindingCadence` (its README's rule: a schema-forced edit, no measured premise reads it).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **The power entry's position.** It must stay first even if a player moved it. The helper takes every `kind === "power"` entry first, whatever its current index. Covered by Task 1 test 1.
- **An entry outside `start.priority`** (`reserve:` entries are injected by `effectivePriority`, never stored in `state.priority`, so none exist today). It sorts last, keeping its relative order. No test: it is unreachable today. The code comment says so.
- **A milestone item with no priority entry.** It is filtered out (`current.includes`), so `REORDER_PRIORITY` always receives a permutation of the existing ids. Covered by the engine accepting every emitted action (Task 1 test 5).
- **Determinism.** The helper is pure over `ctx`; covered by the gate's determinism rerun (Task 2).
- **`casual`/`bottleneck` pins moving.** Their behaviour is unchanged, so a move is a regression to investigate, not a pin to update (Task 2 Step 5).

---

### Task 1: The milestone-first habit for `greedy` and `optimal`

**Files:**
- Modify: `apps/sim/src/policies.ts` (new export before `const greedy`, plus the `greedy` and `optimal` `decide` bodies)
- Test: `apps/sim/src/policies.test.ts` (append one `describe`)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§E.2 table and a note)

**Interfaces:**
- Produces: `export function milestoneFirstReorder(ctx: PolicyContext): Action[]`. It returns `[]` or one `{ type: "REORDER_PRIORITY", entries: string[] }`.

- [ ] **Step 1: Write the failing tests**

Add `milestoneFirstReorder` to the import list from `./policies.js` in `apps/sim/src/policies.test.ts`, then append:

```ts
// Spec 2026-10-12 (milestone-first policies). The fixture's start priority is
// iron_plate, iron_ingot, iron_ore, plastic, fuel, heavy_oil_residue, crude_oil, and
// its tier-3 milestone needs iron_plate then plastic.
describe("milestoneFirstReorder", () => {
  const AUTHORED = [
    "item:iron_plate",
    "item:iron_ingot",
    "item:iron_ore",
    "item:plastic",
    "item:fuel",
    "item:heavy_oil_residue",
    "item:crude_oil",
  ];
  const TIER3_FIRST = [
    "item:iron_plate",
    "item:plastic",
    "item:iron_ingot",
    "item:iron_ore",
    "item:fuel",
    "item:heavy_oil_residue",
    "item:crude_oil",
  ];
  /** The fixture world's priority, reordered to `ids` (power wherever `powerAt` says). */
  function ordered(ids: string[], powerAt = 0): WorldState["priority"] {
    const base = newWorld(content, 1).priority;
    const byId = new Map(base.map((e) => [e.id, e]));
    const items = ids.map((id) => byId.get(id)!);
    const power = base.find((e) => e.kind === "power")!;
    return [...items.slice(0, powerAt), power, ...items.slice(powerAt)];
  }
  const idsOf = (actions: ReturnType<typeof milestoneFirstReorder>) =>
    actions.length === 0 ? null : (actions[0] as { entries: string[] }).entries;

  it("puts power first, then the next milestone's items, then the rest as authored", () => {
    // Precondition: at tier 2 the list is still authored, and plastic sits fourth.
    const ctx = context({ tier: 2 });
    expect(ctx.state.priority.map((e) => e.id)).toEqual(["power", ...AUTHORED]);
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...TIER3_FIRST]);
  });

  it("keeps power first even where the player moved it", () => {
    const ctx = context({ tier: 2, priority: ordered(TIER3_FIRST, 3) });
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...TIER3_FIRST]);
  });

  it("emits nothing when the list is already in that order", () => {
    expect(milestoneFirstReorder(context({ tier: 2, priority: ordered(TIER3_FIRST) }))).toEqual([]);
  });

  it("puts an item back where it was authored once its milestone is no longer next", () => {
    // Tier 1's next milestone (tier 2) needs only iron_plate, so plastic goes home.
    const ctx = context({ tier: 1, priority: ordered(TIER3_FIRST) });
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...AUTHORED]);
  });

  it("reverts to the authored order when there is no next milestone", () => {
    const ctx = context({ tier: 3, priority: ordered(TIER3_FIRST) });
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...AUTHORED]);
  });

  it("is used by greedy and optimal, never by casual or bottleneck", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, state: { ...base.state, tier: 2 } };
    ctx.solution = solve(ctx.state, content);
    for (const name of ["greedy", "optimal"] as const) {
      const first = getPolicy(name).decide(ctx)[0]!;
      expect(first.type).toBe("REORDER_PRIORITY");
      // The engine accepts it: it is a permutation of the existing entries.
      expect(apply(ctx.state, content, first, ctx.state.seed).rejected).toBe(false);
    }
    for (const name of ["casual", "bottleneck"] as const) {
      expect(getPolicy(name).decide(ctx).some((a) => a.type === "REORDER_PRIORITY")).toBe(false);
    }
  });

  it("optimal looks ahead from the reordered list, not the one it was handed", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, state: { ...base.state, tier: 2 } };
    ctx.solution = solve(ctx.state, content);
    const [reorder, ...rest] = getPolicy("optimal").decide(ctx);
    const applied = apply(ctx.state, content, reorder!, ctx.state.seed);
    if (applied.rejected) throw new Error(applied.reason);
    const reordered: PolicyContext = { ...ctx, state: applied.state, solution: solve(applied.state, content) };
    expect(rest).toEqual(getPolicy("optimal").decide(reordered));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx vitest run src/policies.test.ts 2>&1 | grep -E "×|Tests |Error"
```

Expected: the suite errors or every new test fails, because `milestoneFirstReorder` is not exported.

- [ ] **Step 3: Implement**

In `apps/sim/src/policies.ts`, insert immediately before `const greedy: Policy = {`:

```ts
/**
 * Spec 2026-10-12 (milestone-first policies): the habit a competent player has. The
 * desired list is the power entry (spec C.4 keeps it first), then the next milestone's
 * required items in its `requires` order, then every other entry in the bundle's
 * authored `start.priority` order -- so a delivered milestone's items go back where the
 * author put them. Returns one REORDER_PRIORITY when the list differs, else nothing.
 * Never touches paused flags, modes, target rates or reserves.
 *
 * Measured 2026-10-12: on the slice it moves `greedy` by -0.9% at tier 4 and nowhere
 * else, because tier times are set by storage caps and purchase cadence, and consumers
 * draw a milestone item from stock, which the priority order does not govern.
 */
export function milestoneFirstReorder(ctx: PolicyContext): Action[] {
  const { content, state } = ctx;
  const current = state.priority.map((entry) => entry.id);
  const power = state.priority.filter((entry) => entry.kind === "power").map((entry) => entry.id);
  const next = content.milestoneByTier.get(state.tier + 1);
  const lead = (next?.requires ?? [])
    .map((requirement) => `item:${requirement.item}`)
    .filter((id) => current.includes(id) && !power.includes(id));
  // An entry outside start.priority goes last, in its current relative order. None
  // exists today: reserve entries are injected by effectivePriority, never stored.
  const authored = new Map(content.bundle.start.priority.map((itemId, index) => [`item:${itemId}`, index]));
  const rank = (id: string): number => authored.get(id) ?? Number.MAX_SAFE_INTEGER;
  const rest = current
    .filter((id) => !power.includes(id) && !lead.includes(id))
    .map((id, index) => ({ id, index }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index)
    .map(({ id }) => id);
  const desired = [...power, ...lead, ...rest];
  if (desired.every((id, index) => id === current[index])) return [];
  return [{ type: "REORDER_PRIORITY", entries: desired }];
}
```

Change `greedy`'s `decide` to:

```ts
  decide: (ctx) => {
    const reorder = milestoneFirstReorder(ctx);
    // Reassignments first: they cost nothing, and putting a starved recipe on the map
    // before buying means the purchase's own auto-assignment sees the corrected state.
    // The purchase choice does not read the priority list, so the reorder needs no
    // re-solve here.
    const moves = idleReassignments(ctx);
    const pick = cheapest(affordableCandidates(ctx));
    return pick === null ? [...reorder, ...moves] : [...reorder, ...moves, pick.action];
  },
```

Change `optimal`'s `decide` so it starts:

```ts
  decide: (outer) => {
    // Look ahead from the list as it will be after the milestone-first reorder:
    // topTargetItem reads the priority list.
    const reorder = milestoneFirstReorder(outer);
    let ctx = outer;
    if (reorder.length > 0) {
      const applied = apply(outer.state, outer.content, reorder[0]!, outer.state.seed);
      if (!applied.rejected) ctx = { ...outer, state: applied.state, solution: solve(applied.state, outer.content) };
    }
    const decided = ((): Action[] => {
```

Then indent the existing body, starting from `const moves = idleReassignments(ctx);`, unchanged, as the body of that arrow function. Close it with:

```ts
    })();
    return [...reorder, ...decided];
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx vitest run src/policies.test.ts 2>&1 | grep -E "×|Tests "
```

Expected: all pass, including the existing ones ("greedy buys the single cheapest affordable thing" still sees one action: at tier 0 the fixture's next milestone needs `iron_plate`, which is already first).

- [ ] **Step 5: Mutation-check**

Make each edit, run Step 4's command, confirm the named test fails, then undo it by hand (no `git checkout -p`; interactive git is unsupported):

| edit | must fail |
|---|---|
| in `milestoneFirstReorder`, replace `const lead = ...;` with `const lead: string[] = [];` | "puts power first, then the next milestone's items…" |
| in `optimal`, delete the `if (reorder.length > 0) { ... }` block | "optimal looks ahead from the reordered list…" (if it does not fail, say so in the report: the fixture may not distinguish the two states) |
| in `greedy`, drop `...reorder` from both returns | "is used by greedy and optimal…" |

- [ ] **Step 6: Spec E.2's table**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md` §E.2, change the `optimal` and `greedy` rows to:

```markdown
| `optimal` | Perfect ordering; plays milestone-first. The upper bound |
| `greedy` | Buy the cheapest available upgrade; plays milestone-first |
```

and insert after the table (before "The fourth policy answers…"):

```markdown
**Amended 2026-10-12: milestone-first.** `greedy` and `optimal` keep the next milestone's
required items at the top of the priority list and return them to the authored order
once delivered (`milestoneFirstReorder`); `casual` and `bottleneck` never reorder. Measured
before adopting it: a milestone-first `greedy` moves only tier 4, by −0.9%, so the
calibration fitted to the old `greedy` holds for a milestone-first player and was not
redone. See `specs/2026-10-12-milestone-first-policies-design.md`.
```

- [ ] **Step 7: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add apps/sim/src/policies.ts apps/sim/src/policies.test.ts docs/superpowers/specs/2026-09-01-engine-core-design.md
git commit -m "Play milestone-first in greedy and optimal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: Remove `storageBindingCadence`, then re-pin

**Files:**
- Modify: `packages/content/src/schema.ts` (`PacingSchema`)
- Modify: `packages/engine/src/content/types.ts` (the pacing type, line ~139)
- Modify: `packages/content/bundles/{vertical-slice,fixture,calibration-fixture}/pacing.yaml`
- Modify (tests that build a pacing block): `packages/content/src/{checksum,derived,load,schema.phase1,schema}.test.ts`, `packages/content/src/validate/{economy,graph}.test.ts`
- Modify: `apps/sim/src/calibrate.ts` (header comment, line ~16)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§B.7 yaml block and the "author the cadence" sentence near line 483)
- Modify: `apps/sim/src/gate-cli.ts` (pins, only those that move)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (decision 5)

**Interfaces:**
- Consumes: Task 1's commit.

- [ ] **Step 1: Write the failing test**

In `packages/content/src/schema.test.ts`, inside the existing pacing coverage, or as a new `describe` at the end:

```ts
// Spec 2026-10-12: storageBindingCadence was read by nothing and is gone. The schema
// is strict, so a bundle still carrying it is rejected rather than silently ignored.
describe("PacingSchema without storageBindingCadence", () => {
  const pacing = {
    targetCollectionsToTier: [2, 5],
    activeHoursPerDay: 2.5,
    offlineCollectionsPerDay: 3,
    purchaseIntervalEarlySeconds: 120,
    purchaseIntervalLateSeconds: 1800,
  };
  it("accepts a pacing block without it", () => {
    expect(PacingSchema.safeParse(pacing).success).toBe(true);
  });
  it("rejects one that still carries it", () => {
    expect(PacingSchema.safeParse({ ...pacing, storageBindingCadence: 12 }).success).toBe(false);
  });
});
```

(Import `PacingSchema` from `./schema.js` if the file does not already.)

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/content"
npx vitest run src/schema.test.ts 2>&1 | grep -E "×|Tests "
```

Expected: both new tests fail ("accepts" because the field is required; "rejects" because it is still allowed).

- [ ] **Step 3: Remove the field everywhere**

Delete the line `storageBindingCadence: z.number().int().positive(),` from `PacingSchema`; the field from the engine's pacing type; the `storageBindingCadence: 12` line from the three bundles' `pacing.yaml`; and the `storageBindingCadence: 12,` line (or `\n  storageBindingCadence: 12` in `load.test.ts`'s string) from each listed test file. In `apps/sim/src/calibrate.ts`'s header, replace step 2's text "Storage cap growth against `pacing.storageBindingCadence`." with "Storage cap growth (`capPerTier`), solved jointly with `r_eff`." -- reading the surrounding lines first and keeping the rest of that step accurate.

Then confirm nothing is left:

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
grep -rn "storageBindingCadence" --include=*.ts --include=*.yaml apps packages | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Spec B.7 and the handoff**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md`: delete the `storageBindingCadence:    12       # machines between storage binding` line from §B.7's yaml block. Change "Solves for: per-class `r_eff` (hence `r`), milestone delivery requirements, storage `s` and `sc`, QS `q` and its cost curve." to:

```markdown
Solves for: per-class `r_eff` (hence `r`), milestone delivery requirements, and storage's
`capPerTier`. **Amended 2026-10-12:** the storage and Quantum Storage curves (`capGrowth`,
`costGrowth`, `baseCostAmount`, `maxLevel`) are authored, with measurements behind them
(§3.3's binding shape, check 12's climbable ladder, the 22/16 depth). The
`storageBindingCadence` intent was read by nothing and is removed.
```

Find the sentence near line 483 that says to "author the cadence and let the script solve: `storageBindingCadence: 12`", and append to it: " *(Superseded 2026-10-12: the knob was never consumed and is removed; see §B.7.)*"

In `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, prefix decision 5's bullet ("**B.7's storage list.**") with "**DONE 2026-10-12:** `storageBindingCadence` removed; the curves are recorded as authored-with-measurements in §B.7."

- [ ] **Step 5: Verify, then re-pin**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
pnpm content:check 2>&1 | grep -E "warning|error|v1:"
```

Expected: all green. `content:check` lists three bundles, each with only the known check-6 warning on the two slice-shaped ones.

Then the full gate, with nothing else running:

```bash
cd apps/sim
S=${CLAUDE_JOB_DIR:-/tmp}/milestone-first; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Compare the emitted pins with `VERTICAL_SLICE_GATE` in `apps/sim/src/gate-cli.ts`:
- **`greedy`:** expected to move only slightly (tier 4 around 1.82). Update moved values, appending to each moved pin's `why` the sentence `Re-measured 2026-10-12 after greedy played milestone-first.` A `greedy` tier gated by tolerance rather than a pin needs no edit if it stays inside ±5%.
- **`casual` or `bottleneck` moving at all:** STOP and report. Their behaviour did not change, so a move is a defect.

If any pin changed, re-run the gate without `--emit-pins` and confirm it exits 0 with no findings.

- [ ] **Step 6: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add -A packages/content packages/engine/src/content/types.ts apps/sim/src/calibrate.ts apps/sim/src/gate-cli.ts docs
git commit -m "Remove the unconsumed storageBindingCadence knob, and re-pin the gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives the gate's total time, every pin that moved (old → new), and confirms `casual` and `bottleneck` did not move.

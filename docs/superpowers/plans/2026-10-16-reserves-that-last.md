# Reserves That Last Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reserves are sized against what their item actually makes (ruling R8), and `bottleneck` keeps a reserve while it is working. Together these end the one-decision reserve churn and the two-payer alternation. Three small test and doc gaps ride along.

**Architecture:**
- **Task 1:** reserve sizing in `solve` (`packages/engine/src/solve/solve.ts`) and `effectivePriority` (`packages/engine/src/solve/waterfall.ts`).
- **Task 2:** the policy's keep rule (`apps/sim/src/policies.ts`).
- **Task 3:** the small gaps.
- **Task 4:** measurement, the gate re-pin and the docs.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-16-reserves-that-last-design.md`

## Global Constraints

- **Where to work:** `.claude/worktrees/phase-1-engine`, branch `reserve-followups`, cut from `main` at `0583997`. Never work in the top-level checkout.
- **Reserve target:** `percent × productionWithoutReserves(itemId)`, where `percent` is still clamped by `RESERVE_MAX_PERCENT` (0.5). "Production without reserves" is the item's `production` from one `solveItems` pass of the state with every reserve at 0, with `capacity.unitsByRecipe` (power ratio 1) and `effectivePriority(content, bare, capacity, 0)` (no power demand). *Amended 2026-10-16 after Task 4 measured the full-`solve` version: its longest dead stretch was 1.34, over the limit.*
- **No reserve set:** `solve` runs no extra pass, and its result is unchanged.
- **The keep rule:** the policy clears a reserve only when its item is FULL or not growing (net ≤ `FLOW_TOLERANCE`), and the reporter isn't advising that reserve.
- **The gate:** `greedy` and `casual` pins must stay byte-identical.
- **Purity:** `packages/engine` is pure (lint-enforced).
- **Commands:**
  - Never run `pnpm format`.
  - Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground.
  - Never `pgrep -f` a pattern that matches your own wait loop. Run any mutation that could hang under `timeout -s KILL 120`.
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Recursion.** The reserve-free solve must itself never recurse: with every reserve at 0, it takes the no-reserve path. Covered by Task 1's tests terminating.
- **The solve cache.** The per-resolve solve cache (in `resolve`) is keyed on `tier|tapStacks|item tags`. A reserve change only happens through an action, between resolves, so a cached solve never sees a different reserve within one resolve. Task 1 must not add any reserve-dependent state outside `solve`'s inputs. The reviewer confirms this by reading.
- **The existing clear test.** `policies.test.ts` "clears a reserve the advice no longer names" sets `iron_ingot` reserved. Under the keep rule, a growing reserve is now kept, so that test must use a not-growing (or FULL) item. Task 2 says how.
- **Accumulating reserves.** The keep rule can leave several reserves set. Each is at most 50% of its own item's production (Task 1), so none can take everything. Covered by Task 2 test C and the gate's dead-time stop condition.

---

### Task 1: Size a reserve against its item's production, test-first

**Files:**
- Modify: `packages/engine/src/solve/waterfall.ts` (`effectivePriority`)
- Modify: `packages/engine/src/solve/solve.ts` (`solve`)
- Test: `packages/engine/src/solve/solve.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `effectivePriority(content, state, capacity, powerTargetRate, productionOf?: ReadonlyMap<ItemId, number>)`. When `productionOf` is given, a reserve's target is `percent × (productionOf.get(itemId) ?? 0)`. When it is omitted (direct callers such as tests), the old `percent × unconstrainedRate(...)` stays, and a comment says so. `solve` always passes it when a reserve is set.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/solve/solve.test.ts`. Use the file's existing fixture `content` and helpers; read the top of the file for their names. The fresh fixture has `iron_ore` EMPTY, so `smelt_iron` runs below its unconstrained rate, which makes iron_ingot's real production lower than its unconstrained rate.

```ts
// Spec 2026-10-16 (reserves that last), ruling R8 amended: a reserve is sized against
// what its item really makes. Measured cause: every bottleneck reserve lasted one
// decision, because 25% of the unconstrained rate took the whole short upstream.
describe("solve — a reserve is sized against its item's production (R8)", () => {
  const start = initialWorld(content, 1, 0);
  const reserved: WorldState = { ...start, reserve: { ...start.reserve, iron_ingot: 0.25 } };
  const bare = solve(start, content);
  const withReserve = solve(reserved, content);
  const entry = withReserve.entries.find((e) => e.entryId === "reserve:iron_ingot");

  it("targets percent x production without reserves", () => {
    const production = bare.itemRates.get("iron_ingot")!.production;
    // Precondition: the upstream is short, so the two sizings differ.
    expect(production).toBeGreaterThan(0);
    expect(unconstrainedRate(content, withReserve.capacity, "iron_ingot")).toBeGreaterThan(production * 1.01);
    expect(entry?.requested).toBeCloseTo(0.25 * production, 9);
  });

  it("leaves the item's consumers a share", () => {
    expect(withReserve.itemRates.get("iron_ingot")!.consumption).toBeGreaterThan(0);
  });

  it("gives an item nothing makes no reserve effect", () => {
    // plastic is not live at tier 1, so nothing makes it.
    const noMaker: WorldState = { ...start, reserve: { ...start.reserve, plastic: 0.25 } };
    const s = solve(noMaker, content);
    const plastic = s.entries.find((e) => e.entryId === "reserve:plastic");
    expect(plastic === undefined || plastic.requested === 0).toBe(true);
  });
});
```

**Fixture facts to check before running.** If any is wrong, STOP and report it; do not guess.
- `initialWorld`, `WorldState`, `unconstrainedRate` (from `../economy/capacity.js`) and `solve` are importable in `solve.test.ts`. Add any missing import.
- `Solution` exposes `entries` (with `entryId`, `requested`) and `capacity`. Read `solve.ts`'s return type. If `capacity` isn't exposed, compute it the way `solve` does, or assert the precondition another honest way, and say how.
- `plastic` exists in the fixture and isn't live at tier 1. If not, use any stock item nothing makes at tier 1.
- If iron_ingot isn't short at start (the precondition fails), find a fixture state where it is, such as one with fewer miners. If you can't, STOP.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/solve.test.ts 2>&1 | grep -E "×|Tests " | head -20
```

Expected: "targets percent x production…" fails, because today's target is 25% of the unconstrained rate. The other two may pass; that's fine, because they pin behaviour.

- [ ] **Step 3: Implement**

In `waterfall.ts` `effectivePriority`:
- add the trailing optional parameter `productionOf?: ReadonlyMap<ItemId, number>`;
- set the target to `percent * (productionOf ? (productionOf.get(itemId) ?? 0) : unconstrainedRate(content, capacity, itemId))`;
- update its doc comment: R8 now sizes against production, and the fallback exists only for callers outside `solve`.

In `solve.ts` `solve`, before the first `solveItems` call:

```ts
  // Spec 2026-10-16 (ruling R8 amended): a reserve is sized against what its item makes
  // with no reserves set, so it can take at most half of real production. The
  // reserve-free state takes the branch below's `undefined` path, so this never
  // recurses, and with no reserve set it never runs.
  const anyReserve = Object.values(state.reserve).some((percent) => percent > 0);
  const productionOf = anyReserve
    ? new Map(
        [...solve({ ...state, reserve: Object.fromEntries(Object.keys(state.reserve).map((id) => [id, 0])) }, content, options).itemRates]
          .map(([itemId, flow]) => [itemId, flow.production]),
      )
    : undefined;
```

Pass `productionOf` as the fifth argument to both `effectivePriority(...)` calls in `solve`. Match the file's types: `itemRates` is a `Map<ItemId, ItemFlow>`.

- [ ] **Step 4: Run the tests, then the engine suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/solve.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. A test elsewhere that pinned a reserve's old target (for example in `bottleneck.test.ts` or `waterfall.test.ts`) gets reported by name, with why, and is not edited, unless it calls `effectivePriority` directly. Those direct callers keep the old fallback, so they should pass unchanged.

- [ ] **Step 5: Mutation-check**

Edit by hand, run `solve.test.ts` under `timeout -s KILL 120`, then undo by hand:

| edit | must fail |
|---|---|
| in `solve`, pass `undefined` instead of `productionOf` | "targets percent x production…" |
| in `effectivePriority`, use `productionOf.get(itemId) ?? 1e9` | "gives an item nothing makes no reserve effect" or "targets…"; record which |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src/solve
git commit -m "Size a reserve against what its item makes (R8)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: `bottleneck` keeps a reserve that is working, test-first

**Files:**
- Modify: `apps/sim/src/policies.ts` (the `bottleneck` policy's reserve clears, around line 366)
- Test: `apps/sim/src/policies.test.ts` (`describe("bottleneck and reserve advice (spec 2026-10-13)")`)

**Interfaces:**
- Consumes: `FLOW_TOLERANCE`. Check whether `@manufactory/engine` exports it (it's defined in `packages/engine/src/solve/fixpoint.ts`). If it doesn't, add it to the engine's solve index export, the same way other solve constants are exported, and say so in the report.

- [ ] **Step 1: Write the failing tests**

In that describe:

1. **Change the existing test** "clears a reserve the advice no longer names". Under the keep rule a growing reserve is kept, so make its item not growing. Hand the policy a `solution` whose `itemRates` has `iron_ingot` at `{ production, consumption: production, net: 0 }`, as a copy of the solved one. Rename it "clears a reserve whose item has stopped growing", and keep its assertion (a `SET_RESERVE` to 0). Record the change in the report as intended.
2. **Add:**

```ts
  // Spec 2026-10-16 (reserves that last): a reserve is kept while it is working, so it is
  // not dropped the moment the advice moves. Measured cause: every reserve lasted one
  // decision, and two payers alternated four times.
  const reservedWith = (items: Record<string, number>, rates: Record<string, number>, states: Record<string, "EMPTY" | "FLOWING" | "FULL"> = {}) => {
    const base = rich();
    const state: WorldState = { ...base.state, reserve: { ...base.state.reserve, ...items } };
    const solved = solve(state, content);
    const itemRates = new Map(solved.itemRates);
    for (const [itemId, net] of Object.entries(rates)) itemRates.set(itemId, { production: net + 1, consumption: 1, net });
    const itemStates = new Map(solved.itemStates);
    for (const [itemId, tag] of Object.entries(states)) itemStates.set(itemId, tag);
    const ctx: PolicyContext = { ...base, state, solution: { ...solved, itemRates, itemStates } };
    // Precondition: the advice is not a reserve on any of these items.
    for (const itemId of Object.keys(items)) expect(ctx.solution.bottleneck).not.toMatchObject({ kind: "reserve", itemId });
    return getPolicy("bottleneck").decide(ctx);
  };

  it("keeps a reserve whose item is still growing after the advice moved", () => {
    const actions = reservedWith({ iron_ingot: 0.25 }, { iron_ingot: 2 }, { iron_ingot: "FLOWING" });
    expect(actions).not.toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0 });
  });

  it("clears a reserve whose item is FULL", () => {
    const actions = reservedWith({ iron_ingot: 0.25 }, { iron_ingot: 2 }, { iron_ingot: "FULL" });
    expect(actions).toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0 });
  });

  it("keeps two reserves at once while both are growing", () => {
    const actions = reservedWith({ iron_ingot: 0.25, iron_ore: 0.25 }, { iron_ingot: 2, iron_ore: 3 }, { iron_ingot: "FLOWING", iron_ore: "FLOWING" });
    expect(actions.filter((a) => a.type === "SET_RESERVE" && a.percent === 0)).toEqual([]);
  });
```

Check that `rich()`, `solve`, `content`, `WorldState` and `PolicyContext` are in scope in that file; they're used nearby. If the precondition fails for `iron_ore` (the advice becomes a reserve on it), pick another stock item that is made at tier 1 and say which.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx vitest run src/policies.test.ts 2>&1 | grep -E "×|Tests " | head -20
```

Expected:
- "keeps a reserve whose item is still growing…" fails, because today it's cleared;
- "keeps two reserves at once…" fails;
- the FULL and stopped-growing tests pass, because today clears everything; that's fine.

- [ ] **Step 3: Implement**

In `policies.ts` `bottleneck.decide`, the clears loop:

```ts
    for (const [itemId, percent] of Object.entries(ctx.state.reserve)) {
      if (percent > 0 && !(report?.kind === "reserve" && report.itemId === itemId)) {
        clears.push({ type: "SET_RESERVE", itemId, percent: 0 });
      }
    }
```

becomes:

```ts
    for (const [itemId, percent] of Object.entries(ctx.state.reserve)) {
      if (percent <= 0) continue;
      if (report?.kind === "reserve" && report.itemId === itemId) continue;
      // Spec 2026-10-16: keep a reserve that is still working -- its item is growing and
      // has room -- even after the advice moved. Dropping it the moment the advice moved
      // made every reserve last one decision and let two payers alternate.
      const growing = (ctx.solution.itemRates.get(itemId)?.net ?? 0) > FLOW_TOLERANCE;
      const full = ctx.solution.itemStates.get(itemId) === "FULL";
      if (growing && !full) continue;
      clears.push({ type: "SET_RESERVE", itemId, percent: 0 });
    }
```

Update the comment above the loop, which says "a reserve lasts only while the reporter asks for it", to describe the keep rule.

- [ ] **Step 4: Run the tests, then the sim suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx vitest run src/policies.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. A sim test that pinned a full `bottleneck` run's outcome gets reported by name, not edited.

- [ ] **Step 5: Mutation-check**

| edit | must fail |
|---|---|
| delete `if (growing && !full) continue;` | "keeps a reserve whose item is still growing…", "keeps two reserves at once…" |
| change `!full` to `true` | "clears a reserve whose item is FULL" |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add apps/sim/src packages/engine/src
git commit -m "Keep a reserve while it is still banking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 3: The small gaps

**Files:**
- Test: `packages/engine/src/actions/machines.test.ts`
- Test: `packages/engine/src/solve/bottleneck.test.ts`
- Modify: `apps/sim/src/gate-cli.ts`

- [ ] **Step 1: A named-recipe purchase the player can't afford.** In `machines.test.ts`'s describe "a purchase that names its recipe", add:

```ts
    it("rejects a wrong-lane recipe before checking it can be afforded", () => {
      // A world too poor to buy a refinery: the recipe is still the reason given, so
      // validation runs before payment.
      const poor: WorldState = { ...oilWorld(), stored: { ...oilWorld().stored, iron_plate: D(0), iron_ingot: D(0), iron_ore: D(0) } };
      const result = applyBuyMachine(poor, content, buy("make_plate"));
      expect(result.rejected ? result.reason : "").toMatch(/^recipe "make_plate" does not run on refinery in oil$/);
    });
```

Check first that the refinery is unaffordable in `poor`: the same purchase without `recipeId` must reject with the afford message. Assert that as a precondition. If refinery mk1 is priced in an item not zeroed here, zero that item too.

- [ ] **Step 2: The maxed-storage wall for a blocked output.** In `bottleneck.test.ts`'s describe "computeBottleneck — a payer blocked by its own output gets storage", add a test that sets `heavy_oil_residue`'s storage level and its lane's quantum-storage level to each curve's `maxLevel`. Read `bundle.storage` and `bundle.quantumStorage` for the field, and `state.storageLevel` and `state.qsLevel` for the shape. Then assert the advice is `{ kind: "storage", itemId: "heavy_oil_residue", upgrade: null }` (use `toMatchObject`), using the describe's `advise(0, "FULL")` setup on that state. You'll need to pass the state through; extend `advise` with an optional state if needed. If the fixture's curves have no `maxLevel`, STOP and report.

- [ ] **Step 3: The gate's repeated `why` text.** In `apps/sim/src/gate-cli.ts`, find the re-measure sentences repeated across the `bottleneck` pins' `why` texts. Name the repeated text once (a `const`, or a small helper that builds it from a date and cause), and use it in each place. The resulting `why` strings must be byte-identical to today's: run the gate CLI's own tests, or compare `JSON.stringify(VERTICAL_SLICE_GATE)` before and after with a tiny `tsx` one-liner, and say which you did.

- [ ] **Step 4: Run the suites**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine" && npx vitest run src/actions/machines.test.ts src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests "
cd ../../apps/sim && npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. The two new engine tests pin behaviour that already holds, so they pass on first run. For each, show it can fail: change the validation order, or the `null` upgrade, by hand; run; undo.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src apps/sim/src/gate-cli.ts
git commit -m "Pin validation order and the maxed-storage wall; name the gate's re-measure text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 4: Measure, re-pin, record

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (the bottleneck entry)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (R8 and §4.5 amendments)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`
- Modify: `docs/superpowers/specs/2026-10-16-reserves-that-last-design.md` (Status)
- Possibly modify: `.github/workflows/ci.yml` (timing note, only if the gate time moves by more than 20% from about 1m20s)

- [ ] **Step 1: Full suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
```

Expected: green. Report any failure by name.

- [ ] **Step 2: The probe**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx tsx /home/nec/.claude/jobs/56686703/tmp/land/reserve.mts 2>&1 | grep -v "^D " | cut -c1-300
```

This counts reserve *advice* runs, not how long the policy holds a reserve. Report its output, and in the report note that reserve holding is now longer than the advice runs it counts. Expected: fewer A-B-A alternations than `main`'s 4.

- [ ] **Step 3: Gate with pins emitted**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/home/nec/.claude/jobs/56686703}/reserves-last; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Expected:
- **`greedy` and `casual`:** identical to the committed pins. Diff them explicitly against `gate-cli.ts`.
- **`bottleneck`:** reaches tier 10, and the longest dead stretch is below 1.0 collection. The prototype measured about t4 0.42, t7 1.02, t9 2.23, t10 10.06 and dead 0.78. This design's full reserve-free solve may differ slightly.

If `greedy` or `casual` moves, `bottleneck` misses tier 10, or its dead time is 1.0 or more, STOP and report BLOCKED. Do not re-pin.

- [ ] **Step 4: Re-pin `bottleneck`**

In `VERTICAL_SLICE_GATE`'s bottleneck entry:
- update every moved tier value from the emitted block;
- end each moved pin's `why` with `Re-measured 2026-10-16 after reserves were sized against production and kept while working.`; use Task 3's helper if it fits;
- update the comment above the entry with the new tier 10 and dead time.

Re-run the gate without `--emit-pins` and confirm exit 0 with no findings.

- [ ] **Step 5: Docs**

- **The engine spec:** in `docs/superpowers/specs/2026-09-01-engine-core-design.md`, add the spec's two amendment texts, without the `> ` prefixes:
  - the R8 one, where ruling R8 or reserve entries are described (search for "R8");
  - the policy one, after the 2026-10-15 unmade-payer amendment in §4.5.
- **The handoff:** in `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, mark both "Follow-ups from the reserves branch (2026-10-13)" items done (2026-10-16), with the measured numbers. Also mark done:
  - "No rejection test in an unaffordable world";
  - "The maxed-storage `upgrade: null` wall for a blocked output is untested";
  - "The gate-cli `why` texts repeat…".
- **The spec's Status:** `**Status:** implemented 2026-10-16.`

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add apps/sim/src/gate-cli.ts docs .github
git commit -m "Re-pin bottleneck after reserves that last

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives:
- the probe's output;
- the gate's time;
- every moved pin (old → new);
- the explicit `greedy`/`casual` diff result;
- `bottleneck`'s dead time.

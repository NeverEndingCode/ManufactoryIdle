# Manufactory Idle — Engine Core Design

**Status:** In progress. Section A approved-pending-review; Sections B–F not yet written.
**Scope:** Spec 1 of 4 — the engine core (build phases 0–4) plus the simulator.
**Date:** 2026-09-01

This document is the decision record for the design conversation held against
`manufactory-idle-spec.md`. It captures what was settled, why, and what remains
open. It supersedes the original spec wherever the two disagree; disagreements
are called out explicitly in §3.

---

## 1. Project decomposition

The original spec covers five progression axes, ten sub-menus, expeditions, the
Deep Core, a statistics system, PWA and push, leaderboards, a headless simulator,
a terminal client, story logs, a virtual pet, and a gardening minigame. That is
too large for one spec. It is split into four:

| Spec | Covers | Status |
|---|---|---|
| **1. Engine core** | Solver, storage, Quantum Storage, power, event-driven resolution, server authority, action API, simulator | **This document** |
| 2. Progression | Milestones, alt recipes, ranks, Pioneers, Tickets, contracts, Phases, Engineer Level | Not started |
| 3. Live content | Expeditions, Deep Core, daily contracts, achievements, leaderboards, story logs | Not started |
| 4. Statistics & platform | §13.7 statistics, graphs, PWA, push notifications | Not started |

Rationale: §16 of the original spec is correct that balance is the whole job, and
balance cannot be tuned without a simulator. Phases 0–4 plus the simulator is the
smallest unit that produces something you can actually tune.

---

## 2. Decisions

### D1 — Audience and infrastructure

**Public, with leaderboards.** Server authority, anti-cheat, and leaderboard
integrity are load-bearing and designed in from the start rather than retrofitted.
SuperTokens and Postgres exist from phase 0, per original §12.3 and §12.6.

### D2 — Licensing

The project reuses `packages/rational`, `packages/gamedata`, and `packages/solver`
from `EvanTrow/Satisfactory-Colab-Modeler`, which is **GPL-3.0**.

Consequence, accepted deliberately: Manufactory Idle is a derivative work and must
also be GPL-3.0. Because the web client ships JavaScript to every player's browser,
that constitutes distribution, so the entire project must be source-available.
GPLv3 (not AGPL) means server-side operation alone would not trigger this, but a
browser game always does.

### D3 — The growth model

This was the largest correction to the original spec. See §3.1 for the problem.

**Four levers, one dial:**

| Lever | Shape | Job |
|---|---|---|
| Purchase-count ladder | Continuous, `2^(n/25)` | Sets `r_eff`. The master dial. Smooths pace *within* a tier |
| Machine marks (Mk1→Mk3) | Discrete, ~×3, resets cost curve | The staircase. Restores pace at tier boundaries |
| Milestone lane multipliers | Discrete, ~×1.5 lane-wide | Rewards breadth; makes neglected lanes catchable |
| Overclocking | Continuous, power-gated | Player-operated dial trading power for throughput. Phase 1 unlock |

**The ladder thresholds must be arithmetic, not geometric.** Doubling at
25/50/100/200 (each threshold double the last) yields a multiplier *linear* in n,
and no polynomial multiplier can beat an exponential cost. Doubling every 25
machines forever yields `M = 2^(n/25) = 1.0281ⁿ`, which is the same shape as the
cost curve and can therefore compete with it.

**The master dial is the effective cost ratio:**

```
r_eff = r / m         r = cost ratio per machine
                      m = production multiplier growth per machine

r = 1.09, doubling every 25 machines (m = 1.0281)
  → r_eff = 1.060
```

| Condition | Machine count | Production | Feel |
|---|---|---|---|
| `r_eff > 1` | `log(t)` | `log(t)` | Slow, staircase-driven — the genre norm |
| `r_eff = 1` | linear in t | exponential in t | Knife edge |
| `r_eff < 1` | super-linear | super-exponential | Runaway; game over in an afternoon |

**Invariant: `r_eff > 1 + ε` must hold for every recipe with every multiplier
maxed.** This is statically checkable by the content validator at build time and
dynamically by the simulator with the whole stack maxed. It is a far stronger
guard against original §16.4's "runaway growth" than prose.

**The pacing law.** Time to buy machine *n+1* is proportional to `r_eff ⁿ / n`.
At `r_eff = 1.060` each purchase takes ~6% longer than the last, so moving from a
2-minute purchase to a 30-minute purchase — the point a tier starts to drag —
takes `ln(15)/ln(1.06) ≈ 46` machines.

> **A tier is worth about 45 machines on its critical recipe.** Past that it drags,
> and a milestone, machine mark, or overclock level must land to reset pace.

This turns original §16.6's "every layer must restore pace" into a number the
simulator can assert.

**Reframe: logarithmic base growth is correct, not a bug.** Cookie Clicker,
AdVenture Communist, and ISEPS are all logarithmic and all run for years. The
failure mode is not a slowing number, it is *dead time*. The tuning target is
therefore **bounded event cadence**, not growth rate — and `r_eff` controls it
directly.

**Softcaps** (original §16.6 wants softcap, never hard-cap):

```
M_eff = M ≤ T ? M : T · (M/T)^p          p ≈ 0.7
```

Applied per multiplier category *and* again on the product, so neither a single
system nor the four stacking can drive `r_eff` below 1. Nothing reads as wasted; it
bends.

### D4 — Dismantle and Quantum Storage

**Dismantle is a general verb, not a recipe-switch special case.** In Satisfactory
anything can be dismantled anytime for full refund. Recipe switching is then just
dismantle plus rebuild — one code path.

This supersedes original §4.6's dead-purchase guard #2 (a small lane-wide logistics
multiplier on every purchase). A reversible purchase is a much stronger guard than a
consolation prize, and the consolation prize muddies the multiplier stack in D3.

**Refunds are LIFO.** Dismantling the *n*th machine returns `cost(n)` and decrements
the counter, so rebuilding costs exactly what was refunded. Symmetric; no pump.

**Quantum Storage is a second buffer tier**, not an infinite void:

```
production → Storage (capped, purchasable)
           → full? → Quantum Storage (capped, purchasable)
           → full? → backpressure
```

This preserves backpressure, preserves the fluid byproduct triangle (original §3.4 —
the residue tank fills, then QS fills, then the refinery throttles, just with more
slack), and keeps storage a real currency sink with two curves to buy rather than one.

**Dismantling ignores the QS cap**, so materials are never destroyed.

**Quantum Storage above its cap is builds-only.** Below the cap it is fully liquid —
spendable on anything, deliveries included. Above the cap, the bulge can only be
re-instantiated into machines, and becomes liquid as room opens beneath it.

Rationale — the exploit this closes:

> A milestone needs 1e9 iron plate. Storage cap is 25M and QS is 100M, so it can
> never be banked. Buy 200 constructors over a few hours (each purchase individually
> under the cap), then dismantle all 200 immediately before delivery. QS holds 4.1B
> plate. Deliver.

A full-stack refund is the geometric sum `base·(rⁿ−1)/(r−1)` — roughly **10× the
marginal cost of the next machine** at r = 1.09. Without the builds-only rule,
storage caps stop gating deliveries, milestones, contracts, and the AWESOME Sink,
where build/dismantle/sink becomes an infinite Engineer XP loop.

Fiction: Quantum Storage holds components in a coherent quantum state. The buffer
holds only so much before the excess must stay bound as machine matter —
re-instantiable, but not decoherable back into raw stock.

**Where decision weight lives.** Materials come back, so the cost is elsewhere:
- **Time.** Refunding six hours of banked plate does not refund the six hours, and
  the machine produced nothing while it sat in the wrong lane. In an idle game time
  is the currency.
- **The purchase-count ladder.** Dismantling 210 constructors down to 190 drops ×16
  to ×8. A legible, self-inflicted cost to churn, with no special-case code.

Free to reconsider, expensive to thrash.

### D5 — Time, authority, and the tick model

**Tick model and authority model are orthogonal.** Fixed-tick does not imply a
client-authoritative design. The tick choice is about cost and code duplication;
the authority choice is about security.

**Rejected: client-simulates, server-validates.** To check a client's claimed state
the server must compute the correct state anyway — at which point accepting the
client's version buys nothing. Approximate plausibility checks are worse: a cheater
tunes the cheat to sit inside the bounds. Validation is strictly worse than
authority in every dimension.

**Adopted:**

```
SERVER   event-driven, on demand.        ← the only thing that must be exact
         resolve(now − last_resolved_at)

CLIENT   interpolation, display only.    ← zero authority, corrected constantly
         snaps to server truth on every response
```

The server never ticks, because nothing observes intermediate state. It only needs
to be correct at the instants it is asked — an action or a page load.

**How event-driven resolution works.** `solve(state)` returns per-recipe clocks and
a net rate per item, and those rates are constant until something discontinuous
happens. Between discontinuities every stockpile is a straight line,
`stored[i] + net[i]·t`. There are only four discontinuities:

1. A buffer hits its cap → producers backpressure
2. A buffer hits zero → consumers starve
3. A scheduled timer fires → disruption ends, MAM scan completes, Deep Core level lands
4. The player acts

So: solve, compute `t = min(next fill, next drain, next timer, remaining)`, jump
straight there in one step, apply, re-solve. It terminates in a handful of passes
because a factory settles into a steady state where nothing is filling or draining.

Eight hours offline at a 10 Hz fixed tick is ~288,000 solves. Event-driven is ~5–20.

**Anti-cheat.** Under real server authority the client never sends state, only
actions. The server reads its own wall clock. Speeding up time is not *detected* —
it has **no input channel**. Device clock rollback, Lucky Patcher, GameGuardian, and
a patched client cannot express "more time passed."

Residual attack surface, complete:

| Vector | Guard |
|---|---|
| Illegal or unaffordable actions | Validated against content bundle and resolved state, server-side |
| **Taps** — the one genuinely client-timed input | Rate limit (~20/s), validated against wall-clock elapsed, hard-capped per window |
| Concurrent requests double-resolving a window | `SELECT … FOR UPDATE` on `player_worlds`; resolve and write in one transaction |
| Replaying a captured request | Idempotency key per action, plus session auth |
| Crafting a factory expensive to resolve (self-DoS) | Event cap per resolve (~10k) plus a minimum event epsilon against Zeno subdivision |

None of these concern time.

**The 60-second heartbeat in original §12.3 is removed.** Resolution is a pure
function of `(state, now − last_resolved_at)`, so a server crash loses nothing — the
next request recomputes it exactly. The heartbeat's only real job was flushing taps,
which are client-timed; those flush on a debounce while the player is actually
tapping. A player idling with the tab open now costs zero requests rather than
1,440/day.

**Continuous randomness becomes scheduled randomness.** There are no ticks to roll
on. When a disruption ends, the *next* one is scheduled immediately from a seeded
PRNG and becomes a timer event. This is a discipline the whole design must follow,
and it is strictly better: deterministic, replayable in `sim replay`, and consistent
with original §16.6's no-RNG-on-the-critical-path rule.

**Client efficiency.** The tick model barely affects battery; render frequency and
scope dominate. A solve on a 35-item graph is tens of microseconds, while a React
re-render of 40 rows at 10 Hz is milliseconds plus GC churn. Therefore:

- The client solves **zero times** in steady state — it draws `stored + net·t` from
  the event schedule the server sends.
- Text updates at **~4 Hz**; nobody reads faster.
- Bars are CSS-driven, animating on the compositor without touching JS (original §13.6).
- Everything pauses on `visibilitychange`; only the visible lane updates; lists virtualized.

### D6 — Content scope for phases 1–4

A vertical slice of roughly **4 lanes, ~35 items, ~45 recipes**:

```
Iron    ore → ingot → rod → screw → plate → reinforced plate → rotor
Copper  ore → ingot → wire → cable
Coal    ore → steel, coal generator
Oil     crude → plastic + heavy oil residue → rubber, fuel generator
```

Deep enough to exercise cross-lane contention, fluids, byproducts, and fuel
generators; small enough to hand-tune while the growth curve is still moving. The
full ~160-item catalog remains build phase 10.

---

## 3. Concerns raised against the original spec

### 3.1 The growth curve was logarithmic, unintentionally — RESOLVED (D3)

Three rules combined badly: §3.1 (only extraction creates value), §3.2
(`cost(n) = base × rⁿ`, "not optional"), and §10.1 (milestones unlock *depth*).

Time to afford miner *n+1* is `base·rⁿ / (a·n)`, so machine count and throughput
both grow as `log(t)` forever. Milestones do not fix this, because unlocking deeper
items adds no raw throughput under rule §3.1 — a tier-8 unlock makes the graph wider
and more interesting but produces exactly zero additional ore.

The spec had an exponential cost guard with no exponential production source facing
it. §16.6 names this exact failure and its stated guard is "every layer must restore
pace" — but ranks and phases are days-to-months apart, leaving nothing inside a rank.

### 3.2 Scope — RESOLVED (§1)

### 3.3 Online and offline solvers should be unified — RESOLVED (D5)

Original §8's offline algorithm is also the correct online algorithm.

### 3.4 The rational/Decimal boundary is really three zones — RESOLVED (§A)

### 3.5 Alt recipe switching stranded investment — RESOLVED (D4)

### 3.6 Reuse assumption — VERIFIED

`EvanTrow/Satisfactory-Colab-Modeler` exists and contains `packages/solver`,
`packages/gamedata`, and `packages/rational`. Stack matches original §12.1 exactly.
Licensed GPL-3.0 (see D2).

### 3.7 Open, to address in later sections or later specs

- **Content authoring is ~2,000 tuned numbers** across 160 items. Original §16.2's
  calibration script is the right answer, but it is phase-1 infrastructure, not
  phase 10. To be specified in Section B.
- **Disruptions only spawn while active** (§5) means the more you play, the more you
  are attacked. Combined with Pollution, an engaged player is strictly punished.
  Defer to Spec 2.
- **§13.7's activity clock** needs an explicit session table and a stored timezone;
  it cannot be derived later from action logs. Defer to Spec 4, but the session table
  should exist from phase 0.

---

## Section A — Architecture and numbers

### A.1 Package layout

```
packages/
  engine/          pure TypeScript · zero I/O · no React, no Fastify, no clock, no Math.random
    content/       bundle loader, JSON Schema validator, version pinning
    graph/         expansion vectors, SCC detection, per-unit raw costs   ← rational, load-time only
    solve/         waterfall allocation, clocks, bottleneck reporting
    power/         grid equilibrium, storage bank
    resolve/       event-driven time advancement                          ← the only time function
    economy/       cost curves, multiplier stack, r_eff, softcaps, buy/dismantle
    numbers/       Decimal wrapper + the shared formatter
    actions/       action types + reducers (validate, then apply)
  content/         YAML bundles · JSON Schema · build step · calibration script
  rational/        forked from Colab-Modeler
apps/
  api/             Fastify · SuperTokens · Kysely · thin transport only
  web/             Vite · React · Tailwind · Zustand · TanStack Query
  sim/             Ink terminal client + batch runner
```

### A.2 Actions are engine reducers, not API handlers

```ts
resolve(state, content, elapsedMs)          → { state, events }
apply(state, content, action, seed)         → { state, effects } | Rejection
```

The API becomes almost pure transport: authenticate, lock the row, `resolve`,
`apply`, persist, return. Essentially no game logic lives in `apps/api`, so there is
nothing there to get subtly wrong or to drift from the client.

This also buys original §16.3's hard requirement — **full action parity in
`sim play`** — for free rather than as ongoing maintenance. The terminal client calls
the identical functions with no HTTP in between, so a divergence between what is
possible in the simulator and in the game becomes structurally impossible.

Enforced by a lint rule: `packages/engine` may import nothing but `rational` and
`break_infinity.js`. No dates, no randomness, no fetch.

### A.3 Reuse from Satisfactory-Colab-Modeler

| Package | Plan |
|---|---|
| `rational` | **Fork as-is.** BigInt exact rational + parser. Load-time use only |
| `gamedata` | **Extend, don't drop in.** Take the indexing, validation, and icon manifest; their schema assumes one static `game_data.json`, ours needs content versions and per-player unlock state |
| `solver` | **Port the expansion, rewrite the allocation.** Their Full calculator's priority-node recipe-tree expansion is genuinely the hard part and it exists. Our semantics differ — waterfall with capacity depletion, backpressure, storage — so the allocation pass is new |
| `infra/` | Dockerfile and compose patterns, adapted for Unraid |
| `ydoc`, `doc-storage`, `realtime` | **Not used.** Single-player authoritative simulation; CRDTs have no analogue here |

### A.4 Three numeric zones, not two

Original §9 specifies two. A third is needed, because clocks do not need exactness
and BigInt in the tick loop would hurt:

| Zone | Type | Lives where | Why |
|---|---|---|---|
| **Graph ratios** | BigInt rational | **Load time only** — per-unit expansion vectors, raw-cost traces, cycle resolution | Ratios must be exact or allocation drifts across a deep graph. Computed once per (content version × active recipe set), then frozen |
| **Clocks, satisfaction, allocation** | `float64` | Every solve | All values in [0,1]. float64 carries 15 digits — far more than needed. **Zero BigInt in the hot path** |
| **Stockpiles, rates, costs, multipliers** | Decimal (`break_infinity.js`) | Economy layer, persistence | Reaches 1e600+ |

The boundary is a reviewable rule: *the solver returns fractions; the economy
multiplies fractions into Decimals.* A Decimal never enters a solve; a rational never
leaves load time.

The expansion-vector cache is keyed by `(contentVersion, activeRecipeSet)`, so
switching one alt recipe invalidates and recomputes it — cheap at 45 recipes, still
fine at 250, and it happens on a player action rather than on a tick.

### A.5 Determinism

Everything original §16.3's replay depends on:

- No `Math.random` anywhere in `packages/engine`. A seeded PRNG is passed explicitly,
  and its state is part of the save.
- No `Date.now()` in the engine. Time arrives as a parameter.
- The formatter is one pure function taking notation mode as an argument — never a
  branch at the call site (original §9).
- Decimals persist as canonical strings (`"1.2345e678"`) in JSONB, never `numeric`.
- Canonical event ordering: sort by time, ties broken by a stable id, so two machines
  never disagree about which buffer filled first.

**Runtime:** Node 22 LTS, TypeScript strict.

---

## Sections still to write

| Section | Covers |
|---|---|
| **B — Content model** | Schema, the ~35-item vertical slice, machine marks, cost/storage/QS curves, the validator, and the calibration script that derives costs from a target pacing curve |
| **C — The engine** | Solver and waterfall allocation, backpressure, Quantum Storage, power grid equilibrium, the tap, event-driven resolution in detail |
| **D — Server and authority** | Action API, database schema, SuperTokens, sessions, idempotency, rate limiting |
| **E — Simulator and testing** | `sim run` policies, `sim play` with Ink, session record/replay as regression tests, CI gates on pacing tolerance |
| **F — UI scope and build order** | What phases 1–4 render, and the revised phase breakdown |

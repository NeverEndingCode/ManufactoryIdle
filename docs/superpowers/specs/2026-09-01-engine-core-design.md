# Manufactory Idle — Engine Core Design

**Status:** Complete. Sections A–F approved. Ready for an implementation plan.
**Scope:** Spec 1 of 4 — the engine core, plus the simulator.
**Date:** 2026-09-01

This document is the design and decision record produced from the conversation held
against `manufactory-idle-spec.md`. It captures what was settled and why. **It
supersedes the original spec wherever the two disagree**; every disagreement is called
out explicitly.

---

## 1. Project decomposition

The original spec covers five progression axes, ten sub-menus, expeditions, the Deep
Core, a statistics system, PWA and push, leaderboards, a headless simulator, a terminal
client, story logs, a virtual pet, and a gardening minigame. That is too large for one
spec. It is split into four:

| Spec | Covers | Status |
|---|---|---|
| **1. Engine core** | Solver, storage, Quantum Storage, power, event-driven resolution, server authority, action API, simulator, marks, milestones | **This document** |
| 2. Progression | Alt recipes, ranks, Pioneers, Tickets, contracts, Phases, Engineer Level, disruptions, pollution | Not started |
| 3. Live content | Expeditions, Deep Core, daily contracts, achievements, leaderboards, story logs | Not started |
| 4. Statistics & platform | §13.7 statistics, graphs, PWA, push notifications | Not started |

Rationale: §16 of the original spec is correct that balance is the whole job, and
balance cannot be tuned without a simulator. The engine plus the simulator is the
smallest unit that produces something tunable.

---

## 2. Decisions

### D1 — Audience and infrastructure

**Public, with leaderboards.** Server authority, anti-cheat, and leaderboard integrity
are load-bearing and designed in from the start. SuperTokens and Postgres exist from
phase 0, per original §12.3 and §12.6.

### D2 — Licensing

The project reuses `packages/rational`, `packages/gamedata`, and `packages/solver` from
`EvanTrow/Satisfactory-Colab-Modeler`, which is **GPL-3.0**.

Consequence, accepted deliberately: Manufactory Idle is a derivative work and must also
be GPL-3.0. Because the web client ships JavaScript to every player's browser, that
constitutes distribution, so the entire project must be source-available. GPLv3 (not
AGPL) means server-side operation alone would not trigger this, but a browser game
always does.

### D3 — The growth model

The largest correction to the original spec. See §3.1 for the problem it fixes.

**Four levers, one dial:**

| Lever | Shape | Job |
|---|---|---|
| Purchase-count ladder | Stepped, default ×1.5 every 10 machines | Sets `r_eff`. The master dial |
| Machine marks (Mk1→Mk3) | Discrete, rate ×A at build cost ×B | The staircase. Restores pace at tier boundaries |
| Milestone lane multipliers | Discrete, ~×1.5 lane-wide | Surplus on top; rewards breadth |
| Overclocking | Continuous, power-gated | Player-operated dial trading power for throughput |

**Ladder thresholds must be arithmetic, not geometric.** Doubling at 25/50/100/200
(each threshold double the last) yields a multiplier *linear* in n, and no polynomial
multiplier can beat an exponential cost. A fixed interval — every 10 machines, forever
— yields `m = 1.5^(n/10) = 1.0414ⁿ`, the same shape as the cost curve, so the two
compete on equal terms.

**The master dial is the effective cost ratio:**

```
r_eff = r / m         r = cost ratio per machine
                      m = production multiplier growth per machine

default: ×1.5 every 10 machines  (m = 1.0414),  r = 1.09
  → r_eff = 1.047
```

| Condition | Machine count | Production | Feel |
|---|---|---|---|
| `r_eff > 1` | `log(t)` | `log(t)` | Slow, staircase-driven — the genre norm |
| `r_eff = 1` | linear in t | exponential in t | Knife edge |
| `r_eff < 1` | super-linear | super-exponential | Runaway; game over in an afternoon |

**Invariant: `r_eff > 1 + ε` must hold for every recipe with every multiplier maxed.**
Statically checkable by the content validator (B.6 check 8) and dynamically by the
simulator with the whole stack maxed. Far stronger than prose against original §16.4's
"runaway growth".

**Authoring inversion.** You author the **ladder** (a feel decision) and **`r_eff`** (a
pacing decision). The calibration script derives **`r = r_eff × m`**. Retuning the
ladder because it feels better therefore changes pacing by exactly zero.

**Reframe: logarithmic base growth is correct, not a bug.** Cookie Clicker, AdVenture
Communist, and ISEPS are all logarithmic and all run for years. The failure mode is not
a slowing number, it is *dead time*. The tuning target is **bounded event cadence**, not
growth rate — and `r_eff` controls it directly.

**Softcaps** (original §16.6 wants softcap, never hard-cap), applied per multiplier
category *and* again on the product, so neither a single system nor the four stacking
can drive `r_eff` below 1. Piecewise-linear rather than a power law, for the determinism
reason in E.4.

### D4 — Dismantle and Quantum Storage

**Dismantle is a general verb, not a recipe-switch special case.** In Satisfactory
anything can be dismantled anytime for full refund. Recipe switching is then just
dismantle plus rebuild — one code path.

This supersedes original §4.6's dead-purchase guard #2 (a small lane-wide logistics
multiplier on every purchase). A reversible purchase is a much stronger guard than a
consolation prize, and the consolation prize muddies the multiplier stack in D3.

**Refunds are LIFO.** Dismantling the *n*th machine returns `cost(n)` and decrements the
counter, so rebuilding costs exactly what was refunded. Symmetric; no pump.

**Quantum Storage is a second buffer tier**, not an infinite void:

```
production → Storage (capped, purchasable)
           → full? → Quantum Storage (capped, purchasable)
           → full? → backpressure
```

This preserves backpressure, preserves the fluid byproduct triangle (original §3.4 — the
residue tank fills, then QS fills, then the refinery throttles, just with more slack),
and keeps storage a real currency sink with two curves to buy rather than one.

**Dismantling ignores the QS cap**, so materials are never destroyed.

**Quantum Storage above its cap is builds-only.** Below the cap it is fully liquid —
spendable on anything, deliveries included. Above the cap, the bulge can only be
re-instantiated into machines, and becomes liquid as room opens beneath it.

Rationale — the exploit this closes:

> A milestone needs 1e9 iron plate. Storage cap is 25M and QS is 100M, so it can never
> be banked. Buy 200 constructors over a few hours (each purchase individually under the
> cap), then dismantle all 200 immediately before delivery. QS holds 4.1B plate. Deliver.

A full-stack refund is the geometric sum `base·(rⁿ−1)/(r−1)` — roughly **10× the marginal
cost of the next machine** at r = 1.09. Without the builds-only rule, storage caps stop
gating deliveries, milestones, contracts, and the AWESOME Sink, where
build/dismantle/sink becomes an infinite Engineer XP loop.

Fiction: Quantum Storage holds components in a coherent quantum state. The buffer holds
only so much before the excess must stay bound as machine matter — re-instantiable, but
not decoherable back into raw stock.

**Where decision weight lives.** Materials come back, so the cost is elsewhere:
- **Time.** Refunding six hours of banked plate does not refund the six hours, and the
  machine produced nothing while it sat in the wrong lane. In an idle game time is the
  currency.
- **The purchase ladder.** Churning machine counts moves you back down the ladder.

Free to reconsider, expensive to thrash.

### D5 — Time, authority, and the tick model

**Tick model and authority model are orthogonal.** Fixed-tick does not imply a
client-authoritative design. The tick choice is about cost and code duplication; the
authority choice is about security.

**Rejected: client-simulates, server-validates.** To check a client's claimed state the
server must compute the correct state anyway — at which point accepting the client's
version buys nothing. Approximate plausibility checks are worse: a cheater tunes the
cheat to sit inside the bounds. Validation is strictly worse than authority in every
dimension.

**Adopted:**

```
SERVER   event-driven, on demand.        ← the only thing that must be exact
         resolve(now − last_resolved_at)

CLIENT   interpolation, display only.    ← zero authority, corrected constantly
         snaps to server truth on every response
```

The server never ticks, because nothing observes intermediate state. It only needs to be
correct at the instants it is asked — an action or a page load. Eight hours offline at a
10 Hz fixed tick is ~288,000 solves; event-driven is ~5–20.

**Anti-cheat.** The client never sends state, only actions. The server reads its own wall
clock. Speeding up time is not *detected* — it has **no input channel**. Device clock
rollback, Lucky Patcher, GameGuardian, and a patched client cannot express "more time
passed." The residual attack surface is enumerated and implemented in D.5.

**The 60-second heartbeat in original §12.3 is removed.** Resolution is a pure function
of `(state, now − last_resolved_at)`, so a server crash loses nothing — the next request
recomputes it exactly. The heartbeat's only real job was flushing taps, which are
client-timed; those flush on a debounce while the player is actually tapping. A player
idling with the tab open costs zero requests rather than 1,440/day.

**Continuous randomness becomes scheduled randomness.** There are no ticks to roll on.
When a disruption ends, the next one is scheduled immediately from a seeded PRNG and
becomes a timer event. Deterministic, replayable, and consistent with original §16.6's
no-RNG-on-the-critical-path rule.

**Client efficiency.** Render frequency and scope dominate battery, not solve frequency.
The client solves zero times in steady state, drawing `stored + net·t` from the event
schedule; text updates at ~4 Hz; bars are CSS-driven on the compositor; everything pauses
on `visibilitychange`; only the visible lane updates; lists virtualized.

### D6 — Content scope for the engine spec

A vertical slice of 4 lanes, 31 items, ~44 recipes. Detailed in B.5. The full ~160-item
catalog remains a later phase.

### D7 — Anonymous play (supersedes original §12.6)

Original §12.6 rules out anonymous play. Given D1 makes this a public game, a signup wall
in front of the first click is the most expensive thing that can go there, and the
retrofit cost is asymmetric: a nullable column and one endpoint now, versus reconciling
two identity models across a live player base with leaderboard history later.

Guests get the full game with no progress gate. Design in D.4.

### D8 — Build order

Two changes from original §14: the simulator moves to phase 1 (E.1), and machine marks
plus milestone tier-unlocks move into Spec 1, because D3's staircase *is* marks and
milestones and calibration cannot solve a curve without them. Server precedes client.
Full breakdown in F.2.

---

## 3. Concerns raised against the original spec

### 3.1 The growth curve was logarithmic, unintentionally — RESOLVED (D3)

Three rules combined badly: §3.1 (only extraction creates value), §3.2
(`cost(n) = base × rⁿ`, "not optional"), and §10.1 (milestones unlock *depth*).

Time to afford miner *n+1* is `base·rⁿ / (a·n)`, so machine count and throughput both
grow as `log(t)` forever. Milestones do not fix this, because unlocking deeper items adds
no raw throughput under rule §3.1 — a tier-8 unlock makes the graph wider and more
interesting but produces exactly zero additional ore.

The spec had an exponential cost guard with no exponential production source facing it.
§16.6 names this exact failure and its stated guard is "every layer must restore pace" —
but ranks and phases are days-to-months apart, leaving nothing inside a rank.

### 3.2 Scope — RESOLVED (§1)

### 3.3 Online and offline solvers should be unified — RESOLVED (D5)

Original §8's offline algorithm is also the correct online algorithm.

### 3.4 The rational/Decimal boundary is really three zones — RESOLVED (A.4)

### 3.5 Alt recipe switching stranded investment — RESOLVED (D4)

### 3.6 Reuse assumption — VERIFIED

`EvanTrow/Satisfactory-Colab-Modeler` exists and contains `packages/solver`,
`packages/gamedata`, and `packages/rational`. Stack matches original §12.1 exactly.
Licensed GPL-3.0 (see D2).

### 3.7 Content authoring is ~2,000 tuned numbers — RESOLVED (B.1, B.7)

Original §16.2's calibration script is the right answer, but it is phase-1
infrastructure, not phase 10. Nothing is hand-authored; intent is authored and the script
solves.

### 3.8 The activity clock cannot be backfilled — RESOLVED (D.3)

§13.7's activity clock needs session windows and a stored timezone. Neither can be
reconstructed from an action log afterwards, so `players.timezone` and the `sessions`
table ship in phase 0 even though statistics are Spec 4.

### 3.9 Deferred to Spec 2

**Disruptions only spawn while active** (§5) means the more you play, the more you are
attacked. Combined with Pollution, an engaged player is strictly punished. This needs
resolving when disruptions are specified.

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

The API becomes almost pure transport: authenticate, lock the row, `resolve`, `apply`,
persist, return. Essentially no game logic lives in `apps/api`, so there is nothing there
to get subtly wrong or to drift from the client.

This also buys original §16.3's hard requirement — **full action parity in `sim play`** —
for free rather than as ongoing maintenance. The terminal client calls the identical
functions with no HTTP in between, so a divergence between what is possible in the
simulator and in the game becomes structurally impossible.

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

Original §9 specifies two. A third is needed, because clocks do not need exactness and
BigInt in the tick loop would hurt:

| Zone | Type | Lives where | Why |
|---|---|---|---|
| **Graph ratios** | BigInt rational | **Load time only** — per-unit expansion vectors, raw-cost traces, cycle resolution | Ratios must be exact or allocation drifts across a deep graph. Computed once per (content version × active recipe set), then frozen |
| **Clocks, satisfaction, allocation** | `float64` | Every solve | All values in [0,1]. float64 carries 15 digits — far more than needed. **Zero BigInt in the hot path** |
| **Stockpiles, rates, costs, multipliers** | Decimal (`break_infinity.js`) | Economy layer, persistence | Reaches 1e600+ |

The boundary is a reviewable rule: *the solver returns fractions; the economy multiplies
fractions into Decimals.* A Decimal never enters a solve; a rational never leaves load
time.

The expansion-vector cache is keyed by `(contentVersion, activeRecipeSet)`, so switching
one alt recipe invalidates and recomputes it — cheap at 44 recipes, still fine at 250,
and it happens on a player action rather than on a tick.

### A.5 Determinism

- No `Math.random` anywhere in `packages/engine`. A seeded PRNG is passed explicitly, and
  its state is part of the save.
- No `Date.now()` in the engine. Time arrives as a parameter.
- The formatter is one pure function taking notation mode as an argument — never a branch
  at the call site (original §9).
- Decimals persist as canonical strings (`"1.2345e678"`) in JSONB, never `numeric`.
- Canonical event ordering: sort by time, ties broken by a stable id, so two machines
  never disagree about which buffer filled first.
- Transcendental functions are avoided in state-affecting paths. See E.4.

**Runtime:** Node 22 LTS, TypeScript strict.

---

## Section B — The content model

### B.1 What is authored vs. what is computed

**Cost numbers are never hand-authored.** Intent is authored and a script solves for the
numbers. Original §16.2 says this; it needs to be structural, not aspirational.

```
bundles/core/*.yaml          ← hand-authored: the graph, and pacing intent
        │
        ├─ validate          ← schema, references, cycles, invariants
        ├─ calibrate         ← solves for cost ratios, storage curves,
        │                       milestone requirements
        └─ emit → core.v14.json + checksum   ← committed, loaded by migration
```

Runtime never calibrates. The built bundle is a committed artifact, so a content version
is exactly reproducible and a save pinned to v14 stays pinned to v14 (original §12.7).

### B.2 The counters — what `n` counts

```
installed[lane][machineClass][mark]     ← the one counter
```

| Reads it | Scope | Why |
|---|---|---|
| **Cost curve** | `(lane, class, mark)` | Resets on a new mark → the staircase |
| **Purchase ladder** | `(lane, class)`, **mark-weighted** | Does not reset on a new mark → upgrading never costs you your multiplier |

```
ladderInput[lane][class] = Σ_mark  installed[mark] × rateMultiplier(mark)
```

Mark-weighting is mandatory, not cosmetic — the derivation is in C.0. Counting raw
machines would make consolidating 45 Mk1 into 15 Mk2 collapse the ladder and destroy
output, so nobody would ever upgrade.

Three consequences worth being explicit about:

**Cost and ladder read the same counter.** This is what makes `r_eff = r/m` *exact*
rather than a rough estimate. If cost were per-recipe and the ladder per-lane, `r_eff`
would vary by situation and stop being tunable. They diverge only deliberately, at a mark
boundary, which is precisely the staircase mechanism.

**`n` is not per-recipe.** A Constructor is a Constructor; assigning it to Screws or Cast
Screw does not change what it cost. This keeps pillar 3 intact — the player buys "a
Constructor in the Iron lane" and assigns it, rather than managing 44 independent cost
curves.

**`n` is per-lane, and that is a feature.** A newly unlocked lane starts its cost curves
at zero, so opening a lane is itself a pace-restoring staircase event. Free alignment
with D3, no extra mechanism.

### B.3 Ladder step size

The multiplier steps but the cost climbs smoothly, so pace sawtooths:

| Ladder | m/machine | r_eff (r=1.09) | Decay within a window | Recovery | Net sawtooth |
|---|---|---|---|---|---|
| ×2 every 25 | 1.0281 | 1.060 | 8.6× | 2× | **4.3×** |
| **×1.5 every 10** | **1.0414** | **1.047** | **2.37×** | **1.5×** | **1.58×** |
| ×1.2 every 5 | 1.0371 | 1.051 | 1.54× | 1.2× | 1.28× |

**Default: ×1.5 every 10, calibration-tunable per machine class.** It keeps a visible
threshold to grind toward while holding the sawtooth under 1.6×. This is authored, not
derived, because it is a feel decision — and per D3's authoring inversion, changing it
does not move pacing.

### B.4 The three curves

| Curve | Scope | Authored | Derived |
|---|---|---|---|
| **Machine cost** | `(lane, class, mark)` | base cost items, ladder | `r` |
| **Storage cap** | per item | base cap | `s`, cost curve `sc` |
| **Quantum Storage cap** | **per lane** | per-item base | `q`, cost curve |

**QS is per-lane, not per-item.** One purchase — "Iron lane Quantum Storage level 5" —
raises every item in that lane to `base_i × q^5`. That halves the upgrade surface (35
tracks instead of 70), gives QS its own identity as lane infrastructure rather than
another bin, and delivers the lane-wide warehouse convenience original §3.3 asked for
without a separate late-game mechanism.

**Storage `s` and `sc` are derived.** Original §3.3 says caps should grow "slightly slower
than build costs" so capacity periodically blocks production. That is a *cadence*, so
author the cadence and let the script solve: `storageBindingCadence: 12`.

### B.5 The vertical slice

Four lanes, 31 items, ~44 recipes. Real Satisfactory ratios throughout.

| Lane | Items |
|---|---|
| **Iron** (9) | ore → ingot → {plate, rod} → screw → reinforced plate, rotor, modular frame, smart plating |
| **Copper** (5) | ore → ingot → {wire → cable, sheet} |
| **Coal** (7) | coal, limestone → concrete; steel ingot → {beam, pipe} → encased industrial beam |
| **Oil** (9) | crude, water, heavy oil residue, plastic, rubber, fuel, empty canister, packaged fuel, polymer resin |
| **Power** (1) | biomass |

What each piece is load-bearing for:

- **Cross-lane contention** — Steel Ingot takes iron ore *and* coal, so Iron and Coal
  compete for the same solver capacity. Encased Industrial Beam needs concrete plus steel.
- **The byproduct triangle** — Plastic (3 crude → 2 plastic + 1 HOR) and Rubber (3 crude →
  2 rubber + 2 HOR) both emit heavy oil residue. Residual Fuel (6 HOR → 4 fuel) is the
  *consume* corner, and fuel feeds Fuel Generators. Every corner of §3.4 is exercised.
- **Fluids and packaging** — water gates coal generators; Packaged Fuel exercises the
  "fluids cannot be sunk directly" rule.
- **Alt recipes** — Cast Screw (bypasses rods entirely), Steel Rod, Solid Steel Ingot, and
  **Coated Cable** (5 wire + 2 HOR → 9 cable), which makes a byproduct into a mainline
  input and gives the triangle a second consume corner.
- **A deliberate cycle** — Recycled Plastic and Recycled Rubber form a genuine SCC.
  Included so the validator's cycle detection has something real to catch, and so we can
  decide from evidence whether to ship §4.3's SCC solver or forbid cycles in v1.

### B.6 The validator (`pnpm content:check`)

Original §12.7 lists four checks. Eleven are specified — the extra ones each produce a
*permanently* stuck save rather than merely bad balance, which makes them worth a build
failure.

| # | Check | Catches |
|---|---|---|
| 1 | JSON Schema conformance | Typos |
| 2 | Reference resolution | Dangling ids |
| 3 | Every item has a producer | Unobtainable items |
| 4 | Every item has a consumer, sink target, or delivery use | Dead-end items |
| 5 | **Every byproduct has a consumer reachable at its own tier** | §3.4's stated rule — a byproduct with no outlet is a hard stall |
| 6 | SCC detection | Cycles; flags them unselectable in v1 |
| 7 | **Build costs are satisfiable at unlock tier** | Chicken-and-egg — a machine whose build cost needs an item only that machine can make |
| 8 | **`r_eff > 1 + ε` with every multiplier maxed** | D3's runaway invariant, checked statically |
| 9 | **Storage + QS cap ≥ largest single build cost at that tier** | A permanent hard wall — you could never bank enough to buy the thing |
| 10 | **Generator capacity available ≥ draw of everything unlocked at that tier** | A tier that browns out on arrival |
| 11 | Checksum + version stamp | Save integrity |

### B.7 Calibration

Input is pacing intent, expressed in **collections rather than hours** per original §16.2
— with an 8h offline cap a player gets ~3 meaningful collections a day, so a tier costing
40 collections is a two-week tier no matter what the hour count claims:

```yaml
pacing:
  targetCollectionsToTier: [2, 5, 11, 24, 52, 110, 230, 480, 1000, 2100]
  activeHoursPerDay:        2.5
  offlineCollectionsPerDay: 3
  purchaseIntervalEarly:    120s     # seconds between purchases at tier start
  purchaseIntervalLate:     1800s    # at tier end, before the staircase resets
  storageBindingCadence:    12       # machines between storage binding
```

Solves for: per-class `r_eff` (hence `r`), milestone delivery requirements, storage `s`
and `sc`, QS `q` and its cost curve.

**The calibration script is the simulator with a search wrapper.** It runs
`sim run --policy greedy` and binary-searches the free parameters until the observed curve
matches the target. There is therefore exactly one implementation of "how long does this
take," so calibrated numbers cannot disagree with measured ones. This is why the simulator
must exist before the content does (E.1, F.2).

---

## Section C — The engine

### C.0 Why the ladder is mark-weighted

A Mk2 with rate ×A means only `n/A` machines are needed for the same output. **That is the
cost-curve reset** — consolidate 45 Mk1 into 15 Mk2 and land at n=15 on the Mk2 curve
instead of n=45. With A=3 and r=1.09 the next machine costs 4.4× less while producing 3×
more.

Let mark rate be ×A and build cost ×B:

```
pace gain at the mark  =  (A/B) · r^(n·(1−1/A))
tier decay from n/A → n =        r^(n·(1−1/A))
```

**When B = A these are exactly equal.** A mark whose build cost scales with its rate is
precisely pace-neutral across a full tier cycle, so tier size is self-balancing rather
than tuned. Set B slightly below A to make the game gently accelerate; the milestone lane
multiplier is then pure surplus, which is what "every layer restores pace" wants.

With A=3, a tier spans n/A → n machines — 15 → 45, i.e. 30 machines of growth, about 4×
pace decay at `r_eff = 1.047`, exactly cancelled by the mark.

This only holds if the ladder counts mark-weighted equivalents (B.2). Counting raw
machines would collapse the ladder from ×5.06 to ×1.5 on consolidation — output drops
3.4× and nobody ever upgrades.

### C.1 State shape

```ts
type WorldState = {
  schemaVersion: number
  contentVersion: string
  seed:           PrngState              // explicit; part of the save

  installed:      Record<Lane, Record<MachineClass, number[]>>   // by mark
  assignment:     Record<RecipeId, number>
  activeRecipe:   Record<ItemId, RecipeId>

  stored:         Record<ItemId, Decimal>
  quantum:        Record<ItemId, Decimal>   // liquid
  bound:          Record<ItemId, Decimal>   // above QS cap — builds only
  storageLevel:   Record<ItemId, number>
  qsLevel:        Record<Lane, number>
  reserve:        Record<ItemId, number>

  priority:       PriorityEntry[]
  powerBank:      Decimal
  timers:         Timer[]                   // sorted by fire time

  lifetime:       Record<ItemId, Decimal>
  lastResolvedAt: number
}
```

### C.2 The three item states

Everything in the engine rests on this. Original §4.2's solver models production capacity
only and has no notion of stock, which means banked items are unusable and buffers cannot
bind. Each item is in one of three states:

```
EMPTY    stored = 0        consumption is clamped to production      (starves consumers)
FLOWING  0 < stored < cap  net rate is free                          (unconstrained)
FULL     stored = cap      production is clamped to consumption      (backpressure)
```

`FULL` means storage **and** Quantum Storage are both at cap, per D4's fill order.

Two things fall out, and they are why this abstraction earns its place:

**Stored items become usable.** A target can pull faster than production while stock
lasts. The stock drains at `demand − production`, and hitting zero is a discrete event —
exactly what the event loop already looks for.

**Backpressure and starvation are the same mechanism.** Original §5's claim that
disruption consequences "propagate in both directions with no special-case code" is only
true if this abstraction exists.

### C.3 The solver

```
solve(state, content) → { clocks, allocations, itemRates, bottleneck, power }
```

Precomputed once per `(contentVersion × activeRecipeSet)` per A.4: `perUnit[target][recipe]`.

Per solve — demand-pull waterfall in priority order, per original §4.2, with `remaining[R]`
depleted as each target takes its share, `share`-mode entries grouped and scaled
proportionally, and a 2% reserve floor so low-priority targets never read a hard 0%.

**The fixed point.** Constraints interact: pinning one item `EMPTY` changes rates, which
may push another to `FULL`.

```
1. assume every item FLOWING
2. solve
3. find violations  (stored=0 with net<0, or stored=cap with net>0)
4. none? done.
5. pin the worst violator, goto 2
```

Each iteration pins at least one item, so it **terminates in ≤ |items| passes** — a
provable bound, not a hope. At 31 items that is a worst case of 31 and a typical case of
2–4.

**Cost.** ~44 recipes × ~10 priority targets ≈ 440 ops per pass, × ~3 item-state passes,
× ~3 power passes ≈ 4,000 operations. Microseconds. An 8-hour resolve with 20 events is 20
of those.

**Bottleneck** returns `{ recipeId, limitingTarget, machinesToClear }` as first-class
output per §4.5 — never derived by the UI — or a power-shaped bottleneck instead when the
grid is binding.

**Amended 2026-09-06 (Phase 2 task 0): a third, storage-shaped kind.**
`{ kind: "storage", itemId, limitingTarget, upgrade }`, where `upgrade` is `"storage"`,
`"quantum"`, or `null` when both curves are already at `maxLevel`.

A FULL item is throttled by backpressure rather than by capacity: its producing recipe is
limited because there is nowhere to put the output, so no machine purchase can move it.
With only the two original kinds the reporter had no way to say this and fell through to
the recipe it *could* name. The `bottleneck` policy — which exists precisely to test
whether this advice is worth following (E.2) — consequently bought machines into a full
warehouse and never reached tier 2 on the fixture, stalling for 19d 23h of simulated time
with production at exactly zero.

The check is ordered ahead of the recipe branch and behind the power branch, so a browning
grid still wins. Only one level is ever recommended: the caller re-solves after buying, and
an iterative honest answer beats a "levels to clear" count derived from the same 10%-lift
heuristic that produced the bad machine advice. `upgrade: null` is deliberately an empty
recommendation rather than an invented one — that state is the permanent wall validator
check 9 exists to make unreachable.

### C.4 Power

Grid per §6.1: `powerRatio = min(1, capacity / demand)`, demand scales with clock, clock
scales with ratio, so it settles at equilibrium rather than tripping. Power is the **outer**
loop, item states the inner; ratio is a scalar in [0,1] and demand is monotonic in it, so
damped iteration converges in 2–3 passes.

**Hazard the spec misses: the power death spiral.** Generators consume fuel items drawn
from the graph (§6.3), so a brownout starves fuel production, which lowers capacity, which
deepens the brownout. Unrecoverable without intervention — and it would hit hardest
offline, violating pillar 1.

**Fix: power is a real priority entry, pinned to position 1 by default.** No new mechanism
— it reuses the waterfall the player already understands. Generators get first call on
fuel, so the spiral cannot start on its own; the player *can* deprioritize power
deliberately, and the bottleneck reporting will tell them exactly what they did.

### C.5 Storage, Quantum Storage, and spend order

```
production overflow →  stored → quantum → BACKPRESSURE
                                          (bound is never created here)

dismantle refund   →  quantum (to cap) → bound (uncapped)

spend on builds    →  bound → quantum → stored     (liquid preserved last)
spend on delivery, →  stored → quantum             (bound never touched)
  contracts, sink
```

Builds draw from `bound` first — spending the restricted resource before the liquid one is
both player-favourable and the intuitive reading. Whenever `quantum < cap && bound > 0`,
bound flows down automatically.

### C.6 The tap

§7 wants a production kick that is a *percentage* of throughput. One architectural
constraint: the MVP's exponentially-decaying kick makes rates continuously variable, which
breaks the piecewise-constant assumption the entire event model depends on.

**So the kick is a step function** — fixed magnitude, fixed duration, stacking to a cap,
with expiry as an ordinary timer event. Cheaper, and clearer to the player than an
invisible decay curve. Magnitude is calibrated against §16.4's target that an active hour
beats an idle hour by 1.5–2×.

### C.7 Event-driven resolution

```
resolve(state, content, elapsedMs) → { state, events, summary }

remaining = min(elapsed, offlineCapMs)
guard = 0
while remaining > 0 && guard++ < MAX_EVENTS:
    s = solve(state)
    t = min( nextFill, nextDrain, nextTimer, remaining )
    t = max(t, EPSILON)                      // no Zeno subdivision
    integrate all stockpiles by rate × t     // straight lines
    remaining -= t
    apply whichever discontinuity fired
```

Termination guards per D5: `MAX_EVENTS ≈ 10k` falling back to coarse fixed-step, and
`EPSILON` preventing infinite subdivision. Both are required — without them a player can
craft an oscillating factory that denies service to the server.

`summary` powers the "while you were away" report: what was produced, what filled up and
when, what stalled.

---

## Section D — Server, authority, and persistence

### D.1 The action set

```
BUY_MACHINE       { lane, machineClass, mark, count }
DISMANTLE         { lane, machineClass, mark, count }
UPGRADE_MARK      { lane, machineClass, fromMark }      ← atomic dismantle + rebuild
ASSIGN_MACHINES   { recipeId, count }
SELECT_RECIPE     { itemId, recipeId }
REORDER_PRIORITY  { entries[] }
SET_PRIORITY_MODE { entryId, mode, share?, targetRate? }
SET_RESERVE       { itemId, percent }
BUY_STORAGE       { itemId, levels }
BUY_QS            { lane, levels }
TAP               { count, clientElapsedMs }
```

`UPGRADE_MARK` is the one-tap payoff for C.0 — it dismantles every Mk*n* of a class in a
lane and rebuilds the mark-equivalent count at Mk*n+1*, paying the difference. Without it,
D4's dismantle verb turns a mark upgrade into forty-five taps of busywork.

**Actions are batched.** One POST carries an ordered list, applied in sequence. Mobile
clients queue actions across flaky connections, and the wire format becomes identical to
the `sim replay` log format from §16.3, so a real player's session file is directly
replayable.

**A failed action aborts the whole batch.** Atomic, easy to reason about, and the response
names which action failed and why.

### D.2 Request lifecycle

```
POST /api/actions
{ idempotencyKey, baseVersion, actions: [...] }

  1  authenticate                          SuperTokens session
  2  BEGIN
  3  SELECT … FOR UPDATE                   row lock on player_worlds
  4  idempotencyKey seen? → return cached response
  5  resolve(state, content, now − last_resolved_at)
  6  validate + apply each action in order
  7  persist state, last_resolved_at = now, state_version++
  8  append to action_log
  9  COMMIT
 10  → { state, eventSchedule, summary, stateVersion }
```

`eventSchedule` is what lets the client interpolate exactly per D5 — it carries the next
boundary so the client draws straight lines and never solves.

`baseVersion` is **advisory only**, for telemetry. Multi-device play is expected, and
correctness comes from the row lock plus server-side affordability validation, not from
optimistic concurrency.

### D.3 Schema

**Content is one row, not ten tables.** Spec §12.5 normalizes content across `lanes`,
`items`, `recipes`, `recipe_inputs`, `machines`, and more. But B.1 already emits a single
validated, checksummed JSON bundle, and the engine loads the whole thing into indexed
in-memory structures at startup. Normalized tables would be read exactly once per process
and never queried again. Admin tooling reads the built bundle from disk, or uses Postgres
JSON operators.

```sql
content_versions(version pk, checksum, bundle jsonb, published_at)

players(
  id uuid pk,
  supertokens_user_id  text unique null,     -- null for guests
  guest_token          text unique null,     -- client-generated, localStorage
  display_name         text,
  timezone             text not null default 'UTC',
  created_at           timestamptz,
  last_seen_at         timestamptz not null,
  current_rank int, lifetime_tickets numeric, leaderboard_score numeric
)
-- exactly one of supertokens_user_id / guest_token is non-null

player_worlds(
  id uuid pk,
  player_id uuid references players,
  world_type text, expedition_id text null,
  content_version  text not null,
  state            jsonb not null,
  state_version    bigint not null,
  last_resolved_at timestamptz not null,
  schema_version   int not null,
  unique(player_id, world_type, expedition_id)
)

action_log(id bigserial pk, player_id, world_id, actions jsonb,
           idempotency_key, created_at)      -- monthly partitions, 30d retention

idempotency(key pk, player_id, response_hash, created_at)   -- 24h TTL

sessions(id bigserial pk, player_id, opened_at, closed_at, client)
```

**`timezone` and `sessions` ship in phase 0** even though statistics are Spec 4, per §3.8.

State size is a few KB at 31 items, tens of KB at the full 160 — comfortably inside TOAST,
with one write per action.

### D.4 Auth and anonymous play

SuperTokens self-hosted core as its own container, EmailPassword plus Discord and GitHub
(§12.6). Session middleware on every `/api` route.

**Guests are supported** (D7). A first-time visitor gets a guest row and a real
server-side world — full engine, full offline accrual, full statistics. Claiming folds
into the lazy row creation that already exists: on the first authenticated request, if the
request carries an unclaimed guest token, adopt that row instead of creating a fresh one.

```
POST /api/auth/claim   { guestToken }
  → players row exists with that token, supertokens_user_id IS NULL?
      attach supertokens_user_id, null the guest_token — one transaction
```

Because the claim happens *before* a new world would be created, there is no merge
conflict to resolve.

**No gate on progress** — that would be exactly the dark pattern pillar 1 rules out. The
honest limitations do the persuading:

| | Guest | Account |
|---|---|---|
| Full game, offline accrual, statistics | Yes | Yes |
| Survives clearing browser storage | **No** | Yes |
| Cross-device | **No** | Yes |
| Leaderboards | No | Yes |
| Push notifications | No | Yes |

§13.8 already notes iOS evicts PWA storage for unused apps, so "sign up so you don't lose
this" is a true statement rather than a manufactured one. Surface it after the player has
something worth keeping — first milestone, not first load.

**Abuse control.** Guest creation rate-limited per IP (~5/hour); guest worlds with
`last_seen_at` older than 30 days deleted nightly; leaderboard queries filter
`WHERE supertokens_user_id IS NOT NULL`.

### D.5 Anti-cheat, implemented

| Guard | Implementation |
|---|---|
| Elapsed time | Server wall clock only. `clientElapsedMs` is never trusted for anything but tap ceiling arithmetic |
| Tap ceiling | `maxTaps = elapsedSinceLastFlush / 50ms`, clamped server-side, surplus discarded silently |
| Action rate | Per-player token bucket, ~30 requests / 10s |
| Double-resolve | `SELECT … FOR UPDATE` + resolve and write in one transaction |
| Replay | Idempotency key, 24h window, cached response returned verbatim |
| Illegal actions | Validated against the player's **pinned** content version |
| Resolve-cost DoS | `MAX_EVENTS` + `EPSILON` from C.7 |

Leaderboards land in Spec 3, but the denormalized `players` columns and the `action_log`
retention window exist from phase 0 — retroactive invalidation is impossible without the
log.

### D.6 Content version pinning, before ranks exist

§12.7 makes rank-up the migration point. Spec 1 has no ranks, so a world pins a version
and never migrates. For the development period that means an explicit admin migrate
endpoint plus occasional wipes.

### D.7 The handler, in full

All the game logic that lives in `apps/api`:

```ts
const { state, events, summary } = resolve(world.state, content, now - world.lastResolvedAt)
let s = state
for (const action of body.actions) {
  const r = apply(s, content, action, seed)
  if (r.rejected) return reply.code(409).send({ failedAction: action, reason: r.reason })
  s = r.state
}
await persist(tx, world.id, s, now)
```

Every API instance is stateless apart from an LRU cache of content bundles by version, so
scaling out is just adding instances. The row lock serializes per world, which is the only
serialization the game needs.

---

## Section E — Simulator and testing

### E.1 The simulator is phase 1

§16.3 puts it in phase 4. B.7 makes that impossible: calibration *is* the simulator with a
search wrapper, so content cannot be authored without it, and there is no game without
content.

```
engine core  →  simulator  →  calibrated content  →  a playable game
```

§16.6 closes with "balancing is the whole job… it cannot be done by inspection" — that is
only actionable if the measuring instrument exists before the thing being measured.

### E.2 `sim run` — batch mode

```
sim run --policy greedy --content v14 --until tier:10 --report json
sim run --policy casual --seed 42
```

| Policy | Behaviour |
|---|---|
| `optimal` | Perfect ordering. The upper bound |
| `greedy` | Buy the cheapest available upgrade |
| `casual` | Checks in 3×/day, never reorders priorities. The lower bound |
| **`bottleneck`** | Always buys exactly what §4.5's bottleneck reporter recommends |

The fourth policy answers the only question that matters about the game's advice
mechanism: **is the advice actually good?** If `bottleneck` lands materially worse than
`greedy`, the UI is lying to players and no amount of balance tuning fixes that.

Reported per run, in **collections** rather than hours per §16.2:

- Time to each tier, rank, phase
- **Max time-between-meaningful-events** — §16.6's pace-decay detector, as a hard number
- Observed `r_eff` vs authored
- Which recipe was the binding constraint, and for how long

### E.3 `sim play` — interactive

Ink-based, with time warp as a first-class verb and full action parity, which A.2 gives
for free. Two commands beyond §16.3's list:

- **`explain <item>`** — why a rate is what it is: which constraint bound, which state each
  upstream item is in, what the fixed point pinned and in what order. Debugging the C.3
  solver interactively will be the most-used feature in the tool.
- **`assert <expr>`** — turns an exploratory session into a committed regression test
  without leaving the REPL.

### E.4 Replay, and a determinism hazard

D.1 made the wire format identical to the replay format, so a real player's `action_log`
replays directly.

That only works if A.5's determinism holds, and there is a trap: **IEEE-754 guarantees
`+ − × ÷` are identical across platforms, but `Math.pow`, `exp`, and `log` are not.** They
are libm-dependent and vary by platform and Node version. A game built on `rⁿ` and
`(M/T)^p` walks straight into it.

| Where | Fix |
|---|---|
| Cost curves `base · rⁿ` | **n is always an integer** — exponentiation by squaring. Exact and platform-stable |
| Softcaps `T·(M/T)^p` | **Piecewise-linear softcap, not a power law.** Deterministic, visually indistinguishable |

`break_infinity.js` still uses transcendentals internally at very large magnitudes, so full
byte-equality is not achievable at the top of the range. Replay comparison therefore uses:

- **Exact equality** for all discrete state — machine counts, levels, priority order, item
  states, event ordering
- **Relative tolerance 1e-12** for Decimal magnitudes

Discrete divergence is a bug; magnitude divergence in the last digits is physics.

### E.5 CI gates

- `content:check` — all eleven checks from B.6
- `greedy`, `casual`, and `bottleneck` all land within tolerance of
  `pacing.targetCollectionsToTier`
- Max dead time under threshold
- `r_eff > 1 + ε` with every multiplier maxed
- Replay determinism: same log twice, identical discrete state

A full 10-tier greedy run is a few thousand solves — seconds in CI.

### E.6 How the engine gets tested

TDD throughout, with properties rather than examples carrying the weight:

| Property | Guards |
|---|---|
| `resolve(s, 2t) ≡ resolve(resolve(s, t), t)` | **The one that matters most.** Offline and online cannot disagree if this holds |
| Conservation — nothing created outside extraction | §3.1's core economic rule |
| Adding a machine never decreases output | §4.6's dead-purchase guard, as an invariant |
| The C.3 fixed point terminates in ≤ \|items\| passes | The provable bound, on random states |
| An item at cap never has positive net rate | Backpressure |
| `bound > 0` ⟹ `quantum == qsCap` | D4's Quantum Storage invariant |
| Buy N then dismantle N returns exactly what was paid | LIFO symmetry |

Plus golden tests on hand-computed scenarios, and a fuzzer pushing random states through
`resolve` asserting no NaN, no negative stock, and that the C.7 guards never trip on
legitimate input.

---

## Section F — UI scope and build order

### F.1 What Spec 1 renders

Five surfaces. Everything else in §13 belongs to Specs 2–4.

**Lane view (§13.1)** — lane tabs, item rows carrying name, rate, and satisfaction bar;
split bars on contested items; the bottleneck frame on exactly one row per lane per §4.5.

A row now has three storage tiers to show. Staying inside §13.0's density budget:

```
Iron plate                              412.0 /s
  ████████████████████░░░░  8.2M / 25.0M
  QS 100.0M ▲   BOUND 4.01B
```

Storage is the primary readout; QS and BOUND chips appear only when non-zero, so early
game looks exactly like the MVP and complexity arrives only once the player has met it.

**Buy drawer** — machine class and mark, cost, and three things the design demands:

- Projected effect before purchase (§4.6 guard #1 — the one guard that survived D4)
- **Ladder progress** — "12 more Constructors → ×1.5". B.3's goal-chasing element; if it
  is not visible the ladder does nothing for feel
- The `UPGRADE_MARK` button when a mark is available, showing the consolidation
  ("45 Mk1 → 15 Mk2")

**Priority list (§13.3)** — drag reorder, Simple/Advanced toggle. Power sits pinned at
position 1 per C.4, movable but with an explicit warning.

**Power bar and tap (§13.2)** — docked, demand against capacity, holdable tap target. C.6
made the kick a step function, so the remaining duration is shown rather than left
invisible.

**Handbook (§13.4)** — §16.6 is blunt that needing an external calculator means the UI
failed. The "traces back to" raw-cost expansion is the best defence, and A.4's precomputed
per-unit vectors give it for free.

§13.6's motion rules and §13.8's responsive rules apply from the first screen.

### F.2 Build order

| Phase | Deliverable | Ends in |
|---|---|---|
| **0** | Monorepo, Postgres, SuperTokens, engine skeleton, content schema + validator, CI | Green pipeline |
| **1** | **Engine + simulator.** Solver, item states, storage/QS, power, resolve, marks, milestones. `sim run` + `sim play`. Placeholder content | **A playable game in the terminal** |
| **2** | **Calibrated content.** The B.5 vertical slice, calibration script, all 11 checks, CI pacing gates | A game that is *paced* |
| **3** | **Server + authority.** Action API, schema, SuperTokens, guests, idempotency, rate limits | A game with a backend |
| **4** | **Web client** against the real API from its first render | A game other people can play |

Each phase ends in something real, and the risk is front-loaded: the engine and the
balance curve are the hard parts, React screens are not.

Phase 1 ending in a playable terminal game is not a consolation prize — §16.3 is explicit
that play mode "is not a developer-only tool… it will get more use than the batch mode."

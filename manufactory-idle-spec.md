# MANUFACTORY IDLE — Technical & Design Specification

An idle/incremental factory game that takes AdVenture Communist's
lane-and-tier progression structure, replaces its free-cascade economy with a real
recipe graph drawn from Satisfactory, and adds a power grid with Spaceplan-style
manual generation.

Target: a genuinely idle game with no ads, no dark patterns, no monetization, that
stays interesting for years. Self-hosted.

---

## 1. Design pillars

1. **Idle at its core.** The player should be able to close the app for a day and
   come back to meaningful progress. Nothing decays. Nothing is lost by not playing.
2. **Challenge lives in decisions, not in labor.** The player never micromanages a
   production line. They choose recipes, order priorities, and budget power. The
   engine does all routing and arithmetic.
3. **No management-game surface area.** No belts, no placement, no ratios to hand-solve.
   If the player has to do math the engine could do, that is a design bug.
4. **Every purchase must visibly help.** A deep machine bought into a starved lane
   feels dead. Guard against this explicitly (§4.6).
5. **Content is data.** The recipe graph is a versioned seed file, not code. It will
   be rebalanced for years.

---

## 2. Terminology

| Manufactory Idle term | AdComm equivalent | Notes |
|---|---|---|
| Lane | Industry | Iron, Copper, Limestone, Oil, Caterium, … |
| Item | Resource | ~160 from Satisfactory + invented items |
| Recipe | — | Inputs → output, at a rate, in a machine, drawing power |
| Machine | Generator | Player owns N machines assigned to a recipe |
| Pioneer | Researcher | Card-based meta progression; survives rank wipe |
| Rank | Rank | Full prestige wipe |
| Milestone | — | Tier unlock inside a rank |
| Ticket | Science | Spent on Pioneer levels |
| Contract | Mission | Gates rank-up |
| Disruption | — | Alien attack; stalls a node |
| Expedition | Event | Limited-time parallel world (moon, undersea, …) |

Open: whether "Ticket" is the right name for the Pioneer currency.

---

## 3. Economic model — hybrid

This is the single most important decision in the spec and everything else follows
from it.

### 3.1 Two classes of recipe

**Extraction recipes** have no inputs. A Miner produces Iron Ore from nothing at a
fixed rate. This is the only place value enters the economy, and it is the reason
numbers can grow without bound for years.

**Conversion recipes** consume inputs and produce outputs. A Smelter consumes
30 Iron Ore/min and produces 30 Iron Ingot/min. Conversion never creates value; it
transforms it.

Consequence: total economic output scales with extraction machine count multiplied
by Pioneer multipliers, exactly like AdComm. The recipe graph shapes *what* you can
make and *how efficiently*, not *how much* raw throughput exists. This keeps the
growth curve uncapped while making the recipe graph meaningful.

### 3.2 What a purchase costs

There is no Comrade-equivalent gating currency. A machine costs:

- **Items** — a build cost drawn from the recipe graph itself (e.g. an Assembler
  costs Reinforced Iron Plates and Rotors). Deducted from storage on purchase.
- **Power headroom** — the machine adds to grid demand. It can be built without
  headroom, but doing so browns out the whole grid (§6).
- **Storage** — build costs are paid from stored items, so storage capacity is an
  implicit gate on how large a single purchase can be.

Build costs come out of storage, which means the player must have *banked* the items,
not merely be producing them. This is the throttle that Comrades provided in AdComm.

**Build costs must inflate with machine count.** This is not optional. AdComm could
keep generator prices flat because Comrades gated every purchase; with that gate
removed, a flat price means the moment you can afford one miner you can afford
infinite miners, and growth runs away immediately. Machine cost must follow
`cost(n) = base × r^n` where `n` is the count already owned of that machine on that
recipe. A ratio in the 1.07–1.15 range gives clean logarithmic growth in machine
count over time, which is what produces a months-long curve rather than a weekend
one. This ratio is the single most important number in the game and belongs in the
content bundle, per machine class, not hardcoded.

### 3.3 Storage rules

Storage is for **overage only**. An item is banked only when production exceeds
current consumption. Items flowing directly from producer to consumer never touch
storage and are not capped by it.

- Each item has a storage cap. Caps are upgradeable and are a major currency sink.
- When an item's buffer hits cap, its producers **backpressure**: they throttle down
  to match actual consumption. They do not stop and they do not waste.
- The player may optionally pin a **reserve percentage** on any item, diverting that
  share of production to storage even when downstream demand exists. Used to bank
  for an upcoming contract or build cost.

**Storage caps are purchasable but bounded.** Each item has a base cap and a purchased
capacity level. Cap grows geometrically per level (`cap = base × s^level`, suggest
s ≈ 1.6) while the cost of each level grows faster, so capacity is always buyable but
never free and never unbounded. Additional hard ceilings:

- A per-item maximum level, raised by milestones and by Storage-category Pioneers.
  Without a ceiling, storage upgrades become the dominant strategy and flatten
  everything else.
- **Storage caps should grow slightly slower than build costs.** This makes storage a
  real pacing gate: periodically the next machine you want costs more than you can
  bank, and you must invest in capacity before you can invest in production. That
  alternation is a large part of what makes the mid game interesting rather than a
  straight line.
- Warehouse-tier upgrades that raise caps across a whole lane at once, as a
  late-game convenience so the player is not buying 160 individual upgrades.
- Offline: a maxed buffer simply stops accepting. If Iron Rod storage fills after
  20 minutes of an 8-hour offline window, no further rods are banked — but every
  downstream item that consumes rods continues to be calculated for the full window
  (§8).

---

### 3.4 Fluids

Fluids are deliberately **not** just items with a different icon.

**The byproduct triangle** is the centrepiece and the most interesting thing about
fluids. Several fluid recipes emit a byproduct — heavy oil residue, used water, spent
coolant. If nothing consumes it, its tank fills and the producing machine backpressures
to a stop, taking the whole downstream chain with it. This drops straight into the
existing backpressure model (§3.3) with no new engine code.

When a byproduct backs up, the player has three options, presented inline on the row:

| Option | Cost | Character |
|---|---|---|
| **Consume** — build a machine that uses it (residue → fuel → power) | Build cost, power capacity, planning | The correct answer. Turns waste into value. |
| **Reinject** — a well that voids it | ~18 MW sustained | Always available, never free, no hidden cost |
| **Dump** — one tap, instant | Raises Pollution (§5.1) | Free right now, paid for later |

This triangle is the recurring decision that makes fluid lanes different from item
lanes. Two rules keep it fair: **every byproduct in the graph must have at least one
real consumer recipe reachable at the tier it appears**, and dumping must never be the
only way out of a situation.

The remaining differences:

- **Tanks, not storage.** Fluids use tank capacity on a separate, tighter upgrade curve.
  Tanks are small relative to throughput, so fluid lanes run tight and react fast to
  disruption. This is what makes byproduct backup happen in minutes rather than hours.
- **Fluids cannot be sunk or spent directly.** They must run through a Packager into
  canisters before delivery to the AWESOME Sink or use in a build cost. Packaging costs
  an item input and power, making "package this surplus or reinject it" a real
  recurring choice.

Fluids are otherwise ordinary nodes in the solver — same clock, same satisfaction, same
allocation. The differences are all in the content data and the tank rules.

---

## 4. The solver

### 4.1 Player intent

The player maintains one ordered list: **output priority**. Entries are finished or
intermediate items the player wants produced. Each entry has:

- position (drag to reorder)
- mode: `guaranteed` (waterfall) or `share`
- optional target rate (default: unbounded — take as much as possible)
- paused flag

The player never allocates an intermediate. If Screws feed both Reinforced Plates and
Rotors, the split is a *consequence* of where those two sit in the priority list. The
UI shows the resulting split as a read-only bar on the Screws row.

**Two modes, one list.** The list has a Simple/Advanced toggle. Simple mode exposes
only drag-to-reorder and pause — enough to play the whole game, and the default for
new players. Advanced mode reveals per-entry controls on the same rows:

| Control | Effect |
|---|---|
| `guaranteed` / `share N%` | Waterfall, or split the remainder with other share entries at a set weight |
| Target rate cap | Stop pulling once this target hits N/s, freeing inputs for entries below it |
| Reserve % | Divert a share of this target's output to storage rather than to consumers |
| Pause | Remove from allocation entirely |

Advanced mode must be strictly additive. Any state reachable in Advanced must remain
comprehensible when the player toggles back to Simple — never hide a setting that is
still in effect. Show a small indicator on rows carrying non-default advanced settings
while in Simple mode, with a tap to reveal.

### 4.2 Allocation algorithm

Demand-pull, processed in priority order.

```
solve(state) -> { clocks, allocations, itemRates, bottlenecks }

precompute:
  for each recipe R: capacity[R] = machineCount[R] * baseRate[R] * multipliers[R]
  remaining = copy(capacity)
  rawRemaining = extraction capacities

for each target T in priority order (skipping paused):
  subtree = expand(T)        # memoized recursive expansion via selected recipes
  perUnit[R] = units of R's output consumed per unit of T   # for all R in subtree

  maxRate = min over R in subtree of ( remaining[R] / perUnit[R] )
  alloc   = min(targetRate[T] ?? Infinity, maxRate)

  for each R in subtree:
    used = alloc * perUnit[R]
    remaining[R] -= used
    allocations[R][T] = used        # this is what drives the split-bar UI

  bottleneck[T] = argmin R          # the recipe that limited this target
```

`share`-mode entries are grouped: compute each member's independent `maxRate`, then
scale the group proportionally so their combined draw fits the remaining capacity.

**Reserve floor.** Before the waterfall runs, reserve a small fraction (suggest 2%)
of every contested intermediate for targets below the waterline. This prevents a
low-priority target from sitting at a hard 0% and reading as broken, without
violating conservation — the reserve is real throughput, not a fake floor.

### 4.3 Recipe cycles

Parts of the Satisfactory graph contain loops (residual fuels, recycled plastic/rubber).
Naive recursive expansion will not terminate.

- Detect strongly connected components in the selected-recipe graph at load time.
- Any SCC of size > 1 is solved with a local fixed-point iteration (bounded at ~20
  passes, damped 0.5) and treated as a single composite node by the outer waterfall.
- **v1 may forbid cyclic recipes entirely** and flag them as unselectable. Ship this
  way if it saves time; the SCC path can be added later without changing the outer
  algorithm.

### 4.4 Alt recipes

An alt recipe is a second `Recipe` row producing the same item with different inputs.
Selecting it changes which edges `expand()` traverses. Nothing else changes — the
solver reallocates automatically on the next tick, which is exactly the "the game
should be smart enough to take resources from wherever it needs" requirement.

Recipe selection is per-item and global (one active recipe per output item at a time
in v1). A later enhancement can allow split production across two recipes for the
same item, but do not build that first.

### 4.5 Bottleneck reporting

Every solve returns, per priority target, the single recipe that limited it, plus the
quantity of additional machines that would clear the constraint. This is the primary
tool the player uses to decide what to buy next, and it replaces the spreadsheet work
that would otherwise make this a management game.

UI contract for bottlenecks:

- **Exactly one row per lane carries the bottleneck treatment** — the actual binding
  constraint. Marking every row below 100% teaches the player to ignore the marking.
  If several targets are limited by different recipes, highlight the one limiting the
  highest-priority target.
- The highlighted row is framed in the danger role, not merely tinted, so it survives
  a glance at arm's length.
- The row states the consequence in plain language ("Limiting rotor") and the fix as a
  concrete number ("6 more constructors clears it").
- The row carries the buy button for that fix. Diagnosis and action are one gesture.
- If the binding constraint is power rather than a recipe, the bottleneck surfaces on
  the power bar instead, with the same framing and a generator purchase.
- A lane with no bottleneck shows nothing. Absence of the marker must be meaningful.

The solver must therefore return `bottleneck: { recipeId, limitingTarget, machinesToClear }`
as a first-class output, not something the UI derives.

### 4.6 The dead-purchase guard

In AdComm, buying a tier-8 generator instantly lifts everything below it. In a hybrid
economy, buying a deep machine does nothing if its inputs are starved. Mitigations,
all three of which should ship:

1. The buy button shows projected effect *before* purchase ("+0/min — Screws limited").
2. Every machine purchase grants a small permanent lane-wide logistics multiplier, so
   a purchase is never literally worthless.
3. Machines that would be starved are visually marked in the buy list, with the
   blocking item named and a shortcut to buy *that* instead.

---

## 5. Satisfaction and disruption

Every recipe resolves to a single `clock` value in [0, 1]:

```
clock[R] = min( inputSatisfaction[R], powerRatio, disruptionFactor[R] )
```

- `inputSatisfaction` falls out of the allocation pass.
- `powerRatio` is grid-wide (§6).
- `disruptionFactor` is 1.0 normally, reduced by an active Disruption.

**Disruptions** (alien attacks) target a single recipe node and set its
`disruptionFactor` low for a duration. The consequences propagate in both directions
through the existing math, with no special-case code:

- **Downstream**, satisfaction propagates. Disrupt Screws → Rotors starve → anything
  needing Rotors starves.
- **Upstream**, backpressure applies. Screw demand collapses → Iron Rods accumulate →
  rod buffer fills → rod machines throttle at the buffer edge. Rods are still being
  produced and banked, exactly as specified.

Disruptions self-recover on a timer. The player may end one early by tapping (§7) or
by spending items on a defense structure. Disruptions never destroy machines and
never remove progress. They drain power and stall lanes; that is all.

Disruptions should be **suppressed or heavily damped while offline** — coming back to
a factory that was stalled for six hours violates pillar 1. Suggest: disruptions only
spawn while the session is active, and any active disruption is resolved at the moment
the session ends.

### 5.1 Pollution

Disruptions are not purely random. Their frequency and severity scale with a
**Pollution** stat, which the player controls.

- Dumping a fluid byproduct (§3.4) is the primary source. Pollution added scales with
  volume dumped relative to current throughput, so a dump is proportionally costly at
  any stage of the game.
- Pollution **decays continuously** and is capped. Tune decay so that a player who
  never dumps trends to zero without effort, and a player who dumps occasionally
  recovers within hours.
- Pollution raises disruption spawn rate and duration on a smooth curve, never a
  threshold. There should be no cliff the player falls off.
- Pioneers and Phase upgrades can reduce pollution per dump and accelerate decay.

**Why this matters beyond flavour.** It converts disruptions from a dice roll into a
consequence. An attack becomes something the player can explain — four dumps during a
contract push, now paying for it — which is far more satisfying than randomness, and
it is consistent with the no-RNG-on-the-critical-path rule in §16.6. It also gives the
mid game a genuine risk/reward dial the player operates deliberately.

**Guards.** Pollution must never become unrecoverable, must never be required to
progress, and its meter must be visible whenever a Dump button is. The player should
always be able to see the bill before choosing to run it up.

---

## 6. Power

### 6.1 Grid model

- Every machine has a power draw. Grid demand = Σ (draw × clock).
- Generators have a capacity. Grid capacity = Σ generator output.
- `powerRatio = min(1, capacity / demand)`.

Because demand scales with `clock` and `clock` scales with `powerRatio`, the grid is
self-balancing: it settles at an equilibrium rather than tripping. Resolve by iterating
Phase A at `powerRatio = 1`, computing demand, rescaling, and re-running. Converges in
2–3 passes. **The grid never trips to zero.** Brownout is a smooth slowdown, which is
required for the offline case.

### 6.2 Storage

Power Storage banks surplus energy (MWh). When demand exceeds capacity, banked energy
is drained first and `powerRatio` stays at 1.0 until the bank is empty. This gives
burst headroom for contract pushes and absorbs disruption spikes.

### 6.3 Generators

Mirror Satisfactory's progression, all as ordinary recipes that consume fuel items:
Biomass Burner → Coal Generator → Fuel Generator → Geothermal → Nuclear. Fuel is drawn
from the graph like any other input, meaning power generation competes for resources
with production — a real tradeoff, and a natural place for alt recipes to matter.

---

## 7. Manual input (the tap)

Two mechanics, both from Spaceplan's Kinetigen by way of Egg Inc:

- **Tap** — injects power into the grid *and* applies a production kick.
- **Hold** — same effect at ~80% of the manual tap rate. Thumb relief without making
  manual tapping pointless.

**The production kick must be a percentage of current throughput, not a flat amount.**
A flat +500 items is enormous at rank 3 and invisible at rank 80. A percentage keeps
tapping relevant into late game, which is the stated goal.

Power injected per tap should also scale, but more slowly than the production kick, so
that early game tapping is genuinely about keeping the lights on and late game tapping
is about burst throughput.

Server-side rate limiting on tap actions is mandatory (§12.4).

---

## 8. Offline resolution

Offline progress is **integrated, not simulated tick-by-tick.** The engine solves the
steady state and integrates forward, breaking only at discrete events.

```
resolveOffline(state, elapsedSeconds):
  remaining = min(elapsedSeconds, offlineCapSeconds)   # default 8h, upgradeable
  while remaining > 0:
    solution = solve(state)
    netRate[i] = production[i] - consumption[i]  for each item i

    # find the next discrete event
    tFill = min over items with netRate > 0 of (cap[i] - stored[i]) / netRate[i]
    tDrain = min over items with netRate < 0 of stored[i] / -netRate[i]
    t = min(tFill, tDrain, remaining)

    advance all stored[i] by netRate[i] * t
    remaining -= t
    if t == tFill: mark that item's producers as backpressured, continue loop
    if t == tDrain: continue loop
```

In practice this terminates in a handful of iterations. Cost is bounded and it exactly
implements the storage rule: a buffer that fills at 20 minutes stops accepting, its
producers throttle, and everything downstream keeps being calculated for the full
window.

**Buffers should not bind for items actively feeding a priority target.** Otherwise an
8-hour cap becomes a 20-minute cap in practice and the offline upgrade is a lie. Items
that nothing is currently pulling on are capped normally.

The 8h cap is extendable through Pioneers and milestone upgrades. Consider a reduced
trickle beyond the cap as a later addition; do not build it first.

---

## 9. Numbers

**Two numeric types, used in different places.** This is a correctness and performance
requirement, not a preference.

| Domain | Type | Why |
|---|---|---|
| Recipe ratios, per-unit expansion vectors, solver internals | Exact BigInt rational | Ratios must be exact or allocations drift and rounding compounds across a deep graph. Magnitudes here are small — `1/3`, `4/1`, `0.25` — so BigInt is cheap. |
| Stockpiles, rates, build costs, Pioneer multipliers | Mantissa/exponent decimal (`break_infinity.js`) | Magnitudes reach 1e600+. An exact rational at that magnitude is a multi-thousand-digit BigInt and will destroy the tick loop. |

The boundary is clean: the solver computes exact ratios and clock fractions, the
economy layer multiplies those ratios into Decimal magnitudes. Never let a Decimal
enter the solver's ratio math, and never let a stockpile become a rational.

- Persist Decimals as a canonical string (`"1.2345e678"`) in JSONB. Never as `numeric`.
- Display notation: K, M, B, T, then two-letter (aa, ab … az, ba …) then three-letter,
  matching the AdComm convention players will already recognize.
- The formatter is shared client/server and must be pure and deterministic.

**Notation is a player setting.** Idle players have strong preferences here and it costs
almost nothing to support several. Offer in settings, applied globally and instantly:

| Mode | Example |
|---|---|
| Scientific | `1.23e45` |
| Engineering | `123.4e42` |
| Standard names | `1.23 quattuordecillion` |
| Letter — short | `1.23 K / M / B / T`, then `aa, ab … az, ba` |
| Letter — doubled | AdComm style: `AA, BB, CC …` |
| Hybrid | Names up to a threshold, then scientific |

Default to Hybrid. Store the choice in player preferences, not world state, so it
survives every reset. The formatter must be a single pure function taking mode as an
argument — never branch on mode at call sites.

---

## 10. Progression

### 10.1 Milestones (within a rank)

Satisfactory-style tier unlocks. Delivering items to the HUB equivalent unlocks new
machines, recipes, and lanes. This is the moment-to-moment progression loop and the
main pacing lever.

### 10.2 Alt recipe acquisition

Alt recipes come from **Hard Drives**, redeemed through the MAM. There is no map to
explore, so drives drop from play instead:

- Level-up reward boxes (the primary source)
- The Deep Core (§11.5)
- Disruption defence
- Daily contracts and Expedition milestones

**The scan.** A Hard Drive is loaded into the MAM and takes **12 real hours** to scan.
One slot to start; additional slots unlock through Engineer Levels and Phases. The
scan is wall-clock and resolved server-side, so it runs while the player is away.

**The choice.** On completion the MAM offers **three** alt recipes and the player must
pick one. The two not chosen **return to the pool** and can appear in a later scan.
Nothing is ever permanently lost — that is the no-hardwall rule from §10.7 applied
here. There is no re-roll and no skip; the choice is the point.

Weight the offered three toward recipes relevant to the player's current lanes, with
one deliberate wildcard from a lane they have barely touched. A pure random draw from
250 recipes produces mostly useless offers late in the game.

Once unlocked, an alt recipe is permanent and survives rank wipes and Phase resets.

### 10.3 Ranks (prestige)

Full AdComm-style wipe. On rank-up:

- All machines, items, storage, power, milestones, and priority lists reset
- **Pioneers, Pioneer levels, unlocked alt recipes, Tickets, achievements, and
  leaderboard history are retained**
- The next rank's contracts require materially larger numbers

Contracts available per rank should exceed contracts required, so the player can skip
the two or three worst ones — this is what keeps ranks from becoming a wall.

### 10.4 Pioneers

The meta-progression layer, and the only thing that makes a rank wipe a net gain.

**Acquisition is deterministic.** Specific Pioneers are earned from specific contracts,
milestones, and Expedition thresholds. No gacha for first acquisition. Duplicates are
awarded from capsules (daily contracts, rank-ups, Expedition rewards) and are spent to
level an already-owned Pioneer, exactly as AdComm does.

Pioneer categories, mirroring AdComm's spread:

| Category | Effect |
|---|---|
| Machine | Multiplies output of one specific machine type |
| Line | Multiplies output of an entire lane |
| Output | Multiplies a specific item's production |
| Efficiency | Reduces input requirements for a recipe class |
| Power | Increases generator output or reduces machine draw |
| Storage | Increases storage caps |
| Luck chance | Frequency of bonus drops |
| Luck bonus | Magnitude of bonus drops |
| Offline | Extends the offline cap |
| Ticket | Increases Ticket yield |

Rarity tiers gate max level. Levels cost duplicates plus Tickets.

Balance note from AdComm: luck-bonus researchers are worth roughly ×4 per level where
a common is worth ×2, which made them dominant. Decide deliberately whether to
replicate that or flatten it.

### 10.5 Tickets

Earned when an item's lifetime produced count crosses a power of ten, with the amount
scaling by lane depth (AdComm's science model — it rewards breadth, which fits a
recipe graph well). Also from contracts and the sink equivalent. Spent exclusively on
Pioneer levels.

---

### 10.6 Phases — the third prestige layer

Ranks alone cap out. A dedicated player will exhaust the rank ladder and stall. The
third layer is **Project Assembly**, which is Satisfactory's own endgame and fits
without inventing anything.

**Trigger.** At a sufficiently high rank, a Project Part set becomes deliverable.
Delivering it completes a Phase.

**What resets.** Everything ranks reset, plus: all ranks return to 1, all Pioneer
*levels* return to 0, all milestones lock. Pioneer *cards* and unlocked alt recipes
are retained.

**What is granted.** **Assembly Cores**, a permanent currency that never resets under
any condition. Cores do three distinct things, and all three matter:

1. **Multiply the effect of every Pioneer level.** This is the Egg Inc Prophecy Egg
   pattern — layer three boosts layer two's *exchange rate* rather than adding a flat
   bonus. It compounds, which is what makes a third layer feel like a step change
   rather than a bigger number.
2. **Raise Pioneer maximum levels**, opening headroom that was previously capped.
3. **Unlock one entirely new mechanic per Phase.** This is the ISEPS lesson and the
   most important of the three. ISEPS sustains years of play because each prestige
   layer opens new *menus* — Lab, Initiative, Egetuarium, City of Tomorrow — not just
   larger multipliers. A layer that only multiplies gets boring on the second lap.

Suggested Phase unlocks:

| Phase | Unlocks |
|---|---|
| 1 | Overclocking — a Power Shard analogue, applied per lane rather than per machine |
| 2 | Amplification — a Somersloop analogue that duplicates output at a power cost |
| 3 | A second concurrent factory slot, running its own lanes and priority list |
| 4 | Recipe fusion — combine two known alt recipes into a custom one |
| 5 | Ficsonium tier, plus the first hooks for a fourth layer |

**Scaling rule: each Phase compresses everything below it by roughly an order of
magnitude.** Phase 1 is the full ~8 month climb. Phase 2 re-climbs that content in
roughly three weeks and then adds its own new content, landing at two to four months.
Repeat. Five phases lands around two years, and the structure is open-ended if you
keep authoring phases.

**Lifetime thresholds.** Add a tier of upgrades gated on totals that *never* reset —
lifetime items produced, lifetime Tickets earned, lifetime ranks completed. This is
ISEPS's Infinity Upgrade pattern and it is what keeps a dedicated player progressing
toward something even during a bad run or a slow week. Without it, a reset-heavy game
develops dead stretches where nothing is moving.

**The failure mode to guard against.** A third-layer multiplier tuned too generously
collapses the whole loop — players report reaching endgame in minutes after two or
three prestige points, skipping most of the content they were meant to experience.
The headless simulator (§16.3) must run multi-phase scenarios, not just a single
climb, or you will not catch this until players do.

---

### 10.7 Engineer Level and menu unlocks

This is the structural piece that makes a game last years, and it is worth copying
from ISEPS closely.

**Engineer Level is a fourth progression axis that never resets.** Not on rank-up, not
on Phase completion, not ever. XP is earned from one specific act: delivering items to
the AWESOME Sink. Levels grant two things — **Level Rewards** at fixed thresholds, and
**Level Points** spent in a Talent Tree.

The point is not the multipliers. The point is that Level Rewards **unlock entire
menus**, so no reset ever feels like standing still. The player is always a measurable
distance from a new mechanic, independent of where they are in the rank or phase loop.

**Four unlock cadences, deliberately out of phase with each other:**

| Axis | Resets? | Cadence | Unlocks |
|---|---|---|---|
| Milestone | Every rank | Minutes to hours | Machines, recipes, lanes |
| Engineer Level | Never | Hours to days | Menus, permanent multipliers, Level Points |
| Rank | Every phase | 1–2 days | Pioneer tier access, contract tiers |
| Phase | Never | Weeks to months | Major systems (§10.6) |

Because the four run at different speeds and reset differently, something is always
about to unlock. That interleaving *is* the retention mechanism.

**Target reset cadence.** ISEPS's community guidance is that a simulation reset should
never last much more than 1–1.5 days at any point in the game. Adopt the same target
for Ranks and enforce it with the simulator (§16.3). A reset layer that stretches to a
week has failed regardless of how large the reward is.

**Menus to unlock.** Each is a small self-contained sub-economy, not a settings panel:

| Menu | Unlocked by | Consumes | Produces |
|---|---|---|---|
| AWESOME Sink | Start | Surplus items | Tickets and Engineer XP |
| MAM | Level ~7 | Exotic materials | Alt recipe unlocks |
| Drone Network | Level ~18 | Batteries and fuel | Lane-wide throughput multipliers |
| Research Lab | Level ~26 | Hard Drives and power | Recipe efficiency multipliers |
| Talent Tree | Level ~50 | Level Points | Branching permanent perks |
| Overclock Grid | Phase 1 | Power Shards | Per-lane speed multipliers |
| Somersloop Array | Phase 2 | Sloops and heavy power | Output duplication |
| Second Factory | Phase 3 | Assembly Cores | A concurrent parallel world |
| Fusion Lab | Phase 4 | Two known alt recipes | A custom recipe |
| Ficsonium Reactor | Phase 5 | Endgame materials | Endgame tier |

**Rules that make the submenu web work**, all drawn from what ISEPS does well:

1. **Every menu consumes a different resource and boosts something upstream.** The
   Drone Network boosting lane throughput, which feeds the Lab, which boosts recipe
   efficiency, which feeds the Sink, which drives Engineer XP. This web of
   interdependence is what makes the game a puzzle rather than a ladder.
2. **A new resource should start nearly useless and become critical later.** ISEPS's
   Delta particle does almost nothing until level 30 and then becomes one of the most
   powerful in the game. This reads as a flaw and is actually what gives each
   mechanic a second life. Design at least two resources this way deliberately.
3. **All prestige-currency upgrades are retroactive.** In ISEPS, every Data Cube
   upgrade applies retroactively, so a player never feels they spent at the wrong
   moment. Assembly Core and Ticket upgrades must behave the same way.
4. **Free respec on the Talent Tree and any perk tree.** ISEPS originally charged
   premium currency to reset Singularity perks, which turned build choice into anxiety
   and produced hardwalls players could not undo. They later made respec free. Start
   where they ended up.
5. **Cumulative counters that never reset, with permanent rewards at thresholds.**
   ISEPS grants permanent buffs at 5, 10, 20, 42, 69, 100 … tasks completed, forever
   cumulative. Mirror this with lifetime statistics (§13.7) — lifetime items produced,
   disruptions survived, contracts completed. It guarantees that even a bad week moves
   something.
6. **Reward active play with time, not with power.** ISEPS's Tasks give Time Skips
   rather than direct multipliers. Time Skips are strictly better design for an idle
   game: they respect the player's schedule instead of punishing absence. Disruption
   defence and daily contracts should pay in time skips.

**Explicitly do not copy from ISEPS:**

- **XP overflow loss.** In ISEPS, Alpha sold beyond the current level's requirement in
  one go is discarded. This punishes exactly the batching behaviour an idle game
  encourages. Always carry the remainder.
- **Chests that replace themselves.** ISEPS's chest and task timers overwrite an
  uncollected item when they fire again, so a player who steps away loses it. Anything
  time-gated must accumulate to a generous cap instead.
- **Choices that hardwall.** ISEPS has perk paths the community warns can stall you for
  weeks. Every irreversible choice in this game must be either reversible or provably
  non-blocking.
- **Ad-gated and IAP-gated currencies.** ISEPS's Crystals and Tokens come from ads.
  Not applicable here and not wanted.
- **Battery drain that pushes players to emulators.** ISEPS players are advised to run
  it on a PC emulator 24/7 to avoid cooking their phone. Server-authoritative offline
  resolution (§8) makes this a non-issue, and that advantage should be protected —
  never require the app to be open to accrue.

---

## 11. Live content

### 11.1 Expeditions (timed events)

Limited-time parallel worlds with their own lanes, items, recipes, alt recipes, and
machines. The player's main-world progress is untouched; an Expedition is a separate
`player_world` row running the same engine against different content.

Planned themes: lunar base, undersea, polar (seasonal), alien world. Each ships its
own seed file. Rewards: Expedition-exclusive Pioneers that migrate into the main world
once the event closes, plus duplicates and Tickets.

Because Expeditions run the identical engine against swapped content, the marginal cost
of a new Expedition after the first is authoring content, not writing code. Build the
content pipeline with that in mind.

### 11.2 Daily contracts

Rotating short objectives, refreshed on a fixed daily boundary in the player's timezone.
Rewards: capsules, Tickets, Hard Drive equivalents. Mirror the Rackstack implementation.

### 11.3 Achievements

Permanent, account-scoped, survive rank wipes. Both milestone-style ("reach rank 25")
and discovery-style ("run a full lane on alt recipes only").

### 11.4 Leaderboards

Server-computed, refreshed on a schedule rather than on every write. Suggested boards:
current rank, lifetime Tickets, fastest rank clear, Expedition placement. Store denormalized
leaderboard columns on the player row so the query is a simple indexed sort.

---

### 11.5 The Deep Core

An offline-only progression zone, modelled on ISEPS's Hauler Mine, and the single best
counterweight to the 8-hour offline cap.

**How it works.** A Hauler descends one depth level at a time. Each level takes a
**locked 6 real hours** and cannot be accelerated by any means — no currency, no
boosts, no ads. When a level completes, it yields a roll from that depth's loot table
and the Hauler begins the next descent automatically.

**Why the lock matters.** The factory caps at 8 hours of offline accrual. The Deep Core
does not. A player gone for three days collects 8 hours of factory output *and* twelve
completed depth levels. That makes a long absence rewarding without touching the
factory economy or inflating the production curve. It also sets a natural rhythm — four
levels a day, one waiting for you morning and evening.

**Depth never resets**, under any layer. It is a fifth progression axis, and the
slowest one.

**Loot tables.** Depth tiers every ~10 levels. Contents, weighted by depth:

| Drop | Purpose |
|---|---|
| Hard Drives | Feed the MAM scan queue (§10.2) |
| Lore notes | Collectible narrative fragments — ISEPS's story-log analogue |
| Alien artifacts | Somersloop and Mercer Sphere analogues, feeding Phase menus |
| Collectibles | Machine skins, conveyor colours, HUB decorations |
| Tickets and Pioneer duplicates | Modest amounts |
| Time skips | Rewarding absence with time, per §10.7 rule 6 |

**Deep Core must stay optional.** If its output becomes necessary to keep pace, the
6-hour lock turns into an obligation and the game starts scheduling the player's day.
Weight it toward collectibles, lore, and Hard Drives rather than raw production power.

**Server-computed.** Depth progress is wall-clock, resolved server-side on the next
request exactly like offline factory time. Completed levels queue up and are presented
as unopened rewards when the player returns, never auto-claimed — the opening is the
fun part.

### 11.6 Story logs

Lore notes are a real collectible system, not flavour text. This is ISEPS's story-log
pattern and it is a meaningful part of why that game holds people for years.

- Notes drop from the Deep Core, milestone completions, Phase completions, and
  Expedition thresholds.
- They are **numbered within named sets** (a survey team's logs, a derelict FICSIT
  outpost, transmissions from whatever is sending the attackers). Sets are visibly
  incomplete, which is what makes them collectible rather than disposable.
- **Achievements tie to completing sets**, not to individual notes. Completing a set
  grants a real reward — a Pioneer, a cosmetic, a permanent multiplier.
- All notes are permanent and readable at any time from a Logs section in the handbook
  (§13.4). Nothing is missable.
- Notes should reward reading. The narrative can carry the explanation for the
  disruptions, the Deep Core, and the Phases, which makes the mechanics feel like a
  world rather than a spreadsheet.

Content note: this is writing work, not engineering work. Budget for it separately and
do not let it block a phase. A set of six notes shipped well beats forty shipped
carelessly.

---

## 12. Architecture

### 12.1 Stack

The stack matches `EvanTrow/Satisfactory-Colab-Modeler`, because this project reuses
that repo's solver and game data. Matching its conventions means those packages drop
in rather than needing a port.

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node 20+, TypeScript strict | Matches source repo |
| API | Fastify | Matches source repo; SuperTokens ships a Fastify recipe |
| Auth | SuperTokens (self-hosted core) | Required from day one |
| DB | PostgreSQL 16+ | Required from day one |
| Migrations | Kysely migrator, plain SQL | Matches source repo; no ORM in the game loop |
| Data access | `pg` + Kysely for typed queries | State is a JSONB blob; there is no ORM-shaped workload here |
| Frontend | Vite + React + Tailwind | Matches source repo |
| Client state | Zustand + TanStack Query | — |
| Ratios | BigInt exact rational | Reuse `packages/rational` |
| Magnitudes | break_infinity.js | New — see §9 |
| Monorepo | pnpm workspaces + Turborepo | Matches source repo |

### 12.1a What to reuse from Satisfactory-Colab-Modeler

- **`packages/solver`** — the Full calculator already implements priority nodes and
  recipe-tree expansion over the real Satisfactory graph. This is the hard part of
  §4.2 and it exists. Port it as the allocation core; wrap it with the waterfall
  ordering, storage/backpressure, and power equilibrium layers, which are new.
- **`packages/gamedata`** — `game_data.json` typed, indexed and validated, plus an
  icon manifest. This is the entire §12.7 content problem already solved for the base
  catalog. Extend its schema with the idle-specific fields (build cost, cost ratio,
  storage base cap, power draw where missing, lane and tier assignment) rather than
  authoring a parallel format.
- **`packages/rational`** — as-is, for solver internals only.
- **`infra/`** — Dockerfile and compose patterns, adapted for Unraid.

Do not reuse the Yjs/CRDT layer. This is a single-player authoritative simulation;
collaborative editing has no analogue here and would add a large amount of
complexity for nothing.

### 12.2 The shared engine package

**This is the most important structural decision in the spec.**

```
packages/
  engine/          # pure TypeScript, zero I/O, zero dependencies on Express or React
    solver.ts
    offline.ts
    power.ts
    content.ts     # loads and validates a content bundle
    decimal.ts
    format.ts
  content/         # versioned seed files (JSON/YAML) + schema
apps/
  api/             # Fastify, imports @manufactory/engine
  web/             # React, imports @manufactory/engine
```

The client runs the engine for smooth local UI (rates ticking, bars animating). The
server runs the *same* engine as the authority. Because it is one deterministic
implementation, client prediction and server authority cannot drift.

Every engine function must be pure: `(state, content, elapsed) -> newState`. No clocks,
no randomness except from an explicitly passed seed, no I/O.

### 12.3 Server authority

The client never sends state. It sends **actions**:

```
POST /api/actions
{ type: "BUY_MACHINE", recipeId, count }
{ type: "REORDER_PRIORITY", entries: [...] }
{ type: "SELECT_RECIPE", itemId, recipeId }
{ type: "SET_RESERVE", itemId, percent }
{ type: "TAP", count, clientTs }
{ type: "CLAIM_CONTRACT", contractId }
{ type: "RANK_UP" }
{ type: "LEVEL_PIONEER", pioneerId }
```

Server handling for every action:

1. Load `player_world` row, read `last_resolved_at`.
2. Run `resolveOffline(state, now - last_resolved_at)`.
3. Validate and apply the action against the resolved state.
4. Persist state, set `last_resolved_at = now`.
5. Return the new authoritative state.

Also resolve on a periodic heartbeat (~60s) while a session is active, so a crash never
loses more than a minute.

### 12.4 Anti-cheat

Server authority handles most of it. Additionally:

- Tap actions are rate-limited server-side to a plausible ceiling (suggest 20/sec) and
  validated against wall-clock elapsed time, not client timestamps.
- Every action is validated against the content bundle for the player's current
  content version — a client cannot claim a recipe it has not unlocked.
- An append-only `action_log` table for a bounded window, for debugging and for
  invalidating leaderboard entries retroactively if needed.

### 12.5 Database schema

Content tables (seeded from files, read-mostly):

```
content_versions(id, version, published_at, checksum)
lanes(id, content_version, name, order)
items(id, content_version, lane_id, tier, name, base_storage_cap, icon)
recipes(id, content_version, output_item_id, output_rate, machine_id,
        power_draw, is_alternate, unlock_requirement jsonb)
recipe_inputs(recipe_id, item_id, rate)
machines(id, content_version, name, build_cost jsonb)
pioneers(id, content_version, name, rarity, category, effect jsonb, max_level)
contracts(id, content_version, rank, requirements jsonb, rewards jsonb)
ranks(id, content_version, contracts_required, contracts_available)
expeditions(id, content_version, name, starts_at, ends_at, content_bundle_id)
```

Player tables:

```
players(id, supertokens_user_id UNIQUE, display_name, created_at,
        current_rank, lifetime_tickets, leaderboard_score)

player_worlds(id, player_id, world_type, expedition_id NULL,
              content_version, state jsonb, last_resolved_at,
              schema_version, UNIQUE(player_id, world_type, expedition_id))

player_pioneers(player_id, pioneer_id, level, duplicates)
player_alt_recipes(player_id, recipe_id, unlocked_at)
player_achievements(player_id, achievement_id, earned_at)
player_contracts(player_id, contract_id, status, progress jsonb)
daily_contracts(player_id, date, contracts jsonb, claimed jsonb)
action_log(id, player_id, action jsonb, created_at)

player_lifetime(player_id, stat_key, value_text, updated_at)
player_stat_hourly(player_id, bucket_hour, stat_key, value numeric,
                   PRIMARY KEY (player_id, bucket_hour, stat_key))
player_sessions(id, player_id, started_at, ended_at, active_seconds,
                offline_seconds_claimed)
player_levels(player_id, engineer_level, xp_text, level_points_spent jsonb)
```

**Store mutable world state as a single JSONB blob**, not as normalized rows. With ~160
items and ~250 recipes, normalizing means hundreds of row updates per action. One blob
per world is dramatically faster and the state is never queried by shape. Extract only
the handful of columns leaderboards need.

Index `player_worlds(player_id)`, `players(leaderboard_score DESC)`,
`action_log(player_id, created_at)`.

### 12.6 SuperTokens

- Self-hosted SuperTokens core as its own container.
- EmailPassword + at least one social provider (the existing Rackstack setup used
  Discord and GitHub; reuse those).
- Session verification middleware on every `/api` route.
- `players.supertokens_user_id` is the join key. Create the player row lazily on first
  authenticated request.
- Anonymous play is **not** supported in v1 — accounts exist from the start, which is
  the stated requirement.

### 12.7 Content pipeline

- Content lives as YAML in `packages/content/bundles/<name>/`.
- A build step validates against a JSON Schema, resolves references, detects cycles,
  computes a checksum, and emits a single JSON bundle.
- Bundles are loaded into Postgres by migration and referenced by version.
- A player world pins its content version. Rank-up is the migration point: on rank-up,
  the world adopts the latest content version. This is how balance changes ship
  without corrupting saves.
- Ship a validation CLI (`pnpm content:check`) that reports orphaned items,
  unreachable recipes, cycles, and unsatisfiable build costs.

---

## 13. UI specification

Mobile-first. All screens must work one-handed on a phone.

### 13.0 Look and feel

The visual language is **industrial readout, not dashboard**. The player is reading
instrument panels on a factory, so density is fine but decoration is not.

- **Flat surfaces, hairline borders.** No gradients, no drop shadows, no glow. Cards
  are a plain surface with a 0.5px border and 12px radius.
- **Rows over cards for lists.** Item lists use bordered rows, not stacked rounded
  cards. At 160 items, card chrome is unreadable noise.
- **Three text sizes only.** 15px for item names, 13px for rates and status, 12px for
  chips and captions. Two weights: regular and medium. Never bold body text.
- **Monospace for all numbers.** Rates, stockpiles, and wattages are monospaced so
  digits do not jitter as they tick. Names stay in the sans face.
- **Bars carry state, color carries severity.** A 3px bar under every item row shows
  satisfaction. Green = fed, amber = capped or throttled, red = bottleneck, gray =
  paused. Nothing else in the UI uses those four colors.
- **Chips are the only decoration.** Modes, statuses, and tags are small
  radius-8 chips with tinted backgrounds. No icons inside data rows except status
  indicators.
- **Dark mode is the default,** with light mode fully supported. This is a game people
  will open in bed.
- **Motion is limited to number transitions and bar fills.** No page transitions, no
  parallax, no celebratory particle effects on routine actions. Rank-up and Pioneer
  unlocks may be the exception.

### 13.1 Lane view (primary)

The home screen. Lane tabs across the top, a persistent help icon top-right, and a
vertical list of items in the selected lane.

Each row: item name, current rate, and a satisfaction bar. Rows additionally render:

- **Split bar** on contested items — a stacked bar showing which priority targets
  consumed this item's output, with percentages beneath. Read-only. Tapping it
  navigates to the priority list.
- **Storage full** state on backpressured items.
- **Bottleneck frame** on the single binding constraint, per §4.5 — danger-role
  border, plain-language consequence, concrete fix, and an inline buy button.
- **Disruption state** and remaining timer on attacked nodes.

Tapping any row opens buy/upgrade for its machines and its storage capacity.

### 13.2 Power bar and tap surface

Persistently docked at the bottom of the lane view, not buried on its own screen.
Shows grid demand against capacity as a bar, plus a large circular tap target that is
holdable. Tapping shows watts injected and the production kick applied as a brief
inline readout. If power is the binding constraint, the bottleneck framing moves here.

A dedicated Power screen behind it carries generator lists, storage charge, and fuel
consumption detail.

### 13.3 Priority list

The only allocation surface in the game. Drag-to-reorder rows with live satisfaction
percentages. Simple/Advanced toggle at the top per §4.1; Advanced reveals mode,
target rate, and reserve chips inline on each row rather than opening a separate
editor. Should comfortably fit one screen at eight to twelve entries.

### 13.4 Handbook

A searchable reference for the entire recipe graph, reachable from a help icon present
on every screen. The icon is **context-aware**: tapping it from a lane row opens that
item's entry directly, not the handbook index.

Each item entry shows:

- Identity — name, lane, tier, current storage cap
- **Made from** — the active recipe as `inputs → output`, with machine and power draw.
  Alternate recipes listed below it, dimmed when locked, with their unlock source.
- **Traces back to** — the fully expanded raw resource cost per unit, plus the chain
  in plain text (`ore → ingot → rod → screw`). This is the answer to "which items
  come from which resources" and it must be computed from the live graph, including
  the player's currently selected alt recipes, not authored as static text.
- **Used in** — every recipe consuming this item, as tappable chips.

The handbook is also where lane overviews, mechanic explanations, and a glossary live.
It should be genuinely readable as documentation, not a tooltip dump.

### 13.5 Other screens

- **Pioneers** — owned cards, levels, duplicate counts, upgrade actions
- **Contracts** — active contracts, rank progress, daily contracts
- **Milestones** — the tier tree and its delivery requirements
- **Expeditions** — active event, its own lane view
- **Leaderboards / achievements**

### 13.6 Motion and animation

Animation exists to make state readable at a glance and to make the factory feel
alive. Every effect below carries information; none is decorative.

**Production sweep.** A translucent highlight sweeps across each satisfaction bar. The
sweep period is a function of that item's actual production rate — a fast line sweeps
fast, a crawling line sweeps slowly. This lets the player read relative throughput
across a whole lane without reading a single number. Clamp the period to a sane range
(suggest 0.8s–6s) so extremes stay legible.

**Bottleneck pulse.** The bottleneck row's frame pulses between full and ~45% opacity
on a ~2.6s cycle. Only ever one on screen per lane, matching §4.5. The pulse is the
only urgent motion in the UI, which is what makes it read as urgent. Keep it slow —
anything under ~1.6s reads as an alarm and becomes tiring across a long session, and
players will have a bottleneck showing for much of the mid game. The cycle duration
should be a single named constant, easy to retune after playtesting.

**Background conveyor.** A low-opacity conveyor strip runs behind the lane content,
with small item blocks travelling along it. Speed and item density map to the lane's
throughput, so a starved lane visibly runs sparse and slow. Direction indicates flow
toward the currently selected priority target. It must sit at low enough opacity to
never compete with text.

**Number transitions.** Counters interpolate rather than snapping. Interpolate in log
space so a jump from 1e12 to 1e14 reads as motion rather than a blur.

**Reserved for big moments.** Rank-up, Phase completion, Pioneer unlock, and alt recipe
discovery may use larger transitions. Nothing routine gets a celebration — a purchase
that fires confetti stops being satisfying by the hundredth time.

Technical constraints, all mandatory:

- Animate `transform` and `opacity` only. Never `width`, `left`, `background-position`,
  or anything else that triggers layout or paint.
- Everything wrapped in `@media (prefers-reduced-motion: no-preference)`. Reduced
  motion must yield a fully usable static UI, with the bottleneck still legible from
  its frame colour alone.
- Pause all animation on `visibilitychange` when the tab is hidden. This is a game
  people leave open for hours on a phone; a running conveyor in a background tab is a
  battery complaint.
- Virtualize long item lists. With 160 items, cap concurrently animating elements to
  what is actually on screen.
- No animation library. CSS keyframes only.

### 13.7 Player statistics

Track everything, permanently. Lifetime counters never reset — not on rank-up, not on
Phase completion. They are both a retention hook and the raw material for the
lifetime-threshold upgrades in §10.6.

**What to track.** Assume everything unless there is a reason not to:

- Per item: lifetime produced, lifetime consumed, lifetime stored, peak rate achieved
- Per recipe: lifetime machines bought, lifetime spend, time spent as the bottleneck
- Per lane: lifetime output, peak throughput
- Economy: lifetime Tickets earned and spent, lifetime power generated, lifetime taps
- Progression: ranks completed, phases completed, milestones cleared, alt recipes
  unlocked, Pioneers acquired and levelled, contracts completed and skipped
- Sessions: session count, session lengths, day streak, longest streak, total active
  time, total offline time claimed
- Events: disruptions survived, expeditions entered and placed

**Graphs.** All time-series graphs share one component with a timeframe selector
(24h / 7d / 30d / all time), matching how stats.fm handles custom timeframes.

- **Activity clock** — a 24-hour radial chart of active play time by hour, in the
  player's local timezone. Bar length encodes minutes; the peak hour is called out in
  the centre. This is the stats.fm listening-clock analogue and it is the single most
  shareable screen in the game.
- **Weekday clock** — the same idea across days of the week.
- **Progression lines** — rank over time, lifetime production over time (log axis),
  Tickets over time, power capacity over time.
- **Lane composition** — stacked area of output share per lane over time, which makes
  a player's strategy shifts legible to them.
- **Rank pace** — time taken per rank as a bar chart. This is also your best early
  warning for difficulty walls in live data.
- **Recap** — a periodic generated summary (monthly, and on each Phase completion)
  with the standout numbers. Shareable as an image.

**Active vs idle time must be distinguished.** The activity clock is meaningless if
offline accrual counts as play. Track session windows explicitly — a session opens on
app focus and closes on blur or a timeout — and attribute clock time only to open
sessions. Offline claimed time is its own separate statistic.

**Aggregate at write time, not query time.** Roll statistics into hourly buckets as
they happen. Never compute a 30-day graph by scanning an event log; that gets slow
within weeks and this data is meant to survive for years.

**Achievements read from this system.** Every achievement is a threshold on a tracked
statistic, so adding an achievement is a content change rather than a code change.

---

### 13.8 PWA, responsive layout, and notifications

**Installable everywhere.** Web app manifest, service worker, full icon set, standalone
display mode. Installable on Android and desktop Chrome/Edge, and on iOS via Safari →
Share → Add to Home Screen. Apple does not implement `beforeinstallprompt`, so there is
no native install banner on iOS — ship a custom install-instruction sheet that detects
iOS and standalone mode and walks the user through it.

**iOS storage may be evicted** for PWAs left unused for an extended period. Local
caching is a performance optimization only. The server is always the source of truth,
which the architecture in §12.3 already guarantees.

**Responsive layout.** Breakpoints on viewport width, never on device type, so a phone
held sideways gets the wide layout for free.

| Width | Layout |
|---|---|
| < 600px (portrait phone) | Single column, bottom tab bar, one screen at a time |
| 600–1000px (landscape phone, small tablet) | Two panes — lane list beside item detail |
| > 1000px (tablet, desktop) | Three panes — lanes, detail, and priority list all visible |

**Hard rule: no horizontal scrolling in portrait, anywhere, ever.** Buttons wrap rather
than overflow. Tables collapse to stacked rows. Every item row must render legibly at
320px. Test at 320px, not at 390px.

In the wide layouts, use the space for parallelism rather than bigger elements — the
priority list beside the lane view means reordering while watching the split bars
update, which is the best version of this UI.

**Notifications.** Web Push works on Android and desktop browsers directly. On iOS it
works only for PWAs installed to the Home Screen, on iOS 16.4+ — an open Safari tab has
no access to `PushManager` regardless of browser, since all iOS browsers use WebKit. So
notification opt-in must be presented inside the installed app, after a user action,
never on first load.

Because state is server-authoritative, the server knows in advance exactly when each
event will fire and can schedule the push at write time rather than polling.

| Notification | Default |
|---|---|
| Offline cap nearly full (~7h) | On |
| Deep Core level complete | On |
| MAM scan complete | On |
| Daily contracts refreshed | Off |
| Expedition ending soon | On |
| Disruption started | Off |
| Contract completed | Off |

Every one individually toggleable, with a global cap of a few per day. Use the Badge
API (supported on iOS 16.4+) for an unobtrusive count of unclaimed rewards on the app
icon — that is often better than a notification.

**Never require the app to be open.** All accrual is server-computed. A player should
never be advised to leave the game running, and battery use should never be a reason
to play differently.

---

## 14. Build order

Each phase should end in something playable.

| Phase | Deliverable |
|---|---|
| 0 | Monorepo, Postgres, SuperTokens, empty Express + React, engine package skeleton, content schema and validator |
| 1 | Single lane (Iron), extraction + conversion, storage with caps and backpressure, solver, lane UI |
| 2 | Priority list, split-bar readout, bottleneck reporting, multi-lane, cross-lane recipes |
| 3 | Power grid, generators, brownout, power storage, tap and hold |
| 4 | Offline resolution, server authority, action API, heartbeat |
| 5 | Milestones, alt recipes, recipe selection and automatic rerouting |
| 6 | Ranks, Pioneers, duplicates, Tickets, contracts |
| 7 | Disruptions |
| 8 | Achievements, daily contracts, leaderboards |
| 9 | Expeditions and the second content bundle |
| 10 | Full Satisfactory catalog authored and balanced |

Phases 1–4 are the engine. If they are right, everything after is content and UI.

---

## 15. Deployment

Target: Unraid, Docker Compose, behind a Cloudflare tunnel — matching the existing
Rackstack setup.

Containers: `api`, `web` (static, served by the API or a separate nginx),
`supertokens-core`, and the **existing** Postgres container. Create an isolated
database and role inside the running Postgres instance via `docker exec` rather than
standing up a second Postgres. SuperTokens gets its own database in the same instance.

Environment: database URLs, SuperTokens connection URI and API key, session domain,
OAuth client credentials. No secrets in the image.

Add a `pg_dump` cron sidecar. Game saves are JSONB blobs; a nightly dump is cheap and
worth having from day one.

---

## 16. Balance

The stated target is that reaching the highest tier takes **many months**. That does
not happen by hand-tuning numbers and hoping. It happens by treating the pacing curve
as the input and deriving costs from it.

### 16.1 The five dials

In order of impact:

1. **Machine cost ratio `r`** (§3.2). Sets the doubling time of the whole economy.
   This is the master dial. Everything else is a modifier on it.
2. **Milestone delivery requirements.** Sets how many doublings separate one tier
   from the next.
3. **Storage cap curve `s`** (§3.3). Determines how often capacity blocks production
   investment, which is the mid-game rhythm.
4. **Pioneer multiplier curve.** Determines how much faster a re-climb is after a
   rank wipe.
5. **Extraction base rates.** Sets the absolute floor of the early game. Least
   important, most tempting to fiddle with.

### 16.2 Derive costs from a target curve

Put the intended pacing in the content bundle as data:

```yaml
pacing:
  targetHoursToTier: [0.5, 1.2, 3, 8, 20, 48, 110, 240, 520, 1100]
  activeHoursPerDay: 2.5
  offlineCollectionsPerDay: 3
```

Then write a calibration script that solves for the milestone requirements and cost
ratios that produce that curve, rather than authoring costs by hand. The numbers above
are illustrative — the shape is what matters. Each tier roughly 2.2× the previous, ten
tiers, summing to about 2,000 hours of wall-clock progression. With an 8h offline cap
and a few collections a day, that lands in the four-to-eight month range for a normal
player, which is the target.

**Express tier times in collections, not hours.** With an 8h offline cap, a player gets
roughly three meaningful collections a day. A tier that takes 40 collections is a
two-week tier regardless of what the hour count says. This framing catches pacing bugs
that hour-based tuning hides.

### 16.3 The simulator — headless and playable

This is the highest-leverage piece of infrastructure in the project, and it should be
built in phase 4, not phase 10.

One binary, two modes, both driving the identical engine the real game uses. There is
no second implementation to keep in sync.

**Batch mode — `sim run`.** Runs with no UI under a defined policy, reporting
time-to-each-tier, time-to-each-rank, and time-to-each-phase.

```
sim run --policy greedy --content v14 --phases 3 --report json
sim run --policy casual --seed 42 --until phase:2
```

Policies should include at minimum `optimal` (perfect ordering), `greedy` (buy the
cheapest available upgrade), and `casual` (deliberately sloppy — checks in three times
a day, never reorders priorities). Real players sit between greedy and casual; tuning
only against `optimal` produces a game that is brutal for everyone else.

Run in CI. Any content change that shifts a tier time beyond tolerance fails the build.

**Play mode — `sim play`.** An interactive terminal client. Same engine, same actions,
but with time under your control.

```
> status
Iron lane          screws BOTTLENECK  limiting rotor (+6 constructors)
Grid               812 / 940 MW

> buy constructor 6
> advance 8h
[8h elapsed] iron ore 41.2 M  ·  rotor 1.10 M  ·  rank 12 → 13
> priority move rotor 1
> advance 3d
```

Requirements for play mode to be genuinely useful:

- **Time warp as a first-class verb.** `advance 8h`, `advance 3d`, `advance until
  rank:20`. This is the entire point — you can play eight months in an afternoon and
  feel where the game drags.
- **Full action parity** with the real client. Anything you can do in the app, you can
  do here, including advanced priority controls and Phase resets.
- **Session recording and replay.** Every session writes an action log. `sim replay
  session.log --content v15` re-runs your exact play session against new content, and
  diffs the outcome. This turns your own playtesting into a regression test — which is
  how balance stays stable across years of content changes.
- **Save interchange.** `sim export` produces a save loadable by the real game, and
  vice versa. Debug a real player's stuck save in the terminal.
- **Readable output.** Build it with Ink (React for terminals) so the lane view,
  bottleneck highlighting, and priority list render as real components rather than
  print statements. It shares mental model with the web client and is much nicer to
  live in.

Play mode is not a developer-only tool. It is the fastest way for you to answer "does
this feel right", and it will get more use than the batch mode.

### 16.4 Known failure modes to design against

- **Runaway growth.** Any path where output grows faster than cost. Alt recipes that
  reduce input requirements are the usual culprit — an efficiency chain can compound
  multiplicatively. Cap total achievable efficiency per item.
- **Difficulty walls.** AdComm's rank 100 taking two weeks is its most-complained-about
  property. Ranks should get gradually longer, never step-function longer. The
  simulator's job is to catch steps.
- **Dead mid-game.** Between "the early tiers are fresh" and "the late tiers are
  impressive" there is a stretch where nothing new unlocks. Front-load alt recipe
  drops and Pioneer acquisitions into exactly that window.
- **Storage as a dominant strategy.** If storage upgrades are ever strictly better than
  production upgrades, players will only buy storage. Ceilings in §3.3 exist for this.
- **Offline being strictly better than active play.** If the 8h cap is generous and
  active play adds little, the game plays itself. The tap's production kick (§7) is the
  counterweight and should be tuned so an active hour beats an idle hour meaningfully
  but not overwhelmingly — target roughly 1.5× to 2×.

### 16.5 Instrument from day one

You have accounts and Postgres. Log time-to-milestone and time-to-rank per player,
server-side, from the first playable build. Build a small balance dashboard against
that data. Real player curves will disagree with the simulator, and the difference is
where the actual balance work is.

### 16.6 Genre gotchas

Failures that recur across incremental games, and the specific guard for each.

**The pace-decay death spiral.** The most common way incrementals lose players: output
scales linearly with upgrades while cost scales exponentially, so time-to-next-upgrade
grows as roughly `2^x / x`. Progress slows forever with no end in sight, and since
there is no end state, the player's only exit is quitting while frustrated. The guard
is that every layer must *restore* pace: a rank must feel faster than the end of the
last rank, a phase must feel faster than the end of the last phase. Instrument
time-between-meaningful-events directly and alert when it exceeds a threshold. If a
player goes more than a few hours with nothing to click, the curve is broken.

**Exponent blowup.** Naive exponential stacking reaches floating-point infinity fast,
especially once several multiplicative systems compound. Beyond the Decimal type in
§9, apply softcaps: past a threshold, additional multipliers contribute at a reduced
exponent. Softcap rather than hard-cap, so nothing ever reads as wasted.

**RNG on the critical path.** Player reports on RNG-gated incrementals consistently
describe being knocked backwards by bad luck and nearly quitting. Randomness is fine
for flavour and for bonuses; it must never gate progression. Pioneers are already
deterministic (§10.4) — hold that line for alt recipes, contracts, and Phase
requirements too. Luck-category Pioneers should only ever add upside.

**Multiplicative stacking that collapses the loop.** Several independent multiplier
systems that all apply to the same number will combine into something no one modelled.
The simulator must run with every system maxed, not just typical builds.

**Balance changes that invalidate saves.** Rebalancing a live incremental usually means
either breaking existing players or freezing the numbers forever. The content-version
pin on `player_worlds` (§12.7) plus rank-up as the migration point is the escape hatch —
use it, and never hot-patch numbers into an active run.

**Progress loss of any kind.** A player losing progress to a refresh, a crash, or a
punishing mechanic is the single most damaging event in this genre. Server-authoritative
state, the 60s heartbeat, and nightly `pg_dump` cover the technical cases. The design
cases — disruptions, contracts, phase resets — must never remove anything the player
did not choose to spend.

**The "which upgrade do I buy" fog.** Late-game incrementals become opaque, and players
resort to community spreadsheets. Two guards: the bottleneck reporting in §4.5 should
extend to a general "biggest available gain" hint, and the handbook (§13.4) should show
the projected effect of every purchase before it is made. If players need an external
calculator, the UI has failed.

**Under-scoped early game.** Players quit in the first ten minutes if the first few
upgrades are slow. Front-load: the first tier should complete in well under an hour,
with unlocks arriving every couple of minutes at the very start.

**Balancing is the whole job.** Multiple developer postmortems land on the same point —
incrementals look easy and the balance is the hard part, and it cannot be done by
inspection. This is why the simulator (§16.3) is phase 4 rather than an afterthought.

These are deliberately unresolved and should be settled before or during the phase
that needs them.

1. **Pollution tuning** (§5.1). The decay rate, cap, and how steeply attack pressure
   scales with it. This is the dial that decides whether dumping is a legitimate
   tactic or a trap, and it can only be settled by playtesting in `sim play`.
2. **Cycle handling.** Ship v1 with cyclic recipes disabled, or build SCC handling
   up front (§4.3).
3. **Overclocking.** Whether to include a Power Shard equivalent, and whether it is a
   per-machine control (management-y) or a global lane setting (idle-friendly).
4. **Somersloop equivalent.** Duplication amplification is powerful and would need
   careful balancing against the extraction-only value-creation rule in §3.1.
5. **Rank count and the number ceiling.** AdComm reached rank 187. Decide the intended
   ceiling early — it determines the contract requirement curve.
6. **Luck bonus balance.** Whether to replicate AdComm's dominant luck-bonus tier or
   flatten it (§10.4).
7. **Push notifications.** Would help retention on contracts and Expeditions; adds
   meaningful platform complexity.
8. **PWA vs native shell.** Web-only is simplest; a PWA gets installability and
   background sync cheaply.
9. **Currency naming.** Whether "Ticket" is right for the Pioneer currency, and what
   the Deep Core's exotic materials are called.
10. **Split production across two recipes for the same item** (§4.4) — deferred, but
    decide whether the data model should anticipate it now.

---

## 18. Parking lot

Ideas worth building eventually. Nothing here blocks anything, and nothing here should
be started before phase 9.

### 18.1 The Buddy

A virtual pet living in the corner of the lane view. Reference point: the Pebble
watchapp *MyBuddy Pet Sugar Glider* — a low-resolution sprite pet, day/night state
driven by the real clock, no settings screen, named once on first meeting. Open source
at `github.com/johosoft0/mybuddy_virtual_pet` if the sprite approach is worth studying.

Design register: **cute, low-resolution, and deliberately not fully animated.** A
handful of sprite frames, idle blinks, a reaction when tapped, a sleep state at night.
The restraint is the charm — a fully animated pet would fight the industrial readout
aesthetic in §13.0 and cost far more to make.

Fed with Alien Protein and Mycelia, which gives those otherwise-dead-end items a
purpose.

**Cosmetic plus one small permanent buff.** Feeding it grants a modest permanent bonus
that accrues and never decays. Explicitly no neglect states, no hunger decay, no
punishment for ignoring it — a pet that can be neglected turns an idle game into an
obligation, which is the opposite of pillar 1. It should be a small warm thing that
happens to be slightly useful, not a chore.

Thematically it is the Lizard Doggo, but it should be its own creature.

### 18.2 The Greenhouse

A Plants vs. Zombies-style tending minigame: plant, water, feed, harvest. Low stakes,
tactile, and pleasant to poke at while the factory runs.

Output is Biomass, Mycelia, Alien Protein, and Flower Petals — feeding biomass
generators early, the Buddy throughout, and a few alt recipes later. That gives the
minigame real economic grounding rather than making it a detached distraction.

Should be fully skippable. Anyone who never opens it should not fall behind.

### 18.3 Other

- Story logs and lore, surfaced through Deep Core notes and the handbook
- Machine and conveyor skins from Deep Core collectibles
- Loadouts — saved priority list configurations, swappable in one tap
- Photo mode or a shareable factory summary card
- Fourth prestige layer, once phases are exhausted

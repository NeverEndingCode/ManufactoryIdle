# Tier 10's capstone: a product the player has to build toward

**Amends:** the vertical slice's content (items, recipes, machines, milestones); spec B.7
(calibration inputs: a class authored outside the `r_eff` scale).
**Status:** implemented 2026-10-13.
**Depends on:** `2026-10-12-milestone-first-policies-design.md` (PR #7). Tier 10 is
calibrated against the milestone-first `greedy`.

---

## The problem

Tier 10 is the slice's only tier outside its ±5% band. `greedy` reaches it at 20.87
collections against a target of 25 (−16.5%), and Phase 2 proved no requirement amount can
fix it. The milestone asks for 4,000 `smart_plating` and 3,000 `encased_industrial_beam`,
both items the player already makes at scale by tier 9. Milestones are paid from liquid
stock, so the amount cannot exceed what storage holds, and the time to fill that storage
saturates at 20.872 (handoff, "Tier 10 — the only off-target tier").

The decision recorded in the handoff: what is left is structural, meaning recipe depth, a
power wall or a throughput wall. The intent agreed for this spec is **a capstone
product**: reaching tier 10 should feel like building the big thing.

## What was measured, and what it rules out

All runs resume milestone-first `greedy` from its own tier-9 checkpoint (15.539
collections) on in-memory variants of the slice, so that only tier 10 varies. The probe is
at `$CLAUDE_JOB_DIR/tmp/t10/probe.mts`, throwaway.

| variant | tier 10 at |
|---|---|
| capstone item on the **existing** `manufacturer` class | 15.54, instantly: idle manufacturers are reassigned to it |
| capstone on its **own** class, ordinary cost growth, cost 50–200, rate 2/min | 15.56–15.67 |
| own class, ordinary cost growth, rate down to 0.005/min | 16.25–16.45 |
| own class, **`costRatio` 1.5**, rate 0.1/min | 15.86 (1,000) · 16.56 (5,000) · 17.42 (10,000) |
| own class, **`costRatio` 2.0**, rate 0.1/min | 18.67 (10,000) · **23.99 (30,000)** · **26.33 (40,000)** |

Three conclusions follow.

- **The capstone needs its own machine class.** On a shared class, the player's existing
  machines are simply reassigned.
- **Rate and amount alone are logarithmic.** In this economy production compounds with
  purchases (the ladder multiplier), so a slower rate is offset by buying more machines:
  a 20× slower rate adds ~0.4 collections. This is the same "deep end is logarithmic"
  wall Phase 2 met.
- **Steep cost growth on the capstone's class is the lever that works.** At `costRatio` 2.0
  each rig costs twice the last, so buying your way out stops working, and tier-10 time
  grows roughly linearly with the amount (~0.3 collections per 1,000 units). The target 25
  lies between 30,000 (23.99) and 40,000 (26.33), at about 34,000.

Base caps do not bind: with the capstone at `smart_plating`'s ordinary caps (200 / 800),
the results above are identical to a 50× cap. The ordinary storage ladder holds the
requirement.

## Design

### Content (the vertical slice)

- **Item** `heavy_modular_frame`: lane `iron`, tier 9, `terminal: true`,
  `baseStorageCap: 200`, `baseQuantumCap: 800` (as `smart_plating`).
- **Machine class** `assembly_rig` ("Assembly Rig"). One mark, Mk.1, unlocked at tier 9.
  Its build cost is 200 `smart_plating` + 200 `encased_industrial_beam`, its power draw is
  `manufacturer` Mk.1's, and its ladder is `manufacturer`'s (step 1.5, interval 10). It
  authors **`costRatio: 2.0` and no `rEff`**; see "Calibration" below for why.
- **Recipe** `make_heavy_modular_frame`: lane `iron`, class `assembly_rig`, unlock tier 9.
  - Inputs: `modular_frame` 10, `steel_pipe` 30, `encased_industrial_beam` 10, `screw` 200.
  - Output: `heavy_modular_frame` **0.1**.
  - Rates are per minute, as every slice recipe.
  - It unlocks at tier 9, not 10: a milestone's requirement must be producible before
    the milestone it unlocks.
- **Milestone 10** requires `heavy_modular_frame` only. The authored seed amount is
  30,000; calibration solves the real one. The tier-9 items stop being tier 10's
  requirement and become the rig's build cost and the recipe's inputs.
- **Priority:** `heavy_modular_frame` is appended to `start.priority`. Milestone-first
  play moves it to the top during tier 9.

The numbers above are the measured prototype's. They are authored seeds, not
hand-tuned answers.

### Calibration

Tier 10's amount is solved by the existing amount search (B.7). That is a full
`sim calibrate --write`, the normal process, which also refits `r_eff` and `capPerTier`.

**The rig's steepness must survive calibration.** The `r_eff` scan applies one scale to
`r_eff − 1` for every class that authors `rEff`. A class that authors `costRatio` with no
`rEff` is skipped by both `withREffScale` and `deriveCostRatios`; the existing test
"leaves a class that authors r directly alone" pins that. Authoring the rig that way keeps
its `costRatio` at 2.0 whatever scale the scan picks.

Spec B.7 is amended to say this:
> a class may author `costRatio` directly, outside the scale, when its cost growth is
> itself the pacing lever. The slice's `assembly_rig` does, for tier 10.

Check 8 is only a floor (r_eff > 1 + ε). The rig's r_eff, 2.0 / 1.5^(1/10) ≈ 1.92, passes.

### What moves

- **`derived.yaml`** is regenerated. Tiers 1–9 should reproduce within their bands, since
  nothing below tier 10 changed. Any tier that leaves its band is reported, not hidden.
- **Tier 10 for `greedy`** should land within ±5% of 25. Its known-red pin goes away,
  because the gate holds it to its target.
- **`casual` and `bottleneck`** are re-pinned at whatever they now do at tier 10.
  - If `bottleneck` stalls at tier 10, that is reported with what its reporter advised,
    not pinned silently.
  - A rig whose cost doubles per purchase is exactly where advice could point at
    something unpayable.
- **The handoff's item 3** ("Tier 10 — the only off-target tier") is marked done.

## Out of scope

- **A power wall.** It was not prototyped. The same steep-cost principle would apply to
  a power-hungry rig if wanted later.
- **More marks for the rig, or alternate recipes for the capstone.**
- **Retuning tiers 1–9.** They are only re-run as part of the normal calibration.

## Acceptance

- `content:check` passes with the new item, class and recipe. Checks 7–12 hold, check 9
  included: the solved tier-10 amount fits `maxAttainableCap(heavy_modular_frame, 9)`.
- Tests:
  1. A content test confirms the slice loads with the capstone, the recipe unlocks at tier
     9, and milestone 10 requires only `heavy_modular_frame`.
  2. A calibration test confirms the `r_eff` scan leaves a class with authored
     `costRatio` and no `rEff` unchanged. That exists today; the plan confirms it still
     covers this case.
- The full suite, lint and typecheck pass.
- `sim calibrate --write` regenerates `derived.yaml`. The PR shows its tier table.
- A full `sim gate` passes. `greedy`'s tier 10 lands within ±5% of 25, every moved pin
  is listed, and any `bottleneck` stall is called out.

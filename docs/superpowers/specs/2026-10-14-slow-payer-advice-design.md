# Advice that does not wait on a slow payer

**Amends:** engine spec §4.5 (the bottleneck reporter; its 2026-10-10 "payable" and
2026-10-13 "drained payer" amendments).
**Status:** implemented 2026-10-14.
**Follows:** `2026-10-13-reserves-protect-stock-design.md` (PR #9), whose measured stall
this addresses.

---

## The problem, measured

`bottleneck` stops at tier 9 (`reachesTier: 9`, 428 purchases, last purchase ~5.07
collections). Its advice is correct but slow:
- **The advice:** buy the 12th assembly rig, at 409,600 `smart_plating` + 409,600
  `encased_industrial_beam`.
- **The payers:** `smart_plating` (720,576, FULL) covers its half. `encased_industrial_beam`
  holds 169,905 and grows at +2.94/s, so the remaining 239,695 takes ~22.6 h of game time,
  beyond the gate's 2-collection dead-time cut-off.

`greedy` is not stuck at the same point: it reaches tier 10 at 24.06, because it keeps
buying cheap things, beam production included. `bottleneck` buys only what the reporter
names, and the reporter keeps naming a purchase that is a day away. Spec E.2: "if
`bottleneck` lands materially worse than `greedy`, the UI is lying to players." The fix
belongs in the advice. The content and the pacing are fine.

## Design

### The rule

`payable` is the final step every answer passes through (§4.5). It already runs two
checks:
1. **The storage-cap check:** a price above a payer's cap + bound becomes storage advice
   for that payer.
2. **The drained-payer check:** a payer that is short, not growing and produced becomes
   reserve advice.

A third check runs after those two, when neither fires. For each cost item of the
answer's price:
- the **shortfall** is the price minus the item's liquid stock plus bound;
- if the shortfall is > 0 and the item's net rate is > `FLOW_TOLERANCE`, its **time to
  afford** is shortfall / net.

If the largest time to afford exceeds the **slow-payer horizon**, half an offline window
(`0.5 × offlineCapMs`, 4 hours on the slice), the slowest such item is the **slow
payer**. The advice becomes:

```ts
{ kind: "recipe", recipeId: <the slow payer's active recipe>, limitingTarget: <unchanged>, machinesToClear: 1 }
```

That is, buy one more machine for the item the purchase is waiting on. It is an ordinary
`recipe` answer, so no new kind is needed. `sim play`'s wording, `run.ts` and the
`bottleneck` policy handle it as they do today.

### Guards

- **The slow payer has no active recipe, or its recipe is not live** (not unlocked at
  the current tier): the advice stays as it was.
- **One redirect per item.** The slow payer joins the same `visited` set the
  storage-cap redirects use. Reaching it again leaves the advice as it is, so the chain
  is bounded at one step per item.
- **Back through the checks.** The redirected answer goes around `payable`'s loop again,
  so the machine's own price meets the storage-cap, drained-payer and slow-payer checks
  in turn. Its price is in other items, and those may themselves need storage or a
  reserve.

### Why half an offline window

Measured, `bottleneck` on the slice under the gate's 2-collection dead-time cut-off:

| horizon | reaches | tier 9 | tier 10 | purchases | longest dead stretch |
|---|---|---|---|---|---|
| off (today) | 9, stalled | 2.5329 | — | 428 | 2.001 |
| 1 collection | 10 | 2.4077 | 17.0752 | 570 | 1.372 |
| **0.5 collection** | 10 | 2.4785 | **12.4274** | 589 | **0.610** |
| 0.25 collection | 10 | 2.4785 | 12.6654 | 655 | 0.437 |

The "off" row reproduces today's pins exactly.
- **At 1 collection:** finishing takes far longer, and dead stretches stay long.
- **At 0.25 collection:** it buys 66 more machines for a later finish.
- **0.5** is the measured best. It also reads naturally: a purchase more than half an
  offline window away is not the next thing a player should save for.

A full gate on the prototype (0.5 horizon) exits 0. The `greedy` and `casual` pins are
**identical** to `main`'s. `bottleneck` reaches tier 10, with dead time 0.6095. (The table above
and this paragraph are the prototype's. The shipped rule also walks the redirect on to the
recipe that limits a starved input, see "Amended after final review" below; its numbers are
there.)
- **tiers 1–6:** unchanged;
- **tiers 7–9:** 1.3573, 1.7369, 2.4785, against `main`'s 1.3077, 1.6469, 2.5329;
- **tier 10:** 12.4274.

### Amended after final review (2026-10-14): walk to what limits it

Measured on the shipped rule: the redirect named a recipe starved of an input.
`make_encased_industrial_beam` was advised 318 times and bought 98 times while its input
`steel_beam` was EMPTY, and `make_cable` 12 of 12 while `wire` was EMPTY. Another machine for
a starved recipe produces nothing. So after choosing the slow payer's live active recipe R,
while R has an EMPTY input (recipe order) whose active recipe is live and whose item is not in
`visited`, that item joins `visited` and R becomes that recipe. The final R is advised. If the
deepest R still has an EMPTY input it cannot walk to, the redirect is dropped and the advice
stays as it was. Bounded by `visited`; deterministic.

Full gate, 2026-10-14: exit 0, `greedy` and `casual` pins identical. `bottleneck` reaches tier
10 at 10.6168 (was 12.4274), dead time 0.5473 (was 0.6095). Tiers 7 to 9 move to 1.3033,
1.6826, 2.5167 (were 1.3573, 1.7369, 2.4785); tiers 1 to 6 are unchanged.

The horizon is a named constant, `SLOW_PAYER_HORIZON_COLLECTIONS = 0.5`, multiplied by
`content.offlineCapMs`.

### What this does not change

- The storage-cap and drained-payer checks and their order.
- Answers whose every payer can afford the price within the horizon.
- `greedy`, `casual` and `optimal`. None reads the reporter, so their behaviour cannot
  change.

## Out of scope

- Buying more than one machine for the slow payer per decision (`machinesToClear: 1`).
  The caller re-solves after each purchase.
- Reserve sizing and the one-reserve livelock (follow-ups from PR #9).
- Whether the 409,600-beam rig is good pacing. With this rule, `bottleneck` finishes
  tier 10 at 10.62 collections. That is faster than `greedy` (24.06), and is
  `bottleneck`'s known "buys the minimum, overshoots every target" pattern.

## Acceptance

Unit tests (`bottleneck.test.ts`):
1. A recipe answer whose payer is short and growing too slowly becomes a recipe answer
   for that payer's active recipe, with the limiting target unchanged and
   `machinesToClear: 1`.
2. A payer growing fast enough to afford within the horizon leaves the answer as it was.
3. A slow payer whose recipe is not live leaves the answer as it was.
4. A slow-payer redirect whose own price overflows a payer's cap continues to storage
   advice.

Measured: the full suite, lint, typecheck and `content:check` pass. A full `sim gate`:
- `greedy` and `casual` pins are byte-identical.
- `bottleneck` is re-pinned. It now finishes all ten tiers, so `reachesTier: 9` is
  removed and tier 10 is pinned at its observed value, with `why` texts recording the
  cause.
- The handoff's bottleneck item records the 12th-rig wait as fixed.

## The §4.5 amendment

To be added after the 2026-10-13 drained-payer amendment:

> **Amended 2026-10-14: a slow payer gets production advice.** If no payer of a
> purchase overflows its cap or is drained, but one is short of the price and would take
> longer than half an offline window to afford it at its current net rate, the advice
> becomes one more machine for that payer's active recipe (if live), and passes through
> this final step again. Measured cause: `bottleneck` stopped at tier 9 of the vertical
> slice, told to buy an assembly rig while its 409,600 encased beams were ~22.6 hours of
> production away. With this rule it finishes tier 10 at 10.62 collections, with no dead
> stretch over 0.55.

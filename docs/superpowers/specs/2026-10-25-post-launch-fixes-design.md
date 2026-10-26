# Post-launch fixes: the tier-5 advice deadlock and the tier-8 GET cost

**Status:** design, 2026-10-25. Both problems affect the live game at `manufactory.neverendingcode.com`, deployed in PR #26.

**Evidence:** both root causes were reproduced and measured by an investigation against `main` at c0066e8. The probes are summarised below, with the numbers this design relies on.

---

## Problem 1: following the bottleneck advice deadlocks at tier 5

### What a player sees
A player who only presses the bottleneck frame's buy button reaches tier 5 at 7.59 h of game time, then never progresses. At the 400 h limit they are still at tier 5, after 1,193 decisions and 0 rejections.

The frame says "Limiting encased industrial beam. 1 more Constructor clears it." It offers `BUY_MACHINE coal/constructor mark 3 … recipeId make_steel_pipe`, which is never affordable and has no ETA.

### Root cause: the advice is wrong, not the content
- **The content is consistent.**
  - `make_steel_pipe` unlocks at tier 5 on the coal-lane Constructor (`recipes.yaml:55`).
  - Constructor Mk3 also unlocks at tier 5, and is priced only in steel pipe (`machines.yaml:51`).
  - That is a bootstrap cycle. It is solvable with Mk2 (40 iron plate) or Mk1 (20 iron ingot), and both are affordable in the stuck state.
- **The engine's reporter** (`packages/engine/src/solve/bottleneck.ts`) does the following:
  1. `payable` prices its answer through `machinePrice`, which always uses `bestUnlockedMark`: Mk3, costing 25 steel pipe (l.399–410).
  2. It correctly redirects to steel pipe's producer, because steel pipe is unmade (`unmadePayerAdvice`, l.464–489).
  3. It then prices that redirect at Mk3 again. Steel pipe is already in `visited`, so the chain stops.

  The result is "a steel-pipe machine, priced in steel pipe".
- **The consumers hard-code the best mark too:** the web's `machineBuy` (`apps/web/src/ui/derive.ts:188`) and the sim's bottleneck policy (`apps/sim/src/policies.ts:434`).

### Ruling PL-1: advise the best mark that can actually be paid
- **The rule.** The reporter keeps its producer-redirect chain unchanged. Only for the **final** answer, it chooses the advised mark as follows:
  - the best unlocked mark, **unless** that mark's one-machine price has a *dead payer*. A dead payer is an item that is short (liquid + bound < price) **and** not made at all (production ≤ `FLOW_TOLERANCE`);
  - in that case, the best **lower** unlocked mark with no dead payer;
  - if none qualifies, the best mark, so a single-mark class (for example `assembly_rig`) is unchanged.
- **The Bottleneck shape.** The recipe and power Bottleneck kinds carry this `mark`. The web and the sim read it instead of calling `bestUnlockedMark`.
- **Why (measured):**
  - A frame-only player reaches tier 10 at 224 h, or 182 h with milestone reorders, against 181 h for the full player. There is one step-down in the whole run.
  - The alternative, falling back inside `machinePrice`, stalls at tier 9: steel pipe is never named, so it's never made.
  - The content alternative, Mk3 unlocked at tier 6, only moves the stall to tier 7. It also shifts greedy's tier 6 by −11%, which means recalibrating.
- **The gates don't move (measured).**
  - The `bottleneck` policy reproduces every `VERTICAL_SLICE_GATE` pin exactly. Across 906 decisions, the advice carried a dead mark 0 times.
  - Greedy, casual and optimal never read the advice, so `gate:smoke` and calibration are untouched.
  - The play.test player's pins hold.
- **Known wrinkle.** `machinesToClear` is computed in best-mark units, so a stepped-down buy can under-clear. The next solve corrects it, and the frame re-advises.
- **Cost if wrong:** one helper and one field. The gates prove that nothing else moved.

## Problem 2: a world GET costs about 0.3 s (0.6 s in production) on tier-8 worlds

### Root cause: the EPSILON cycle burns the whole event budget
- **The cycle.** On a tier-8 world, screw alternates between EMPTY (net +149.9/s) and FLOWING (net −34.5/s). It steps at `EPSILON_MS` and 4.3e-6 ms.
- **The budget.** `resolve` spends its full `MAX_EVENTS` = 10,000 fine steps on 26.7 µs of game time, then falls back to coarse 60 s steps.
- **Where the time goes.**
  - Each fine step costs about 27 µs of Decimal bookkeeping:
    - the cache-key closure calling `itemStateTag` for every item (42%);
    - `liquidCap`/`capAtLevel` recomputing powers (22%);
    - `integrate` (26%);
    - `settle` (14%).
  - The solves themselves are only 8–18 ms, because they're already cached.
- **Who pays it.** The server resolves from the stored state (`worlds.ts:153`), so **every GET until the player's next action pays the full ~300 ms**, whatever the gap.
- **How common it is.** The sim's bottleneck policy trips the guard on 369 of 906 resolves, so real worlds hit this.

### Ruling PL-2: make it cheap without changing a single result
- **Exact fixes now.** Both are byte-identical, so replay and every pin are safe.
  1. **A resumable prefix cache.**
     - Up to the guard, the fine-step loop doesn't depend on the window length: no step is clipped by `remaining`.
     - Cache the state at step `MAX_EVENTS`, plus the sequence of step sizes and the events. Key the entry on the caller's identity for the start state.
     - Any later resolve from that same start, with a window at least as long, resumes from the cached point.
     - The engine takes an optional cache with a caller-supplied key. The API keys it by `(worldId, stateVersion, contentChecksum)` in a small per-process LRU.
     - Prototype: 272–286 ms drops to 4.6–22 ms, with state, events and schedule byte-identical at 5 s, 60 s, 1 h, 8 h and 24 h.
  2. **Memoise `capAtLevel`.** This is exact, about −10%.
- **The real fix is deferred, and it's the user's decision.**
  - That fix is to collapse the cycle into an averaged rate: hold screw at 0 with blend θ = 34.5 / (149.9 + 34.5).
  - It would bring a resolve to about 5 ms, and it would also remove a non-physical side effect. The coarse phase banks screws at the last-solved +149.9/s.
  - But it breaks byte-exact replay for every world whose history crossed a cycle, and it moves the calibration pins.
  - So it needs engine versioning in the action log, or a re-base at deploy, plus a re-gate. That is recorded here, and not built.
- **Cost if wrong:** caches are per process. A wrong key could return another world's prefix, so the key includes the world identity and `stateVersion`, and a test proves that a different key misses.

## Out of scope
- The averaged-rate cycle fix (PL-2's deferred part).
- Content and pacing changes.
- The other post-Phase-4 minors listed in PR #25.

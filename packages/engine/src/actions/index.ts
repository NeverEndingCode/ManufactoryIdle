// Spec A.2: actions are engine reducers, not API handlers. The API becomes almost
// pure transport -- authenticate, lock the row, resolve, apply, persist, return --
// so essentially no game logic lives in apps/api and there is nothing there to
// drift from the client. It also buys spec 16.3's full action parity in `sim play`
// structurally: the terminal client calls these identical functions with no HTTP in
// between, so a divergence between what is possible in the simulator and in the
// game cannot be expressed.
import type { IndexedContent } from "../graph/index-content.js";
import type { PrngState } from "../state/prng.js";
import type { WorldState } from "../state/world.js";
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

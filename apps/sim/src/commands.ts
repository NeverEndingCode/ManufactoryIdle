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
  } else if (bottleneck.kind === "power") {
    lines.push(
      `BOTTLENECK  power limiting ${bottleneck.limitingTarget} — ` +
        `${bottleneck.machinesToClear} more ${bottleneck.generatorRecipeId ?? "generator"} clears it`,
    );
  } else if (bottleneck.upgrade === null) {
    // Both curves maxed. Naming no fix is the honest answer; check 9 is what should
    // keep a bundle from ever reaching this state.
    lines.push(
      `BOTTLENECK  ${bottleneck.itemId} is at its cap and both storage curves are maxed`,
    );
  } else {
    const what = bottleneck.upgrade === "storage" ? "storage" : "quantum storage";
    lines.push(
      `BOTTLENECK  ${bottleneck.itemId} is at its cap limiting ${bottleneck.limitingTarget} — ` +
        `one more ${what} level clears it`,
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

// Spec 3a: the request body is validated per action type before any transaction
// opens. Unknown types, missing fields, extra fields and wrong types are a 400 here;
// the engine still owns semantics (affordability, liveness, count ranges), which is
// why numeric fields are typed but not ranged beyond what JSON already guarantees.
// Kept in step with the engine's `Action` union (packages/engine/src/actions/types.ts).

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const num = { type: "number" } as const;

function action(
  type: string,
  required: Record<string, object>,
  optional: Record<string, object> = {},
): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", ...Object.keys(required)],
    properties: { type: { const: type }, ...required, ...optional },
  };
}

const machine = { lane: str, machineClass: str, mark: int, count: int };

export const actionSchema = {
  oneOf: [
    action("BUY_MACHINE", machine, { recipeId: str }),
    action("DISMANTLE", machine),
    action("UPGRADE_MARK", { lane: str, machineClass: str, fromMark: int }),
    action("ASSIGN_MACHINES", { recipeId: str, count: int }),
    action("SELECT_RECIPE", { itemId: str, recipeId: str }),
    action("REORDER_PRIORITY", { entries: { type: "array", items: str } }),
    action(
      "SET_PRIORITY_MODE",
      { entryId: str, mode: { enum: ["guaranteed", "share"] } },
      { share: num, targetRate: { type: ["number", "null"] }, paused: { type: "boolean" } },
    ),
    action("SET_RESERVE", { itemId: str, percent: num }),
    action("BUY_STORAGE", { itemId: str, levels: int }),
    action("BUY_QS", { lane: str, levels: int }),
    action("TAP", { count: num, clientElapsedMs: num }),
  ],
} as const;

/** Spec D.2's body: `{ idempotencyKey, baseVersion, actions }`. */
export const actionsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["idempotencyKey", "baseVersion", "actions"],
  properties: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
    // Advisory only (engine spec D.2): correctness comes from the row lock.
    baseVersion: { type: "integer", minimum: 0 },
    actions: { type: "array", minItems: 1, maxItems: 100, items: actionSchema },
  },
} as const;

// Tarjan's strongly-connected-components algorithm over the recipe dependency
// graph. Spec B.6 check 6 and spec section 4.3: parts of the Satisfactory graph
// contain real loops (residual fuels, recycled plastic and rubber), and naive
// recursive expansion would not terminate on them.
//
// Written iteratively rather than recursively: recipe counts reach a few hundred
// and a blown call stack in a content validator is a miserable failure mode.
import type { ValidationIssue } from "../load.js";
import type { Bundle } from "../schema.js";

export function findStronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, string[]>,
): string[][] {
  const known = new Set(nodes);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  const successors = (node: string): string[] =>
    (edges.get(node) ?? []).filter((next) => known.has(next));

  for (const root of nodes) {
    if (index.has(root)) continue;

    // Each frame tracks how far through its successor list we have walked.
    const frames: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const children = successors(frame.node);

      if (frame.next < children.length) {
        const child = children[frame.next]!;
        frame.next += 1;

        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          frames.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        // A single node is only a cycle if it points at itself.
        const isCycle =
          component.length > 1 ||
          (component.length === 1 && successors(component[0]!).includes(component[0]!));
        if (isCycle) result.push(component);
      }
    }
  }

  return result;
}

// Recipe R depends on recipe S when R consumes an item S produces.
export function buildRecipeDependencyGraph(bundle: Bundle): {
  nodes: string[];
  edges: Map<string, string[]>;
} {
  const producersOf = new Map<string, string[]>();
  for (const recipe of bundle.recipes) {
    for (const output of recipe.outputs) {
      const list = producersOf.get(output.item) ?? [];
      list.push(recipe.id);
      producersOf.set(output.item, list);
    }
  }

  const edges = new Map<string, string[]>();
  for (const recipe of bundle.recipes) {
    const deps = new Set<string>();
    for (const input of recipe.inputs) {
      for (const producer of producersOf.get(input.item) ?? []) deps.add(producer);
    }
    edges.set(recipe.id, [...deps]);
  }

  return { nodes: bundle.recipes.map((r) => r.id), edges };
}

// Ruling R6: every recipe inside a non-trivial SCC is permanently unselectable —
// the engine's `findCyclicRecipes` excludes exactly this set from the live graph.
// Anything that reasons about what a player can actually reach has to agree, or
// the validator clears content the game cannot run.
export function cyclicRecipeIds(bundle: Bundle): Set<string> {
  const { nodes, edges } = buildRecipeDependencyGraph(bundle);
  return new Set(findStronglyConnectedComponents(nodes, edges).flat());
}

export function selectableRecipes(bundle: Bundle): Bundle["recipes"] {
  const cyclic = cyclicRecipeIds(bundle);
  return bundle.recipes.filter((recipe) => !cyclic.has(recipe.id));
}

export function checkCycles(bundle: Bundle): ValidationIssue[] {
  const { nodes, edges } = buildRecipeDependencyGraph(bundle);
  // A warning, not an error: spec B.6 flags cycles "unselectable in v1" rather than
  // rejecting the bundle, and ruling R6 already makes every recipe in a non-trivial
  // SCC permanently non-live in the engine. See ValidationIssue.severity.
  return findStronglyConnectedComponents(nodes, edges).map((component) => ({
    check: 6,
    severity: "warning" as const,
    message: `recipe cycle (unselectable in v1): ${[...component].sort().join(" -> ")}`,
  }));
}

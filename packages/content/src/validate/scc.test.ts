import { describe, expect, it } from "vitest";
import { findStronglyConnectedComponents } from "./scc.js";

function graph(spec: Record<string, string[]>): {
  nodes: string[];
  edges: Map<string, string[]>;
} {
  return { nodes: Object.keys(spec), edges: new Map(Object.entries(spec)) };
}

describe("findStronglyConnectedComponents", () => {
  it("returns nothing for an acyclic graph", () => {
    const { nodes, edges } = graph({ a: ["b"], b: ["c"], c: [] });
    expect(findStronglyConnectedComponents(nodes, edges)).toEqual([]);
  });

  it("finds a two-node cycle", () => {
    const { nodes, edges } = graph({ a: ["b"], b: ["a"] });
    const found = findStronglyConnectedComponents(nodes, edges);
    expect(found).toHaveLength(1);
    expect([...found[0]!].sort()).toEqual(["a", "b"]);
  });

  it("finds a three-node cycle and ignores the acyclic tail", () => {
    const { nodes, edges } = graph({ a: ["b"], b: ["c"], c: ["a"], d: ["a"], e: [] });
    const found = findStronglyConnectedComponents(nodes, edges);
    expect(found).toHaveLength(1);
    expect([...found[0]!].sort()).toEqual(["a", "b", "c"]);
  });

  it("finds a self-loop", () => {
    const { nodes, edges } = graph({ a: ["a"], b: [] });
    expect(findStronglyConnectedComponents(nodes, edges)).toEqual([["a"]]);
  });

  it("finds two independent cycles", () => {
    const { nodes, edges } = graph({ a: ["b"], b: ["a"], c: ["d"], d: ["c"] });
    expect(findStronglyConnectedComponents(nodes, edges)).toHaveLength(2);
  });

  it("tolerates edges to nodes that are not in the node list", () => {
    const { nodes, edges } = graph({ a: ["ghost"] });
    expect(findStronglyConnectedComponents(nodes, edges)).toEqual([]);
  });
});

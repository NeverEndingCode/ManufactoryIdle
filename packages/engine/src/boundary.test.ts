import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function lint(file: string): { code: number; output: string } {
  try {
    const output = execFileSync("pnpm", ["exec", "eslint", "--no-warn-ignored", file], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("engine import boundary", () => {
  it("rejects a forbidden import from inside packages/engine", () => {
    const file = join(repoRoot, "packages/engine/src/__boundary_probe.ts");
    writeFileSync(file, 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n');
    try {
      const result = lint(file);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("no-restricted-imports");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("allows the two permitted dependencies", () => {
    const file = join(repoRoot, "packages/engine/src/__boundary_ok.ts");
    writeFileSync(
      file,
      'import Decimal from "break_infinity.js";\nimport { ONE } from "@manufactory/rational";\nexport const x = [Decimal, ONE];\n',
    );
    try {
      expect(lint(file).code).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("rejects a bare '.' import, not just './something'", () => {
    // Regression case: an earlier gitignore-style allow-list negated "./**"
    // but not the bare "." segment itself, so `import x from "."` slipped
    // through unrestricted. The regex-based rule must reject it too.
    const file = join(repoRoot, "packages/engine/src/__boundary_probe.ts");
    writeFileSync(file, 'import { x } from ".";\nexport const y = x;\n');
    try {
      const result = lint(file);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("no-restricted-imports");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("does not restrict packages outside the engine", () => {
    // packages/rational is a fine control here — it is a real, unrestricted
    // package (no import-boundary or clock/RNG rules apply to it), same as
    // packages/content. Either would do; this one predates and is unrelated
    // to content, so it stays put rather than churning for churn's sake.
    const file = join(repoRoot, "packages/rational/src/__boundary_probe.ts");
    writeFileSync(file, 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n');
    try {
      expect(lint(file).code).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("engine determinism guardrail (spec A.5)", () => {
  it("rejects a dynamic import", () => {
    const file = join(repoRoot, "packages/engine/src/__determinism_probe.ts");
    writeFileSync(
      file,
      'export async function f() {\n  const fs = await import("node:fs");\n  return fs;\n}\n',
    );
    try {
      const result = lint(file);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("no-restricted-syntax");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("rejects Date.now()", () => {
    const file = join(repoRoot, "packages/engine/src/__determinism_probe.ts");
    writeFileSync(file, "export const t = Date.now();\n");
    try {
      const result = lint(file);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("no-restricted-properties");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("rejects Math.random()", () => {
    const file = join(repoRoot, "packages/engine/src/__determinism_probe.ts");
    writeFileSync(file, "export const r = Math.random();\n");
    try {
      const result = lint(file);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("no-restricted-properties");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("still rejects Date.now() inside a *.test.ts file — only the import rule relaxes for tests", () => {
    const file = join(repoRoot, "packages/engine/src/__determinism_probe.test.ts");
    writeFileSync(file, "export const t = Date.now();\n");
    try {
      const result = lint(file);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("no-restricted-properties");
    } finally {
      rmSync(file, { force: true });
    }
  });
});

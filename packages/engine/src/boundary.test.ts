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

  it("does not restrict packages outside the engine", () => {
    // packages/content does not exist yet (it arrives in Task 5); this points
    // at packages/rational instead so the case can run today. Once Task 5
    // lands, this can be switched to packages/content/src/__boundary_probe.ts.
    const file = join(repoRoot, "packages/rational/src/__boundary_probe.ts");
    writeFileSync(file, 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n');
    try {
      expect(lint(file).code).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

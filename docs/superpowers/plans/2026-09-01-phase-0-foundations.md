# Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, the vendored rational package, the engine's number layer, and the content schema and structural validator, all behind a green CI pipeline.

**Architecture:** A pnpm + Turborepo monorepo of source-only TypeScript workspace packages. `packages/engine` is pure — no I/O, no clock, no randomness — and an ESLint boundary rule enforces that it imports nothing but `@manufactory/rational` and `break_infinity.js`. `packages/content` owns the bundle schema and a validator CLI that fails the build on structurally broken content.

**Tech Stack:** Node 22 LTS, TypeScript 5.6 strict, pnpm 10, Turborepo 2, vitest 4, Zod 4, YAML, break_infinity.js, ESLint 9 flat config, Prettier 3, Docker Compose (Postgres 16 + SuperTokens).

**Spec:** `docs/superpowers/specs/2026-09-01-engine-core-design.md`

## Global Constraints

- **Runtime:** Node 22 LTS. TypeScript `strict: true` plus `noUncheckedIndexedAccess`. (Spec A.5)
- **License:** Everything is GPL-3.0. Vendored code keeps its attribution and carries a modification notice, per GPLv3 §5(a). (Spec D2)
- **Engine purity:** `packages/engine` may import only `@manufactory/rational` and `break_infinity.js`. No `Date.now()`, no `Math.random`, no `fetch`, no filesystem. Enforced by lint, not convention. (Spec A.2, A.5)
- **Numeric zones:** BigInt rationals at content-load time only; `float64` for clocks and allocation; `Decimal` for stockpiles, rates, costs, multipliers. A Decimal never enters a solve; a rational never leaves load time. (Spec A.4)
- **Determinism:** Decimals persist as canonical strings, never `numeric`. Transcendental functions (`Math.pow`/`exp`/`log`) are avoided in state-affecting paths — cost curves use integer exponentiation by squaring, softcaps are piecewise-linear. (Spec A.5, E.4)
- **Module system:** ESM throughout (`"type": "module"`). Workspace packages are source-only — `"main": "./src/index.ts"` — and consumed directly by TypeScript.
- **Test runner:** vitest. Every task ends with tests passing and a commit.

## Scope

This plan covers **Phase 0 only** of the five-phase build order in spec F.2. It ends in a green pipeline with a validated content bundle, not a playable game.

**Deferred to Phase 2 (calibration):** validator checks 8, 9, and 10 from spec B.6 (`r_eff > 1 + ε`, storage cap versus largest build cost, generator capacity versus tier draw). All three need economy and calibration machinery that does not exist until Phase 2. Checks 1–7 and 11 ship here.

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` | Workspace wiring, shared compiler options |
| `eslint.config.js` | Flat config; carries the engine import-boundary rule |
| `.github/workflows/ci.yml` | lint → typecheck → test → content:check |
| `infra/docker-compose.yml`, `infra/.env.example` | Postgres 16 + SuperTokens core |
| `packages/rational/` | Vendored BigInt exact rational arithmetic (GPL-3.0, EvanTrow) |
| `packages/engine/src/numbers/decimal.ts` | Decimal construction and canonical string serialization |
| `packages/engine/src/numbers/format.ts` | The six display notations, one pure function |
| `packages/content/src/schema.ts` | Zod schema for a content bundle |
| `packages/content/src/load.ts` | YAML → parse → validate → reference resolution |
| `packages/content/src/validate/scc.ts` | Tarjan SCC over the recipe graph |
| `packages/content/src/validate/graph.ts` | Structural checks 3–7 |
| `packages/content/src/checksum.ts` | Deterministic bundle checksum |
| `packages/content/src/cli.ts` | `pnpm content:check` |
| `packages/content/bundles/fixture/` | A tiny bundle that exercises the whole pipeline |

---

### Task 1: Monorepo scaffolding, vendored rational, and CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.prettierrc.json`, `eslint.config.js`
- Create: `.github/workflows/ci.yml`
- Create: `packages/rational/` (vendored), `packages/rational/README.md`, `packages/rational/tsconfig.json`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `@manufactory/rational` exporting `Rational`, `makeRational(n: bigint, d: bigint): Rational`, `of(n: bigint|number, d?: bigint|number): Rational`, `add`, `subtract`, `multiply`, `divide`, `negate`, `reciprocal`, `abs`, `compare`, `equals`, `isZero`, `isNegative`, `isPositive`, `ZERO`, `ONE`, `parseRational(s: string): Rational`, `RationalParseError`, `formatRational`, `toDecimalString`, `powerAtClock`, `toApproximateNumber`

- [ ] **Step 1: Create the workspace root files**

`package.json`:

```json
{
  "name": "manufactory-idle",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@10.24.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "content:check": "pnpm --filter @manufactory/content content:check"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.0.0",
    "globals": "^16.0.0",
    "prettier": "^3.0.0",
    "turbo": "^2.0.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.10"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "test": { "dependsOn": ["^build"], "outputs": [] },
    "content:check": { "dependsOn": ["^build"], "outputs": [] }
  }
}
```

`tsconfig.base.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

`.nvmrc`:

```
22
```

`.prettierrc.json`:

```json
{ "printWidth": 100, "semi": true, "singleQuote": false, "trailingComma": "all" }
```

- [ ] **Step 2: Vendor the rational package**

Run:

```bash
git clone --depth 1 https://github.com/EvanTrow/Satisfactory-Colab-Modeler.git /tmp/scm-src
mkdir -p packages/rational
cp -r /tmp/scm-src/packages/rational/src packages/rational/src
cp /tmp/scm-src/packages/rational/package.json packages/rational/package.json
rm -rf /tmp/scm-src
```

Then replace `packages/rational/package.json` with:

```json
{
  "name": "@manufactory/rational",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.10"
  }
}
```

Create `packages/rational/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "noEmit": true },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Add the GPL attribution notice**

GPLv3 §5(a) requires a prominent notice of modification with a date. Create `packages/rational/README.md`:

```markdown
# @manufactory/rational

BigInt-backed exact rational arithmetic.

## Attribution

This package is vendored from
[EvanTrow/Satisfactory-Colab-Modeler](https://github.com/EvanTrow/Satisfactory-Colab-Modeler),
`packages/rational`, which is licensed GPL-3.0.

**Modified on 2026-09-01** by the Manufactory Idle project. Changes: package renamed
from `@scm/rational` to `@manufactory/rational`; build script changed to typecheck-only
because this workspace consumes packages from source; tsconfig re-parented to this
repository's `tsconfig.base.json`. No changes to the arithmetic itself.

Manufactory Idle is a derivative work and is likewise licensed GPL-3.0. See the
repository root `LICENSE`.
```

- [ ] **Step 4: Add the ESLint flat config**

`eslint.config.js`:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
```

- [ ] **Step 5: Add the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 6: Install and verify the vendored tests pass**

Run:

```bash
pnpm install
pnpm test
```

Expected: vitest runs `packages/rational`'s five test files (`rational.test.ts`, `parse.test.ts`, `format.test.ts`, `power.test.ts`, `round-trip.test.ts`) and all pass. If any fail, the vendoring is incomplete — check that `src/` copied in full.

- [ ] **Step 7: Verify lint and typecheck are clean**

Run:

```bash
pnpm lint && pnpm typecheck
```

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Scaffold the monorepo and vendor the rational package

pnpm + Turborepo workspace on Node 22 with TypeScript strict and
noUncheckedIndexedAccess. Vendors packages/rational from
EvanTrow/Satisfactory-Colab-Modeler under GPL-3.0 with the modification
notice GPLv3 5(a) requires. CI runs lint, typecheck, and test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The engine package and its Decimal layer

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/src/index.ts`
- Create: `packages/engine/src/numbers/decimal.ts`
- Test: `packages/engine/src/numbers/decimal.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the workspace
- Produces: from `@manufactory/engine`:
  - `type Dec = Decimal` (re-exported from `break_infinity.js`)
  - `D(value: number | string | Dec): Dec`
  - `toCanonical(value: Dec): string`
  - `fromCanonical(text: string): Dec`
  - `DECIMAL_ZERO: Dec`, `DECIMAL_ONE: Dec`

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/engine/package.json`:

```json
{
  "name": "@manufactory/engine",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@manufactory/rational": "workspace:*",
    "break_infinity.js": "^2.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.10"
  }
}
```

`packages/engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "noEmit": true },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/engine/src/numbers/decimal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { D, DECIMAL_ONE, DECIMAL_ZERO, fromCanonical, toCanonical } from "./decimal.js";

describe("D", () => {
  it("builds from number, string, and Decimal", () => {
    expect(D(42).toNumber()).toBe(42);
    expect(D("1e100").exponent).toBe(100);
    expect(D(D(7)).toNumber()).toBe(7);
  });

  it("exposes zero and one", () => {
    expect(DECIMAL_ZERO.toNumber()).toBe(0);
    expect(DECIMAL_ONE.toNumber()).toBe(1);
  });
});

describe("canonical serialization", () => {
  const cases = ["0e0", "1e0", "1.5e0", "1e300", "1e-300", "1.2345e678", "9.999999e9999"];

  it.each(cases)("round-trips %s", (text) => {
    expect(toCanonical(fromCanonical(text))).toBe(text);
  });

  it("is stable across a second round trip", () => {
    const once = toCanonical(D("1.2345e678"));
    expect(toCanonical(fromCanonical(once))).toBe(once);
  });

  it("normalizes zero to a single representation", () => {
    expect(toCanonical(D(0))).toBe("0e0");
    expect(toCanonical(D("0e50"))).toBe("0e0");
  });

  it("survives magnitudes far past float64", () => {
    const big = D("1e6000");
    expect(fromCanonical(toCanonical(big)).exponent).toBe(6000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @manufactory/engine test`
Expected: FAIL — `Cannot find module './decimal.js'`.

- [ ] **Step 4: Write the implementation**

`packages/engine/src/numbers/decimal.ts`:

```ts
// Magnitude arithmetic. Spec A.4 zone 3: stockpiles, rates, build costs, and
// multipliers reach 1e600 and beyond, so they are mantissa/exponent Decimals
// rather than rationals or plain floats.
import Decimal from "break_infinity.js";

export type Dec = Decimal;

export const DECIMAL_ZERO: Dec = new Decimal(0);
export const DECIMAL_ONE: Dec = new Decimal(1);

export function D(value: number | string | Dec): Dec {
  return value instanceof Decimal ? value : new Decimal(value);
}

// Spec A.5: Decimals persist as canonical strings in JSONB, never as `numeric`.
// We serialize mantissa and exponent explicitly rather than relying on
// `toString()`, whose formatting switches representation by magnitude.
// Number#toString() emits the shortest round-trippable form, so no precision
// is lost.
export function toCanonical(value: Dec): string {
  if (value.mantissa === 0) return "0e0";
  return `${value.mantissa.toString()}e${value.exponent.toString()}`;
}

export function fromCanonical(text: string): Dec {
  return new Decimal(text);
}
```

- [ ] **Step 5: Create the package entry point**

`packages/engine/src/index.ts`:

```ts
export { D, DECIMAL_ONE, DECIMAL_ZERO, fromCanonical, toCanonical, type Dec } from "./numbers/decimal.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @manufactory/engine test`
Expected: PASS, all cases green.

If `9.999999e9999` fails to round-trip, that is `break_infinity.js` hitting its exponent ceiling — lower that case to `1e5000` and note it in the test, since the game never reaches it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the engine package and its Decimal layer

Canonical mantissa/exponent string serialization, per spec A.5, so saved
magnitudes round-trip exactly and never rely on toString() switching
representation by magnitude.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The number formatter

**Files:**
- Create: `packages/engine/src/numbers/format.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/numbers/format.test.ts`

**Interfaces:**
- Consumes: `D`, `type Dec` from Task 2
- Produces: from `@manufactory/engine`:
  - `type NotationMode = "sci" | "eng" | "names" | "short" | "doubled" | "hybrid"`
  - `format(value: Dec, mode: NotationMode): string`
  - `letterSuffix(index: number): string` (0 → `"aa"`, 25 → `"az"`, 26 → `"ba"`, 676 → `"aaa"`)

- [ ] **Step 1: Write the failing test**

`packages/engine/src/numbers/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { D } from "./decimal.js";
import { format, letterSuffix } from "./format.js";

describe("letterSuffix", () => {
  it("starts at two letters and rolls over correctly", () => {
    expect(letterSuffix(0)).toBe("aa");
    expect(letterSuffix(1)).toBe("ab");
    expect(letterSuffix(25)).toBe("az");
    expect(letterSuffix(26)).toBe("ba");
    expect(letterSuffix(675)).toBe("zz");
    expect(letterSuffix(676)).toBe("aaa");
  });
});

describe("format", () => {
  it("renders small values without a suffix", () => {
    expect(format(D(0), "short")).toBe("0");
    expect(format(D(5), "short")).toBe("5.00");
    expect(format(D(42.5), "short")).toBe("42.5");
    expect(format(D(999), "short")).toBe("999");
  });

  it("renders negatives", () => {
    expect(format(D(-1234), "short")).toBe("-1.23 K");
  });

  it.each([
    ["sci", "1.23e45"],
    ["eng", "12.30e44"],
    ["short", "12.30 od"],
    ["hybrid", "1.23e45"],
  ] as const)("renders 1.23e45 in %s mode", (mode, expected) => {
    expect(format(D("1.23e45"), mode)).toBe(expected);
  });

  it("uses short suffixes below the letter threshold", () => {
    expect(format(D(1234), "short")).toBe("1.23 K");
    expect(format(D("1.5e6"), "short")).toBe("1.50 M");
    expect(format(D("2e9"), "short")).toBe("2.00 B");
    expect(format(D("7.7e12"), "short")).toBe("7.70 T");
  });

  it("switches to letters at 1e15", () => {
    expect(format(D("1e15"), "short")).toBe("1.00 aa");
    expect(format(D("1e18"), "short")).toBe("1.00 ab");
  });

  it("doubles and uppercases letters in doubled mode", () => {
    expect(format(D("1e15"), "doubled")).toBe("1.00 AA");
    expect(format(D(1234), "doubled")).toBe("1.23 K");
  });

  it("spells out names while it has them, then falls back to scientific", () => {
    expect(format(D(1234), "names")).toBe("1.23 thousand");
    expect(format(D("3e15"), "names")).toBe("3.00 quadrillion");
    expect(format(D("1e60"), "names")).toBe("1.00e60");
  });

  it("hybrid uses short suffixes then scientific", () => {
    expect(format(D("7.7e12"), "hybrid")).toBe("7.70 T");
    expect(format(D("1e15"), "hybrid")).toBe("1.00e15");
  });

  it("is pure — mode is an argument, not global state", () => {
    const value = D("1e15");
    expect(format(value, "short")).toBe("1.00 aa");
    expect(format(value, "sci")).toBe("1.00e15");
    expect(format(value, "short")).toBe("1.00 aa");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @manufactory/engine test format`
Expected: FAIL — `Cannot find module './format.js'`.

- [ ] **Step 3: Write the implementation**

`packages/engine/src/numbers/format.ts`:

```ts
// Display notation. Spec section 9: idle players have strong preferences here,
// so several notations are offered and the choice lives in player preferences.
// This is one pure function taking mode as an argument — never a branch at the
// call site.
import type { Dec } from "./decimal.js";

export type NotationMode = "sci" | "eng" | "names" | "short" | "doubled" | "hybrid";

const SHORT = ["", "K", "M", "B", "T"] as const;
const NAMES = [
  "",
  "thousand",
  "million",
  "billion",
  "trillion",
  "quadrillion",
  "quintillion",
  "sextillion",
  "septillion",
  "octillion",
  "nonillion",
  "decillion",
] as const;

// 0 -> "aa", 25 -> "az", 26 -> "ba", 675 -> "zz", 676 -> "aaa".
// Fixed-width base-26 blocks, widest-first, starting at two letters.
export function letterSuffix(index: number): string {
  let n = index;
  let width = 2;
  let block = 26 * 26;
  while (n >= block) {
    n -= block;
    width += 1;
    block *= 26;
  }
  let out = "";
  for (let i = 0; i < width; i += 1) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function plain(value: number): string {
  const abs = Math.abs(value);
  if (abs < 10) return value.toFixed(2);
  if (abs < 100) return value.toFixed(1);
  return value.toFixed(0);
}

export function format(value: Dec, mode: NotationMode): string {
  if (value.mantissa === 0) return "0";

  const negative = value.mantissa < 0;
  const sign = negative ? "-" : "";
  const exponent = value.exponent;
  const mantissa = Math.abs(value.mantissa);

  if (exponent < 3) return sign + plain(mantissa * Math.pow(10, exponent));

  // tier counts groups of three digits; scaled sits in [1, 1000).
  const tier = Math.floor(exponent / 3);
  const scaled = mantissa * Math.pow(10, exponent - tier * 3);

  const sci = () => `${sign}${mantissa.toFixed(2)}e${exponent}`;

  switch (mode) {
    case "sci":
      return sci();
    case "eng":
      return `${sign}${scaled.toFixed(2)}e${tier * 3}`;
    case "names":
      return tier < NAMES.length ? `${sign}${scaled.toFixed(2)} ${NAMES[tier]}` : sci();
    case "hybrid":
      return tier < SHORT.length ? `${sign}${scaled.toFixed(2)} ${SHORT[tier]}` : sci();
    case "short":
    case "doubled": {
      if (tier < SHORT.length) return `${sign}${scaled.toFixed(2)} ${SHORT[tier]}`;
      const letters = letterSuffix(tier - SHORT.length);
      const suffix = mode === "doubled" ? letters.toUpperCase() : letters;
      return `${sign}${scaled.toFixed(2)} ${suffix}`;
    }
  }
}
```

Note on `Math.pow` here: spec E.4 bans transcendentals from **state-affecting** paths. Formatting is display-only and never feeds back into state, so it is exempt. Do not copy this pattern into `economy/`.

- [ ] **Step 4: Export it**

Modify `packages/engine/src/index.ts` to read:

```ts
export { D, DECIMAL_ONE, DECIMAL_ZERO, fromCanonical, toCanonical, type Dec } from "./numbers/decimal.js";
export { format, letterSuffix, type NotationMode } from "./numbers/format.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @manufactory/engine test`
Expected: PASS.

Two expectations worth understanding rather than "fixing" if they surprise you:
- `format(D("1.23e45"), "short")` is `"12.30 od"` because tier 15 lands 10 places past `T`, and `letterSuffix(10)` is `"ok"`... verify against the implementation and correct the literal in the test to whatever `letterSuffix(15 - 5)` actually returns. The *rule* under test is the threshold and rollover, not the specific pair.
- `format(D("1e15"), "hybrid")` is scientific, not `"1.00 aa"` — hybrid deliberately stops at `T`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add the number formatter

Six notations from spec section 9 as one pure function taking mode as an
argument. Letter suffixes start at two characters and roll over in
fixed-width base-26 blocks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The engine import-boundary lint rule

**Files:**
- Modify: `eslint.config.js`
- Test: `packages/engine/src/boundary.test.ts`

**Interfaces:**
- Consumes: the flat config from Task 1
- Produces: a lint failure whenever `packages/engine` imports anything but `@manufactory/rational`, `break_infinity.js`, or a relative path

Spec A.2 makes engine purity structural rather than a convention. This task is what turns that sentence into something CI enforces.

- [ ] **Step 1: Write the failing test**

`packages/engine/src/boundary.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function lint(file: string): { code: number; output: string } {
  try {
    const output = execFileSync("npx", ["eslint", "--no-warn-ignored", file], {
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
    const dir = mkdtempSync(join(tmpdir(), "boundary-"));
    rmSync(dir, { recursive: true, force: true });
    const file = join(repoRoot, "packages/content/src/__boundary_probe.ts");
    writeFileSync(file, 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n');
    try {
      expect(lint(file).code).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @manufactory/engine test boundary`
Expected: FAIL — the first case exits 0 because no restriction exists yet.

The third case also needs `packages/content` to exist. If Task 5 has not run yet, temporarily point that case at `packages/rational/src/__boundary_probe.ts` instead and switch it back after Task 5.

- [ ] **Step 3: Add the restriction to the flat config**

Append this block to `eslint.config.js`, immediately before the trailing `prettier,`:

```js
  {
    files: ["packages/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Spec A.2: the engine is pure. It may import its two numeric
              // dependencies and its own relative modules, nothing else — no
              // clock, no randomness, no I/O, no framework.
              group: ["*", "!@manufactory/rational", "!break_infinity.js", "!./**", "!../**"],
              message:
                "packages/engine is pure (spec A.2): only @manufactory/rational, break_infinity.js, and relative imports are allowed.",
            },
          ],
        },
      ],
    },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @manufactory/engine test boundary`
Expected: PASS — forbidden import rejected, permitted imports accepted, other packages unaffected.

- [ ] **Step 5: Verify the real engine sources still lint clean**

Run: `pnpm lint`
Expected: exit 0. `decimal.ts` and `format.ts` import only `break_infinity.js` and relative paths.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Enforce the engine import boundary in lint

Spec A.2 makes engine purity structural rather than a convention: no
clock, no randomness, no I/O, no framework. A test drives eslint against
a probe file to prove the rule both fires and stays scoped to the engine.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

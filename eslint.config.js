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
  {
    files: ["packages/engine/**/*.ts"],
    ignores: ["packages/engine/**/*.test.ts", "packages/engine/src/testing/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Spec A.2: the engine is pure. It may import its two numeric
              // dependencies and its own relative modules, nothing else — no
              // clock, no randomness, no I/O, no framework.
              //
              // A gitignore-style `group` allow-list was tried first and
              // rejected: ESLint matches `group` patterns via the `ignore`
              // package's gitignore semantics, where "**" excludes every path
              // *segment*, including "." and "@manufactory" themselves.
              // Re-including a leaf ("!./**", "!@manufactory/rational")
              // without also re-including its parent segment ("!.",
              // "!@manufactory") is silently ineffective — and even once
              // patched to do that, bare "." / ".." / "@manufactory" (no
              // subpath) still slipped through, because those negations
              // unignore the literal strings outright rather than only as
              // path prefixes. That imprecision cannot be read off the
              // config, which makes a `group` array a maintenance hazard here
              // regardless of whether a given revision happens to be correct.
              //
              // A `regex` states the allow-list exactly instead: restrict
              // everything EXCEPT a relative import (a "." or ".." segment
              // followed by "/", so bare "." / ".." are still restricted) or
              // one of the two exact permitted specifiers. The trailing "."
              // requires at least one character, so an empty specifier can't
              // match vacuously.
              regex: "^(?!\\.{1,2}\\/|@manufactory\\/rational$|break_infinity\\.js$).",
              message:
                "packages/engine is pure (spec A.2): only @manufactory/rational, break_infinity.js, and relative imports are allowed.",
            },
          ],
        },
      ],
    },
  },
  {
    // Spec A.5: no clock, no randomness, no transcendentals in state-affecting
    // paths (E.4). Deliberately NOT relaxed for `*.test.ts` — unlike the
    // import-boundary block above, engine tests get no exemption here. A
    // test that reaches for `Date.now()` or `Math.random()` for convenience
    // is itself nondeterministic, which is exactly the flakiness this whole
    // design is trying to keep out of the engine's tests, not just its
    // source.
    files: ["packages/engine/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "Spec A.2: dynamic import bypasses the engine import boundary.",
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Spec A.5: time arrives as a parameter.",
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "performance", message: "Spec A.5: no clock in the engine." },
        { name: "setTimeout", message: "Spec A.5: no clock in the engine." },
        { name: "setInterval", message: "Spec A.5: no clock in the engine." },
        { name: "process", message: "Spec A.2: the engine has no I/O." },
        { name: "crypto", message: "Spec A.5: pass a seeded PRNG explicitly." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Spec A.5: pass a seeded PRNG explicitly.",
        },
        { object: "Date", property: "now", message: "Spec A.5: time arrives as a parameter." },
        {
          object: "Math",
          property: "pow",
          message: "Spec E.4: libm-dependent. Integer exponentiation by squaring.",
        },
        { object: "Math", property: "exp", message: "Spec E.4: libm-dependent." },
        { object: "Math", property: "log", message: "Spec E.4: libm-dependent." },
      ],
    },
  },
  prettier,
);

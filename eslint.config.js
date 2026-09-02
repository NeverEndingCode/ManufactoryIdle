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
    ignores: ["packages/engine/**/*.test.ts"],
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
  prettier,
);

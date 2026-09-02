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
              // The glob must be "**", not "*": minimatch's "*" never matches a
              // "/", so it would silently leave every scoped package and every
              // "node:x/y" specifier unrestricted.
              //
              // This "group" array is matched with gitignore semantics (via the
              // `ignore` package), not raw minimatch: "**" excludes everything,
              // including the "." and "@manufactory" path segments themselves.
              // Gitignore's "cannot re-include a file whose parent directory is
              // excluded" rule then means a negation of only the leaf ("!./**",
              // "!@manufactory/rational") is not enough — the parent segment
              // ("!.", "!..", "!@manufactory") must be unignored too, or the
              // leaf negation is silently ineffective.
              group: [
                "**",
                "!@manufactory",
                "!@manufactory/rational",
                "!break_infinity.js",
                "!.",
                "!./**",
                "!..",
                "!../**",
              ],
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

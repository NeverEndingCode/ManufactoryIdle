// S-17: vite.config.ts defines this from scripts/build-info.ts. Vitest has no `define`, so
// readers guard with `typeof __BUILD_INFO__ === "undefined"`.
declare const __BUILD_INFO__: { commit: string | null; dirty: boolean; repo: string };

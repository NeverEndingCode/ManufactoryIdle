// S-17 / W-25: the commit a build is made from, for the footer's source link. Node only:
// vite.config.ts imports it and `define`s the result as __BUILD_INFO__ (src/build-info.d.ts).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  commit: string | null;
  dirty: boolean;
  repo: string;
}

/** This repository's `origin`; SOURCE_REPO overrides it (a fork's deploy). */
export const DEFAULT_REPO = "https://github.com/NeverEndingCode/ManufactoryIdle";

const SHA = /^[0-9a-f]{40}$/;

/** `git <args>` in this checkout: its stdout, or null when git is missing or fails. */
function runGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * The first of SOURCE_COMMIT, GITHUB_SHA and `git rev-parse HEAD` that is 40 lowercase hex.
 * `dirty` only for a git-derived commit whose tracked files differ from it: an env commit is
 * what the deploy says it built.
 */
export function buildInfo(
  env: Record<string, string | undefined> = process.env,
  git: (args: string[]) => string | null = runGit,
): BuildInfo {
  const repo = env.SOURCE_REPO || DEFAULT_REPO;
  for (const name of ["SOURCE_COMMIT", "GITHUB_SHA"] as const) {
    const v = env[name];
    if (v !== undefined && SHA.test(v)) return { commit: v, dirty: false, repo };
  }
  const head = git(["rev-parse", "HEAD"])?.trim() ?? "";
  if (!SHA.test(head)) return { commit: null, dirty: false, repo };
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return { commit: head, dirty: status !== null && status.trim() !== "", repo };
}

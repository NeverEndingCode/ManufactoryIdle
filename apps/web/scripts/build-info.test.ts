// S-17: the built commit. SOURCE_COMMIT, then GITHUB_SHA, then git; only 40 lowercase hex.
import { describe, expect, it } from "vitest";
import { buildInfo, DEFAULT_REPO } from "./build-info.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** A fake git: rev-parse answers `head`, status answers `porcelain`. Records the calls. */
function fakeGit(head: string | null, porcelain: string | null = "") {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse") return head === null ? null : `${head}\n`;
    if (args[0] === "status") return porcelain;
    return null;
  };
  return { git, calls };
}

describe("buildInfo", () => {
  it("SOURCE_COMMIT wins over GITHUB_SHA, which wins over git", () => {
    const { git } = fakeGit(C, " M x.ts\n");
    expect(buildInfo({ SOURCE_COMMIT: A, GITHUB_SHA: B }, git).commit).toBe(A);
    expect(buildInfo({ GITHUB_SHA: B }, git).commit).toBe(B);
    expect(buildInfo({}, git).commit).toBe(C);
  });

  it("skips a value that isn't 40 lowercase hex", () => {
    const { git } = fakeGit(C);
    expect(buildInfo({ SOURCE_COMMIT: "abc1234", GITHUB_SHA: B }, git).commit).toBe(B);
    expect(buildInfo({ SOURCE_COMMIT: A.toUpperCase() }, git).commit).toBe(C);
    expect(buildInfo({ SOURCE_COMMIT: `${A}0`, GITHUB_SHA: "" }, git).commit).toBe(C);
    expect(buildInfo({}, fakeGit("not a sha").git).commit).toBeNull();
  });

  it("is dirty only for a git-derived commit with porcelain output", () => {
    expect(buildInfo({}, fakeGit(C, " M src/a.ts\n").git)).toMatchObject({
      commit: C,
      dirty: true,
    });
    expect(buildInfo({}, fakeGit(C, "").git)).toMatchObject({ commit: C, dirty: false });
    expect(buildInfo({}, fakeGit(C, "\n").git).dirty).toBe(false);
    // An env commit is what CI built: the working tree isn't asked about.
    const env = fakeGit(C, " M src/a.ts\n");
    expect(buildInfo({ SOURCE_COMMIT: A }, env.git)).toMatchObject({ commit: A, dirty: false });
    expect(env.calls.some((c) => c[0] === "status")).toBe(false);
    // The status asked for ignores untracked files.
    const tracked = fakeGit(C, "");
    buildInfo({}, tracked.git);
    expect(tracked.calls).toContainEqual(["status", "--porcelain", "--untracked-files=no"]);
  });

  it("git failing gives commit null, not dirty", () => {
    expect(buildInfo({}, fakeGit(null).git)).toEqual({
      commit: null,
      dirty: false,
      repo: DEFAULT_REPO,
    });
    // rev-parse works but status fails: the commit stands, not marked dirty.
    expect(buildInfo({}, fakeGit(C, null).git)).toMatchObject({ commit: C, dirty: false });
  });

  it("SOURCE_REPO overrides the default", () => {
    const { git } = fakeGit(null);
    expect(DEFAULT_REPO).toBe("https://github.com/NeverEndingCode/ManufactoryIdle");
    expect(buildInfo({}, git).repo).toBe(DEFAULT_REPO);
    expect(buildInfo({ SOURCE_REPO: "https://example.org/fork" }, git).repo).toBe(
      "https://example.org/fork",
    );
    expect(buildInfo({ SOURCE_REPO: "" }, git).repo).toBe(DEFAULT_REPO);
  });
});

// W-25 / S-17: the footer's source and license links, at the built commit when there is one.
import { describe, expect, it } from "vitest";
import { sourceLinks } from "./source-link.js";

const REPO = "https://github.com/NeverEndingCode/ManufactoryIdle";
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("sourceLinks", () => {
  it("links the tree and the license at the commit", () => {
    expect(sourceLinks({ commit: SHA, dirty: false, repo: REPO })).toEqual({
      source: { href: `${REPO}/tree/${SHA}`, text: "Source, 0123456" },
      license: { href: `${REPO}/blob/${SHA}/LICENSE` },
    });
  });

  it("says 'modified from' a dirty build's commit", () => {
    expect(sourceLinks({ commit: SHA, dirty: true, repo: REPO }).source).toEqual({
      href: `${REPO}/tree/${SHA}`,
      text: "Source, modified from 0123456",
    });
  });

  it("links the repo root and main's license with no commit", () => {
    const none = {
      source: { href: REPO, text: "Source" },
      license: { href: `${REPO}/blob/main/LICENSE` },
    };
    expect(sourceLinks(undefined)).toEqual(none);
    expect(sourceLinks({ commit: null, dirty: false, repo: REPO })).toEqual(none);
  });

  it("uses the build's repo", () => {
    const fork = "https://example.org/fork";
    expect(sourceLinks({ commit: SHA, dirty: false, repo: fork }).license.href).toBe(
      `${fork}/blob/${SHA}/LICENSE`,
    );
    expect(sourceLinks({ commit: null, dirty: false, repo: fork }).source.href).toBe(fork);
  });
});

// W-25 / S-17: the footer's links. Shipping JS is distribution (GPL-3.0), so the source is
// linked at the commit this build was made from, when it is known.
export type BuildInfo = typeof __BUILD_INFO__;

export interface SourceLinks {
  source: { href: string; text: string };
  license: { href: string };
}

export function sourceLinks(info: BuildInfo | undefined): SourceLinks {
  const repo = info?.repo ?? "https://github.com/NeverEndingCode/ManufactoryIdle";
  const commit = info?.commit ?? null;
  if (commit === null)
    return {
      source: { href: repo, text: "Source" },
      license: { href: `${repo}/blob/main/LICENSE` },
    };
  const short = commit.slice(0, 7);
  return {
    source: {
      href: `${repo}/tree/${commit}`,
      text: info?.dirty ? `Source, modified from ${short}` : `Source, ${short}`,
    },
    license: { href: `${repo}/blob/${commit}/LICENSE` },
  };
}

/** The build's info; undefined under vitest, which has no `define`. */
export function currentBuildInfo(): BuildInfo | undefined {
  return typeof __BUILD_INFO__ === "undefined" ? undefined : __BUILD_INFO__;
}

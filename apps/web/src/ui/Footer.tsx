// W-25: the GPL footer. The source at the built commit, and the license.
import { currentBuildInfo, sourceLinks } from "./source-link.js";

export function Footer() {
  const links = sourceLinks(currentBuildInfo());
  return (
    <footer className="app-footer">
      <span>Free software under the GPL-3.0</span>
      <span aria-hidden="true"> · </span>
      <a href={links.source.href} data-source-link>
        {links.source.text}
      </a>
      <span aria-hidden="true"> · </span>
      <a href={links.license.href} data-license-link>
        License
      </a>
    </footer>
  );
}

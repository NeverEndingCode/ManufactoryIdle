// What the web client's UI tests may import (the package's "./bundle" export): the bundle
// loader alone. "./testing" also loads db/migrate.ts, whose module-level file URL fails
// under jsdom's URL global.
export { bundleChecksum, loadBundleDir } from "@manufactory/content";

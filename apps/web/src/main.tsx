import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import { superTokensClient } from "./auth/supertokens.js";
import { ACCOUNT_LABEL_KEY, PARKED_GUEST_TOKEN_KEY } from "./sync/constants.js";
import { browserFetch } from "./sync/fetch.js";
import { browserTokenStorage } from "./sync/identity.js";
import type { ClientClock } from "./sync/snapshot.js";
import { GameStore } from "./sync/store.js";
import { App } from "./ui/App.js";
import { capabilities } from "./ui/capabilities.js";
import { feelOf } from "./ui/feel.js";
import { parseRoute, replaceRoute } from "./ui/route.js";
import { applyTheme, storedTheme } from "./ui/theme.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

/** P-8: the monotonic clock and the window's timers; never the device's wall clock. */
const browserClock: ClientClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

// Created and started once, outside React: StrictMode's mount, cleanup, mount must not
// stop and restart it. fetch is late-bound (S-2): the SDK's init() patches window.fetch after
// this, and game requests must go through the patched one.
// O-6 / O-8: a load on /account/callback/:provider finishes the sign-in at boot; done()
// replaces the spent URL once, after the attempt.
const first = parseRoute(location.pathname);
const store = new GameStore({
  fetch: browserFetch,
  clock: browserClock,
  tokens: browserTokenStorage(),
  parked: browserTokenStorage(undefined, PARKED_GUEST_TOKEN_KEY),
  accounts: superTokensClient(location.origin),
  random: crypto,
  accountLabel: browserTokenStorage(undefined, ACCOUNT_LABEL_KEY),
  navigate: (url) => window.location.assign(url),
  ...(first.kind === "callback"
    ? {
        callback: {
          provider: first.provider,
          search: location.search,
          done: () => replaceRoute({ kind: "game" }),
        },
      }
    : {}),
});
// L-3: the feel pair subscribes now, before start() can adopt the first snapshot.
feelOf(store);

/** W-9: a hidden tab has no boundary timer, no text tick, and every animation paused.
 * Q-11: hiding ends a hold and sends the pending taps at once, with keepalive. */
function syncVisibility(): void {
  const hidden = document.visibilityState === "hidden";
  document.documentElement.classList.toggle("hidden-tab", hidden);
  if (hidden) {
    store.releaseTap();
    store.flushTaps({ keepalive: true });
  }
  store.setVisible(!hidden);
}
document.addEventListener("visibilitychange", syncVisibility);
// bfcache and Safari can hide the page without a visibilitychange: end the hold here too.
window.addEventListener("pagehide", () => {
  store.releaseTap();
  store.flushTaps({ keepalive: true });
});
// O-11: Back from the provider restores this page from the bfcache with its buttons off.
window.addEventListener("pageshow", (e) => store.pageShown(e.persisted));
window.addEventListener("focus", () => store.onFocus());
window.addEventListener("online", () => store.onOnline());
if (document.visibilityState === "hidden") syncVisibility();

// U-1i / V-7: index.html's inline script already set the migrated theme before first paint;
// this applies the capability-aware one and the theme-color meta, before the first render.
applyTheme(storedTheme(), capabilities(store.getView()));

void store.start();

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

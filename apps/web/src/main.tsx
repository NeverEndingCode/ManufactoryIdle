import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import { superTokensClient } from "./auth/supertokens.js";
import { PARKED_GUEST_TOKEN_KEY } from "./sync/constants.js";
import { browserFetch } from "./sync/fetch.js";
import { browserTokenStorage } from "./sync/identity.js";
import type { ClientClock } from "./sync/snapshot.js";
import { GameStore } from "./sync/store.js";
import { App } from "./ui/App.js";
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
const store = new GameStore({
  fetch: browserFetch,
  clock: browserClock,
  tokens: browserTokenStorage(),
  parked: browserTokenStorage(undefined, PARKED_GUEST_TOKEN_KEY),
  accounts: superTokensClient(location.origin),
  random: crypto,
});

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
window.addEventListener("focus", () => store.onFocus());
window.addEventListener("online", () => store.onOnline());
if (document.visibilityState === "hidden") syncVisibility();

void store.start();

// S-11: the stored theme before the first paint, so a light player never sees a dark flash.
applyTheme(storedTheme());

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

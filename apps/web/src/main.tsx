import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import { browserTokenStorage } from "./sync/identity.js";
import type { ClientClock } from "./sync/snapshot.js";
import { GameStore } from "./sync/store.js";
import { App } from "./ui/App.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

/** P-8: the monotonic clock and the window's timers; never the device's wall clock. */
const browserClock: ClientClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

// Created and started once, outside React: StrictMode's mount, cleanup, mount must not
// stop and restart it.
const store = new GameStore({
  fetch: window.fetch.bind(window),
  clock: browserClock,
  tokens: browserTokenStorage(),
  random: crypto,
});

/** W-9: a hidden tab has no boundary timer, no text tick, and every animation paused. */
function syncVisibility(): void {
  const hidden = document.visibilityState === "hidden";
  document.documentElement.classList.toggle("hidden-tab", hidden);
  store.setVisible(!hidden);
}
document.addEventListener("visibilitychange", syncVisibility);
window.addEventListener("focus", () => store.onFocus());
window.addEventListener("online", () => store.onOnline());
if (document.visibilityState === "hidden") syncVisibility();

void store.start();

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

// U-7a / K-2 / K-4: the dispatcher. One keydown/keyup pair on document, in the bubble phase, so
// every component's own key handling (the tablists, the priority list, the radios, the TAP
// button, the dialogs' Esc) runs first and can claim a key with preventDefault or
// stopPropagation. resolveKey decides; the actions are App's, read through a ref at event time.
// preventDefault is called only when a command resolved and its action found its target (K-9).
import { useEffect, useRef } from "react";
import type { GameStore } from "../sync/store.js";
import { resolveKey, type KeyContext, type RowMove, type SectionKey } from "./keys.js";
import { tapKeyHold } from "./use-tap-hold.js";

/** Each action returns whether it found its target; false leaves the event alone. */
export interface KeyActions {
  /** Read at event time from App's state and document.activeElement. */
  context(): KeyContext;
  run(): boolean;
  runOne(): boolean;
  why(): boolean;
  lane(n: number, closeDrawer: boolean): boolean;
  view(v: "factory" | "priority" | "handbook", closeDrawer: boolean, closeCard: boolean): boolean;
  move(to: RowMove, follow: boolean): boolean;
  open(): boolean;
  close(): boolean;
  section(k: SectionKey): boolean;
  /** Task 3; absent, the command is a no-op and nothing is prevented. */
  help?(): boolean;
}

export function useKeyboard(
  enabled: boolean,
  actions: KeyActions,
  store: Pick<GameStore, "pressTap" | "releaseTap">,
): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    if (!enabled) return;
    const tap = tapKeyHold(store);
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      const r = resolveKey(
        {
          type: e.type === "keyup" ? "keyup" : "keydown",
          key: e.key,
          repeat: e.repeat,
          isComposing: e.isComposing,
          keyCode: e.keyCode,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          defaultPrevented: e.defaultPrevented,
        },
        a.context(),
      );
      if (r === null) return;
      const c = r.command;
      let found: boolean;
      switch (c.kind) {
        case "tap":
          if (c.down) tap.down();
          else tap.up();
          found = true;
          break;
        case "run":
          found = a.run();
          break;
        case "runOne":
          found = a.runOne();
          break;
        case "why":
          found = a.why();
          break;
        case "lane":
          found = a.lane(c.n, c.closeDrawer);
          break;
        case "view":
          found = a.view(c.view, c.closeDrawer, c.closeCard);
          break;
        case "move":
          found = a.move(c.to, c.follow);
          break;
        case "open":
          found = a.open();
          break;
        case "close":
          found = a.close();
          break;
        case "section":
          found = a.section(c.key);
          break;
        case "help":
          found = a.help?.() ?? false;
          break;
      }
      if (found && r.preventDefault) e.preventDefault();
    };
    // K-2: the hold can never stick. A blurred window or a hidden tab never sends the keyup.
    const release = () => tap.up();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") tap.up();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
      tap.up();
    };
  }, [enabled, store]);
}

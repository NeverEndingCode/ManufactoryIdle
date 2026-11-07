// V-12 / K-5: one inert pass for every modal (Settings, the help, the phone NEXT_BUY sheet),
// and the Tab wrap they share. React 18 has no prop for inert, so it's set on the DOM.

/** K-5: every modal's host, topmost first. Only one is ever open (each opener sits behind the
 * others' inert), so the order only settles a test's fixture tree. */
export const MODAL_HOSTS: readonly string[] = [
  "[data-settings-host]",
  "[data-help-host]",
  "[data-next-buy-host]",
];

/** The open modal's host under `app`: the first of MODAL_HOSTS present, or null. */
export function openModal(app: HTMLElement): Element | null {
  for (const sel of MODAL_HOSTS) {
    const host = app.querySelector(sel);
    if (host !== null) return host;
  }
  return null;
}

/** What goes inert inside the notices while a modal is open; the region itself never does. */
export const NOTICE_CONTROLS = "button, a, input, select, textarea, [tabindex]";

/**
 * Walks down from `root`: every element that holds none of `keep` and not `region` goes inert;
 * one that holds them is descended into. The region stays live (W-20: the one region keeps
 * speaking, and the modal's announcements land there), so only its controls go inert. An
 * element already inert is left alone. Returns the undo.
 */
export function inertOutside(
  root: HTMLElement,
  keep: readonly Element[],
  region: Element | null,
): () => void {
  const set: Element[] = [];
  const mark = (el: Element) => {
    if (el.hasAttribute("inert")) return;
    el.setAttribute("inert", "");
    set.push(el);
  };
  const holds = (el: Element) =>
    keep.some((k) => el.contains(k)) || (region !== null && el.contains(region));
  const visit = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (keep.includes(el)) continue;
      if (el === region) {
        for (const c of Array.from(el.querySelectorAll(NOTICE_CONTROLS))) mark(c);
        continue;
      }
      if (holds(el)) visit(el);
      else mark(el);
    }
  };
  visit(root);
  return () => {
    for (const el of set) el.removeAttribute("inert");
  };
}

const TABBABLE = "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])";

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.closest("[inert]") !== null) return false;
    // A radio group is one stop: only its checked radio is in the Tab order.
    if (el instanceof HTMLInputElement && el.type === "radio" && !el.checked) return false;
    return true;
  });
}

/** The Tab wrap: past the last control to the first, before the first to the last. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== "Tab") return;
  const all = tabbables(root);
  if (all.length === 0) return;
  const at = all.indexOf(document.activeElement as HTMLElement);
  if (e.shiftKey && at <= 0) {
    e.preventDefault();
    all[all.length - 1]!.focus();
  } else if (!e.shiftKey && (at === -1 || at === all.length - 1)) {
    e.preventDefault();
    all[0]!.focus();
  }
}

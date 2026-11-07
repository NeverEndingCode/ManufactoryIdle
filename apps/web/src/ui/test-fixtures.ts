// Test-only: snapshots built straight from the slice bundle and engine fixture worlds, with no
// server. Excluded from tsconfig.json and from the browser lint block, like sync/test-rig.ts.
import { readFileSync } from "node:fs";
import { act } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleChecksum, loadBundleDir } from "@manufactory/api/bundle";
import {
  deserializeWorld,
  indexContent,
  initialWorld,
  liquidCap,
  schedule,
  serializeWorld,
  withInstalled,
  type Action,
  type ContentBundle,
  type IndexedContent,
  type WorldState,
} from "@manufactory/engine";
import type { Outcome } from "../sync/errors.js";
import { makeSnapshot, type Snapshot } from "../sync/snapshot.js";
import type { Batch } from "../sync/outbox.js";
import type { AdoptEvent, BeginResult, Notice, StoreView } from "../sync/store.js";

// Paths from strings, not URL objects: under jsdom the global URL is jsdom's, which
// fileURLToPath refuses. That is also why this file doesn't import sync/test-rig.ts.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SLICE_DIR = join(ROOT, "packages/content/bundles/vertical-slice");
const FIXTURES = join(ROOT, "packages/engine/src/resolve/fixtures");

/** As sync/test-rig.ts: the server clock's start, and a performance.now()-like client start. */
export const SERVER_T0 = 1_760_000_000_000;
export const CLIENT_T0 = 1_000_000;

export interface Slice {
  content: IndexedContent;
  checksum: string;
}

/** The vertical slice, indexed, straight from the bundle directory. */
export function loadSlice(): Slice {
  const bundle = loadBundleDir(SLICE_DIR);
  return { content: indexContent(bundle as ContentBundle), checksum: bundleChecksum(bundle) };
}

/**
 * The slice with a Biomass Burner Mk.2 (rate 2, unlocked from tier 0), in memory only: the slice
 * has no generator with a second mark, so a generator's UPGRADE_MARK needs one (K-12, U-5c).
 */
export function burnerMk2Slice(): Slice {
  const bundle = loadBundleDir(SLICE_DIR);
  const burner = bundle.machineClasses.find((c) => c.id === "biomass_burner")!;
  const mk1 = burner.marks[0]!;
  burner.marks.push({
    ...mk1,
    mark: 2,
    name: "Biomass Burner Mk.2",
    rateMultiplier: 2,
    buildCostMultiplier: 2,
  });
  return { content: indexContent(bundle as ContentBundle), checksum: bundleChecksum(bundle) };
}

/** The real worldView shape: the serialized state and the engine's schedule of it. */
export function snapshotOf(
  slice: Slice,
  state: WorldState,
  opts: { stateVersion?: number; persistedAtMs?: number; receivedAt?: number } = {},
): Snapshot {
  return makeSnapshot(
    {
      state: JSON.parse(serializeWorld(state)) as unknown,
      schedule: schedule(state, slice.content),
      stateVersion: opts.stateVersion ?? 0,
      contentChecksum: slice.checksum,
      ...(opts.persistedAtMs === undefined ? {} : { persistedAtMs: opts.persistedAtMs }),
    },
    slice.content,
    opts.receivedAt ?? CLIENT_T0,
  );
}

/** A fresh guest's world, as POST /api/guests makes it, at SERVER_T0. */
export function freshState(slice: Slice): WorldState {
  return initialWorld(slice.content, 1, SERVER_T0);
}

/** An engine fixture world (packages/engine/src/resolve/fixtures). */
export function fixtureState(file: string): WorldState {
  return deserializeWorld(readFileSync(join(FIXTURES, file), "utf8"));
}

/**
 * STARVED_PIPE (4b Task 2 test 8): tier 5, six coal Constructors all on `make_concrete`.
 * Concrete and steel beam sit at their liquid cap in `stored`, so `make_concrete` idles
 * (clock 0) and `make_steel_beam` is not starved; `make_steel_pipe` has none: starved.
 */
export function starvedPipeState(slice: Slice): WorldState {
  let w: WorldState = { ...freshState(slice), tier: 5 };
  w = withInstalled(w, "coal", "constructor", 1, 6);
  w = {
    ...w,
    assignment: { ...w.assignment, make_concrete: 6, make_steel_beam: 0, make_steel_pipe: 0 },
  };
  return {
    ...w,
    stored: {
      ...w.stored,
      concrete: liquidCap(slice.content, w, "concrete"),
      steel_beam: liquidCap(slice.content, w, "steel_beam"),
    },
  };
}

/** What App reads from a GameStore, driven by hand: set() a view, adopt() a snapshot, tick() the
 * clock (the 4 Hz text and any due later() timers). `send` never settles unless a test gives it
 * an implementation. */
export interface FakeStore {
  subscribe(fn: () => void): () => void;
  getView(): StoreView;
  subscribeTick(fn: () => void): () => void;
  now(): number;
  send: Mock<(actions: Action[], label: string) => Promise<Outcome>>;
  newFactory: Mock<() => Promise<void>>;
  dismiss: Mock<(kind: Notice["kind"]) => void>;
  /** Task 5's tap. */
  pressTap: Mock<() => void>;
  releaseTap: Mock<() => void>;
  flushTaps: Mock<(opts?: { keepalive?: boolean }) => void>;
  /** The accounts (O-5, S-7); each resolves with a success unless a test says otherwise. */
  beginSignIn: Mock<(provider: string) => Promise<BeginResult>>;
  signOut: Mock<() => Promise<boolean>>;
  /** U-9f, L-2: as GameStore. */
  onAdopt(fn: (e: AdoptEvent) => void): () => void;
  later(fn: () => void, ms: number): () => void;
  set(patch: Partial<StoreView>): void;
  /** One adoption, in one act(): the adopt listeners run (the view still reads prev, as in
   * the real store), then the view's snapshot becomes `next` and the view listeners run.
   * `prev` defaults to the view's snapshot before. */
  adopt(e: { prev?: Snapshot | null; next: Snapshot; settled?: Batch | null }): void;
  /** Moves the clock on, firing the due later() timers in time order, then the tickers. */
  tick(ms: number): void;
  readonly tickers: number;
}

export function fakeStore(snapshot: Snapshot | null, opts: { now?: number } = {}): FakeStore {
  let view: StoreView = {
    status: snapshot ? "ready" : "loading",
    snapshot,
    pending: [],
    notices: [],
    failures: 0,
    taps: { pending: 0, lastTapAt: null, holding: false },
    polling: snapshot !== null,
    accounts: "off",
    identity: "guest",
    account: null,
    auth: "idle",
    parked: false,
    providers: [],
    leaving: null,
  };
  let clock = opts.now ?? CLIENT_T0;
  const listeners = new Set<() => void>();
  const tickers = new Set<() => void>();
  const adoptListeners = new Set<(e: AdoptEvent) => void>();
  let timers: { at: number; seq: number; fn: () => void }[] = [];
  let seq = 0;
  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getView: () => view,
    subscribeTick: (fn) => {
      tickers.add(fn);
      return () => tickers.delete(fn);
    },
    now: () => clock,
    send: vi.fn(() => new Promise<Outcome>(() => {})),
    newFactory: vi.fn(() => Promise.resolve()),
    dismiss: vi.fn(),
    pressTap: vi.fn(),
    releaseTap: vi.fn(),
    flushTaps: vi.fn(),
    beginSignIn: vi.fn(() => Promise.resolve<BeginResult>({ ok: true })),
    signOut: vi.fn(() => Promise.resolve(true)),
    onAdopt: (fn) => {
      adoptListeners.add(fn);
      return () => {
        adoptListeners.delete(fn);
      };
    },
    later: (fn, ms) => {
      const timer = { at: clock + Math.max(0, ms), seq: seq++, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    set(patch) {
      view = { ...view, ...patch };
      act(() => listeners.forEach((fn) => fn()));
    },
    adopt({ prev, next, settled }) {
      const event: AdoptEvent = {
        prev: prev === undefined ? view.snapshot : prev,
        next,
        settled: settled ?? null,
      };
      act(() => {
        // As the real store: the listeners see the view still at prev, then it emits.
        adoptListeners.forEach((fn) => fn(event));
        view = { ...view, snapshot: next };
        listeners.forEach((fn) => fn());
      });
    },
    tick(ms) {
      const until = clock + ms;
      act(() => {
        // A timer a firing timer sets, due by `until`, fires too.
        for (;;) {
          const due = timers
            .filter((t) => t.at <= until)
            .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
          if (due === undefined) break;
          timers = timers.filter((t) => t !== due);
          clock = due.at;
          due.fn();
        }
        clock = until;
        tickers.forEach((fn) => fn());
      });
    },
    get tickers() {
      return tickers.size;
    },
  };
}

/** matchMedia for a viewport this wide (and `height` tall, 900 by default): min-/max-width and
 * min-/max-height queries, plus `prefers-reduced-motion: reduce` when `reducedMotion`. resize()
 * changes the width (and the height, if given) and fires `change` on each list whose answer
 * flipped. Undo with vi.unstubAllGlobals(). */
export function stubWidth(
  initial: number,
  opts: { reducedMotion?: boolean; height?: number } = {},
) {
  let width = initial;
  let height = opts.height ?? 900;
  const lists: { q: string; matches: boolean; fns: Set<() => void> }[] = [];
  const evaluate = (q: string) => {
    if (q.includes("prefers-reduced-motion"))
      return /:\s*reduce\)/.test(q) === !!opts.reducedMotion;
    const min = /min-width:\s*(\d+)px/.exec(q);
    const max = /max-width:\s*(\d+)px/.exec(q);
    const minH = /min-height:\s*(\d+)px/.exec(q);
    const maxH = /max-height:\s*(\d+)px/.exec(q);
    return (
      (min === null || width >= Number(min[1])) &&
      (max === null || width <= Number(max[1])) &&
      (minH === null || height >= Number(minH[1])) &&
      (maxH === null || height <= Number(maxH[1]))
    );
  };
  vi.stubGlobal("matchMedia", (q: string) => {
    const entry = { q, matches: evaluate(q), fns: new Set<() => void>() };
    lists.push(entry);
    return {
      get matches() {
        return evaluate(q);
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => entry.fns.add(fn),
      removeEventListener: (_: string, fn: () => void) => entry.fns.delete(fn),
    } as unknown as MediaQueryList;
  });
  return {
    resize(w: number, h?: number) {
      width = w;
      if (h !== undefined) height = h;
      act(() => {
        for (const l of lists) {
          const now = evaluate(l.q);
          if (now === l.matches) continue;
          l.matches = now;
          for (const fn of [...l.fns]) fn();
        }
      });
    },
    get listeners() {
      return lists.reduce((n, l) => n + l.fns.size, 0);
    },
  };
}

/** U-1h: what looks like an id (IRON_ORE, CONSTRUCTOR_MK1, NEXT_BUY). */
export const ID_LIKE = /[A-Z]+_[A-Z]/;

/** Where a label replaces the contents: a reader says the label, never the text inside. */
const LABELLED = [
  "button[aria-label]",
  '[role="button"][aria-label]',
  '[role="option"][aria-label]',
  '[role="tab"][aria-label]',
  "h1[aria-label]",
  "h2[aria-label]",
  "h3[aria-label]",
].join(", ");

/**
 * U-1h: everything under `root` a screen reader could say that looks like an id: each
 * aria-label and title, and each text node, outside aria-hidden and outside a labelled control.
 */
export function spokenIds(root: Element): string[] {
  const hits: string[] = [];
  const hidden = (el: Element) => el.closest('[aria-hidden="true"]') !== null;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (hidden(el)) continue;
    for (const attr of ["aria-label", "title"]) {
      const v = el.getAttribute(attr);
      if (v !== null && ID_LIKE.test(v)) hits.push(`${attr}: ${v}`);
    }
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const el = n.parentElement;
    if (el === null || hidden(el) || el.closest(LABELLED) !== null) continue;
    if (ID_LIKE.test(n.textContent ?? "")) hits.push(`text: ${n.textContent}`);
  }
  return hits;
}

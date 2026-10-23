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
import type { AuthResult, ResetResult } from "../auth/accounts.js";
import type { Outcome } from "../sync/errors.js";
import { makeSnapshot, type Snapshot } from "../sync/snapshot.js";
import type { Notice, StoreView } from "../sync/store.js";

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

/** What App reads from a GameStore, driven by hand: set() a view, tick() the 4 Hz text. `send`
 * never settles unless a test gives it an implementation. */
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
  /** Task 3's accounts; each resolves with a success unless a test says otherwise. */
  signUp: Mock<(email: string, password: string) => Promise<AuthResult>>;
  signIn: Mock<(email: string, password: string) => Promise<AuthResult>>;
  signOut: Mock<() => Promise<boolean>>;
  sendReset: Mock<(email: string) => Promise<ResetResult>>;
  submitNewPassword: Mock<(password: string) => Promise<ResetResult>>;
  set(patch: Partial<StoreView>): void;
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
  };
  let clock = opts.now ?? CLIENT_T0;
  const listeners = new Set<() => void>();
  const tickers = new Set<() => void>();
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
    signUp: vi.fn((email: string) => Promise.resolve<AuthResult>({ ok: true, email })),
    signIn: vi.fn((email: string) => Promise.resolve<AuthResult>({ ok: true, email })),
    signOut: vi.fn(() => Promise.resolve(true)),
    sendReset: vi.fn(() => Promise.resolve<ResetResult>({ ok: true })),
    submitNewPassword: vi.fn(() => Promise.resolve<ResetResult>({ ok: true })),
    set(patch) {
      view = { ...view, ...patch };
      act(() => listeners.forEach((fn) => fn()));
    },
    tick(ms) {
      clock += ms;
      act(() => tickers.forEach((fn) => fn()));
    },
    get tickers() {
      return tickers.size;
    },
  };
}

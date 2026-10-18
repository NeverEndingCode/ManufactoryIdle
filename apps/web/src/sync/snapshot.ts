// A snapshot: one adopted server response, with the client's clock reading at arrival
// (W-6) and the one display solve it gets (W-8).
import {
  deserializeWorld,
  scheduleDetail,
  type IndexedContent,
  type Schedule,
  type Solution,
  type WorldState,
} from "@manufactory/engine";
import type { WorldResponse } from "./wire.js";

/** The client's monotonic clock and timers (P-8): performance.now() and window timers in the
 * browser, a FakeClientClock in tests. Never the device's wall clock. */
export interface ClientClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface Snapshot {
  /** The response's state, as truth. */
  state: WorldState;
  /** The SERVER's schedule: rates and the boundary come only from here. */
  schedule: Schedule;
  stateVersion: number;
  contentChecksum: string;
  content: IndexedContent;
  persistedAtMs: number | null;
  /** ClientClock.now() when the response landed. */
  receivedAt: number;
  /** scheduleDetail(state, content), once per snapshot: only its solution is shown (W-8). */
  display: { state: WorldState; solution: Solution };
}

export function makeSnapshot(
  resp: WorldResponse,
  content: IndexedContent,
  receivedAt: number,
): Snapshot {
  const state = deserializeWorld(JSON.stringify(resp.state));
  const detail = scheduleDetail(state, content);
  return {
    state,
    schedule: resp.schedule,
    stateVersion: resp.stateVersion,
    contentChecksum: resp.contentChecksum,
    content,
    persistedAtMs: resp.persistedAtMs ?? null,
    receivedAt,
    display: { state: detail.state, solution: detail.solution },
  };
}

/** True if `next` may replace `current`: no current, or (stateVersion, schedule.atMs) not
 * lexicographically older. A POST's atMs can trail a GET's by the round trip, so a higher
 * version wins whatever its atMs. */
export function isAdoptable(
  current: Snapshot | null,
  next: Pick<Snapshot, "stateVersion" | "schedule">,
): boolean {
  if (current === null) return true;
  if (next.stateVersion !== current.stateVersion) return next.stateVersion > current.stateVersion;
  return next.schedule.atMs >= current.schedule.atMs;
}

/** The server's clock now, from the snapshot and the client's clock (W-6). */
export function serverNow(s: Snapshot, clientNow: number): number {
  return s.schedule.atMs + (clientNow - s.receivedAt);
}

/** The client-clock time at which the server's clock reads `serverMs`. */
export function localTimeOf(s: Snapshot, serverMs: number): number {
  return s.receivedAt + (serverMs - s.schedule.atMs);
}

/** P-4: production stops offlineCapMs after the last persisted resolve; Infinity if unknown. */
export function plateauAtMs(s: Snapshot): number {
  return s.persistedAtMs === null ? Infinity : s.persistedAtMs + s.content.offlineCapMs;
}

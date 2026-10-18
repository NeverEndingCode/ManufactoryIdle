// The API's JSON shapes, as the client reads them (spec D.2, W-5, W-22).
import type { Action, Schedule } from "@manufactory/engine";

export interface WorldResponse {
  state: unknown;
  schedule: Schedule;
  stateVersion: number;
  contentChecksum: string;
  /** P-4: the stored state's lastResolvedAt. Absent on idempotent replays stored before 4a. */
  persistedAtMs?: number;
  summary?: unknown;
}

export interface HealthResponse {
  ok: true;
  contentChecksum: string;
  accounts: boolean;
}

export interface GuestResponse {
  guestToken: string;
  world: WorldResponse;
}

export interface RejectionBody {
  failedAction: Action;
  index: number;
  reason: string;
}

export interface ActionsRequest {
  idempotencyKey: string;
  baseVersion: number;
  actions: Action[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

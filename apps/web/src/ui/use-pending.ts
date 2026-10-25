// Q-10: optimistic settings live in the component, not the store. A control shows the value the
// player asked for from the moment the intent is sent until THAT request's send() promise
// settles; then it falls back to the server's value (the new one after adoption, the old one
// after a 409). A snapshot that lands meanwhile doesn't move it. Per key, the newest run wins:
// an older request settling never releases a newer one's value.
//
// The held values live in a registry, not in React state, so a control that unmounts and
// remounts within one round trip (an action-tab or view switch, a drawer closed and reopened)
// still shows its pending value. Pass an owner (the store) to share one registry across mounts;
// without one, the registry is the component's own.
import { useState, useSyncExternalStore } from "react";
import type { Outcome } from "../sync/errors.js";

interface Held {
  value: unknown;
  token: number;
}

export class PendingRegistry {
  private held: ReadonlyMap<string, Held> = new Map();
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Replaced on every change, so it is a useSyncExternalStore snapshot. */
  readonly current = (): ReadonlyMap<string, Held> => this.held;

  /** Hold every entry's value under one token until `send`'s promise settles. */
  run(entries: readonly (readonly [string, unknown])[], send: () => Promise<Outcome>): void {
    const token = ++this.seq;
    const next = new Map(this.held);
    for (const [k, value] of entries) next.set(k, { value, token });
    this.commit(next);
    const release = () => {
      const after = new Map(this.held);
      let changed = false;
      for (const [k] of entries) {
        if (after.get(k)?.token === token) {
          after.delete(k);
          changed = true;
        }
      }
      if (changed) this.commit(after);
    };
    let sent: Promise<Outcome>;
    try {
      sent = send();
    } catch (err) {
      console.error(err);
      release();
      return;
    }
    sent.then(release, (err: unknown) => {
      console.error(err);
      release();
    });
  }

  private commit(next: ReadonlyMap<string, Held>): void {
    this.held = next;
    for (const fn of [...this.listeners]) fn();
  }
}

const shared = new WeakMap<object, PendingRegistry>();

/** The registry for this owner (the store), made on first use. */
export function pendingRegistry(owner: object): PendingRegistry {
  let r = shared.get(owner);
  if (r === undefined) {
    r = new PendingRegistry();
    shared.set(owner, r);
  }
  return r;
}

export interface PendingMap<V> {
  /** The key's held value while its newest request is unsettled, else `server`. */
  shown(key: string, server: V): V;
  /** One intent: every entry shows at once, until `send`'s promise settles. */
  run(entries: readonly (readonly [string, V])[], send: () => Promise<Outcome>): void;
  /** The key has an unsettled request. */
  held(key: string): boolean;
}

/** Many keys at once (a list of rows). Keys are global to the owner: prefix them. */
export function usePendingMap<V>(owner?: object): PendingMap<V> {
  const [own] = useState(() => new PendingRegistry());
  const reg = owner === undefined ? own : pendingRegistry(owner);
  const held = useSyncExternalStore(reg.subscribe, reg.current, reg.current);
  return {
    shown: (key, server) => {
      const h = held.get(key);
      return h === undefined ? server : (h.value as V);
    },
    run: (entries, send) => reg.run(entries, send),
    held: (key) => held.has(key),
  };
}

/** One setting. `at` shares the hold across mounts (see the file comment). */
export function usePendingSetting<T>(
  server: T,
  at?: { owner: object; key: string },
): { shown: T; run(next: T, send: () => Promise<Outcome>): void } {
  const map = usePendingMap<T>(at?.owner);
  const key = at?.key ?? "setting";
  return {
    shown: map.shown(key, server),
    run: (next, send) => map.run([[key, next]], send),
  };
}

// W-20: one polite live region for the whole page, the notices'. Components that need to say
// something discrete (the priority list's moves) announce through this, and Notices renders
// the latest text inside its region. One announcer per App instance, given by context, so
// nothing leaks between mounts or tests.
import { createContext, useContext, useSyncExternalStore } from "react";

export interface Announcement {
  text: string;
  /** Bumped on every announce, so the same words twice are read twice. */
  seq: number;
}

export interface Announcer {
  announce(text: string): void;
  subscribe(fn: () => void): () => void;
  current(): Announcement;
}

export function createAnnouncer(): Announcer {
  let latest: Announcement = { text: "", seq: 0 };
  const listeners = new Set<() => void>();
  return {
    announce(text) {
      latest = { text, seq: latest.seq + 1 };
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    current: () => latest,
  };
}

export const AnnounceContext = createContext<Announcer | null>(null);

const NONE: Announcement = { text: "", seq: 0 };
const noSubscribe = () => () => {};

/** The announce function; a no-op outside a provider. */
export function useAnnounce(): (text: string) => void {
  const a = useContext(AnnounceContext);
  return a === null ? () => {} : a.announce;
}

/** The latest announcement, for the one live region. */
export function useAnnouncement(): Announcement {
  const a = useContext(AnnounceContext);
  return useSyncExternalStore(
    a === null ? noSubscribe : a.subscribe,
    a === null ? () => NONE : a.current,
    a === null ? () => NONE : a.current,
  );
}

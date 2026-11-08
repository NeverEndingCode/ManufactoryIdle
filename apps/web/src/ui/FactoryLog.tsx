// U-9a, L-9..L-12: the factory log on screen.
// - FactoryLog: desktop and tablet with a viewport 700 px tall or more (L-10). A 96 px `tail -f`
//   box between the content row and the command line: fixed, so a line never moves a row.
// - LogTicker: the phone and short viewports. The newest line, as a button that opens…
// - LogSheet: …the modal log sheet, the phone's third (L-11).
// None of them is a live region (U-8a, L-9): a reader hears the lines by reading them, in the
// plain voice (L-5). Each subscribes to the book itself, so a line re-renders the log and
// nothing else, and the 4 Hz tick never re-renders it (L-12).
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { trapTab } from "./dialog.js";
import { logTime, type LogEntry } from "./factory-log.js";
import { useFeel } from "./feel.js";
import css from "./FactoryLog.module.css";
import { Spoken } from "./Spoken.js";
import { useTheme } from "./theme.js";

/** The book's lines, oldest first; a new array only when a line is added or the log resets. */
function useLogEntries(): readonly LogEntry[] {
  const { log } = useFeel();
  return useSyncExternalStore(log.subscribe, log.entries, log.entries);
}

/** One line: `14:02:11  text`. The terminal shows the ids and says the names (U-1h). */
const Line = memo(function Line({
  entry,
  shell,
  cursor,
}: {
  entry: LogEntry;
  shell: boolean;
  cursor: boolean;
}) {
  return (
    <li className={css[entry.tone]} data-tone={entry.tone}>
      {`${logTime(entry.atLocalMs)}  `}
      {shell ? <Spoken shown={entry.text} said={entry.said} /> : entry.said}
      {cursor && <span className={css.cursor} aria-hidden="true" />}
    </li>
  );
});

/**
 * `tail -f`: after the lines change, the scroll box follows them down if it was at the bottom
 * (within 2 px) before; a player who scrolled up to read stays put. `overflowing` is measured
 * then and on a resize, so the box is a Tab stop only when it scrolls (L-9, WCAG 2.1.1).
 */
function useTail(ref: RefObject<HTMLElement | null>, entries: readonly LogEntry[]) {
  const stuck = useRef(true);
  const [overflowing, setOverflowing] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el !== null) setOverflowing(el.scrollHeight > el.clientHeight);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    measure();
  }, [ref, entries, measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  const onScroll = () => {
    const el = ref.current;
    if (el !== null) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  };
  return { overflowing, onScroll };
}

/** U-9a's box. No props: it re-renders only when the book's lines or the theme change. */
export const FactoryLog = memo(function FactoryLog() {
  const entries = useLogEntries();
  const shell = useTheme().applied.voice === "shell";
  const ref = useRef<HTMLElement>(null);
  const { overflowing, onScroll } = useTail(ref, entries);
  return (
    <section
      ref={ref}
      className={css.box}
      aria-label="Factory log"
      aria-live="off"
      data-factory-log
      tabIndex={overflowing ? 0 : undefined}
      onScroll={onScroll}
    >
      <p className={css.head} aria-hidden="true">
        {shell ? "$ tail -f factory.log" : "Factory log"}
      </p>
      <ol className={css.lines}>
        {entries.map((e, i) => (
          <Line key={e.seq} entry={e} shell={shell} cursor={i === entries.length - 1} />
        ))}
      </ol>
    </section>
  );
});

/** L-10: the newest line, ellipsized, as the button that opens the sheet; none with no lines.
 * M-1, accepted: its first line of a world shrinks the row list's visible height once (row tops
 * stay put). */
export const LogTicker = memo(function LogTicker({ onOpen }: { onOpen(): void }) {
  const entries = useLogEntries();
  const shell = useTheme().applied.voice === "shell";
  const last = entries.at(-1);
  if (last === undefined) return null;
  const n = entries.length;
  return (
    <button
      type="button"
      className={css.ticker}
      data-log-ticker
      aria-haspopup="dialog"
      aria-label={`Factory log, ${n} ${n === 1 ? "entry" : "entries"}`}
      onClick={() => onOpen()}
    >
      <span className={`${css.tickerText} ${css[last.tone]}`} aria-hidden="true">
        {shell ? last.text : last.said}
      </span>
      <span className={css.tickerMark} aria-hidden="true">
        {shell ? "[log]" : "Log"}
      </span>
    </button>
  );
});

/** L-11: the modal log sheet (U-4c style): the full list, newest at the bottom, scrolled there
 * on open. Closed by x, the backdrop or Esc; App returns focus to the ticker. */
export function LogSheet({ onClose }: { onClose(): void }) {
  const entries = useLogEntries();
  const shell = useTheme().applied.voice === "shell";
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const { overflowing, onScroll } = useTail(list, entries);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-close]")?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (ref.current !== null) trapTab(e.nativeEvent, ref.current);
  };
  return (
    <div
      className={css.backdrop}
      data-log-host
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={css.logSheet}
        data-log-sheet
        onKeyDown={onKeyDown}
      >
        <div className={css.grip} aria-hidden="true" />
        <div className={css.sheetHead}>
          <h2 id={titleId} className={css.sheetTitle}>
            <Spoken shown={shell ? "factory.log" : "Factory log"} said="Factory log" />
          </h2>
          <button
            type="button"
            className={css.x}
            data-close
            aria-label="Close"
            onClick={() => onClose()}
          >
            x
          </button>
        </div>
        <ol
          ref={list}
          className={css.sheetLines}
          aria-labelledby={titleId}
          tabIndex={overflowing ? 0 : undefined}
          onScroll={onScroll}
        >
          {entries.map((e) => (
            <Line key={e.seq} entry={e} shell={shell} cursor={false} />
          ))}
        </ol>
      </div>
    </div>
  );
}

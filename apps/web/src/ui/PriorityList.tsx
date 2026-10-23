// The output priority list (W-1 item 3, §13.3): reorder by drag, by Alt+↑/↓ or by ▲ / ▼
// (W-21); pause in Simple; mode, share, target and reserve inline in Advanced (Q-9). Power is
// pinned at 1 and moves only behind the C.4 confirm. Every control is optimistic (Q-10) and
// reverts when its batch settles without adoption; the satisfaction chips move only with
// snapshots (W-13).
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { MAX_RESERVE_PERCENT, type Action, type PriorityMode } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { stateClass } from "./derive.js";
import { Guarded } from "./Guarded.js";
import styles from "./PriorityList.module.css";
import {
  dropIndex,
  isNonDefault,
  powerMoveNeedsConfirm,
  reorderVisible,
  visiblePriority,
  type PriorityRowModel,
} from "./priority-model.js";
import { useAnnounce } from "./announce.js";
import { usePendingMap, usePendingSetting } from "./use-pending.js";

/** Every priority batch carries this label. */
export const PRIORITY_LABEL = "priority";

/** Q-9: Simple / Advanced is a per-viewer convenience. */
const VIEW_KEY = "mi.priorityView";
type ListView = "simple" | "advanced";

const POWER_WARNING =
  "Generators lose first call on fuel; a brownout can starve them (C.4). Move anyway?";

interface Settings {
  mode: PriorityMode;
  share: number;
  targetRate: number | null;
  paused: boolean;
}

export interface PriorityListProps {
  store: Pick<GameStore, "send">;
  snapshot: Snapshot;
  /** Scroll this entry's row into view and focus it (a split bar's tap, §13.1). */
  focusEntry?: string | null;
  /** Called once focusEntry has been taken, so the same entry can be asked for again. */
  onFocused?: () => void;
}

function readView(): ListView {
  try {
    return localStorage.getItem(VIEW_KEY) === "advanced" ? "advanced" : "simple";
  } catch {
    return "simple";
  }
}

function useListView(): [ListView, (v: ListView) => void] {
  const [view, setView] = useState<ListView>(readView);
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        /* storage blocked: the choice lasts this mount */
      }
    },
  ];
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/** The drag in progress: the rows' midpoints (without the dragged row) are read once. Every y
 * is a document coordinate (client y + window.scrollY), so a page scroll mid-drag moves the
 * pointer over the rows instead of shifting where they seem to be. */
interface DragStart {
  id: string;
  pointerId: number;
  startY: number;
  from: number;
  mids: number[];
  /** The pointer's last client y, for a scroll with no pointer move. */
  clientY: number;
}

/** A client y as a document y. */
const docY = (clientY: number) => clientY + window.scrollY;

export function PriorityList({ store, snapshot, focusEntry = null, onFocused }: PriorityListProps) {
  const rows = useMemo(() => visiblePriority(snapshot), [snapshot]);
  const serverAll = useMemo(() => snapshot.state.priority.map((e) => e.id), [snapshot]);
  const order = usePendingSetting<readonly string[]>(serverAll, {
    owner: store,
    key: "priority:order",
  });
  const settings = usePendingMap<Settings>(store);
  const reserves = usePendingMap<number>(store);
  const [view, setView] = useListView();
  const [confirm, setConfirm] = useState<{ id: string; next: string[] } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number; to: number } | null>(null);
  const dragStart = useRef<DragStart | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const refocus = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** A move landed, or was undone: said through the page's one live region (W-20). */
  const announce = useAnnounce();
  const orderSeq = useRef(0);
  const warnId = useId();

  // A held order for another set of entries can't apply: show the server's.
  const all = sameMembers(order.shown, serverAll) ? order.shown : serverAll;
  const byId = new Map(rows.map((r) => [r.entryId, r]));
  const shownRows = all.flatMap((id) => {
    const r = byId.get(id);
    return r === undefined ? [] : [r];
  });
  const visible = shownRows.map((r) => r.entryId);

  // A reorder moves DOM nodes, which can drop focus: give it back to what had it.
  useLayoutEffect(() => {
    const el = refocus.current;
    refocus.current = null;
    if (el !== null && el.isConnected && document.activeElement !== el) el.focus();
  });

  useEffect(() => {
    if (focusEntry === null) return;
    const el = rowRefs.current.get(focusEntry);
    if (el !== undefined) {
      el.scrollIntoView?.({ block: "nearest" });
      el.focus();
    }
    onFocused?.();
    // onFocused is the caller's; a new identity alone is not a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEntry]);

  useEffect(() => {
    if (confirm !== null) cancelRef.current?.focus();
  }, [confirm]);

  const send = (actions: Action[]) => store.send(actions, PRIORITY_LABEL);

  const commitOrder = (next: string[], id: string) => {
    const active = document.activeElement;
    refocus.current = active instanceof HTMLElement ? active : null;
    const name = byId.get(id)?.name ?? id;
    const shown = next.filter((x) => byId.has(x));
    announce(`${name} moved to position ${shown.indexOf(id) + 1} of ${shown.length}`);
    const seq = ++orderSeq.current;
    order.run(next, () =>
      send([{ type: "REORDER_PRIORITY", entries: next }]).then((o) => {
        // Anything but adoption reverts the control; say so, unless a newer move superseded it.
        if (o.kind !== "adopt" && seq === orderSeq.current) announce(`${name} move undone`);
        return o;
      }),
    );
  };

  /** One intent, one batch; behind the C.4 confirm when power leaves the top (Q-9). */
  const move = (id: string, to: number) => {
    const from = visible.indexOf(id);
    if (from === -1 || to === from || to < 0 || to >= visible.length) return;
    const next = reorderVisible(all, visible, id, to);
    if (powerMoveNeedsConfirm(all, next)) {
      setConfirm({ id, next });
      return;
    }
    commitOrder(next, id);
  };

  const closeConfirm = (go: boolean) => {
    if (confirm === null) return;
    const row = rowRefs.current.get(confirm.id);
    row?.focus();
    if (go) commitOrder(confirm.next, confirm.id);
    setConfirm(null);
  };

  const shownSettings = (r: PriorityRowModel): Settings =>
    settings.shown(`priority:${r.entryId}`, {
      mode: r.mode,
      share: r.share,
      targetRate: r.targetRate,
      paused: r.paused,
    });

  /** SET_PRIORITY_MODE always carries mode, plus the changed field. */
  const setMode = (
    r: PriorityRowModel,
    change: Partial<Settings>,
    action: Extract<Action, { type: "SET_PRIORITY_MODE" }>,
  ) => {
    const cur = shownSettings(r);
    settings.run([[`priority:${r.entryId}`, { ...cur, ...change }]], () => send([action]));
  };

  const shownReserve = (r: PriorityRowModel): number =>
    r.itemId === null ? 0 : reserves.shown(`priority:reserve:${r.itemId}`, r.reserve);

  const setReserve = (r: PriorityRowModel, percent: number) => {
    if (r.itemId === null) return;
    const itemId = r.itemId;
    reserves.run([[`priority:reserve:${itemId}`, percent]], () =>
      send([{ type: "SET_RESERVE", itemId, percent }]),
    );
  };

  const onRowKey = (e: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    // A slider or number field owns its arrows.
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    move(id, visible.indexOf(id) + (e.key === "ArrowUp" ? -1 : 1));
  };

  // ---- W-21: the hand-rolled drag ----------------------------------------------------------

  const endDrag = () => {
    dragStart.current = null;
    setDrag(null);
  };

  // A drag whose row left the list (a snapshot hid it) is over; so is one cut by an unmount.
  const draggedGone = drag !== null && !visible.includes(drag.id);
  useEffect(() => {
    if (!draggedGone) return;
    dragStart.current = null;
    setDrag(null);
  }, [draggedGone]);
  useEffect(
    () => () => {
      dragStart.current = null;
    },
    [],
  );
  // The page can scroll under a held pointer (a wheel, or the touch scroller): follow it.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onScroll = () => {
      const d = dragStart.current;
      if (d === null) return;
      const y = docY(d.clientY);
      setDrag({ id: d.id, dy: y - d.startY, to: dropIndex(d.mids, y) });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [dragging]);

  const onDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || confirm !== null) return;
    // Safari and macOS Firefox don't focus a button on pointerdown; Escape needs the focus.
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // The midpoints are read once, here, in document coordinates: the list doesn't autoscroll
    // during a drag, and a page scroll doesn't move them.
    const mids: number[] = [];
    for (const v of visible) {
      if (v === id) continue;
      const rect = rowRefs.current.get(v)?.getBoundingClientRect();
      if (rect !== undefined) mids.push(docY(rect.top + rect.height / 2));
    }
    const from = visible.indexOf(id);
    dragStart.current = {
      id,
      pointerId: e.pointerId,
      startY: docY(e.clientY),
      from,
      mids,
      clientY: e.clientY,
    };
    setDrag({ id, dy: 0, to: from });
  };

  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragStart.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    d.clientY = e.clientY;
    const y = docY(e.clientY);
    setDrag({ id: d.id, dy: y - d.startY, to: dropIndex(d.mids, y) });
  };

  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragStart.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    endDrag();
    move(d.id, dropIndex(d.mids, docY(e.clientY)));
  };

  /** pointercancel, or capture lost without a pointerup (released, or the handle went away):
   * the drag ends where it started and nothing is sent. */
  const onCancel = (e: PointerEvent<HTMLButtonElement>) => {
    if (dragStart.current?.pointerId !== e.pointerId) return;
    endDrag();
  };

  /** Escape during a drag drops it back, sending nothing. */
  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Escape" || dragStart.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag();
  };

  /** The drop slot's marker, on the row it lands before (or after the last). */
  const others = drag === null ? [] : visible.filter((v) => v !== drag.id);
  const dropMark = (id: string): "before" | "after" | undefined => {
    if (drag === null || drag.to === visible.indexOf(drag.id)) return undefined;
    if (others[drag.to] === id) return "before";
    if (drag.to === others.length && others[others.length - 1] === id) return "after";
    return undefined;
  };

  const advanced = view === "advanced";

  return (
    <section className={styles.panel} aria-labelledby={`${warnId}-title`}>
      <div className={styles.head}>
        <h2 id={`${warnId}-title`} className={styles.title}>
          Priority
        </h2>
        <div role="group" aria-label="Priority view" className={styles.seg}>
          {(["simple", "advanced"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={view === v ? `${styles.segBtn} ${styles.on}` : styles.segBtn}
              onClick={() => setView(v)}
            >
              {v === "simple" ? "Simple" : "Advanced"}
            </button>
          ))}
        </div>
      </div>
      {confirm !== null && (
        <div
          role="alertdialog"
          aria-labelledby={`${warnId}-warn`}
          className={styles.confirm}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            closeConfirm(false);
          }}
        >
          <p id={`${warnId}-warn`} className={styles.warnText}>
            {POWER_WARNING}
          </p>
          <div className={styles.confirmButtons}>
            <button type="button" className="btn" onClick={() => closeConfirm(true)}>
              Move
            </button>
            <button
              ref={cancelRef}
              type="button"
              className="btn secondary"
              onClick={() => closeConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <ol aria-label="Output priority" className={styles.list}>
        {shownRows.map((r, i) => {
          const cur = shownSettings(r);
          const reserve = shownReserve(r);
          const cls = stateClass({
            satisfaction: r.satisfaction,
            paused: cur.paused,
            idle: r.idle,
          });
          const chip =
            cls === "paused" || cls === "idle" ? cls : `${Math.round(r.satisfaction * 100)}%`;
          const dragging = drag?.id === r.entryId;
          const item = r.kind === "item";
          const nonDefault = isNonDefault({ ...cur, reserve });
          return (
            <li
              key={r.entryId}
              ref={(el) => {
                if (el) rowRefs.current.set(r.entryId, el);
                else rowRefs.current.delete(r.entryId);
              }}
              data-entry={r.entryId}
              data-dragging={dragging || undefined}
              data-drop={dropMark(r.entryId)}
              tabIndex={-1}
              className={styles.row}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
              onKeyDown={(e) => onRowKey(e, r.entryId)}
            >
              <div className={styles.line}>
                <button
                  type="button"
                  className={styles.handle}
                  aria-label={`Drag to reorder ${r.name}`}
                  aria-describedby={`${warnId}-keys`}
                  onPointerDown={(e) => onDown(e, r.entryId)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onCancel}
                  onLostPointerCapture={onCancel}
                  onKeyDown={onHandleKey}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <span className={styles.name}>{r.name}</span>
                {!advanced && nonDefault && (
                  <button
                    type="button"
                    className={styles.dots}
                    aria-label="advanced settings in effect"
                    onClick={() => setView("advanced")}
                  >
                    ⋯
                  </button>
                )}
                <span
                  data-chip
                  data-state={cls}
                  className={`${styles.chip} num ${styles[`state-${cls}`] ?? ""}`}
                >
                  {chip}
                </span>
                <span className={styles.moves}>
                  <Guarded
                    className={styles.step}
                    aria-label={`Move ${r.name} up`}
                    off={i === 0}
                    onPress={() => move(r.entryId, i - 1)}
                  >
                    ▲
                  </Guarded>
                  <Guarded
                    className={styles.step}
                    aria-label={`Move ${r.name} down`}
                    off={i === shownRows.length - 1}
                    onPress={() => move(r.entryId, i + 1)}
                  >
                    ▼
                  </Guarded>
                </span>
                {item && (
                  <button
                    type="button"
                    className={`btn secondary ${styles.pause}`}
                    aria-label={`Pause ${r.name}`}
                    aria-pressed={cur.paused}
                    onClick={() =>
                      setMode(
                        r,
                        { paused: !cur.paused },
                        {
                          type: "SET_PRIORITY_MODE",
                          entryId: r.entryId,
                          mode: cur.mode,
                          paused: !cur.paused,
                        },
                      )
                    }
                  >
                    {cur.paused ? "Resume" : "Pause"}
                  </button>
                )}
              </div>
              {advanced && item && r.itemId !== null && (
                <div className={styles.advanced}>
                  <button
                    type="button"
                    className={styles.modeChip}
                    aria-label={`Mode of ${r.name}`}
                    data-mode={cur.mode}
                    onClick={() => {
                      const mode = cur.mode === "guaranteed" ? "share" : "guaranteed";
                      setMode(r, { mode }, { type: "SET_PRIORITY_MODE", entryId: r.entryId, mode });
                    }}
                  >
                    {cur.mode === "guaranteed" ? "guaranteed" : `share ${cur.share}`}
                  </button>
                  <label className={styles.field}>
                    <span>share</span>
                    <CommitInput
                      type="number"
                      min={0.1}
                      step={0.1}
                      aria-label={`Share weight of ${r.name}`}
                      className={styles.number}
                      value={String(cur.share)}
                      onCommit={(raw) => {
                        const share = Number(raw);
                        if (raw.trim() === "" || !(share > 0) || !Number.isFinite(share)) return;
                        if (share === cur.share) return;
                        setMode(
                          r,
                          { share },
                          { type: "SET_PRIORITY_MODE", entryId: r.entryId, mode: cur.mode, share },
                        );
                      }}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>target /s</span>
                    <CommitInput
                      type="number"
                      min={0}
                      aria-label={`Target rate of ${r.name}`}
                      placeholder="none"
                      className={styles.number}
                      value={cur.targetRate === null ? "" : String(cur.targetRate)}
                      onCommit={(raw) => {
                        const targetRate = raw.trim() === "" ? null : Number(raw);
                        if (
                          targetRate !== null &&
                          !(Number.isFinite(targetRate) && targetRate >= 0)
                        )
                          return;
                        if (targetRate === cur.targetRate) return;
                        setMode(
                          r,
                          { targetRate },
                          {
                            type: "SET_PRIORITY_MODE",
                            entryId: r.entryId,
                            mode: cur.mode,
                            targetRate,
                          },
                        );
                      }}
                    />
                  </label>
                  <ReserveSlider
                    name={r.name}
                    percent={reserve}
                    onCommit={(percent) => {
                      if (percent !== reserve) setReserve(r, percent);
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <p id={`${warnId}-keys`} className={styles.keys}>
        Drag, or focus a row and press Alt+↑ / Alt+↓.
      </p>
    </section>
  );
}

/**
 * An input that shows its draft while the player edits, and commits on the native `change`
 * (a range on release, a number on blur or Enter), never on every `input`. React's onChange
 * fires on `input`, so the commit listens to the DOM event itself.
 */
function CommitInput({
  value,
  onCommit,
  onDraft,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onCommit(raw: string): void;
  onDraft?: (raw: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef({ onCommit, onDraft });
  useLayoutEffect(() => {
    latest.current = { onCommit, onDraft };
  });
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const commit = () => {
      setDraft(null);
      latest.current.onDraft?.(null);
      latest.current.onCommit(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  return (
    <input
      ref={ref}
      {...rest}
      value={draft ?? value}
      onChange={(e) => {
        // The `change` itself is the commit's (above): the draft ends there.
        const next = e.nativeEvent.type === "change" ? null : e.target.value;
        setDraft(next);
        onDraft?.(next);
      }}
    />
  );
}

function ReserveSlider({
  name,
  percent,
  onCommit,
}: {
  name: string;
  percent: number;
  onCommit(percent: number): void;
}) {
  const [live, setLive] = useState<string | null>(null);
  const shown = live ?? String(Math.round(percent * 100));
  return (
    <label className={`${styles.field} ${styles.reserve}`}>
      <span>reserve</span>
      <CommitInput
        type="range"
        min={0}
        max={Math.round(MAX_RESERVE_PERCENT * 100)}
        step={5}
        aria-label={`Reserve of ${name}`}
        aria-valuetext={`${shown}%`}
        value={String(Math.round(percent * 100))}
        onDraft={setLive}
        onCommit={(raw) => {
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          onCommit(Math.min(MAX_RESERVE_PERCENT, Math.max(0, n / 100)));
        }}
      />
      <span className={`${styles.pct} num`}>{`${shown}%`}</span>
    </label>
  );
}

// U-2: the viewport shell, Layout C. App keeps the state and the wiring; the shell is the DOM.
// Desktop and tablet share one tree (U-2c); the phone has its own (U-2d). Each fills the .app
// root App renders: the header, the lane tabs, the content row (V-11: the main box, then the
// notices region, then the overlays), and the slots later tasks fill (the command line, the
// footer, the floating TAP). The live region sits in the content row, so a modal inerts
// around it (V-12), never it.
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { powerLaneId, type BottleneckModel, type LaneTab } from "./derive.js";
import { useNames } from "./names.js";
import { Notices } from "./Notices.js";
import { PowerReading } from "./PowerFooter.js";
import css from "./Shell.module.css";
import { tabTarget } from "./tabs.js";
import { useTheme, type Voice } from "./theme.js";
import { TierReadout } from "./TierReadout.js";
import type { LayoutMode } from "./use-layout-mode.js";

/** The shown view. Power is a view on the phone only (V-25); on desktop it's a lane tab. */
export type View = "factory" | "priority" | "handbook" | "power";

export interface ShellProps {
  store: GameStore;
  view: StoreView;
  /** null while loading and on the sign-in callback page: no game chrome then. */
  snapshot: Snapshot | null;
  mode: LayoutMode;
  shown: View;
  onView(v: View): void;
  /** The lane tabs, from laneTabs (U-3e, U-6a). */
  lanes: readonly LaneTab[];
  /** The selected lane; null only without a snapshot. */
  laneId: LaneId | null;
  onLane(id: LaneId): void;
  bottleneck: BottleneckModel | null;
  /** The NEXT_BUY card is open: its `1` buys one, so the first lane tab's hint steps aside (K-7). */
  cardOpen?: boolean;
  onSettings(opener: HTMLElement): void;
  onSaveChip(opener: HTMLElement): void;
  /** Filled by later tasks: the main box content, the overlays, the command line, the footer/TAP. */
  slots: {
    main: ReactNode;
    overlays: ReactNode;
    command: ReactNode;
    footer: ReactNode;
    floating: ReactNode;
  };
}

/** S-12: the save chip, from the first milestone on, for a guest only; O-13: only when there
 * is a provider to sign in with. */
function showsChip(view: StoreView): boolean {
  return (
    view.accounts === "on" &&
    view.providers.length > 0 &&
    view.identity === "guest" &&
    view.snapshot !== null &&
    view.snapshot.state.tier >= 1
  );
}

const DESKTOP_VIEWS: readonly { id: View; key: string }[] = [
  { id: "factory", key: "F1" },
  { id: "priority", key: "F2" },
  { id: "handbook", key: "F3" },
];
const PHONE_VIEWS: readonly View[] = ["factory", "power", "priority", "handbook"];

/** U-2d: the phone's title is the tab's name. */
const PHONE_TITLES: Record<View, Record<Voice, string>> = {
  factory: { shell: "MANUFACTORY_", plain: "Factory" },
  power: { shell: "POWER_GRID", plain: "Power" },
  priority: { shell: "PRIORITY.CFG", plain: "Priority" },
  handbook: { shell: "HANDBOOK", plain: "Handbook" },
};

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/** The panel the main box is: the factory panel is labelled by its lane tab. */
function panelAttrs(p: ShellProps) {
  if (p.snapshot === null) return {};
  return {
    id: `view-${p.shown}`,
    role: "tabpanel",
    "aria-labelledby":
      p.shown === "factory" && p.laneId !== null ? `lane-tab-${p.laneId}` : `panel-tab-${p.shown}`,
  };
}

function ContentRow({ p, lead }: { p: ShellProps; lead?: ReactNode }) {
  return (
    <div className={css.contentRow} data-content-row>
      <div
        className={cx(css.mainBox, p.mode === "phone" && css.phoneMain)}
        data-main-box
        {...panelAttrs(p)}
      >
        {p.slots.main}
      </div>
      <Notices store={p.store} view={p.view} lead={lead} />
      {p.slots.overlays}
    </div>
  );
}

/** A role=tablist with WAI-ARIA keys; `items` are the tab ids, `skip` the ones arrows pass. */
function useTabKeys<T extends string>(
  items: readonly T[],
  selected: T | null,
  onSelect: (id: T) => void,
  skip?: (id: T) => boolean,
) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const to = tabTarget(
      e,
      selected === null ? -1 : items.indexOf(selected),
      items.length,
      skip === undefined ? undefined : (j) => skip(items[j]!),
    );
    if (to === null) return;
    e.preventDefault();
    const next = items[to]!;
    onSelect(next);
    refs.current.get(next)?.focus();
  };
  const ref = (id: T) => (el: HTMLButtonElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  };
  return { onKeyDown, ref };
}

function LaneTabs({ p, s, phone }: { p: ShellProps; s: Snapshot; phone: boolean }) {
  const names = useNames(s);
  const ids = p.lanes.map((t) => t.id);
  const locked = new Set(p.lanes.filter((t) => t.locked).map((t) => t.id));
  const keys = useTabKeys(ids, p.laneId, p.onLane, (id) => locked.has(id));
  const navId = useId();
  // One label: the tablist is named by its nav, so "Lanes" is written once.
  return (
    <nav id={navId} aria-label="Lanes" className={css.lanes}>
      <div
        role="tablist"
        aria-labelledby={navId}
        className={phone ? css.laneGrid : css.laneRow}
        onKeyDown={keys.onKeyDown}
      >
        {p.lanes.map((t) => {
          const selected = t.id === p.laneId;
          const name = s.content.lanes.get(t.id)?.name ?? t.id;
          // U-3e / W-20: the status is in the name, so the light's colour is never the only signal.
          const label = t.locked
            ? `${name}, unlocks at tier ${t.unlockTier}`
            : `${name}, ${t.status}`;
          return (
            <button
              key={t.id}
              ref={keys.ref(t.id)}
              type="button"
              role="tab"
              id={`lane-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={selected ? "view-factory" : undefined}
              aria-disabled={t.locked ? "true" : undefined}
              aria-label={label}
              tabIndex={selected ? 0 : -1}
              className={cx(css.lane, selected && css.on)}
              data-lane={t.id}
              data-status={t.status ?? "locked"}
              onClick={() => {
                if (!t.locked) p.onLane(t.id);
              }}
            >
              {t.locked ? (
                <span className={css.lock} aria-hidden="true">{`T${t.unlockTier}`}</span>
              ) : phone && t.bottleneck ? (
                <span className={cx("glyph", css.mark)} aria-hidden="true">
                  !
                </span>
              ) : (
                <span className={`glyph state-${t.status}`} aria-hidden="true">
                  ●
                </span>
              )}
              {/* K-7: a hint only where its digit works (U-7a): never on a locked lane, and
                  not on lane 1 while the card's `1` buys one. */}
              {!phone && !t.locked && !(p.cardOpen === true && t.key === 1) && (
                <span className="key-hint" aria-hidden="true">
                  {t.key}
                </span>
              )}
              <span className={css.laneName}>{names.lane(t.id)}</span>
              {!phone && t.bottleneck && (
                <span className={css.mark} aria-hidden="true">
                  {" !"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function PanelTabs({
  p,
  views,
  phone,
}: {
  p: ShellProps;
  views: readonly { id: View; key?: string }[];
  phone: boolean;
}) {
  const ids = views.map((v) => v.id);
  const keys = useTabKeys(ids, ids.includes(p.shown) ? p.shown : null, p.onView);
  // U-2d: power gets " !" when the bottleneck is in the power lane.
  const powerMarked =
    phone &&
    p.snapshot !== null &&
    p.bottleneck !== null &&
    p.bottleneck.laneId !== null &&
    p.bottleneck.laneId === powerLaneId(p.snapshot);
  const navId = useId();
  return (
    <nav id={navId} aria-label="Panels" className={phone ? css.bottomTabs : css.panels}>
      <div
        role="tablist"
        aria-labelledby={navId}
        className={phone ? css.bottomList : css.panelList}
        onKeyDown={keys.onKeyDown}
      >
        {views.map((v) => {
          const selected = p.shown === v.id;
          const marked = v.id === "power" && powerMarked;
          return (
            <button
              key={v.id}
              ref={keys.ref(v.id)}
              type="button"
              role="tab"
              id={`panel-tab-${v.id}`}
              aria-selected={selected}
              aria-controls={selected ? `view-${v.id}` : undefined}
              aria-label={marked ? "Power, bottleneck" : undefined}
              tabIndex={selected ? 0 : -1}
              className={cx(phone ? css.bottomTab : css.panel, selected && css.on)}
              data-view={v.id}
              onClick={() => p.onView(v.id)}
            >
              {v.key !== undefined && (
                <span className="key-hint" aria-hidden="true">
                  {v.key}
                </span>
              )}
              {v.id === "power" && <span aria-hidden="true">{"~ "}</span>}
              {v.id}
              {marked && (
                <span className={css.mark} aria-hidden="true">
                  {" !"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function SettingsButton({
  p,
  label,
  className,
}: {
  p: ShellProps;
  label: string;
  className: string | undefined;
}) {
  return (
    <button
      type="button"
      className={className}
      data-open-settings
      aria-haspopup="dialog"
      aria-label="Settings"
      onClick={(e) => p.onSettings(e.currentTarget)}
    >
      {label}
    </button>
  );
}

/** Desktop and tablet (U-2b, U-2c): one tree; the CSS tells them apart by data-layout. */
export function DesktopShell(p: ShellProps) {
  const { applied } = useTheme();
  const shell = applied.voice === "shell";
  const s = p.snapshot;
  return (
    <>
      <header className={css.header}>
        <h1 aria-label="Manufactory Idle" className={css.title}>
          <span aria-hidden="true">MANUFACTORY_</span>
        </h1>
        {s !== null && <TierReadout snapshot={s} now={() => p.store.now()} />}
        <span className={css.spacer} />
        {s !== null && showsChip(p.view) && (
          <button
            type="button"
            className={css.chip}
            data-save-chip
            aria-label="Save your factory"
            onClick={(e) => p.onSaveChip(e.currentTarget)}
          >
            {shell ? "> save_factory" : "Save your factory"}
          </button>
        )}
        {s !== null && <PanelTabs p={p} views={DESKTOP_VIEWS} phone={false} />}
        <SettingsButton p={p} label={shell ? "cfg" : "Settings"} className={css.cfg} />
      </header>
      {s !== null && p.shown === "factory" && <LaneTabs p={p} s={s} phone={false} />}
      <ContentRow p={p} />
      {p.slots.command}
      {p.slots.footer}
    </>
  );
}

/** The phone (U-2d): the tab's title, lane tabs on the factory tab only, bottom tabs. */
export function PhoneShell(p: ShellProps) {
  const { applied } = useTheme();
  const shell = applied.voice === "shell";
  const s = p.snapshot;
  // U-2e: the save chip is the first notice line on the phone.
  const lead =
    s !== null && showsChip(p.view) ? (
      <div className="notice" data-notice="save">
        <span>
          {shell
            ? "> save_factory: keep this factory on any device"
            : "Keep this factory on any device."}
        </span>
        <button
          type="button"
          className="btn"
          data-save-chip
          aria-label="Save your factory"
          onClick={(e) => p.onSaveChip(e.currentTarget)}
        >
          {shell ? "save" : "Save"}
        </button>
      </div>
    ) : null;
  return (
    <>
      <header className={cx(css.header, css.phoneHeader)}>
        <h1 aria-label="Manufactory Idle" className={css.title}>
          <span aria-hidden="true">
            {PHONE_TITLES[s === null ? "factory" : p.shown][applied.voice]}
          </span>
        </h1>
        {s !== null && (
          <div className={css.readouts}>
            {p.shown !== "power" && <TierReadout snapshot={s} now={() => p.store.now()} phone />}
            <PowerReading snapshot={s} powerTab={p.shown === "power"} />
          </div>
        )}
        <SettingsButton p={p} label="≡" className={css.menu} />
      </header>
      {s !== null && p.shown === "factory" && <LaneTabs p={p} s={s} phone />}
      <ContentRow p={p} lead={lead} />
      {p.shown === "factory" && p.slots.command}
      {p.slots.floating}
      {s !== null && <PanelTabs p={p} views={PHONE_VIEWS.map((id) => ({ id }))} phone />}
    </>
  );
}

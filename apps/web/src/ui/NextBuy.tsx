// U-4c: the NEXT_BUY card (desktop) and sheet (phone): one model, two presentations. The model
// (nextBuyModel) is computed only while one is open, since a preview costs a few ms. The card
// is non-modal: Esc, or focus leaving it, closes it, and it stays open across a buy so the next
// advice follows. The sheet is modal (V-12): App inerts everything outside its host but the
// live region, and Tab wraps inside it.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { ItemId } from "@manufactory/engine";
import { serverNow } from "../sync/snapshot.js";
import { commandText, machineEffect, nextBuyModel, type NextBuyModel } from "./command.js";
import { Run, type CommandProps } from "./CommandBar.js";
import { trapTab } from "./dialog.js";
import { useNames } from "./names.js";
import css from "./NextBuy.module.css";
import { useTheme } from "./theme.js";
import { useTick } from "./use-tick.js";

/** The model at the 4 Hz "have"; null with nothing to run. */
function useNextBuy(p: CommandProps): NextBuyModel | null {
  useTick();
  const { applied } = useTheme();
  if (p.model === null) return null;
  return nextBuyModel(p.snapshot, p.model, serverNow(p.snapshot, p.store.now()), applied);
}

/** On mount: the primary run, else the close button. */
function useInitialFocus(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const r = root.current;
    (
      r?.querySelector<HTMLElement>("[data-run]") ?? r?.querySelector<HTMLElement>("[data-close]")
    )?.focus();
  }, [root]);
}

function Details({
  p,
  n,
  lane,
  extra,
}: {
  p: CommandProps;
  n: NextBuyModel | null;
  lane: boolean;
  extra?: ReactNode;
}) {
  const { applied } = useTheme();
  if (n === null)
    return (
      <p className={css.action}>
        {p.model === null ? commandText(null, p.snapshot, applied.voice) : p.model.text}
      </p>
    );
  return (
    <>
      <p className={css.action}>{n.action}</p>
      <ul className={css.lines}>
        <li>why: {n.why}</li>
        {lane && n.lane !== null && <li>lane: {n.lane}</li>}
        {n.cost.map((c) => (
          <li key={c}>cost: {c}</li>
        ))}
        {n.effect.map((e) => (
          <li key={e}>effect: {e}</li>
        ))}
        {extra}
      </ul>
    </>
  );
}

/** "buy 1", with its own projection computed lazily on focus or hover (U-4c). */
function BuyOne({
  p,
  kind,
  className,
}: {
  p: CommandProps;
  kind: "card" | "sheet";
  className: string | undefined;
}) {
  const { applied } = useTheme();
  const [shown, setShown] = useState(false);
  return (
    <span className={css.one} onFocus={() => setShown(true)} onMouseEnter={() => setShown(true)}>
      <Run {...p} kind={kind} voice={applied.voice} className={className} count={1} />
      {shown && <OneEffect p={p} />}
    </span>
  );
}

function OneEffect({ p }: { p: CommandProps }) {
  const { applied } = useTheme();
  const a = p.model?.action;
  if (p.model === null || a === undefined || a === null || a.type !== "BUY_MACHINE") return null;
  return (
    <span className={css.oneEffect}>
      {`1: ${machineEffect(p.snapshot, p.model, { ...a, count: 1 }, applied)}`}
    </span>
  );
}

/** U-4c, desktop: section[role=dialog][aria-modal=false], inside the content row. */
export function NextBuyCard(p: CommandProps & { onClose(returnFocus: boolean): void }) {
  const { applied } = useTheme();
  const n = useNextBuy(p);
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  useInitialFocus(ref);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    p.onClose(true);
  };
  // Focus leaving for another element closes it; focus lost to nowhere (a run button that
  // unmounts when the next advice has none) keeps it.
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget;
    if (to instanceof Node && !e.currentTarget.contains(to)) p.onClose(false);
  };
  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={css.card}
      data-next-buy
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <div className={css.head}>
        <h2 id={titleId} className={css.title}>
          {applied.voice === "shell" ? "NEXT_BUY" : "Next buy"}
        </h2>
        <button
          type="button"
          className={css.close}
          data-close
          aria-label="Close"
          onClick={() => p.onClose(true)}
        >
          <span className="key-hint" aria-hidden="true">
            [ESC]
          </span>
          close
        </button>
      </div>
      <Details p={p} n={n} lane={false} />
      {n !== null && (
        <div className={css.buttons}>
          <Run {...p} kind="card" voice={applied.voice} className={css.primary} />
          {n.buyOne !== null && <BuyOne p={p} kind="card" className={css.secondary} />}
        </div>
      )}
    </section>
  );
}

/** U-4c, the phone: a modal bottom sheet over the scrim. App renders it next to the settings
 * host, so its inert pass keeps it (and the live region) and nothing else. */
export function NextBuySheet(p: CommandProps & { onClose(): void; onOpenItem(id: ItemId): void }) {
  const { applied } = useTheme();
  const names = useNames(p.snapshot);
  const n = useNextBuy(p);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useInitialFocus(ref);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
      return;
    }
    if (ref.current !== null) trapTab(e.nativeEvent, ref.current);
  };
  return (
    <div
      className={css.backdrop}
      data-next-buy-host
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={css.sheet}
        data-next-buy
        onKeyDown={onKeyDown}
      >
        <div className={css.grip} aria-hidden="true" />
        <div className={css.head}>
          <h2 id={titleId} className={css.sheetTitle}>
            {applied.voice === "shell" ? "NEXT_BUY" : "Next buy"}
          </h2>
          <button
            type="button"
            className={css.x}
            data-close
            aria-label="Close"
            onClick={() => p.onClose()}
          >
            x
          </button>
        </div>
        <Details p={p} n={n} lane />
        {n !== null && (
          <div className={css.sheetButtons}>
            <Run {...p} kind="sheet" voice={applied.voice} className={css.sheetPrimary} />
            {(n.buyOne !== null || n.open !== null) && (
              <div className={css.pair}>
                {n.buyOne !== null && <BuyOne p={p} kind="sheet" className={css.outlined} />}
                {n.open !== null && (
                  <button
                    type="button"
                    className={css.outlined}
                    data-open-item
                    onClick={() => p.onOpenItem(n.open!)}
                  >
                    {`open ${names.item(n.open)}`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

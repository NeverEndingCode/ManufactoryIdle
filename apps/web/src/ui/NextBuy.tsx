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
  type RefObject,
} from "react";
import type { ItemId } from "@manufactory/engine";
import { serverNow } from "../sync/snapshot.js";
import { commandText, machineEffect, nextBuyModel, PLAIN, type NextBuyModel } from "./command.js";
import { Run, type CommandProps } from "./CommandBar.js";
import { MODAL_HOSTS, trapTab } from "./dialog.js";
import { itemName, useNames } from "./names.js";
import css from "./NextBuy.module.css";
import { Spoken } from "./Spoken.js";
import { useTheme } from "./theme.js";
import { useTick } from "./use-tick.js";

/** The model at the 4 Hz "have", in the theme's names and in the plain ones a reader hears
 * (U-1h; the preview under both is memoised per snapshot); null with nothing to run. */
function useNextBuy(p: CommandProps): { n: NextBuyModel; said: NextBuyModel } | null {
  useTick();
  const { applied } = useTheme();
  if (p.model === null) return null;
  const at = serverNow(p.snapshot, p.store.now());
  const n = nextBuyModel(p.snapshot, p.model, at, applied);
  if (n === null) return null;
  const said = applied.names === "title" ? n : nextBuyModel(p.snapshot, p.model, at, PLAIN)!;
  return { n, said };
}

/** The card's and the sheet's title: NEXT_BUY is the shell's, "Next buy" what a reader hears. */
function Title({ id, className }: { id: string; className: string | undefined }) {
  const { applied } = useTheme();
  return (
    <h2 id={id} className={className}>
      <Spoken shown={applied.voice === "shell" ? "NEXT_BUY" : "Next buy"} said="Next buy" />
    </h2>
  );
}

/** The model's lines, as shown or as said. */
function Lines({ n, lane, hidden }: { n: NextBuyModel; lane: boolean; hidden?: true }) {
  return (
    <>
      <p className={css.action} aria-hidden={hidden}>
        {n.action}
      </p>
      <ul className={css.lines} aria-hidden={hidden}>
        <li>why: {n.why}</li>
        {lane && n.lane !== null && <li>lane: {n.lane}</li>}
        {n.cost.map((c) => (
          <li key={c}>cost: {c}</li>
        ))}
        {n.effect.map((e) => (
          <li key={e}>effect: {e}</li>
        ))}
      </ul>
    </>
  );
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
}: {
  p: CommandProps;
  n: { n: NextBuyModel; said: NextBuyModel } | null;
  lane: boolean;
}) {
  const { applied } = useTheme();
  if (n === null)
    return (
      <p className={css.action}>
        {p.model === null ? commandText(null, p.snapshot, applied.voice) : p.model.text}
      </p>
    );
  if (n.said === n.n) return <Lines n={n.n} lane={lane} />;
  // U-1h: the ids are seen, the content names heard.
  return (
    <>
      <Lines n={n.n} lane={lane} hidden />
      <div className="visually-hidden">
        <Lines n={n.said} lane={lane} />
      </div>
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
      <Spoken
        shown={`1: ${machineEffect(p.snapshot, p.model, { ...a, count: 1 }, applied)}`}
        said={`1: ${machineEffect(p.snapshot, p.model, { ...a, count: 1 }, PLAIN)}`}
      />
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
  // Esc from rest too: a buy that swaps the advice unmounts the focused run, and focus falls to
  // <body> with the card still open (K-21). The dispatcher leaves Esc to the card, so the card
  // listens on the document, as the help does; never over a modal, whose own Esc wins.
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const at = document.activeElement;
      if (at !== null && at !== document.body) return;
      if (MODAL_HOSTS.some((sel) => document.querySelector(sel) !== null)) return;
      e.preventDefault();
      close.current(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // Focus leaving for another element closes it; focus lost to nowhere (a run button that
  // unmounts when the next advice has none) keeps it. Focus going to the why button keeps it
  // too: that click toggles it closed, and closing here first would make the click reopen it.
  // Focus going into a modal (`?`'s help over the card) keeps it, inert underneath, so the
  // modal's close can return focus to the control in the card that opened it (K-6).
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget;
    if (!(to instanceof Element) || e.currentTarget.contains(to)) return;
    if (to.closest("[data-why]") !== null) return;
    if (to.closest(MODAL_HOSTS.join(", ")) !== null) return;
    p.onClose(false);
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
        <Title id={titleId} className={css.title} />
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
          {n.n.buyOne !== null && <BuyOne p={p} kind="card" className={css.secondary} />}
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
  const open = n?.n.open ?? null;
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
          <Title id={titleId} className={css.sheetTitle} />
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
            {(n.n.buyOne !== null || open !== null) && (
              <div className={css.pair}>
                {n.n.buyOne !== null && <BuyOne p={p} kind="sheet" className={css.outlined} />}
                {open !== null && (
                  <button
                    type="button"
                    className={css.outlined}
                    data-open-item
                    aria-label={`open ${itemName(p.snapshot, open)}`}
                    onClick={() => p.onOpenItem(open)}
                  >
                    {`open ${names.item(open)}`}
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

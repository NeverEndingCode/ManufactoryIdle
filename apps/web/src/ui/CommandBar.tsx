// U-4a / U-4b: the command line, the recommended buy's one home. The run buttons are the
// frame's SpendButton and ReserveButton, moved (V-23): spends are pessimistic (W-13), so the
// button is busy (aria-disabled, still focusable) until the batch's response lands; the
// reserve is a setting. Every one sends under BOTTLENECK_BUY_LABEL, so they're busy together.
import { useEffect, useRef, useState } from "react";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import {
  commandText,
  runLabel,
  runName,
  shortText,
  whyName,
  type FrameSpend,
  type RunKind,
} from "./command.js";
import { BOTTLENECK_BUY_LABEL, type BottleneckModel, type FrameAction } from "./derive.js";
import css from "./CommandBar.module.css";
import { Guarded } from "./Guarded.js";
import { affordability } from "./quote.js";
import { useTheme, type Voice } from "./theme.js";
import { useTick } from "./use-tick.js";

export type { FrameSpend, RunKind } from "./command.js";

export interface CommandProps {
  model: BottleneckModel | null;
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
}

/** The key hint a run button carries: hidden until the keyboard lands (V-9). */
function hint(kind: RunKind, count: 1 | undefined): string | null {
  if (kind === "bar") return "[ENTER]";
  if (kind === "card") return count === 1 ? "[1]" : "[ENTER]";
  return null;
}

/** The frame's SpendButton, moved: Guarded, aria-busy, BOTTLENECK_BUY_LABEL. `count: 1` is
 * the card's "buy 1": the same machine buy at count 1, under the same label (V-17). */
export function RunButton({
  model,
  spend,
  snapshot,
  store,
  pending,
  kind,
  voice,
  className,
  count,
}: {
  model: BottleneckModel;
  spend: FrameSpend;
  snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">;
  pending: readonly Batch[];
  kind: RunKind;
  voice: Voice;
  className?: string | undefined;
  count?: 1;
}) {
  useTick(); // the countdown and the enable both move with the 4 Hz text tick
  const sent: FrameSpend =
    count === 1 && spend.type === "BUY_MACHINE" ? { ...spend, count } : spend;
  const shown = sent === spend ? model : { ...model, action: sent };
  const busy = pending.some((b) => b.label === BOTTLENECK_BUY_LABEL);
  const a = affordability(snapshot, sent, serverNow(snapshot, store.now()));
  const key = hint(kind, count);
  // Guarded, not the native disabled: a focused button that turns busy keeps its focus.
  return (
    <Guarded
      className={className ?? css.run}
      off={busy || !a.affordable}
      aria-busy={busy}
      aria-label={runName(shown, snapshot, busy ? { affordable: true } : a)}
      data-run
      onPress={() => {
        store.send([sent], BOTTLENECK_BUY_LABEL).catch((err: unknown) => console.error(err));
      }}
    >
      {key !== null && (
        <span className="key-hint" aria-hidden="true">
          {key}
        </span>
      )}
      {runLabel(shown, snapshot, voice, kind, a, busy)}
    </Guarded>
  );
}

/** The frame's ReserveButton, moved. A setting, not a spend (W-13): never busy and never
 * natively disabled. While its own send is unsettled a second click is ignored, so a double
 * tap can't send a duplicate. */
export function ReserveRun({
  model,
  reserve,
  snapshot,
  store,
  kind,
  voice,
  className,
}: {
  model: BottleneckModel;
  reserve: Extract<FrameAction, { type: "SET_RESERVE" }>;
  snapshot: Snapshot;
  store: Pick<GameStore, "send">;
  kind: RunKind;
  voice: Voice;
  className?: string | undefined;
}) {
  const [sending, setSending] = useState(false);
  // The send can settle after the button is gone (the reserve is set, the advice moves on).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const affordable = { affordable: true } as const;
  const key = hint(kind, undefined);
  return (
    <button
      type="button"
      className={className ?? css.run}
      aria-disabled={sending}
      aria-label={runName(model, snapshot, affordable)}
      data-run
      onClick={() => {
        if (sending) return;
        setSending(true);
        store
          .send([reserve], BOTTLENECK_BUY_LABEL)
          .catch((err: unknown) => console.error(err))
          .finally(() => {
            if (mounted.current) setSending(false);
          });
      }}
    >
      {key !== null && (
        <span className="key-hint" aria-hidden="true">
          {key}
        </span>
      )}
      {runLabel(model, snapshot, voice, kind, affordable, false)}
    </button>
  );
}

/** The model's run button, or null when there's nothing to run. */
export function Run(
  p: CommandProps & { kind: RunKind; voice: Voice; className?: string | undefined; count?: 1 },
) {
  const { model, snapshot, store, pending, kind, voice, className, count } = p;
  const action = model?.action ?? null;
  if (model === null || action === null) return null;
  if (action.type === "SET_RESERVE")
    return count === 1 ? null : (
      <ReserveRun
        model={model}
        reserve={action}
        snapshot={snapshot}
        store={store}
        kind={kind}
        voice={voice}
        className={className}
      />
    );
  return (
    <RunButton
      model={model}
      spend={action}
      snapshot={snapshot}
      store={store}
      pending={pending}
      kind={kind}
      voice={voice}
      className={className}
      count={count}
    />
  );
}

/** The command's words: typed out in UI-3 (U-9e), so the visible span is aria-hidden and a
 * visually hidden sibling holds the plain words (U-1h: never the shell's ids), read once when
 * they change (U-8a). */
function CommandWords({
  text,
  said,
  className,
}: {
  text: string;
  said: string;
  className: string | undefined;
}) {
  return (
    <span className={className}>
      <span aria-hidden="true" data-typed>
        {text}
      </span>
      <span className={css.visuallyHidden} data-command-text>
        {said}
      </span>
    </span>
  );
}

/** U-4a: the desktop (and tablet) bar, shown on every view so the advice runs anywhere. */
export function CommandBar(
  p: CommandProps & { onWhy(opener: HTMLElement): void; whyOpen: boolean },
) {
  const { applied } = useTheme();
  const voice = applied.voice;
  return (
    <section aria-label="Command line" className={css.bar} data-command>
      <span className={css.prompt} aria-hidden="true">
        {voice === "shell" ? "operator@manufactory:~$" : "Next"}
      </span>
      <CommandWords
        text={commandText(p.model, p.snapshot, voice)}
        said={commandText(p.model, p.snapshot, "plain")}
        className={css.command}
      />
      <span className={css.cursor} aria-hidden="true" />
      <span className={css.spacer} />
      {p.model !== null && (
        <button
          type="button"
          className={css.why}
          data-why
          aria-haspopup="dialog"
          aria-expanded={p.whyOpen}
          onClick={(e) => p.onWhy(e.currentTarget)}
        >
          <span className="key-hint" aria-hidden="true">
            [TAB]
          </span>
          {voice === "shell" ? "why" : "Why"}
        </button>
      )}
      <Run {...p} kind="bar" voice={voice} />
    </section>
  );
}

/** U-4b: the phone's split bar, on the factory tab only. Left opens the sheet; right runs. */
export function CommandSplit(p: CommandProps & { onWhy(opener: HTMLElement): void }) {
  const { applied } = useTheme();
  const voice = applied.voice;
  const runnable = p.model !== null && p.model.action !== null;
  return (
    <section aria-label="Command line" className={css.split} data-command>
      <button
        type="button"
        className={css.splitWhy}
        aria-disabled={p.model === null}
        data-why
        aria-haspopup="dialog"
        aria-label={whyName(p.model, p.snapshot)}
        onClick={(e) => {
          if (p.model !== null) p.onWhy(e.currentTarget);
        }}
      >
        <span className={css.dollar} aria-hidden="true">
          $
        </span>
        <span className={css.short}>{shortText(p.model, p.snapshot, voice)}</span>
        <span className={css.whyHint}>
          why <span aria-hidden="true">▴</span>
        </span>
      </button>
      {runnable ? (
        <Run {...p} kind="split" voice={voice} className={css.splitRun} />
      ) : (
        <Guarded
          className={css.splitRun}
          off
          aria-label="Nothing to run"
          data-run
          onPress={() => {}}
        >
          —
        </Guarded>
      )}
    </section>
  );
}

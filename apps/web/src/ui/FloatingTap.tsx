// U-6c: the phone's floating TAP, on every tab. TAP, the kick (x1.35), ten stack ticks (■ live,
// □ empty: the fonts have these, not ▮▯, V-5) and a time-left bar, the last two aria-hidden; the
// accessible name carries them, per snapshot and per tap (V-22). It sits over the command bar on
// the factory tab (withCommand), lower elsewhere. The hold is the footer's (useTapHold).
import { kickText, useTapReadout, type TapProps } from "./PowerFooter.js";
import css from "./Power.module.css";
import { useTapHold } from "./use-tap-hold.js";

export function FloatingTap(p: TapProps & { withCommand: boolean }) {
  const { m, name } = useTapReadout(p);
  const hold = useTapHold(p.store);
  const duration = p.snapshot.content.bundle.tap.durationSeconds * 1000;
  const left = duration > 0 ? Math.min(1, m.remainingMs / duration) : 0;
  return (
    <div
      className={p.withCommand ? `${css.floating} ${css.withCommand}` : css.floating}
      data-power
      data-stacks={m.stacks}
      data-holding={p.taps.holding ? "" : undefined}
      data-with-command={p.withCommand ? "" : undefined}
    >
      <button type="button" className={css.tap} aria-label={name} data-tap {...hold}>
        <span className={css.tapWord} aria-hidden="true">
          TAP
        </span>
        <span className={css.tapKick} aria-hidden="true">
          {kickText(m)}
        </span>
        <span className={css.ticks} aria-hidden="true" data-ticks>
          {"■".repeat(m.stacks) + "□".repeat(Math.max(0, m.maxStacks - m.stacks))}
        </span>
        <span className={css.time} aria-hidden="true" data-time-left>
          <span className={css.timeFill} data-fill style={{ transform: `scaleX(${left})` }} />
        </span>
      </button>
    </div>
  );
}

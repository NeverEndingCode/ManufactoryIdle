// S-11: the settings sheet, a modal dialog with four sections: notation, theme, account and
// About (U-2e: the GPL notice, W-25, moved out of the footer).
// U-1i: the Theme fieldset lists the six themes with a registry swatch; a locked one stays
// listed and focusable, aria-disabled, and picking it does nothing. Below it, "Glow and
// scanlines" (L-16): natively disabled outside terminal, which has no glow to turn off, with
// the note that says so.
// A bottom sheet below 600 px and a centred panel above. Escape (anywhere: it listens on the
// document), Close or the backdrop closes it. Tab wraps inside it, and focus never falls to
// <body>: whatever unmounts the focused control, the title takes focus. App makes the
// background inert and returns focus to the opener.
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { GameStore, StoreView } from "../sync/store.js";
import { AccountSection } from "./AccountForms.js";
import { NOTATION_LABELS, NOTATIONS, notationSample, useNotation } from "./notation.js";
import styles from "./Settings.module.css";
import { capabilities } from "./capabilities.js";
import { trapTab } from "./dialog.js";
import { currentBuildInfo, sourceLinks } from "./source-link.js";
import { isLocked, THEMES, useCrt, useTheme } from "./theme.js";

/** U-1i: the locked themes' line, and their radio's accessible description. */
export const LOCKED_LINE = "Unlocks in the prestige store";
/** L-16: the CRT checkbox's note and description. */
export const CRT_LINE = "Retro terminal only";

export interface SettingsProps {
  store: Pick<GameStore, "beginSignIn" | "signOut">;
  view: StoreView;
  /** Open at the Account section (the chip). */
  section?: "account";
  onClose(): void;
}

export function Settings({ store, view, section, onClose }: SettingsProps) {
  const titleId = useId();
  const accountId = useId();
  const aboutId = useId();
  const links = sourceLinks(currentBuildInfo());
  const title = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [notation, setNotation] = useNotation();
  const theme = useTheme();
  const crt = useCrt();
  const caps = capabilities(view);
  const atAccount = section === "account";

  useEffect(() => {
    // The Account section focuses its first provider button when opened there.
    if (!atAccount) title.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape on the document, so it still works when the focused control has just unmounted.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Never on <body>: a session that appears, or a sign-out, swaps the Account section. Runs
  // after the children's own focus effects, so it only catches what they left behind.
  useEffect(() => {
    const d = dialog.current;
    if (d !== null && !d.contains(document.activeElement)) title.current?.focus();
  });

  /** The Tab wrap (V-12's trapTab). */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (dialog.current !== null) trapTab(e.nativeEvent, dialog.current);
  };

  return (
    <div
      className={styles.backdrop}
      data-settings-host
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.sheet}
        data-settings
        onKeyDown={onKeyDown}
      >
        <div className={styles.head}>
          <h2 id={titleId} ref={title} tabIndex={-1} className={styles.title}>
            Settings
          </h2>
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <fieldset className={styles.group}>
          <legend>Numbers</legend>
          {NOTATIONS.map((m) => (
            <div key={m} className={styles.option}>
              <input
                type="radio"
                id={`${titleId}-n-${m}`}
                name="notation"
                value={m}
                checked={notation === m}
                onChange={() => setNotation(m)}
                aria-describedby={`${titleId}-ns-${m}`}
                data-notation={m}
              />
              <label htmlFor={`${titleId}-n-${m}`}>{NOTATION_LABELS[m]}</label>
              <span id={`${titleId}-ns-${m}`} className={`${styles.sample} num`}>
                {notationSample(m)}
              </span>
            </div>
          ))}
        </fieldset>

        <fieldset className={styles.group}>
          <legend>Theme</legend>
          {THEMES.map((t) => {
            const locked = isLocked(t, caps);
            const radioId = `${titleId}-t-${t.id}`;
            const lineId = `${titleId}-tl-${t.id}`;
            return (
              <div
                key={t.id}
                className={styles.option}
                data-theme-option={t.id}
                data-locked-theme={locked ? "" : undefined}
              >
                <input
                  type="radio"
                  id={radioId}
                  name="theme"
                  value={t.id}
                  checked={theme.applied.id === t.id}
                  aria-disabled={locked ? "true" : undefined}
                  aria-describedby={locked ? lineId : undefined}
                  onChange={() => {
                    if (locked) return;
                    theme.set(t.id);
                  }}
                  data-theme-choice={t.id}
                />
                <span className={styles.swatch} aria-hidden="true" data-swatch={t.id}>
                  <span style={{ background: t.swatch.bg }} />
                  <span style={{ background: t.swatch.body }} />
                  <span style={{ background: t.swatch.advice }} />
                </span>
                <label htmlFor={radioId}>{t.name}</label>
                {locked && (
                  <>
                    <span className={styles.tag} data-locked>
                      locked
                    </span>
                    <span id={lineId} className={styles.lockLine}>
                      {LOCKED_LINE}
                    </span>
                  </>
                )}
              </div>
            );
          })}
          <div className={styles.option} data-crt-option>
            <input
              type="checkbox"
              id={`${titleId}-crt`}
              checked={crt.on}
              disabled={!theme.applied.effects}
              aria-describedby={`${titleId}-crt-line`}
              onChange={(e) => crt.set(e.currentTarget.checked)}
              data-crt-choice
            />
            <label htmlFor={`${titleId}-crt`}>Glow and scanlines</label>
            <span id={`${titleId}-crt-line`} className={styles.lockLine}>
              {CRT_LINE}
            </span>
          </div>
        </fieldset>

        <section aria-labelledby={accountId} className={styles.group} data-account>
          <h3 id={accountId} className={styles.legend}>
            Account
          </h3>
          <AccountSection store={store} view={view} focusFirst={atAccount} />
        </section>

        <section aria-labelledby={aboutId} className={styles.group} data-about>
          <h3 id={aboutId} className={styles.legend}>
            About
          </h3>
          <p className={styles.about}>
            <span>Free software under the GPL-3.0</span>
            <span aria-hidden="true"> · </span>
            <a href={links.source.href} data-source-link>
              {links.source.text}
            </a>
            <span aria-hidden="true"> · </span>
            <a href={links.license.href} data-license-link>
              License
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}

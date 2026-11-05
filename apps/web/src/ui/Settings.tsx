// S-11: the settings sheet, a modal dialog with three sections: notation, theme and account.
// U-1i: the Theme fieldset lists the six themes with a registry swatch; a locked one stays
// listed and focusable, aria-disabled, and picking it does nothing.
// A bottom sheet below 600 px and a centred panel above. Escape (anywhere: it listens on the
// document), Close or the backdrop closes it. Tab wraps inside it, and focus never falls to
// <body>: whatever unmounts the focused control, the title takes focus. App makes the
// background inert and returns focus to the opener.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { GameStore, StoreView } from "../sync/store.js";
import { AccountSection, type AccountMode } from "./AccountForms.js";
import { NOTATION_LABELS, NOTATIONS, notationSample, useNotation } from "./notation.js";
import styles from "./Settings.module.css";
import { capabilities } from "./capabilities.js";
import { isLocked, THEMES, useTheme } from "./theme.js";

/** U-1i: the locked themes' line, and their radio's accessible description. */
export const LOCKED_LINE = "Unlocks in the prestige store";

const TABBABLE = "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])";

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.closest("[inert]") !== null) return false;
    // A radio group is one stop: only its checked radio is in the Tab order.
    if (el instanceof HTMLInputElement && el.type === "radio" && !el.checked) return false;
    return true;
  });
}

export interface SettingsProps {
  store: Pick<GameStore, "signUp" | "signIn" | "signOut" | "sendReset">;
  view: StoreView;
  /** Open at the Account section (the chip, the reset page's Sign in). */
  section?: "account";
  mode?: "sign-up" | "sign-in";
  onClose(): void;
}

export function Settings({ store, view, section, mode = "sign-up", onClose }: SettingsProps) {
  const titleId = useId();
  const accountId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [notation, setNotation] = useNotation();
  const theme = useTheme();
  const caps = capabilities(view);
  const [accountMode, setAccountMode] = useState<AccountMode>(mode);
  const atAccount = section === "account";

  useEffect(() => {
    // The account form focuses its own first field when opened there.
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

  // Never on <body>: a sign-in that unmounts its form, "Send another", a mode change. Runs
  // after the children's own focus effects, so it only catches what they left behind.
  useEffect(() => {
    const d = dialog.current;
    if (d !== null && !d.contains(document.activeElement)) title.current?.focus();
  });

  /** The Tab wrap: past the last control to the first, before the first to the last. */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || dialog.current === null) return;
    const all = tabbables(dialog.current);
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && at <= 0) {
      e.preventDefault();
      all[all.length - 1]!.focus();
    } else if (!e.shiftKey && (at === -1 || at === all.length - 1)) {
      e.preventDefault();
      all[0]!.focus();
    }
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
        </fieldset>

        <section aria-labelledby={accountId} className={styles.group} data-account>
          <h3 id={accountId} className={styles.legend}>
            Account
          </h3>
          <AccountSection
            store={store}
            view={view}
            mode={accountMode}
            onMode={setAccountMode}
            focusFirst={atAccount}
          />
        </section>
      </div>
    </div>
  );
}

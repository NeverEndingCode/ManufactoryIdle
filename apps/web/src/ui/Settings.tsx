// S-11: the settings sheet, a modal dialog with three sections: notation, theme and account.
// A bottom sheet below 600 px and a centred panel above. Escape (or Close, or the backdrop)
// closes it; App makes the background inert and returns focus to the opener.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { GameStore, StoreView } from "../sync/store.js";
import { AccountSection, type AccountMode } from "./AccountForms.js";
import { NOTATION_LABELS, NOTATIONS, notationSample, useNotation } from "./notation.js";
import styles from "./Settings.module.css";
import { useTheme, type ThemeChoice } from "./theme.js";

const THEMES: readonly { id: ThemeChoice; name: string }[] = [
  { id: "system", name: "System" },
  { id: "dark", name: "Dark" },
  { id: "light", name: "Light" },
];

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
  const [notation, setNotation] = useNotation();
  const [theme, setTheme] = useTheme();
  const [accountMode, setAccountMode] = useState<AccountMode>(mode);
  const atAccount = section === "account";

  useEffect(() => {
    // The account form focuses its own first field when opened there.
    if (!atAccount) title.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
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
          {THEMES.map((t) => (
            <div key={t.id} className={styles.option}>
              <input
                type="radio"
                id={`${titleId}-t-${t.id}`}
                name="theme"
                value={t.id}
                checked={theme === t.id}
                onChange={() => setTheme(t.id)}
                data-theme-choice={t.id}
              />
              <label htmlFor={`${titleId}-t-${t.id}`}>{t.name}</label>
            </div>
          ))}
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

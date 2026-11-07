// U-7e: the `?` help overlay, a modal dialog built from KEYMAP (K-7), so it can't drift from the
// real map. Its title is `man manufactory` in the shell voice and "Keyboard shortcuts" in the
// plain one, and a reader hears "Keyboard shortcuts" in both (K-1). Each key cap goes through
// Spoken: `[ENTER]` is seen, "Enter" heard. It ends with the GPL line (U-2e), the About links.
// Escape (on the dialog, and on the document like Settings, so it works from <body>), `?`
// (through the dispatcher's help scope), Close or the backdrop closes it. Tab wraps inside it.
// App makes the background inert (K-5) and returns focus to the opener (K-6).
import { Fragment, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { trapTab } from "./dialog.js";
import styles from "./Help.module.css";
import { KEYMAP, type KeyRow } from "./keys.js";
import { currentBuildInfo, sourceLinks } from "./source-link.js";
import { Spoken } from "./Spoken.js";
import { useTheme, type Voice } from "./theme.js";

/** U-7b: the F-keys' note, beside the alternatives. */
export const F_KEY_NOTE = "F1–F3 may be taken by your browser or OS: F, P and H always work";

/** One section per scope, in U-7a's order of reach. */
const SECTIONS: readonly {
  scope: KeyRow["scope"];
  heading: Record<Voice, string>;
  said: string;
}[] = [
  { scope: "global", heading: { shell: "Anywhere", plain: "Anywhere" }, said: "Anywhere" },
  {
    scope: "drawer",
    heading: { shell: "With a drawer open", plain: "With a drawer open" },
    said: "With a drawer open",
  },
  {
    scope: "card",
    heading: { shell: "With NEXT_BUY open", plain: "With Next buy open" },
    said: "With Next buy open",
  },
  {
    scope: "help",
    heading: { shell: "In this help", plain: "In this help" },
    said: "In this help",
  },
];

/** A row's caps, one after another: seen "F1 [F]", heard "F1 or F". */
function Caps({ caps }: { caps: KeyRow["caps"] }) {
  return (
    <>
      {caps.map((c, i) => (
        <Fragment key={c.shown}>
          {i > 0 && <Spoken shown=" " said=" or " />}
          <kbd className={styles.cap}>
            <Spoken shown={c.shown} said={c.said} />
          </kbd>
        </Fragment>
      ))}
    </>
  );
}

export function Help({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const { applied } = useTheme();
  const voice = applied.voice;
  const links = sourceLinks(currentBuildInfo());

  useEffect(() => {
    title.current?.focus();
  }, []);

  // Escape on the document too, so it works with focus on <body>.
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

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (dialog.current !== null) trapTab(e.nativeEvent, dialog.current);
  };

  const rules = KEYMAP.filter((r) => r.caps.length === 0);

  return (
    <div
      className={styles.backdrop}
      data-help-host
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
        className={styles.help}
        data-help
        onKeyDown={onKeyDown}
      >
        <div className={styles.head}>
          <h2 id={titleId} ref={title} tabIndex={-1} className={styles.title}>
            <Spoken
              shown={voice === "shell" ? "man manufactory" : "Keyboard shortcuts"}
              said="Keyboard shortcuts"
            />
          </h2>
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {SECTIONS.map((sec) => {
          const rows = KEYMAP.filter((r) => r.scope === sec.scope && r.caps.length > 0);
          return (
            <section key={sec.scope} className={styles.scope}>
              <h3 className={styles.heading}>
                <Spoken shown={sec.heading[voice]} said={sec.said} />
              </h3>
              <dl className={styles.keys}>
                {rows.map((r) => (
                  <Fragment key={r.caps.map((c) => c.shown).join(" ")}>
                    <dt>
                      <Caps caps={r.caps} />
                    </dt>
                    <dd>{r.does}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          );
        })}

        <ul className={styles.rules}>
          {rules.map((r) => (
            <li key={r.does}>{r.does}</li>
          ))}
          <li>{F_KEY_NOTE}.</li>
        </ul>

        <p className={styles.gpl} data-gpl>
          <span>Free software under the GPL-3.0</span>
          <span aria-hidden="true"> · </span>
          <a href={links.source.href}>{links.source.text}</a>
          <span aria-hidden="true"> · </span>
          <a href={links.license.href}>License</a>
        </p>
      </div>
    </div>
  );
}

// W-16 / S-9: the reset link lands on /account/reset-password?token=…&tenantId=public. The
// SDK reads the token from the location itself; this page asks for the new password only. A
// cold load from the email link waits for /api/health: until it answers there is no client.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GameStore, StoreView } from "../sync/store.js";
import {
  ACCOUNTS_OFF,
  Field,
  fieldErrorsOf,
  fieldSummary,
  FormError,
  useInvalidFocus,
  useRun,
  type FieldErrors,
} from "./AccountForms.js";
import { useAnnounce } from "./announce.js";
import { Guarded } from "./Guarded.js";
import styles from "./Settings.module.css";

const INVALID_TOKEN = "This link has expired or was already used. Ask for a new one.";
const UNAVAILABLE = "Couldn't reach the server. Try again.";

export function ResetPassword({
  store,
  view,
  onDone,
}: {
  store: Pick<GameStore, "submitNewPassword">;
  view: Pick<StoreView, "accounts">;
  /** "Sign in": back to the game, with the sheet open on the sign-in form. */
  onDone(): void;
}) {
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const { pending, run } = useRun();
  const announce = useAnnounce();
  const input = useRef<HTMLInputElement>(null);
  const focusInvalid = useInvalidFocus({ password: input });
  const headingId = useId();
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (changed) doneRef.current?.focus();
  }, [changed]);

  const checking = view.accounts === "unknown";
  const busy = pending || checking;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    run(
      () => store.submitNewPassword(password),
      (r) => {
        const errs = fieldErrorsOf(r);
        setFields(errs);
        if (r.ok) {
          setFormError(null);
          setChanged(true);
          announce("Password changed.");
          return;
        }
        const formError =
          r.kind === "invalid-token"
            ? INVALID_TOKEN
            : r.kind === "unavailable"
              ? UNAVAILABLE
              : null;
        setFormError(formError);
        const said = formError ?? fieldSummary(errs);
        if (said !== null) announce(said);
        focusInvalid(errs);
      },
    );
  };

  if (changed) {
    return (
      <main className={styles.page} data-reset="done">
        <p ref={doneRef} tabIndex={-1} className={styles.signedIn}>
          Password changed.
        </p>
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={onDone}>
            Sign in
          </button>
        </div>
      </main>
    );
  }

  if (view.accounts === "off") {
    return (
      <main className={styles.page} data-reset="off">
        <p className={styles.note}>{ACCOUNTS_OFF}</p>
      </main>
    );
  }

  return (
    <main className={styles.page} data-reset="form">
      <form aria-labelledby={headingId} className={styles.form} noValidate onSubmit={onSubmit}>
        <h2 id={headingId} className={styles.formTitle}>
          Choose a new password
        </h2>
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          inputRef={input}
        />
        {formError !== null && <FormError>{formError}</FormError>}
        {checking && <p className={styles.note}>Checking the server…</p>}
        <div className={styles.actions}>
          <Guarded submit off={busy} aria-busy={busy || undefined}>
            Change password
          </Guarded>
        </div>
      </form>
    </main>
  );
}

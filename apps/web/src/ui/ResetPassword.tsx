// W-16 / S-9: the reset link lands on /account/reset-password?token=…&tenantId=public. The
// SDK reads the token from the location itself; this page asks for the new password only.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GameStore } from "../sync/store.js";
import { Field, fieldErrorsOf, FormAlert, useRun, type FieldErrors } from "./AccountForms.js";
import { Guarded } from "./Guarded.js";
import styles from "./Settings.module.css";

const INVALID_TOKEN = "This link has expired or was already used. Ask for a new one.";
const UNAVAILABLE = "Couldn't reach the server. Try again.";

export function ResetPassword({
  store,
  onDone,
}: {
  store: Pick<GameStore, "submitNewPassword">;
  /** "Sign in": back to the game, with the sheet open on the sign-in form. */
  onDone(): void;
}) {
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const { pending, run } = useRun();
  const headingId = useId();
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (changed) doneRef.current?.focus();
  }, [changed]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    run(
      () => store.submitNewPassword(password),
      (r) => {
        setFields(fieldErrorsOf(r));
        if (r.ok) {
          setFormError(null);
          setChanged(true);
          return;
        }
        setFormError(
          r.kind === "invalid-token"
            ? INVALID_TOKEN
            : r.kind === "unavailable"
              ? UNAVAILABLE
              : null,
        );
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
        />
        {formError !== null && <FormAlert>{formError}</FormAlert>}
        <div className={styles.actions}>
          <Guarded submit off={pending} aria-busy={pending || undefined}>
            Change password
          </Guarded>
        </div>
      </form>
    </main>
  );
}

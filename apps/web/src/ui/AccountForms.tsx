// W-16 / S-11: the settings sheet's Account section. Sign-up, sign-in and forgot-password
// forms, or "Signed in" and Sign out. The forms call the store, never the account client;
// the store does the hold, the claim and the park (Task 3). Real <form>s with labelled inputs;
// a field error is described-by from its input, a form error is an alert.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { AuthField, AuthResult, ResetResult } from "../auth/accounts.js";
import { PARKED_GUEST_TOKEN_KEY } from "../sync/constants.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { useAnnounce } from "./announce.js";
import { Guarded } from "./Guarded.js";
import styles from "./Settings.module.css";

export type AccountMode = "sign-up" | "sign-in" | "forgot";

export const ACCOUNTS_OFF = "Accounts aren't enabled on this server.";
export const RESET_SENT = "If that email has an account, a reset link is on its way.";
const WRONG_CREDENTIALS = "That email and password don't match.";
const UNAVAILABLE = "Couldn't reach the server. Try again.";
const SIGN_OUT_FAILED = "Couldn't sign out. Try again.";
const PARKED_LINE = "A guest factory is kept on this device; signing out returns to it.";

export type FieldErrors = Partial<Record<AuthField, string>>;

export function fieldErrorsOf(r: AuthResult | ResetResult): FieldErrors {
  if (r.ok || r.kind !== "field") return {};
  const out: FieldErrors = {};
  for (const f of r.fields)
    out[f.id] = out[f.id] === undefined ? f.error : `${out[f.id]} ${f.error}`;
  return out;
}

/** A promise's pending flag that ignores a settle after unmount. */
export function useRun(): {
  pending: boolean;
  run<T>(p: () => Promise<T>, then: (v: T) => void): void;
} {
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return {
    pending,
    run(p, then) {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      const done = () => {
        busy.current = false;
        if (live.current) setPending(false);
      };
      p().then(
        (v) => {
          done();
          if (live.current) then(v);
        },
        (err: unknown) => {
          console.error(err);
          done();
        },
      );
    },
  };
}

/** A labelled input; its error, if any, is described-by from it. */
export function Field({
  label,
  type,
  autoComplete,
  value,
  onChange,
  error,
  inputRef,
}: {
  label: string;
  type: "email" | "password";
  autoComplete: string;
  value: string;
  onChange(v: string): void;
  error: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const errId = `${id}-error`;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        name={type}
        type={type}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errId}
      />
      {error !== undefined && (
        <p id={errId} className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  );
}

export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className={styles.formError}>
      {children}
    </p>
  );
}

function formErrorOf(r: AuthResult): string | null {
  if (r.ok) return null;
  switch (r.kind) {
    case "field":
      return null;
    case "wrong-credentials":
      return WRONG_CREDENTIALS;
    case "not-allowed":
      return r.reason;
    case "unavailable":
      return UNAVAILABLE;
  }
}

type AccountStore = Pick<GameStore, "signUp" | "signIn" | "signOut" | "sendReset">;

/** The parked guest token (S-6): the store's notice while it shows, else the key itself. */
function hasParkedGuest(view: StoreView): boolean {
  if (view.notices.some((n) => n.kind === "account-has-factory")) return true;
  try {
    return localStorage.getItem(PARKED_GUEST_TOKEN_KEY) !== null;
  } catch {
    return false;
  }
}

export function AccountSection({
  store,
  view,
  mode,
  onMode,
  focusFirst,
}: {
  store: AccountStore;
  view: StoreView;
  mode: AccountMode;
  onMode(m: AccountMode): void;
  /** Move focus to the form's first field on mount (the chip, or a mode switch). */
  focusFirst: boolean;
}) {
  // A mode switch unmounts the button that made it: the new form takes focus.
  const [switched, setSwitched] = useState(false);
  const go = (m: AccountMode) => {
    setSwitched(true);
    onMode(m);
  };
  const focus = focusFirst || switched;

  if (view.accounts === "off") return <p className={styles.note}>{ACCOUNTS_OFF}</p>;
  if (view.identity === "session") return <SignedIn store={store} view={view} />;
  if (view.accounts === "unknown" || view.identity === "unknown")
    return <p className={styles.note}>Checking the server…</p>;
  if (mode === "forgot")
    return <ForgotForm key="forgot" store={store} focus={focus} onBack={() => go("sign-in")} />;
  return (
    <SignForm
      key={mode}
      kind={mode}
      store={store}
      view={view}
      focus={focus}
      onSwitch={() => go(mode === "sign-up" ? "sign-in" : "sign-up")}
      onForgot={() => go("forgot")}
    />
  );
}

function SignForm({
  kind,
  store,
  view,
  focus,
  onSwitch,
  onForgot,
}: {
  kind: "sign-up" | "sign-in";
  store: AccountStore;
  view: StoreView;
  focus: boolean;
  onSwitch(): void;
  onForgot(): void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { pending, run } = useRun();
  const announce = useAnnounce();
  const first = useRef<HTMLInputElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (focus) first.current?.focus();
    // On mount only: a re-render must never pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = pending || view.auth !== "idle";
  const title = kind === "sign-up" ? "Create account" : "Sign in";
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    run(
      () => (kind === "sign-up" ? store.signUp(email, password) : store.signIn(email, password)),
      (r) => {
        setFields(fieldErrorsOf(r));
        setFormError(formErrorOf(r));
        if (r.ok) announce(r.email === "" ? "Signed in" : `Signed in as ${r.email}`);
      },
    );
  };

  return (
    <form aria-labelledby={headingId} className={styles.form} noValidate onSubmit={onSubmit}>
      <h3 id={headingId} className={styles.formTitle}>
        {title}
      </h3>
      {kind === "sign-up" && (
        <p className={styles.note}>Save this factory to an account and play it anywhere.</p>
      )}
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error={fields.email}
        inputRef={first}
      />
      <Field
        label="Password"
        type="password"
        autoComplete={kind === "sign-up" ? "new-password" : "current-password"}
        value={password}
        onChange={setPassword}
        error={fields.password}
      />
      {formError !== null && <FormAlert>{formError}</FormAlert>}
      <div className={styles.actions}>
        <Guarded submit off={busy} aria-busy={busy || undefined}>
          {title}
        </Guarded>
        {kind === "sign-in" && (
          <button type="button" className="btn secondary" onClick={onForgot}>
            Forgot password?
          </button>
        )}
      </div>
      <p className={styles.switch}>
        {kind === "sign-up" ? "Already have an account? " : "New here? "}
        <button type="button" className={`btn secondary ${styles.linkish}`} onClick={onSwitch}>
          {kind === "sign-up" ? "Sign in instead" : "Create an account instead"}
        </button>
      </p>
    </form>
  );
}

function ForgotForm({
  store,
  focus,
  onBack,
}: {
  store: AccountStore;
  focus: boolean;
  onBack(): void;
}) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { pending, run } = useRun();
  const announce = useAnnounce();
  const first = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (focus) first.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (sent) done.current?.focus();
  }, [sent]);

  // Whatever the server says (sent, unknown, unreachable), the answer is the same: it never
  // tells whether an email has an account.
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    run(
      () => store.sendReset(email),
      () => {
        setSent(true);
        announce(RESET_SENT);
      },
    );
  };

  return (
    <form aria-labelledby={headingId} className={styles.form} noValidate onSubmit={onSubmit}>
      <h3 id={headingId} className={styles.formTitle}>
        Reset password
      </h3>
      {sent ? (
        <>
          <p ref={done} tabIndex={-1} className={styles.note}>
            {RESET_SENT}
          </p>
          <div className={styles.actions}>
            <button type="button" className="btn secondary" onClick={() => setSent(false)}>
              Send another
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.note}>We'll email you a link to choose a new password.</p>
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            error={undefined}
            inputRef={first}
          />
          <div className={styles.actions}>
            <Guarded submit off={pending} aria-busy={pending || undefined}>
              Send reset link
            </Guarded>
          </div>
        </>
      )}
      <p className={styles.switch}>
        <button type="button" className={`btn secondary ${styles.linkish}`} onClick={onBack}>
          Back to sign in
        </button>
      </p>
    </form>
  );
}

function SignedIn({ store, view }: { store: AccountStore; view: StoreView }) {
  const { pending, run } = useRun();
  const [failed, setFailed] = useState(false);
  const busy = pending || view.auth !== "idle";
  const email = view.account?.email ?? null;
  return (
    <div className={styles.form}>
      <p className={styles.signedIn}>{email === null ? "Signed in" : `Signed in as ${email}`}</p>
      {hasParkedGuest(view) && <p className={styles.note}>{PARKED_LINE}</p>}
      {failed && <FormAlert>{SIGN_OUT_FAILED}</FormAlert>}
      <div className={styles.actions}>
        <Guarded
          className="btn secondary"
          off={busy}
          aria-busy={busy || undefined}
          onPress={() => {
            setFailed(false);
            run(
              () => store.signOut(),
              (ok) => setFailed(!ok),
            );
          }}
        >
          Sign out
        </Guarded>
      </div>
    </div>
  );
}

// W-16 / S-11 / O-18: the settings sheet's Account section. One button per sign-in provider,
// or "Signed in" and Sign out. The buttons call the store, never the account client: the
// store drains the outbox and leaves the page for the provider (O-5), and the callback page
// does the rest (O-6). W-20: one polite live region for the page, so a refusal is announced
// through the shared announcer, never with a role="alert" of its own.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { providerName } from "../auth/accounts.js";
import type { BeginResult, GameStore, StoreView } from "../sync/store.js";
import { useAnnounce } from "./announce.js";
import { Guarded } from "./Guarded.js";
import styles from "./Settings.module.css";
import { useTheme } from "./theme.js";

export const ACCOUNTS_OFF = "Accounts aren't enabled on this server.";
const SIGN_IN_UNAVAILABLE = "Sign-in isn't available right now.";
const SIGN_IN_NOTE =
  "Save this factory to an account and play it anywhere. Signing in the first time creates the account.";
const SIGN_OUT_FAILED = "Couldn't sign out. Try again.";
const PARKED_LINE = "A guest factory is kept on this device; signing out returns to it.";

/** O-10: beginSignIn's refusals, as the form error says them. */
function refusalText(provider: string, r: BeginResult): string | null {
  if (r.ok) return null;
  switch (r.kind) {
    case "unsaved":
      return "Your last actions haven't reached the server yet. Try again in a moment.";
    case "storage":
      return `This browser isn't saving your factory, so it would be lost on the way to ${providerName(provider)}. Allow this site to store data, then try again.`;
    case "unavailable":
      return "Couldn't reach the server. Try again.";
    case "not-allowed":
      return r.reason;
  }
}

/** O-9: who this device saw sign in. */
function signedInLine(account: StoreView["account"]): string {
  const provider = account?.provider ?? null;
  const email = account?.email ?? null;
  const via = provider === null ? "" : ` with ${providerName(provider)}`;
  return email === null ? `Signed in${via}` : `Signed in${via} as ${email}`;
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

/** A form-level error: shown here, announced by whoever sets it (W-20: no second region). */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p className={styles.formError} data-form-error>
      {children}
    </p>
  );
}

type AccountStore = Pick<GameStore, "beginSignIn" | "signOut">;

export function AccountSection({
  store,
  view,
  focusFirst,
}: {
  store: AccountStore;
  view: StoreView;
  /** Move focus to the first provider button on mount (the chip). */
  focusFirst: boolean;
}) {
  // Buttons that mount because the player signed out take no focus (the sheet's title does);
  // ones opened at Account do. `was` still holds the identity before this commit's flip.
  const was = useRef(view.identity);
  useEffect(() => {
    was.current = view.identity;
  }, [view.identity]);
  const focus = focusFirst && was.current === view.identity;

  if (view.accounts === "off") return <p className={styles.note}>{ACCOUNTS_OFF}</p>;
  if (view.identity === "session") return <SignedIn store={store} view={view} />;
  if (view.accounts === "unknown" || view.identity === "unknown")
    return <p className={styles.note}>Checking the server…</p>;
  if (view.providers.length === 0)
    return (
      <p className={styles.note} data-signin-unavailable>
        {SIGN_IN_UNAVAILABLE}
      </p>
    );
  return <ProviderButtons store={store} view={view} focus={focus} />;
}

function ProviderButtons({
  store,
  view,
  focus,
}: {
  store: AccountStore;
  view: StoreView;
  focus: boolean;
}) {
  const { pending, run } = useRun();
  const [formError, setFormError] = useState<string | null>(null);
  const announce = useAnnounce();
  const { applied } = useTheme();
  const shell = applied.voice === "shell";
  const group = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (focus) group.current?.querySelector<HTMLButtonElement>("[data-provider]")?.focus();
    // On mount only: a re-render must never pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const off = pending || view.leaving !== null || view.auth !== "idle";
  const begin = (id: string) => {
    setFormError(null);
    run(
      () => store.beginSignIn(id),
      (r) => {
        // { ok: true }: the page is leaving, so there is nothing to say.
        const text = refusalText(id, r);
        setFormError(text);
        if (text !== null) announce(text);
      },
    );
  };

  return (
    <div className={styles.form}>
      <h4 id={headingId} className={styles.formTitle}>
        Sign in
      </h4>
      <p className={styles.note}>{SIGN_IN_NOTE}</p>
      <div ref={group} role="group" aria-labelledby={headingId} className={styles.providers}>
        {view.providers.map((id) => {
          const name = providerName(id);
          const opening = view.leaving === id;
          return (
            <Guarded
              key={id}
              className={`btn secondary ${styles.provider}`}
              off={off}
              aria-label={`Sign in with ${name}`}
              aria-busy={opening || undefined}
              data-provider={id}
              onPress={() => begin(id)}
            >
              {opening ? `Opening ${name}…` : shell ? `> login --${id}` : `Sign in with ${name}`}
            </Guarded>
          );
        })}
      </div>
      {formError !== null && <FormError>{formError}</FormError>}
    </div>
  );
}

function SignedIn({ store, view }: { store: AccountStore; view: StoreView }) {
  const { pending, run } = useRun();
  const [failed, setFailed] = useState(false);
  const announce = useAnnounce();
  const busy = pending || view.auth !== "idle";
  return (
    <div className={styles.form}>
      <p className={styles.signedIn} data-signed-in>
        {signedInLine(view.account)}
      </p>
      {view.parked && <p className={styles.note}>{PARKED_LINE}</p>}
      {failed && <FormError>{SIGN_OUT_FAILED}</FormError>}
      <div className={styles.actions}>
        <Guarded
          className="btn secondary"
          off={busy}
          aria-busy={busy || undefined}
          onPress={() => {
            setFailed(false);
            run(
              () => store.signOut(),
              (ok) => {
                setFailed(!ok);
                if (!ok) announce(SIGN_OUT_FAILED);
              },
            );
          }}
        >
          Sign out
        </Guarded>
      </div>
    </div>
  );
}

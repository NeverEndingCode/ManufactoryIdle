// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { format, liquidCap } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthResult, ResetResult } from "../auth/accounts.js";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { setNotation } from "./notation.js";
import { setTheme, THEME_KEY } from "./theme.js";
import {
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";

let slice: Slice;
let fresh: Snapshot;
let tier8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    setNotation("hybrid");
    setTheme("system");
  });
  localStorage.clear();
  history.replaceState(null, "", "/");
});

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

const settingsButton = () => screen.getByRole("button", { name: "Settings" });

function openSettings(): HTMLElement {
  fireEvent.click(settingsButton());
  return screen.getByRole("dialog", { name: "Settings" });
}

/** Lets the mocks' promises settle and React commit what they set. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function fill(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
}

describe("Settings (S-11)", () => {
  it("1. a modal dialog: focus moves in, Escape closes it, focus returns to the opener", () => {
    const { container } = mount(fakeStore(fresh));
    const opener = settingsButton();
    opener.focus();
    const dialog = openSettings();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The background is inert while the sheet is open.
    expect(container.querySelector("header")!.closest("[inert]")).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("1b. the Close button closes it too, and returns focus", () => {
    mount(fakeStore(fresh));
    const dialog = openSettings();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(settingsButton());
  });

  it("2. Scientific re-renders the rows without a new snapshot", () => {
    const store = fakeStore(tier8);
    const { container } = mount(store);
    const row = () => container.querySelector<HTMLElement>('[data-item="iron_plate"]')!;
    const stock = () => row().querySelector("[data-stock]")!.textContent;
    const at = () => serverNow(tier8, store.now());
    const cap = liquidCap(slice.content, tier8.state, "iron_plate");
    expect(stock()).toBe(format(shownStock(tier8, "iron_plate", at()), "hybrid"));
    expect(row().textContent).toContain(`/ ${format(cap, "hybrid")}`);

    const dialog = openSettings();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Scientific" }));
    expect(within(dialog).getByRole("radio", { name: "Scientific" })).toHaveProperty(
      "checked",
      true,
    );
    const sci = format(shownStock(tier8, "iron_plate", at()), "sci");
    expect(sci).not.toBe(format(shownStock(tier8, "iron_plate", at()), "hybrid"));
    expect(stock()).toBe(sci);
    // laneRows' cap text, memoised per snapshot, follows too.
    expect(row().textContent).toContain(`/ ${format(cap, "sci")}`);
    expect(localStorage.getItem("mi.notation")).toBe("sci");
  });

  it("3. Light sets data-theme and stores it; System removes it", () => {
    mount(fakeStore(fresh));
    const dialog = openSettings();
    const html = document.documentElement;
    expect(within(dialog).getByRole("radio", { name: "System" })).toHaveProperty("checked", true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Light" }));
    expect(html.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
    expect(html.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(within(dialog).getByRole("radio", { name: "System" }));
    expect(html.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
  });

  it("4. accounts off: the Account section says so and has no form", () => {
    mount(fakeStore(fresh));
    const dialog = openSettings();
    expect(within(dialog).getByText("Accounts aren't enabled on this server.")).toBeTruthy();
    expect(dialog.querySelector("form")).toBeNull();
    expect(dialog.querySelector("input[type=email], input[type=password]")).toBeNull();
  });

  it("5. sign-up and sign-in: the call, field errors, a form alert, and the busy submit", async () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on" });
    mount(store);
    const dialog = openSettings();
    const signUp = within(dialog).getByRole("form", { name: "Create account" });
    const email = within(signUp).getByLabelText<HTMLInputElement>("Email");
    const password = within(signUp).getByLabelText<HTMLInputElement>("Password");
    expect(email.type).toBe("email");
    expect(email.autocomplete).toBe("email");
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("new-password");

    store.signUp.mockResolvedValueOnce({
      ok: false,
      kind: "field",
      fields: [
        { id: "email", error: "This email already exists. Please sign in instead." },
        { id: "password", error: "Password must contain at least one number" },
      ],
    } satisfies AuthResult);
    fill(signUp, "Email", "a@x.example");
    fill(signUp, "Password", "password1");
    fireEvent.click(within(signUp).getByRole("button", { name: "Create account" }));
    expect(store.signUp).toHaveBeenCalledTimes(1);
    expect(store.signUp).toHaveBeenCalledWith("a@x.example", "password1");
    await settle();
    const described = (input: HTMLElement) =>
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(described(email)).toContain("This email already exists. Please sign in instead.");
    expect(described(password)).toContain("Password must contain at least one number");
    expect(email.getAttribute("aria-invalid")).toBe("true");

    // Pending: the submit is aria-disabled until the promise settles, and a second press is a
    // no-op.
    store.signUp.mockImplementationOnce(() => never());
    const submit = within(signUp).getByRole("button", { name: "Create account" });
    fireEvent.click(submit);
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    fireEvent.submit(signUp);
    expect(store.signUp).toHaveBeenCalledTimes(2);

    // Sign-in: wrong credentials are a form-level alert.
    cleanup();
    mount(store);
    const d2 = openSettings();
    fireEvent.click(within(d2).getByRole("button", { name: "Sign in instead" }));
    const signIn = within(d2).getByRole("form", { name: "Sign in" });
    expect(within(signIn).getByLabelText<HTMLInputElement>("Password").autocomplete).toBe(
      "current-password",
    );
    store.signIn.mockResolvedValueOnce({ ok: false, kind: "wrong-credentials" });
    fill(signIn, "Email", "a@x.example");
    fill(signIn, "Password", "nope12345");
    fireEvent.click(within(signIn).getByRole("button", { name: "Sign in" }));
    await settle();
    expect(store.signIn).toHaveBeenCalledWith("a@x.example", "nope12345");
    expect(within(signIn).getByRole("alert").textContent).toBe(
      "That email and password don't match.",
    );

    // The store deciding (held, claiming) keeps the submit busy too.
    store.set({ auth: "held" });
    expect(
      within(signIn).getByRole("button", { name: "Sign in" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("6. signed in: the email, Sign out, and the parked-guest line", async () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on", identity: "session", account: { email: "a@x.example" } });
    mount(store);
    let dialog = openSettings();
    expect(within(dialog).getByText("Signed in as a@x.example")).toBeTruthy();
    expect(dialog.querySelector("form")).toBeNull();
    expect(within(dialog).queryByText(/A guest factory is kept/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(store.signOut).toHaveBeenCalledTimes(1);
    await settle();

    // A boot that found the session: no email. A parked token adds its line. A failed sign-out
    // says so.
    store.set({
      account: { email: null },
      notices: [{ kind: "account-has-factory", text: "This account already has a factory." }],
    });
    cleanup();
    mount(store);
    dialog = openSettings();
    expect(within(dialog).getByText("Signed in")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "A guest factory is kept on this device; signing out returns to it.",
      ),
    ).toBeTruthy();
    store.signOut.mockResolvedValueOnce(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await settle();
    expect(within(dialog).getByRole("alert").textContent).toBe("Couldn't sign out. Try again.");
  });

  it("7. the chip: accounts on, a guest, tier 1 or more; it opens the sign-up form", () => {
    const chip = () => screen.queryByRole("button", { name: "Save your factory" });
    const at = (s: Snapshot, patch: Parameters<FakeStore["set"]>[0]) => {
      cleanup();
      const store = fakeStore(s);
      store.set(patch);
      mount(store);
    };
    at(fresh, { accounts: "on" });
    expect(fresh.state.tier).toBe(0);
    expect(chip()).toBeNull();
    at(tier8, { accounts: "on", identity: "session", account: { email: null } });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "off" });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "unknown" });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "on" });
    expect(chip()).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(chip()!);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const form = within(dialog).getByRole("form", { name: "Create account" });
    expect(form.contains(document.activeElement)).toBe(true);
  });

  it("7b. a tier-1 world shows the chip", () => {
    const store = fakeStore(snapshotOf(slice, { ...freshState(slice), tier: 1 }));
    store.set({ accounts: "on" });
    mount(store);
    expect(screen.getByRole("button", { name: "Save your factory" })).toBeTruthy();
  });

  it("8. Forgot password sends the reset and always answers the same", async () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on" });
    mount(store);
    const dialog = openSettings();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in instead" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Forgot password?" }));
    const form = within(dialog).getByRole("form", { name: "Reset password" });
    expect(form.querySelector("input[type=password]")).toBeNull();
    const GENERIC = "If that email has an account, a reset link is on its way.";

    for (const result of [
      { ok: true },
      { ok: false, kind: "unavailable" },
      { ok: false, kind: "field", fields: [{ id: "email", error: "Email is invalid" }] },
    ] satisfies ResetResult[]) {
      store.sendReset.mockResolvedValueOnce(result);
      const f = within(dialog).getByRole("form", { name: "Reset password" });
      fill(f, "Email", "a@x.example");
      fireEvent.click(within(f).getByRole("button", { name: "Send reset link" }));
      await settle();
      expect(within(dialog).getByText(GENERIC)).toBeTruthy();
      expect(within(dialog).queryByText("Email is invalid")).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Send another" }));
    }
    expect(store.sendReset).toHaveBeenCalledTimes(3);
    expect(store.sendReset).toHaveBeenCalledWith("a@x.example");
  });

  it("9. /account/reset-password: submit, invalid-token, then Password changed and Sign in", async () => {
    history.replaceState(null, "", "/account/reset-password?token=t");
    const store = fakeStore(fresh);
    store.set({ accounts: "on" });
    const { container } = mount(store);
    expect(container.querySelector("header")).not.toBeNull();
    expect(screen.queryByRole("tablist", { name: "Lanes" })).toBeNull();
    const form = screen.getByRole("form", { name: "Choose a new password" });
    const input = within(form).getByLabelText<HTMLInputElement>("New password");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");

    store.submitNewPassword.mockResolvedValueOnce({ ok: false, kind: "invalid-token" });
    fill(form, "New password", "password2");
    fireEvent.click(within(form).getByRole("button", { name: "Change password" }));
    expect(store.submitNewPassword).toHaveBeenCalledWith("password2");
    await settle();
    expect(within(form).getByRole("alert").textContent).toBe(
      "This link has expired or was already used. Ask for a new one.",
    );

    store.submitNewPassword.mockResolvedValueOnce({
      ok: false,
      kind: "field",
      fields: [{ id: "password", error: "Password must contain at least 8 characters" }],
    });
    fireEvent.click(within(form).getByRole("button", { name: "Change password" }));
    await settle();
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(
      "Password must contain at least 8 characters",
    );

    fireEvent.click(within(form).getByRole("button", { name: "Change password" }));
    await settle();
    expect(store.submitNewPassword).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Password changed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(location.pathname).toBe("/");
    expect(location.search).toBe("");
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("form", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Lanes" })).toBeTruthy();
  });
});

describe("the header", () => {
  it("keeps the full name as the title's label, with the initials for narrow widths", () => {
    mount(fakeStore(fresh));
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.getAttribute("aria-label")).toBe("Manufactory Idle");
    expect(h1.textContent).toContain("MI");
    expect(screen.getByRole("button", { name: "Handbook" })).toBeTruthy();
  });
});

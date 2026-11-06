// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { format, liquidCap } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { BeginResult, GameStore } from "../sync/store.js";
import userEvent from "@testing-library/user-event";
import { App } from "./App.js";
import { setNotation } from "./notation.js";
import { setTheme, THEME_KEY, THEMES } from "./theme.js";
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
    setTheme("terminal");
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

/** The shared region's latest announcement (W-20). */
const announced = () => document.querySelector("[data-announce]")?.textContent ?? null;
/** Every live region on the page; W-20 allows exactly one. */
const liveRegions = () =>
  document.querySelectorAll('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])');

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** The Account section's provider buttons, in order. */
const providerButtons = (scope: HTMLElement) => [
  ...scope.querySelectorAll<HTMLButtonElement>("[data-provider]"),
];

describe("Settings (S-11)", { timeout: 60_000 }, () => {
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

  it("3. the Theme list: six themes with swatches; Clean (Light) applies and stores", () => {
    mount(fakeStore(fresh));
    const dialog = openSettings();
    const html = document.documentElement;
    const group = within(dialog).getByRole("group", { name: "Theme" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("data-theme-choice"))).toEqual(THEMES.map((t) => t.id));
    expect(radios.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(
      THEMES.map((t) => t.name),
    );
    // Each entry has a three-chip swatch from the registry, not from applying the theme.
    for (const t of THEMES) {
      const swatch = group.querySelector(`[data-swatch="${t.id}"]`)!;
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
      const chips = [...swatch.children].map((c) => (c as HTMLElement).style.background);
      expect(chips).toHaveLength(3);
      const probe = document.createElement("span");
      const css = (v: string) => ((probe.style.background = v), probe.style.background);
      expect(chips).toEqual([css(t.swatch.bg), css(t.swatch.body), css(t.swatch.advice)]);
    }
    expect(within(group).getByRole("radio", { name: "Retro terminal" })).toHaveProperty(
      "checked",
      true,
    );
    fireEvent.click(within(group).getByRole("radio", { name: "Clean (Light)" }));
    expect(html.getAttribute("data-theme")).toBe("clean-light");
    expect(localStorage.getItem(THEME_KEY)).toBe("clean-light");
    expect(within(group).getByRole("radio", { name: "Clean (Light)" })).toHaveProperty(
      "checked",
      true,
    );
    fireEvent.click(within(group).getByRole("radio", { name: "Retro terminal" }));
    expect(html.getAttribute("data-theme")).toBe("terminal");
  });

  it("3b. a locked theme is listed, focusable and described, and picking it does nothing", () => {
    mount(fakeStore(fresh));
    const dialog = openSettings();
    const html = document.documentElement;
    const group = within(dialog).getByRole("group", { name: "Theme" });
    fireEvent.click(within(group).getByRole("radio", { name: "Clean (Dark)" }));
    expect(html.getAttribute("data-theme")).toBe("clean-dark");

    for (const name of ["Cosy", "Industrial"]) {
      const radio = within(group).getByRole("radio", { name });
      expect(radio.getAttribute("aria-disabled")).toBe("true");
      expect((radio as HTMLInputElement).disabled).toBe(false);
      radio.focus();
      expect(document.activeElement).toBe(radio);
      const described = document.getElementById(radio.getAttribute("aria-describedby")!)!;
      expect(described.textContent).toBe("Unlocks in the prestige store");
      const option = radio.closest("[data-theme-option]")!;
      expect(option.querySelector("[data-locked]")!.textContent).toBe("locked");

      fireEvent.click(radio);
      expect(radio).toHaveProperty("checked", false);
      expect(html.getAttribute("data-theme")).toBe("clean-dark");
      expect(localStorage.getItem(THEME_KEY)).toBe("clean-dark");
      expect(within(group).getByRole("radio", { name: "Clean (Dark)" })).toHaveProperty(
        "checked",
        true,
      );
    }
    // The free themes carry no tag and no description.
    const free = within(group).getByRole("radio", { name: "Clean (OLED Dark)" });
    expect(free.hasAttribute("aria-disabled")).toBe(false);
    expect(free.closest("[data-theme-option]")!.querySelector("[data-locked]")).toBeNull();
  });

  it("4. accounts off: the Account section says so and has no buttons", () => {
    mount(fakeStore(fresh));
    const dialog = openSettings();
    expect(within(dialog).getByText("Accounts aren't enabled on this server.")).toBeTruthy();
    expect(providerButtons(dialog)).toEqual([]);
    expect(dialog.querySelector("[data-account]")!.querySelector("form, input, button")).toBeNull();
  });

  it("5a. accounts on with no provider: sign-in isn't available, and no buttons", () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on", providers: [] });
    mount(store);
    const dialog = openSettings();
    const line = dialog.querySelector("[data-signin-unavailable]")!;
    expect(line.textContent).toBe("Sign-in isn't available right now.");
    expect(providerButtons(dialog)).toEqual([]);
  });

  it("5b. one button per provider, in order, in the theme's voice; a click begins once (O-18)", () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on", providers: ["discord", "github"] });
    mount(store);
    let dialog = openSettings();
    const group = within(dialog).getByRole("group", { name: "Sign in" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.getAttribute("data-provider")),
    ).toEqual(["discord", "github"]);
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Sign in with Discord", "Sign in with GitHub"]);
    expect(
      within(dialog).getByText(
        "Save this factory to an account and play it anywhere. Signing in the first time creates the account.",
      ),
    ).toBeTruthy();
    // Terminal: the shell voice.
    expect(providerButtons(dialog).map((b) => b.textContent)).toEqual([
      "> login --discord",
      "> login --github",
    ]);
    act(() => void setTheme("clean-dark"));
    expect(providerButtons(dialog).map((b) => b.textContent)).toEqual([
      "Sign in with Discord",
      "Sign in with GitHub",
    ]);

    store.beginSignIn.mockImplementationOnce(() => never());
    const discord = within(dialog).getByRole("button", { name: "Sign in with Discord" });
    fireEvent.click(discord);
    expect(store.beginSignIn).toHaveBeenCalledTimes(1);
    expect(store.beginSignIn).toHaveBeenCalledWith("discord");
    fireEvent.click(discord);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in with GitHub" }));
    expect(store.beginSignIn).toHaveBeenCalledTimes(1);

    // An id with no display name renders as itself (O-2).
    cleanup();
    store.set({ providers: ["gitlab"] });
    mount(store);
    dialog = openSettings();
    const gitlab = within(dialog).getByRole("button", { name: "Sign in with gitlab" });
    expect(gitlab.textContent).toBe("Sign in with gitlab");
  });

  it("5c. a refusal is a form error, announced once in the one region (O-10)", async () => {
    const cases: [BeginResult, string][] = [
      [
        { ok: false, kind: "unsaved" },
        "Your last actions haven't reached the server yet. Try again in a moment.",
      ],
      [
        { ok: false, kind: "storage" },
        "This browser isn't saving your factory, so it would be lost on the way to Discord. Allow this site to store data, then try again.",
      ],
      [{ ok: false, kind: "unavailable" }, "Couldn't reach the server. Try again."],
      [{ ok: false, kind: "not-allowed", reason: "Accounts are paused." }, "Accounts are paused."],
    ];
    for (const [result, text] of cases) {
      cleanup();
      const store = fakeStore(fresh);
      store.set({ accounts: "on", providers: ["discord", "github"] });
      store.beginSignIn.mockResolvedValueOnce(result);
      mount(store);
      const dialog = openSettings();
      fireEvent.click(within(dialog).getByRole("button", { name: "Sign in with Discord" }));
      await settle();
      expect(dialog.querySelector("[data-form-error]")!.textContent).toBe(text);
      const said = document.querySelector("[data-announce]");
      expect(said?.textContent).toBe(text);
      await settle();
      // Once: a second announcement would re-key the node (Notices keys it by seq).
      expect(document.querySelector("[data-announce]")).toBe(said);
      expect(liveRegions()).toHaveLength(1);
    }
  });

  it("5d. leaving: every button is off, and the chosen one reads Opening… (O-11)", () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on", providers: ["discord", "github"], leaving: "github" });
    mount(store);
    const dialog = openSettings();
    const [discord, github] = providerButtons(dialog);
    expect(discord!.getAttribute("aria-disabled")).toBe("true");
    expect(github!.getAttribute("aria-disabled")).toBe("true");
    expect(github!.textContent).toBe("Opening GitHub…");
    expect(github!.getAttribute("aria-busy")).toBe("true");
    expect(discord!.hasAttribute("aria-busy")).toBe(false);
    expect(github!.getAttribute("aria-label")).toBe("Sign in with GitHub");
    fireEvent.click(discord!);
    expect(store.beginSignIn).not.toHaveBeenCalled();
    store.set({ leaving: null });
    expect(discord!.getAttribute("aria-disabled")).toBe("false");
    expect(github!.textContent).toBe("> login --github");
  });

  it("6. signed in: the provider and email, Sign out, and the parked-guest line (O-9)", async () => {
    const store = fakeStore(fresh);
    const signedIn = (account: { provider: string | null; email: string | null }) => {
      cleanup();
      store.set({ accounts: "on", identity: "session", account, providers: ["discord"] });
      mount(store);
      return openSettings();
    };
    let dialog = signedIn({ provider: "discord", email: "a@x" });
    expect(dialog.querySelector("[data-signed-in]")!.textContent).toBe(
      "Signed in with Discord as a@x",
    );
    expect(providerButtons(dialog)).toEqual([]);
    expect(within(dialog).queryByText(/A guest factory is kept/)).toBeNull();
    dialog = signedIn({ provider: "github", email: null });
    expect(dialog.querySelector("[data-signed-in]")!.textContent).toBe("Signed in with GitHub");
    dialog = signedIn({ provider: null, email: null });
    expect(dialog.querySelector("[data-signed-in]")!.textContent).toBe("Signed in");
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    expect(store.signOut).toHaveBeenCalledTimes(1);
    await settle();

    // A parked token adds its line, from view.parked alone: here the park is only in memory
    // (no notice, nothing in localStorage). A failed sign-out says so.
    expect(localStorage.getItem("mi.parkedGuestToken")).toBeNull();
    store.set({ notices: [], parked: true });
    dialog = signedIn({ provider: null, email: null });
    expect(
      within(dialog).getByText(
        "A guest factory is kept on this device; signing out returns to it.",
      ),
    ).toBeTruthy();
    store.signOut.mockResolvedValueOnce(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await settle();
    expect(dialog.querySelector("[data-form-error]")!.textContent).toBe(
      "Couldn't sign out. Try again.",
    );
    expect(announced()).toBe("Couldn't sign out. Try again.");
    expect(liveRegions()).toHaveLength(1);
  });

  it("7. the chip: accounts on, a provider, a guest, tier 1 or more; it opens at the first provider (O-13)", () => {
    const chip = () => screen.queryByRole("button", { name: "Save your factory" });
    const at = (s: Snapshot, patch: Parameters<FakeStore["set"]>[0]) => {
      cleanup();
      const store = fakeStore(s);
      store.set({ providers: ["github", "discord"], ...patch });
      mount(store);
    };
    at(fresh, { accounts: "on" });
    expect(fresh.state.tier).toBe(0);
    expect(chip()).toBeNull();
    at(tier8, { accounts: "on", identity: "session", account: { provider: null, email: null } });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "off" });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "unknown" });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "on", providers: [] });
    expect(chip()).toBeNull();
    at(tier8, { accounts: "on" });
    expect(chip()).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(chip()!);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Sign in with GitHub" }),
    );
  });

  it("7b. a tier-1 world with a provider shows the chip; with none it doesn't", () => {
    const store = fakeStore(snapshotOf(slice, { ...freshState(slice), tier: 1 }));
    store.set({ accounts: "on", providers: [] });
    mount(store);
    expect(screen.queryByRole("button", { name: "Save your factory" })).toBeNull();
    store.set({ providers: ["github"] });
    expect(screen.getByRole("button", { name: "Save your factory" })).toBeTruthy();
  });
});

describe("Fix round 1", { timeout: 60_000 }, () => {
  it("10. the trap: notice controls behind the sheet are inert, Shift+Tab stays in, the region still speaks", async () => {
    const user = userEvent.setup();
    const store = fakeStore(fresh);
    store.set({
      accounts: "on",
      providers: ["discord"],
      notices: [{ kind: "rejected", text: "That didn't go through." }],
    });
    mount(store);
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    const dialog = openSettings();
    const title = within(dialog).getByRole("heading", { name: "Settings" });
    expect(document.activeElement).toBe(title);
    expect(dismiss.hasAttribute("inert")).toBe(true);
    const region = document.querySelector('[role="status"]')!;
    expect(region.closest("[inert]")).toBeNull();
    expect(region.hasAttribute("inert")).toBe(false);

    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(dismiss);
    // And forward past the last control wraps to the first.
    const last = document.activeElement as HTMLElement;
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);

    // A notice button that appears while the sheet is open is covered too.
    store.set({
      notices: [
        { kind: "rejected", text: "That didn't go through." },
        { kind: "guest-expired", text: "Gone." },
      ],
    });
    expect(screen.getByRole("button", { name: "Start a new factory" }).hasAttribute("inert")).toBe(
      true,
    );

    // The sheet's announcements reach the shared region.
    store.beginSignIn.mockResolvedValueOnce({ ok: false, kind: "unavailable" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in with Discord" }));
    await settle();
    expect(region.querySelector("[data-announce]")?.textContent).toBe(
      "Couldn't reach the server. Try again.",
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dismiss.hasAttribute("inert")).toBe(false);
  });

  it("11. Escape listens on the document: it closes the sheet with focus on <body>", () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on", providers: ["discord"] });
    mount(store);
    openSettings();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(settingsButton());
  });

  it("12. focus never falls to <body> when the Account section swaps", () => {
    const store = fakeStore(fresh);
    store.set({ accounts: "on", providers: ["discord"] });
    mount(store);
    const dialog = openSettings();
    const heading = () => within(dialog).getByRole("heading", { name: "Settings" });

    // A guest whose session appears (a boot finishing) loses the focused provider button.
    const button = within(dialog).getByRole("button", { name: "Sign in with Discord" });
    button.focus();
    store.set({ identity: "session", account: { provider: "discord", email: null } });
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(heading());

    // Signed in, then out: the Sign out button unmounts; the title takes focus, not the
    // first provider button (the sheet wasn't opened at Account).
    const out = within(dialog).getByRole("button", { name: "Sign out" });
    out.focus();
    store.set({ identity: "guest", account: null });
    expect(out.isConnected).toBe(false);
    expect(document.activeElement).toBe(heading());
  });

  it("14. the callback route shows only the loading line; a popstate to / brings the game back", () => {
    history.replaceState(null, "", "/account/callback/github?code=c&state=s");
    const store = fakeStore(tier8);
    store.set({ accounts: "on", providers: ["github"] });
    const { container } = mount(store);
    const app = () => container.querySelector<HTMLElement>(".app")!;
    expect(app().dataset.route).toBe("callback");
    expect(screen.getByText("Signing in…").className).toBe("app-loading");
    expect(screen.queryByRole("tablist", { name: "Lanes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save your factory" })).toBeNull();
    expect(location.pathname + location.search).toBe("/account/callback/github?code=c&state=s");
    act(() => {
      history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(app().dataset.route).toBe("game");
    expect(screen.getByRole("tablist", { name: "Lanes" })).toBeTruthy();
    expect(screen.queryByText("Signing in…")).toBeNull();
  });
});

describe("the header", { timeout: 60_000 }, () => {
  it("keeps the full name as the title's label; the visible title is hidden from it (U-2)", () => {
    mount(fakeStore(fresh));
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.getAttribute("aria-label")).toBe("Manufactory Idle");
    expect(h1.textContent).toBe("MANUFACTORY_");
    expect(h1.querySelector("span")!.getAttribute("aria-hidden")).toBe("true");
    // The handbook is the F3 tab, not a header button.
    expect(screen.getByRole("tab", { name: "handbook" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Handbook" })).toBeNull();
  });
});

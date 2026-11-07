// UI-2 (U-7, K-2, K-4, K-6, K-10, K-19, K-21): the keyboard on the fine-pointer desktop, in a
// real browser. Each key is checked by what it does to the DOM, the store's state version or the
// request log; every wait is on one of those (P-9). The one long wait is real time for the first
// buy to become affordable (P-10), as guest-buy.
import { expect, test, type Page } from "@playwright/test";
import { actionPosts, startGuest } from "./helpers.js";

test.use({ viewport: { width: 1280, height: 820 } });

const focused = (page: Page) => page.locator("*:focus");
const search = (page: Page) => page.locator("[data-handbook-search]");

test.describe("the keyboard", () => {
  // Two real-time waits for affordability (120 s and 60 s) on top of the steps.
  test.describe.configure({ timeout: 200_000 });
  test("every key does what the help says, and typing triggers nothing", async ({ page }) => {
    const posts = actionPosts(page);
    const { root } = await startGuest(page);
    const rows = page.locator('[role="listbox"][data-rows]');
    const version = async () => Number(await root.getAttribute("data-state-version"));

    await test.step("the hints show on a fine pointer", async () => {
      const hint = page.locator("[data-command] [data-run] .key-hint");
      await expect(hint).toBeVisible();
      await expect(hint).toHaveText("[ENTER]");
    });

    await test.step("Tab opens the card, Enter runs it once, Esc closes it", async () => {
      const run = page.locator("[data-command] [data-run]");
      await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Tab");
      const card = page.locator("[data-next-buy]");
      await expect(card).toBeVisible();
      await expect(card.locator("[data-run]").first()).toBeFocused();
      // Every click on a run button, by where it sits: one Enter is one click (K-4). The busy
      // guard would hide a second click under the same label from the POST count alone.
      await page.evaluate(() => {
        const w = window as unknown as { runClicks: string[] };
        w.runClicks = [];
        document.addEventListener(
          "click",
          (e) => {
            const run = (e.target as Element | null)?.closest("[data-run]");
            if (run) w.runClicks.push(run.closest("[data-next-buy]") ? "card" : "bar");
          },
          true,
        );
      });
      await page.keyboard.press("Enter");
      await expect(root).toHaveAttribute("data-state-version", "1");
      const buys = posts.filter((p) => p.body.actions[0]?.type !== "TAP");
      expect(buys, "one POST for one Enter (K-4, K-21)").toHaveLength(1);
      const clicks = await page.evaluate(
        () => (window as unknown as { runClicks: string[] }).runClicks,
      );
      expect(clicks, "Enter on the focused primary is its native click alone").toEqual(["card"]);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(rows).toBeFocused();
    });

    await test.step("the digits switch lanes", async () => {
      await page.keyboard.press("5");
      await expect(page.locator("[data-power-panel]")).toBeVisible();
      await page.keyboard.press("1");
      await expect(page.locator('[role="option"][data-item="iron_ore"]')).toBeVisible();
      // Copper is locked: 2 is a no-op (K-9).
      await page.keyboard.press("2");
      await expect(page.locator('[role="tab"][data-lane="iron"]')).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await test.step("the F-keys and their letters agree (K-10)", async () => {
      const url = page.url();
      const priority = page.locator("#view-priority");
      const handbook = page.locator('[data-route="handbook"]');
      const factory = page.locator('#view-factory [role="option"]').first();
      await page.keyboard.press("F2");
      await expect(priority).toBeVisible();
      expect(page.url()).toBe(url);
      await page.keyboard.press("F3");
      await expect(handbook).toBeVisible();
      await page.keyboard.press("F1");
      await expect(factory).toBeVisible();
      expect(page.url()).toBe(url);
      await page.keyboard.press("p");
      await expect(priority).toBeVisible();
      await page.keyboard.press("h");
      await expect(handbook).toBeVisible();
      await page.keyboard.press("f");
      await expect(factory).toBeVisible();
      expect(page.url()).toBe(url);
    });

    await test.step("↑/↓ move the rows, the drawer follows, Esc closes it", async () => {
      const ids = await page
        .locator('#view-factory [role="option"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-item")));
      const active = await rows.getAttribute("aria-activedescendant");
      const at = ids.findIndex((id) => active === `row-${id}`);
      const start = at === -1 ? 0 : at;
      const next = ids[start + 1]!;
      const after = ids[start + 2]!;
      expect(next, "a row after the selected one").toBeTruthy();
      expect(after, "two rows after the selected one").toBeTruthy();

      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(`[data-drawer="${next}"]`)).toBeVisible();
      await expect(page.locator("#drawer-title")).toBeFocused();

      await page.keyboard.press("ArrowDown");
      await expect(page.locator(`[data-drawer="${after}"]`)).toBeVisible();
      await expect(page.locator("#drawer-title")).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(page.locator("[data-drawer]")).toHaveCount(0);
      await expect(rows).toBeFocused();
      await expect(rows).toHaveAttribute("aria-activedescendant", `row-${after}`);
    });

    await test.step("a letter key in the drawer clicks its button", async () => {
      await page.locator('[role="option"][data-item="iron_ore"]').click();
      const drawer = page.locator('[data-drawer="iron_ore"]');
      await expect(drawer).toBeVisible();
      const buy = drawer.locator('[data-mark-buy="1"][data-count="1"]');
      await expect(buy).toHaveAttribute("aria-disabled", "false", { timeout: 60_000 });
      const before = await version();
      await page.keyboard.press("b");
      await expect(root).toHaveAttribute("data-state-version", String(before + 1));
      await expect(drawer.locator('[data-mark="1"] [data-owned]')).toHaveText("x3");
      await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
    });

    await test.step("typing in the handbook search triggers nothing (K-2, K-19)", async () => {
      await page.keyboard.press("F3");
      const box = search(page);
      await expect(box).toBeVisible();
      const before = await root.getAttribute("data-state-version");
      await box.focus();
      await page.keyboard.type("1pt?");
      await expect(box).toHaveValue("1pt?");
      await expect(page.locator("[data-route]")).toHaveAttribute("data-route", "handbook");
      await expect(page.locator("[data-help]")).toHaveCount(0);
      await expect(root).toHaveAttribute("data-state-version", before!);
      await expect(page.locator("footer[data-power]")).not.toHaveAttribute("data-holding");
    });

    await test.step("? opens the help, Esc closes it", async () => {
      await search(page).blur();
      await page.keyboard.press("F1");
      await expect(page.locator('#view-factory [role="option"]').first()).toBeVisible();
      await page.keyboard.press("?");
      await expect(page.locator("[data-help]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-help]")).toHaveCount(0);
    });

    await test.step("? over the NEXT_BUY card: one modal, and focus comes back", async () => {
      await page.locator("[data-why]").click();
      const card = page.locator("[data-next-buy]");
      await expect(card).toBeVisible();
      await expect(focused(page)).toHaveCount(1);
      const opener = await focused(page).evaluate((el) => el.outerHTML.slice(0, 80));
      await page.keyboard.press("?");
      await expect(page.locator("[data-help]")).toBeVisible();
      await expect(page.locator('[aria-modal="true"]')).toHaveCount(1);
      await expect(page.locator("[data-help] h2")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-help]")).toHaveCount(0);
      // The card stays open under the help (inert, not blurred away), so focus returns to the
      // control that opened the help, inside it.
      await expect(card).toBeVisible();
      await expect(focused(page)).toHaveCount(1);
      expect(await focused(page).evaluate((el) => el.outerHTML.slice(0, 80))).toBe(opener);
    });
  });
});

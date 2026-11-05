// UI-1 (U-1a, U-1i, V-6): the theme picker on desktop. A free theme applies and survives a
// reload; the stored theme is on <html> before the first frame (no flash); a locked theme can't
// be chosen, and a stored locked theme paints as terminal without losing the stored choice.
import { expect, test } from "@playwright/test";
import { startGuest } from "./helpers.js";

const THEME_KEY = "mi.theme";

test("Clean (Light) applies from Settings and survives a reload", async ({ page }) => {
  const { root } = await startGuest(page);
  const html = page.locator("html");
  await page.locator("[data-open-settings]").click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Clean (Light)").check();
  await expect(html).toHaveAttribute("data-theme", "clean-light");
  await page.reload();
  await expect(root).toHaveAttribute("data-sync", "ready");
  await expect(html).toHaveAttribute("data-theme", "clean-light");
});

test("the stored theme is on <html> at the first frame (V-6)", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "clean-light");
    requestAnimationFrame(() => {
      (window as unknown as { firstFrameTheme?: string }).firstFrameTheme =
        document.documentElement.dataset.theme ?? "(unset)";
    });
  }, THEME_KEY);
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { firstFrameTheme?: string }).firstFrameTheme),
    )
    .toBe("clean-light");
});

test("a locked theme can't be chosen", async ({ page }) => {
  await startGuest(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "terminal");
  await page.locator("[data-open-settings]").click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  const cosy = sheet.locator('input[data-theme-choice="cosy"]');
  await expect(cosy).toHaveAttribute("aria-disabled", "true");
  // aria-disabled, not disabled: the click lands and is ignored.
  await cosy.click({ force: true });
  await expect(cosy).not.toBeChecked();
  await expect(html).toHaveAttribute("data-theme", "terminal");
});

test("a stored locked theme paints as terminal and stays stored", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "cosy"), THEME_KEY);
  await startGuest(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terminal");
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("cosy");
});

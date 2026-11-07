// 4b (W-23, Q-15): the drawer's buy. Clicking the row opens the drawer with its ladder and projection
// before any purchase; a Miner becomes affordable in real time (18 s measured) and the buy lands.
import { expect, test } from "@playwright/test";
import { startGuest } from "./helpers.js";

test("the drawer shows the ladder and the projection, then buys a Miner", async ({ page }) => {
  const { root } = await startGuest(page);
  const drawer = page.locator('[data-drawer="iron_ore"]');

  await test.step("the drawer opens with its ladder and projection", async () => {
    await page.locator('[role="option"][data-item="iron_ore"]').click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("[data-ladder]")).toContainText("8 more Miners → ×1.50");
    await expect(drawer.locator("[data-preview]")).not.toBeEmpty();
    await expect(root).toHaveAttribute("data-state-version", "0");
  });

  await test.step("a Miner becomes affordable and the buy lands", async () => {
    // MACHINES' buy 1 on mark 1 (U-5c, K-13): off by aria-disabled while short, never the
    // native disabled, so wait on the attribute.
    const buy = drawer.locator('[data-mark-buy="1"][data-count="1"]');
    await expect(buy).toHaveAttribute("aria-disabled", "false", { timeout: 60_000 });
    await buy.click();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(drawer.locator('[data-mark="1"] [data-owned]')).toHaveText("x3");
    await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
  });
});

// U-3 / U-5a: the drawer covers rows, it never moves them. A row's box is the same, to the
// pixel, with the drawer closed and open: the desktop panel and the phone sheet.
for (const { name, width, height } of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`rows never move when the drawer opens (${name})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await startGuest(page);
    const ore = page.locator('[role="option"][data-item="iron_ore"]');
    const plate = page.locator('[role="option"][data-item="iron_plate"]');
    await expect(ore).toBeVisible();
    const before = [await ore.boundingBox(), await plate.boundingBox()];
    expect(before).not.toContain(null);
    await ore.click();
    await expect(page.locator('[data-drawer="iron_ore"]')).toBeVisible();
    await expect(ore).toHaveAttribute("aria-selected", "true");
    expect([await ore.boundingBox(), await plate.boundingBox()]).toEqual(before);
  });
}

// 4b (W-23, Q-15): the drawer's buy. The row opens the drawer with its ladder and projection
// before any purchase; a Miner becomes affordable in real time (18 s measured) and the buy lands.
import { expect, test } from "@playwright/test";
import { startGuest } from "./helpers.js";

test("the drawer shows the ladder and the projection, then buys a Miner", async ({ page }) => {
  const { root } = await startGuest(page);
  const drawer = page.locator('[data-drawer="iron_ore"]');

  await test.step("the drawer opens with its ladder and projection", async () => {
    await page.locator('[data-item="iron_ore"] [data-open-row]').click();
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("[data-ladder]")).toContainText("8 more Miners → ×1.50");
    await expect(drawer.locator("[data-preview]")).not.toBeEmpty();
    await expect(root).toHaveAttribute("data-state-version", "0");
  });

  await test.step("a Miner becomes affordable and the buy lands", async () => {
    const buy = drawer.getByRole("button", { name: /^Buy 1 Miner/ });
    await expect(buy).toBeEnabled({ timeout: 60_000 });
    await buy.click();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(drawer.locator("[data-owned]")).toHaveText("3 owned");
    await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
  });
});

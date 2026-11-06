// The 4a end-to-end path (W-23), on Layout C: a guest starts, the lane renders as listbox rows
// with the command line naming the bottleneck buy, the run lands it, and a reload keeps the
// same world. Every wait is on a store or
// DOM attribute (P-9); the one long wait is real time for the first buy to become
// affordable (P-10).
import { expect, test } from "@playwright/test";

const TOKEN_KEY = "mi.guestToken";
const GUEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;

test("a guest starts, buys the bottleneck machine, and keeps the world across a reload", async ({
  page,
}) => {
  const root = page.locator("[data-sync]");
  const guestPosts: string[] = [];
  let reloaded = false;
  page.on("request", (req) => {
    if (reloaded && req.method() === "POST" && new URL(req.url()).pathname === "/api/guests")
      guestPosts.push(req.url());
  });
  const token = () => page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY);

  await test.step("guest start", async () => {
    await page.goto("/");
    await expect(root).toHaveAttribute("data-sync", "ready");
    expect(await token()).toMatch(GUEST_TOKEN);
  });

  const plate = page.locator('[role="option"][data-item="iron_plate"]');

  await test.step("the lane renders, with the command line", async () => {
    await expect(page.locator('[role="tab"][data-lane="iron"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(plate).toBeVisible();
    await expect(plate.locator('[class*="_name_"]')).toHaveText("IRON_PLATE");
    await expect(plate).toHaveAccessibleName(/^Iron Plate/);
    await expect(page.locator("[data-command]")).toContainText(
      "buy 1 constructor_mk1 --lane iron --for iron_plate",
    );
    await expect(page.locator("[data-frame]")).toHaveCount(0);
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scroll: d.scrollWidth, client: d.clientWidth };
    });
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  });

  await test.step("the run buys the bottleneck machine", async () => {
    const run = page.locator("[data-command] [data-run]");
    await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
    await run.click();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
  });

  await test.step("a reload keeps the world", async () => {
    const before = await token();
    reloaded = true;
    await page.reload();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "1");
    expect(await token()).toBe(before);
    expect(guestPosts).toEqual([]);
  });
});

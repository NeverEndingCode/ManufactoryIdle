// The 4a end-to-end path (W-23): a guest starts, the lane renders with its bottleneck frame,
// the bottleneck buy lands, and a reload keeps the same world. Every wait is on a store or
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

  const plate = page.locator('li[data-item="iron_plate"]');

  await test.step("the lane renders", async () => {
    await expect(page.locator('[role="tab"][data-lane="iron"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(plate).toBeVisible();
    await expect(plate.getByText("Iron Plate", { exact: true })).toBeVisible();
    await expect(page.getByText("bottleneck", { exact: true })).toHaveCount(1);
    await expect(
      plate.locator("[data-frame]").getByText("bottleneck", { exact: true }),
    ).toHaveCount(1);
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scroll: d.scrollWidth, client: d.clientWidth };
    });
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  });

  await test.step("the bottleneck buy succeeds", async () => {
    const buy = page.getByRole("button", { name: /^Buy 1 / });
    await expect(buy).toBeEnabled({ timeout: 120_000 });
    await buy.click();
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

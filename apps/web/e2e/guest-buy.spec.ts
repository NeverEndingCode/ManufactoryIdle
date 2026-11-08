// The 4a end-to-end path (W-23), on Layout C: a guest starts, the lane renders as listbox rows
// with the command line naming the bottleneck buy, the run lands it, and a reload keeps the
// same world. Every wait is on a store or
// DOM attribute (P-9); the one long wait is real time for the first buy to become
// affordable (P-10).
import { expect, test } from "@playwright/test";

const TOKEN_KEY = "mi.guestToken";
const GUEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;

// U-9a's cost line is measured at 1280×820: the log box leaves room for eight rows.
test.use({ viewport: { width: 1280, height: 820 } });

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
    // U-9b: the TREND column at 1280, ten cells; the oldest minute isn't known yet.
    await expect(page.getByText("LAST 10 MIN", { exact: true })).toBeVisible();
    const trend = page.locator('[role="option"]').first().locator('[class*="_trend_"]');
    await expect(trend).toBeVisible();
    const cells = (await trend.textContent()) ?? "";
    expect(cells).toHaveLength(10);
    expect(cells.startsWith("·")).toBe(true);
    // U-9a: the 96 px log box costs the main box 106 px; eight 44 px rows still fit (the
    // header row and the box's padding and border are the 30).
    const log = page.locator("section[data-factory-log]");
    await expect(log).toBeVisible();
    expect((await log.boundingBox())?.height).toBe(96);
    const mainBox = await page.locator("[data-main-box]").evaluate((el) => el.clientHeight);
    expect(mainBox - 30).toBeGreaterThanOrEqual(8 * 44);
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scroll: d.scrollWidth, client: d.clientWidth };
    });
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  });

  await test.step("the run buys the bottleneck machine", async () => {
    const run = page.locator("[data-command] [data-run]");
    await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
    const top = (await plate.boundingBox())?.y;
    await run.click();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
    // U-9a: the purchase is logged, in the box, and the rows didn't move (U-3a).
    await expect(
      page.locator("[data-factory-log] li", { hasText: "bought 1 CONSTRUCTOR_MK1 (IRON)" }),
    ).toHaveCount(1);
    expect((await plate.boundingBox())?.y).toBe(top);
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

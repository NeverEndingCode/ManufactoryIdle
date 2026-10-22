// 4b (W-11, W-23, Q-18): failures injected with page.route, so a mishandled status shows as a
// stuck outbox or a stuck poll. (a) A lost POST is resent with the same key until it lands,
// with the offline banner after the second failure. (b) A 429 pauses, then resends with the
// same key. (c) A GET answered with an unexpected 4xx stops polling until focus.
import { expect, test, type Page, type Route } from "@playwright/test";
import { actionPosts, startGuest } from "./helpers.js";

const ACTIONS = "**/api/actions";

function failedActionPosts(page: Page): { count: number } {
  const n = { count: 0 };
  page.on("requestfailed", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/actions") n.count += 1;
  });
  return n;
}

test("a lost POST and a 429 are resent with the same key", async ({ page }) => {
  const posts = actionPosts(page);
  const failed = failedActionPosts(page);
  const { root } = await startGuest(page);
  const ore = page.locator('#pane-priority li[data-entry="item:iron_ore"]');
  const pause = ore.getByRole("button", { name: "Pause Iron Ore" });
  const chip = ore.locator("[data-chip]");
  const offline = page.locator('[data-notice="offline"]');
  await expect(page.getByRole("button", { name: "Simple", pressed: true })).toBeVisible();

  await test.step("(a) a lost POST: offline after two failures, then the same key lands", async () => {
    const abort = (r: Route) => r.abort("failed");
    await page.route(ACTIONS, abort);
    await pause.click();
    await expect(chip).toHaveText("paused");
    await expect(pause).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => failed.count).toBeGreaterThanOrEqual(2);
    await expect(offline).toBeVisible();
    await expect(root).toHaveAttribute("data-state-version", "0");
    await page.unroute(ACTIONS, abort);
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(offline).toHaveCount(0);
    await expect(chip).toHaveText("paused");
    expect(posts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(posts.map((p) => p.body.idempotencyKey)).size).toBe(1);
  });

  await test.step("(b) a 429, then the resend a second later with the same key", async () => {
    const sent = posts.length;
    await page.route(
      ACTIONS,
      (r) =>
        r.fulfill({
          status: 429,
          headers: { "retry-after": "1" },
          contentType: "application/json",
          body: '{"error":"rate-limited"}',
        }),
      { times: 1 },
    );
    await pause.click();
    await expect(root).toHaveAttribute("data-state-version", "2");
    await expect(pause).toHaveAttribute("aria-pressed", "false");
    const mine = posts.slice(sent);
    expect(mine).toHaveLength(2);
    expect(mine[1]!.body.idempotencyKey).toBe(mine[0]!.body.idempotencyKey);
    expect(mine[0]!.body.idempotencyKey).not.toBe(posts[0]!.body.idempotencyKey);
    expect(mine[1]!.at - mine[0]!.at).toBeGreaterThanOrEqual(1_000);
  });
});

test("a GET answered with a 4xx stops polling until focus", async ({ page }) => {
  let gets = 0;
  page.on("request", (req) => {
    if (req.method() === "GET" && new URL(req.url()).pathname === "/api/world") gets += 1;
  });
  await page.clock.install();
  const { root } = await startGuest(page);
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await test.step("the 4xx: a client-bug toast, and polling off", async () => {
    await page.route("**/api/world", (r) => r.fulfill({ status: 418, body: '{"error":"x"}' }), {
      times: 1,
    });
    await page.clock.fastForward(6_000);
    await focus();
    await expect(page.locator('[data-notice="client-bug"]')).toBeVisible();
    await expect(root).toHaveAttribute("data-polling", "off");
  });

  await test.step("no GET for over an hour", async () => {
    const n = gets;
    await page.clock.fastForward(4_100_000);
    await expect(root).toHaveAttribute("data-polling", "off");
    expect(gets).toBe(n);
  });

  await test.step("focus: exactly one GET, and polling armed again", async () => {
    const n = gets;
    await focus();
    await expect(root).toHaveAttribute("data-polling", "armed");
    expect(gets).toBe(n + 1);
  });
});

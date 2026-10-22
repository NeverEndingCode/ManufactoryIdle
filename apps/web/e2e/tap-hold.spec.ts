// 4b (W-12, W-23, Q-11, Q-15): the holdable tap in a real browser. A hold flushes at most once
// a second while held, and once more after release; every flush is its own one-TAP batch.
// The 1 s floor itself is pinned exactly in the store's unit tests (Task 5); this sees it
// through the network, so it allows 100 ms of observation jitter.
import { expect, test } from "@playwright/test";
import { actionPosts, isTapPost, startGuest } from "./helpers.js";

test("holding the tap flushes once a second, then once after release", async ({ page }) => {
  const posts = actionPosts(page);
  await startGuest(page);
  const dock = page.locator("[data-dock]");
  const tap = page.locator("button[data-tap]");
  const tapPost = () =>
    page.waitForRequest((r) => isTapPost(r.url(), r.method(), r.postDataJSON()));

  await test.step("hold, two flushes, release, one more", async () => {
    await tap.hover();
    const first = tapPost();
    await page.mouse.down();
    await expect(dock).toHaveAttribute("data-holding", "");
    await first;
    await tapPost();
    const last = tapPost();
    await page.mouse.up();
    await last;
    await expect(dock).not.toHaveAttribute("data-holding");
  });

  await test.step("the flushes are a second apart, one TAP each", async () => {
    const taps = posts.filter((p) => p.body.actions[0]?.type === "TAP");
    expect(taps).toHaveLength(3);
    for (let i = 1; i < taps.length; i++)
      expect(taps[i]!.at - taps[i - 1]!.at).toBeGreaterThanOrEqual(900);
    for (const p of taps) {
      expect(p.body.actions).toHaveLength(1);
      const a = p.body.actions[0] as { type: "TAP"; count: number };
      expect(a.count).toBeGreaterThan(0);
    }
  });

  await test.step("the dock shows the full kick", async () => {
    await expect(dock).toHaveAttribute("data-stacks", "10");
    const kick = dock.getByText(/^×1\.50 · 10\/10 stacks · \d+s$/);
    await expect(kick).toBeVisible();
    const secs = Number(/(\d+)s$/.exec((await kick.textContent()) ?? "")?.[1]);
    expect(secs).toBeGreaterThan(20);
  });
});

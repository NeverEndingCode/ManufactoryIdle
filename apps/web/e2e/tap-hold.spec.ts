// 4b (W-12, W-23, Q-11, Q-15): the holdable tap in a real browser. A hold flushes at most once
// a second while held, and once more after release; every flush is its own one-TAP batch.
// The 1 s floor itself is pinned exactly in the store's unit tests (Task 5); this sees it
// through the network, so it allows 100 ms of observation jitter.
import { expect, test, type Page } from "@playwright/test";
import { actionPosts, isTapPost, startGuest } from "./helpers.js";

/** The first advice has typed itself out (U-9e). Its ~12 ms timers shift the hold's timers by
 * a millisecond: the flush and the tenth repeat are both due a second after the press, and
 * the release's flush needs a tap after the last flush. Holding on a settled page keeps the
 * order this spec has always seen. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator("[data-command] [data-typed]")).not.toBeEmpty();
  await expect(page.locator("[data-command] [data-typing]")).toHaveCount(0);
}

test("holding the tap flushes once a second, then once after release", async ({ page }) => {
  const posts = actionPosts(page);
  await startGuest(page);
  await settled(page);
  const footer = page.locator("footer[data-power]");
  const tap = footer.locator("button[data-tap]");
  const tapPost = () =>
    page.waitForRequest((r) => isTapPost(r.url(), r.method(), r.postDataJSON()));

  await test.step("hold, two flushes, release, one more", async () => {
    await tap.hover();
    const first = tapPost();
    await page.mouse.down();
    await expect(footer).toHaveAttribute("data-holding", "");
    await first;
    await tapPost();
    const last = tapPost();
    await page.mouse.up();
    await last;
    await expect(footer).not.toHaveAttribute("data-holding");
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

  await test.step("the footer shows the full kick", async () => {
    await expect(footer).toHaveAttribute("data-stacks", "10");
    const kick = footer.getByText(/^KICK x1\.50 · 10 STK · \d+s$/);
    await expect(kick).toBeVisible();
    const secs = Number(/(\d+)s$/.exec((await kick.textContent()) ?? "")?.[1]);
    expect(secs).toBeGreaterThan(20);
  });
});

// UI-2 (U-6c, K-2, K-4): a held T is the button held, through the same tap path.
test("a held T taps like the button", async ({ page }) => {
  const posts = actionPosts(page);
  await startGuest(page);
  await settled(page);
  const footer = page.locator("footer[data-power]");
  const tapPost = () =>
    page.waitForRequest((r) => isTapPost(r.url(), r.method(), r.postDataJSON()));
  await expect(footer.locator("button[data-tap]")).toBeVisible();
  // At rest: nothing focused, so the key is the dispatcher's.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  let upAt = 0;
  await test.step("T down holds and flushes; T up releases with one more", async () => {
    const first = tapPost();
    await page.keyboard.down("t");
    await expect(footer).toHaveAttribute("data-holding", "");
    await first;
    const last = tapPost();
    upAt = Date.now();
    await page.keyboard.up("t");
    await expect(footer).not.toHaveAttribute("data-holding");
    await last;
  });

  await test.step("every flush is one TAP", async () => {
    const taps = posts.filter((p) => p.body.actions[0]?.type === "TAP");
    // At least the first and the release flush; a slow runner may hold past a second.
    expect(taps.length).toBeGreaterThanOrEqual(2);
    for (const p of taps) expect(p.body.actions).toHaveLength(1);
    // The release's own flush: the last one is seen after the keyup.
    expect(taps.at(-1)!.at).toBeGreaterThanOrEqual(upAt);
  });
});

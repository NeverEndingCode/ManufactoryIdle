// 4c (W-18, W-20, S-14): under prefers-reduced-motion nothing runs, and nothing is lost: the
// bottleneck still says so in words, and the conveyor is there but still. Without the
// preference the motion does run, the frame's pulse among it.
import { expect, test, type Page } from "@playwright/test";
import { startGuest } from "./helpers.js";

/** Every running animation in the document, by name ("" for a non-CSS animation). CSS
 * modules hash keyframe names (`pulse` ships as `_pulse_<hash>_1`). */
function running(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => (a instanceof CSSAnimation ? a.animationName : "")),
  );
}

const isPulse = (name: string) => /(^|_)pulse(_|$)/.test(name);

test("reduced motion runs no animation and keeps the bottleneck in words", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startGuest(page);
  const frame = page.locator("li[data-item] [data-frame]");
  await expect(frame.getByText("bottleneck", { exact: true })).toBeVisible();
  const conveyor = page.locator("[data-conveyor]");
  await expect(conveyor).toHaveCount(1);
  expect(await running(page)).toEqual([]);
  const onConveyor = await conveyor.evaluate(
    (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
  );
  expect(onConveyor).toBe(0);
});

// A fresh test is a new page in a new context, with no emulation.
test("without the preference the motion runs, the pulse among it", async ({ page }) => {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    false,
  );
  await startGuest(page);
  await expect(page.locator("[data-conveyor]")).toHaveCount(1);
  await expect.poll(() => running(page).then((names) => names.length)).toBeGreaterThan(0);
  await expect.poll(() => running(page).then((names) => names.some(isPulse))).toBe(true);
});

// 4c (W-18, W-20, S-14), on Layout C: under prefers-reduced-motion nothing runs, and nothing is
// lost: the bottleneck row keeps its "!" gutter and says so in its name. Without the preference
// the motion does run, the gutter's pulse among it (U-3e).
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

/** The bottleneck's option (its name ends ", bottleneck") and its gutter (a hashed class). */
function bottleneck(page: Page) {
  const option = page.locator('[role="option"][aria-label$=", bottleneck"]');
  return { option, gutter: option.locator('[class*="_gutter_"]') };
}

test("reduced motion runs no animation and keeps the bottleneck in words", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await startGuest(page);
  const { option, gutter } = bottleneck(page);
  await expect(option).toHaveCount(1);
  await expect(option).toHaveAccessibleName(/, bottleneck$/);
  await expect(gutter).toBeVisible();
  await expect(gutter).toHaveText("!");
  expect(await running(page)).toEqual([]);
  // U-8c, L-19: the advice doesn't type. Once the words are there for a reader, the visible
  // span already reads the whole shell command: one read, no wait for typing.
  const command = page.locator("[data-command]");
  await expect(command.locator("[data-command-text]")).toHaveText(
    "Buy 1 Constructor Mk.1 for Iron Plate",
  );
  expect(await command.locator("[data-typed]").textContent()).toBe(
    "buy 1 constructor_mk1 --lane iron --for iron_plate",
  );
});

// A fresh test is a new page in a new context, with no emulation.
test("without the preference the motion runs, the pulse on the gutter", async ({ page }) => {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    false,
  );
  await startGuest(page);
  const { gutter } = bottleneck(page);
  await expect(gutter).toBeVisible();
  await expect
    .poll(() =>
      gutter.evaluate((el) =>
        el
          .getAnimations()
          .filter((a) => a.playState === "running")
          .map((a) => (a instanceof CSSAnimation ? a.animationName : "")),
      ),
    )
    .toContainEqual(expect.stringMatching(/(^|_)pulse(_|$)/));
});

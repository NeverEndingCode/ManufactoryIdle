// UI-1 (U-1a, U-1i, V-6): the theme picker on desktop. A free theme applies and survives a
// reload; the stored theme is on <html> before the first frame (no flash); a locked theme can't
// be chosen, and a stored locked theme paints as terminal without losing the stored choice.
import { expect, test } from "@playwright/test";
import { startGuest } from "./helpers.js";

const THEME_KEY = "mi.theme";

test("Clean (Light) applies from Settings and survives a reload", async ({ page }) => {
  const { root } = await startGuest(page);
  const html = page.locator("html");
  await page.locator("[data-open-settings]").click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Clean (Light)").check();
  await expect(html).toHaveAttribute("data-theme", "clean-light");
  await page.reload();
  await expect(root).toHaveAttribute("data-sync", "ready");
  await expect(html).toHaveAttribute("data-theme", "clean-light");
});

test("the stored theme is on <html> at the first frame (V-6)", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "clean-light");
    requestAnimationFrame(() => {
      (window as unknown as { firstFrameTheme?: string }).firstFrameTheme =
        document.documentElement.dataset.theme ?? "(unset)";
    });
  }, THEME_KEY);
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { firstFrameTheme?: string }).firstFrameTheme),
    )
    .toBe("clean-light");
});

test("a locked theme can't be chosen", async ({ page }) => {
  await startGuest(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "terminal");
  await page.locator("[data-open-settings]").click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  const cosy = sheet.locator('input[data-theme-choice="cosy"]');
  await expect(cosy).toHaveAttribute("aria-disabled", "true");
  // aria-disabled, not disabled: the click lands and is ignored.
  await cosy.click({ force: true });
  await expect(cosy).not.toBeChecked();
  await expect(html).toHaveAttribute("data-theme", "terminal");
});

test("a stored locked theme paints as terminal and stays stored", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "cosy"), THEME_KEY);
  await startGuest(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terminal");
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("cosy");
});

// L-1: the command is what the player reads, and the prompt is decoration. At every width the
// desktop bar shows (600 to 1280 px), in every theme a production build can select, the
// command's box holds at least 20 characters of its own font, or the whole command fits; the
// page never scrolls sideways. Terminal's prompt is `$` below desktop. Reduced motion, so the
// text is whole (U-8c).
test("the command reads at every width (L-1)", async ({ page }) => {
  /** The command's box, 20 zeros in its own font, the page's width and the run label. */
  const measure = () =>
    page.locator("[data-command] [data-typed]").evaluate((el) => {
      const box = el.parentElement!;
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = getComputedStyle(box).font;
      const doc = document.documentElement;
      return {
        client: box.clientWidth,
        scroll: box.scrollWidth,
        twenty: ctx.measureText("0".repeat(20)).width,
        page: { scroll: doc.scrollWidth, client: doc.clientWidth },
        run: box.closest("[data-command]")!.querySelector("[data-run]")?.textContent ?? null,
      };
    });
  /** The same reading with the run's label swapped for `label` (its voice's case), then put
   * back, all in one task so React never sees it. */
  const worstCase = (label: string) =>
    page.locator("[data-command]").evaluate((bar, label) => {
      const run = bar.querySelector("[data-run]")!;
      const text = [...run.childNodes]
        .filter(
          (n) =>
            n.textContent !== "" && !(n instanceof Element && n.classList.contains("key-hint")),
        )
        .at(-1)!;
      const before = text.textContent;
      const plain = /^[A-Z]/.test(before ?? "");
      text.textContent = plain ? label[0]!.toUpperCase() + label.slice(1) : label;
      const box = bar.querySelector("[data-typed]")!.parentElement!;
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = getComputedStyle(box).font;
      const doc = document.documentElement;
      const reading = {
        client: box.clientWidth,
        twenty: ctx.measureText("0".repeat(20)).width,
        runRight: Math.round(run.getBoundingClientRect().right),
        barRight: Math.round(bar.getBoundingClientRect().right),
        page: { scroll: doc.scrollWidth, client: doc.clientWidth },
      };
      text.textContent = before;
      return reading;
    }, label);
  type Reading = Awaited<ReturnType<typeof measure>>;
  /** At least 20 characters show, or the whole command fits; and no sideways scroll. */
  const reads = (m: Reading) =>
    (m.client >= Math.floor(m.twenty) || m.scroll <= m.client) && m.page.scroll <= m.page.client;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 820 });
  await startGuest(page);
  const typed = page.locator("[data-command] [data-typed]");
  const prompt = page.locator("[data-command] [data-prompt]");
  await expect(typed).not.toBeEmpty();
  for (const theme of ["terminal", "clean-dark", "clean-oled", "clean-light"]) {
    await page.locator("[data-open-settings]").click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await sheet.locator(`input[data-theme-choice="${theme}"]`).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    // The theme's font, loaded: the canvas measures what the layout uses.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const width of [600, 640, 820, 1000, 1280]) {
      await page.setViewportSize({ width, height: 820 });
      await expect(page.locator("[data-sync]")).toHaveAttribute("data-layout", /desktop|tablet/);
      if (theme === "terminal")
        await expect(prompt).toHaveText(width > 1000 ? "operator@manufactory:~$" : "$");
      // A resize or a theme's font can take a frame to lay out: poll a moment, then judge
      // the last reading.
      let m = await measure();
      await expect
        .poll(async () => reads((m = await measure())), { timeout: 5_000 })
        .toBe(true)
        .catch(() => {});
      const label = `${theme} at ${width}px: ${JSON.stringify(m)}`;
      test.info().annotations.push({ type: "command width", description: label });
      expect(reads(m), label).toBe(true);
      if (width <= 640) {
        // The worst labels the run can show (fix round 1): the longest compact wait and
        // "not affordable yet", written into the button's text for one layout. The run gives
        // way, not the command: 20 characters still show, and the run stays inside the bar.
        for (const worst of ["affordable in 100h 00m", "not affordable yet"]) {
          const w = await worstCase(worst);
          const at = `${theme} at ${width}px, run "${worst}": ${JSON.stringify(w)}`;
          test.info().annotations.push({ type: "command width, worst run", description: at });
          expect(w.client, at).toBeGreaterThanOrEqual(Math.floor(w.twenty));
          expect(w.runRight, at).toBeLessThanOrEqual(w.barRight);
          expect(w.page.scroll, at).toBeLessThanOrEqual(w.page.client);
        }
      }
    }
  }
});

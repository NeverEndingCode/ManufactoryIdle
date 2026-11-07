// UI-2 (U-4b, U-5b, U-6, U-7e, U-8d, K-3, K-16, K-17, K-20): the phone and a coarse tablet on a
// real touch screen (Chromium with hasTouch and isMobile). The first step proves the pointer is
// coarse, so K-16's one rule is really under test; every wait is on the DOM or the store's state
// version (P-9), the long ones real time for a buy to become affordable (P-10).
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectCoarseTargets,
  expectNoOverflow,
  expectNoSidewaysScroll,
  startGuest,
} from "./helpers.js";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** K-16's scopes, each with the fewest targets it must show: the drawer panel or sheet (Close
 * and the mark's buy 1, x10, max at least), the power panel (a generator's row button and its
 * +1) and the command bar (why and run). */
const DRAWER = { "[data-drawer]": 4 };
const POWER = { "[data-power-panel]": 2 };
const COMMAND = { "[data-command]": 2 };

async function expectCoarse(page: Page): Promise<void> {
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect(
    coarse,
    "matchMedia('(pointer: coarse)') is false: K-16's coarse rule would go untested",
  ).toBe(true);
}

async function boxOf(l: Locator) {
  const box = await l.boundingBox();
  if (box === null) throw new Error("no layout box");
  return box;
}

test.describe("the phone", () => {
  // Two real-time waits for affordability (the bar's run, then a Biomass Burner).
  test.describe.configure({ timeout: 200_000 });

  test("one keyboardless thumb: the split bar, the sheets, the generator, the TAP", async ({
    page,
  }) => {
    const { root } = await startGuest(page);
    const version = async () => Number(await root.getAttribute("data-state-version"));

    await test.step("the pointer is coarse and no hint shows", async () => {
      await expectCoarse(page);
      await expect(page.locator('[role="option"][data-item="iron_ore"]')).toBeVisible();
      await expect(page.locator(".key-hint:visible")).toHaveCount(0);
    });

    await test.step("the split bar's one-tap buy", async () => {
      const run = page.locator("[data-command] [data-run]");
      await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
      await run.tap();
      await expect(root).toHaveAttribute("data-state-version", "1");
      await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
    });

    await test.step("the why sheet's open, then the grip closes the drawer sheet", async () => {
      await page.locator("[data-why]").tap();
      const next = page.locator("[data-next-buy]");
      await expect(next).toHaveAttribute("aria-modal", "true");
      const openItem = next.locator("[data-open-item]");
      await expect(openItem).toBeVisible();
      await openItem.tap();
      await expect(next).toHaveCount(0);
      const sheet = page.locator('[data-drawer-host] [aria-modal="true"]');
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute("data-drawer", /^[a-z_]+$/);
      const inert = page
        .locator("[data-power] button[data-tap]")
        .evaluate((el) => el.closest("[inert]") !== null);
      expect(await inert, "the TAP is inert under the modal sheet").toBe(true);
      await expectCoarseTargets(page, "the drawer sheet", { ...DRAWER, ...COMMAND });

      // The sheet rises in (180 ms): measure the grip where it comes to rest.
      await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const grip = await boxOf(sheet.locator("[data-grip]"));
      const x = grip.x + grip.width / 2;
      const y = grip.y + grip.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 150, { steps: 10 });
      await page.mouse.up();
      await expect(page.locator("[data-drawer-host]")).toHaveCount(0);
    });

    const panels = page.getByRole("tablist", { name: "Panels" });
    const tab = (name: string) => panels.getByRole("tab", { name: new RegExp(`^${name}`) });

    await test.step("the power tab's generator +1", async () => {
      await tab("power").tap();
      await expect(page.locator("[data-power-panel]")).toBeVisible();
      const plus = page.locator('[data-generator-buy="biomass_burner"]');
      await expect(plus).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
      const before = await version();
      await plus.tap();
      await expect(root).toHaveAttribute("data-state-version", String(before + 1));
      await expect(page.locator('[data-notice="rejected"]')).toHaveCount(0);
      await expectCoarseTargets(page, "the power panel", POWER);
    });

    await test.step("the generator drawer sheet", async () => {
      await page.locator('[data-open-generator="biomass_burner"]').tap();
      const sheet = page.locator('[data-drawer="power:biomass_burner"]');
      await expect(sheet).toHaveAttribute("aria-modal", "true");
      await expectNoOverflow(page, "the generator drawer sheet");
      await expectCoarseTargets(page, "the generator drawer sheet", { ...DRAWER, ...POWER });
      await sheet.getByRole("button", { name: "Close" }).tap();
      await expect(sheet).toHaveCount(0);
    });

    await test.step("the TAP on all four tabs, and a hold on priority", async () => {
      const tap = page.locator("[data-power] button[data-tap]");
      for (const name of ["factory", "power", "priority", "handbook"]) {
        await tab(name).tap();
        await expect(tab(name)).toHaveAttribute("aria-selected", "true");
        await expect(tap, `the TAP on ${name}`).toBeVisible();
      }
      await tab("priority").tap();
      await expect(page.locator("#view-priority")).toBeVisible();
      const box = await boxOf(tap);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await expect(page.locator("[data-power][data-holding]")).toHaveCount(1);
      await page.mouse.up();
      await expect(page.locator("[data-power][data-holding]")).toHaveCount(0);
    });
  });
});

test.describe("a coarse tablet", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("44 px targets with the drawer open (U-8d's 9a in a browser)", async ({ page }) => {
    await startGuest(page);
    await expect(page.locator(".app")).toHaveAttribute("data-layout", "tablet");
    await expectCoarse(page);

    await page.locator('[role="option"][data-item="iron_plate"]').tap();
    const drawer = page.locator('[data-drawer="iron_plate"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("aria-modal", "false");
    await expectNoOverflow(page, "the tablet drawer");
    await expectCoarseTargets(page, "the tablet drawer", { ...DRAWER, ...COMMAND });

    await page.keyboard.press("5");
    await expect(page.locator("[data-power-panel]")).toBeVisible();
    await page.locator('[data-open-generator="biomass_burner"]').tap();
    await expect(page.locator('[data-drawer="power:biomass_burner"]')).toBeVisible();
    await expectNoOverflow(page, "the tablet power panel and generator drawer");
    await expectCoarseTargets(page, "the tablet power panel", {
      ...DRAWER,
      ...POWER,
      ...COMMAND,
    });
  });

  // K-25: the header's wrap is decided by width alone, so the save chip appearing mid-session
  // never changes its height (it would push the rows down). The chip is the real class, put
  // where Shell renders it: a guest only sees it from tier 1, beyond this spec's reach.
  for (const theme of ["terminal", "clean-light"])
    test(`the save chip never changes the header's height (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("mi.theme", t), theme);
      await startGuest(page);
      const header = page.locator("header").first();
      for (const width of [700, 900, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator("[data-save-chip]")).toHaveCount(0);
        const before = (await boxOf(header)).height;
        await header.evaluate((h, shell) => {
          let chipClass = "";
          for (const sh of Array.from(document.styleSheets))
            for (const rule of Array.from(sh.cssRules))
              if (rule instanceof CSSStyleRule && /^\._chip_[\w-]+$/.test(rule.selectorText))
                chipClass = rule.selectorText.slice(1);
          const chip = document.createElement("button");
          chip.className = chipClass;
          chip.setAttribute("data-save-chip", "");
          chip.textContent = shell ? "> save_factory" : "Save your factory";
          h.querySelector("nav")!.before(chip);
        }, theme === "terminal");
        await expect(page.locator("[data-save-chip]")).toHaveCount(1);
        expect((await boxOf(header)).height, `${width} px`).toBe(before);
        const outside = await header.evaluate((h) => {
          const box = h.getBoundingClientRect();
          return Array.from(h.querySelectorAll("button"))
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.left < box.left || r.right > box.right || r.bottom > box.bottom;
            })
            .map((b) => b.textContent);
        });
        expect.soft(outside, `${width} px: header controls outside the header`).toEqual([]);
        await page.locator("[data-save-chip]").evaluate((c) => c.remove());
      }
    });

  // U-2c at its narrow end: no sideways scroll, every control inside the viewport and 44 px,
  // and the header's controls inside the header (the .app clips, so scrollWidth can't see a
  // header that overflows). Clean's wider title and tabs are the harder case.
  for (const theme of ["terminal", "clean-light"])
    test(`600, 640 and 660 px fit, drawer open (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("mi.theme", t), theme);
      await page.setViewportSize({ width: 600, height: 900 });
      await startGuest(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectCoarse(page);
      const row = page.locator('[role="option"][data-item="iron_plate"]');
      await row.tap();
      const drawer = page.locator('[data-drawer="iron_plate"]');
      for (const width of [600, 640, 660]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator(".app")).toHaveAttribute("data-layout", "tablet");
        await expect(drawer).toBeVisible();
        await expectNoSidewaysScroll(page, `${width} px`);
        await expectNoOverflow(page, `${width} px`);
        const outside = await page.locator("header").evaluate((h) => {
          const box = h.getBoundingClientRect();
          return Array.from(h.querySelectorAll("button"))
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.left < box.left || r.right > box.right || r.bottom > box.bottom;
            })
            .map((b) => b.getAttribute("aria-label") ?? b.textContent);
        });
        expect.soft(outside, `${width} px: header controls outside the header`).toEqual([]);
        // The final review's item 6: on the 360 px panel the mark's buttons go under its name,
        // so "CONSTRUCTOR_MK1" (15 characters) shows whole, and the row keeps them inside.
        const mark = await drawer.locator('[data-mark="1"]').evaluate((li) => {
          const name = li.firstElementChild as HTMLElement;
          const box = li.getBoundingClientRect();
          const out = Array.from(li.querySelectorAll("button"))
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom;
            })
            .map((b) => b.textContent);
          return {
            text: name.textContent,
            cut: name.scrollWidth > name.clientWidth,
            rowScrolls: li.scrollWidth > li.clientWidth,
            out,
          };
        });
        expect.soft(mark.cut, `${width} px: "${mark.text}" is cut`).toBe(false);
        expect.soft(mark.rowScrolls, `${width} px: the mark row scrolls sideways`).toBe(false);
        expect.soft(mark.out, `${width} px: mark buttons outside the row`).toEqual([]);
      }
    });
});

// 4c (W-19, W-20, W-23, S-16): every view at 320 px. No sideways scroll, every control and
// number inside the viewport, every target 44 px. Then W-25: the footer links the source at
// the built commit, and the production source maps are served.
import { expect, test, type Page, type Route } from "@playwright/test";
import type { ActionsRequest } from "../src/sync/wire.js";
import { expectNoOverflow, startGuest } from "./helpers.js";

test.use({ viewport: { width: 320, height: 640 } });

/** Moves every running animation to `fraction` of its cycle. The conveyor's belt and the
 * sweep start where they fit and reach their widest at the end of a cycle (translateX up to
 * 0 or 100%), so a missing clip shows only late in a 4 to 20 s loop. */
function seekMotion(page: Page, fraction: number): Promise<number> {
  return page.evaluate((f) => {
    let n = 0;
    for (const a of document.getAnimations()) {
      if (a.playState !== "running") continue;
      const d = a.effect?.getComputedTiming().duration;
      if (typeof d !== "number" || !Number.isFinite(d)) continue;
      a.currentTime = d * f;
      n += 1;
    }
    return n;
  }, fraction);
}

/** The longest item name in the slice (probe4c-handbook.mts). */
const LONGEST = "encased_industrial_beam";

test("every view fits 320 px", async ({ page }) => {
  const { root } = await startGuest(page);
  const view = (name: string) =>
    page.getByRole("tablist", { name: "View" }).getByRole("tab", { name });

  await test.step("Factory, on each unlocked lane", async () => {
    const tabs = page.getByRole("tablist", { name: "Lanes" }).getByRole("tab");
    const lanes = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-lane")));
    expect(lanes).toEqual(["iron", "power"]);
    for (const lane of lanes) {
      const tab = page.locator(`[role="tab"][data-lane="${lane}"]`);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#lane-panel [data-conveyor]")).toHaveCount(1);
      await expectNoOverflow(page, `factory, ${lane} lane`);
      expect(await seekMotion(page, 0.999)).toBeGreaterThan(0);
      await expectNoOverflow(page, `factory, ${lane} lane, motion at the end of its cycle`);
    }
    await page.locator('[role="tab"][data-lane="iron"]').click();
  });

  await test.step("the iron plate drawer sheet", async () => {
    await page.locator('[data-item="iron_plate"] [data-open-row]').click();
    const drawer = page.locator('[data-drawer="iron_plate"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("[data-ladder]")).toBeVisible();
    await expectNoOverflow(page, "the iron plate drawer");
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toHaveCount(0);
  });

  await test.step("Priority, in Simple and in Advanced", async () => {
    await view("Priority").click();
    await expect(page.locator("#pane-priority")).toBeVisible();
    await expect(page.getByRole("button", { name: "Simple", pressed: true })).toBeVisible();
    await expectNoOverflow(page, "priority, Simple");
    await page.getByRole("button", { name: "Advanced" }).click();
    await expect(page.getByRole("button", { name: "Advanced", pressed: true })).toBeVisible();
    await expectNoOverflow(page, "priority, Advanced");
    await page.getByRole("button", { name: "Simple" }).click();
  });

  await test.step("the handbook index, and the longest entry", async () => {
    await view("Handbook").click();
    await expect(page.locator('[data-handbook="index"]')).toBeVisible();
    await expect(page.locator("dl[data-glossary]")).toBeVisible();
    await expectNoOverflow(page, "the handbook index");
    await page.locator(`button[data-handbook-item="${LONGEST}"]`).click();
    await expect(page.locator(`article[data-handbook-entry="${LONGEST}"]`)).toBeVisible();
    await expect(page.locator("[data-traces]")).toBeVisible();
    await expectNoOverflow(page, "the Encased Industrial Beam entry");
    await view("Factory").click();
  });

  const sheet = page.getByRole("dialog", { name: "Settings" });

  await test.step("the settings sheet", async () => {
    await page.locator("[data-open-settings]").click();
    await expect(sheet).toBeVisible();
    await expectNoOverflow(page, "the settings sheet");
  });

  await test.step("the sign-up form with a field error", async () => {
    const form = sheet.getByRole("form", { name: "Create account" });
    await form.getByLabel("Email").fill("x");
    await form.getByLabel("Password").fill("password1");
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(form.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await expectNoOverflow(page, "the sign-up form with a field error");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  await test.step("the reset-password page", async () => {
    await page.goto("/account/reset-password?token=bogus");
    const main = page.locator('main[data-reset="form"]');
    await expect(main).toBeVisible();
    await expectNoOverflow(page, "the reset page");
    await main.getByLabel("New password", { exact: true }).fill("password2");
    await main.getByRole("button", { name: "Change password" }).click();
    await expect(main).toContainText("This link has expired or was already used.");
    await expectNoOverflow(page, "the reset page, an expired link");
  });

  await test.step("a rejection toast", async () => {
    await page.goto("/");
    await expect(root).toHaveAttribute("data-sync", "ready");
    await page.route(
      "**/api/actions",
      (r: Route) => {
        const body = r.request().postDataJSON() as ActionsRequest;
        return r.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            failedAction: body.actions[0],
            index: 0,
            reason: "That priority entry moved before this reorder reached the server.",
          }),
        });
      },
      { times: 1 },
    );
    await view("Priority").click();
    const ore = page.locator('#pane-priority li[data-entry="item:iron_ore"]');
    await ore.focus();
    await ore.press("Alt+ArrowDown");
    const toast = page.locator('[data-notice="rejected"]');
    await expect(toast).toBeVisible();
    await expectNoOverflow(page, "a rejection toast");
  });
});

test("the footer links the source at the built commit, and the source maps are served", async ({
  page,
  request,
}) => {
  await startGuest(page);
  const source = page.locator("footer a[data-source-link]");
  await expect(source).toBeVisible();
  expect(await source.getAttribute("href")).toMatch(/\/tree\/[0-9a-f]{40}$/);
  await expect(page.locator("footer a[data-license-link]")).toHaveAttribute(
    "href",
    /\/blob\/[0-9a-f]{40}\/LICENSE$/,
  );
  await expectNoOverflow(page, "the footer");

  const src = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(src).toMatch(/\.js$/);
  const map = await request.get(new URL(`${src}.map`, page.url()).href);
  expect(map.status()).toBe(200);
  const json = (await map.json()) as { sources?: unknown };
  expect(Array.isArray(json.sources)).toBe(true);
  expect((json.sources as unknown[]).length).toBeGreaterThan(0);
});

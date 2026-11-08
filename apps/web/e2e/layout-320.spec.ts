// 4c (W-19, W-20, W-23, S-16), on Layout C: every view at 320 px. No sideways scroll, every
// control and number inside the viewport, every target 44 px. Then W-25: About in Settings links
// the source at the built commit, and the production source maps are served.
import { expect, test, type Locator, type Route } from "@playwright/test";
import type { ActionsRequest } from "../src/sync/wire.js";
import { expectNoOverflow, startGuest } from "./helpers.js";

test.use({ viewport: { width: 320, height: 640 } });

async function boxOf(l: Locator) {
  const box = await l.boundingBox();
  if (box === null) throw new Error("no layout box");
  return box;
}

/** The longest item name in the slice (probe4c-handbook.mts). */
const LONGEST = "encased_industrial_beam";

test("every view fits 320 px", async ({ page }) => {
  const { root } = await startGuest(page);
  const panels = page.getByRole("tablist", { name: "Panels" });
  const view = (name: string) => panels.getByRole("tab", { name: new RegExp(`^${name}`) });

  await test.step("the bottom tabs and the lanes", async () => {
    await expect(panels.getByRole("tab")).toHaveText([
      "factory",
      "~ power",
      "priority",
      "handbook",
    ]);
    const tabs = page.getByRole("tablist", { name: "Lanes" }).getByRole("tab");
    const lanes = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-lane")));
    expect(lanes).toEqual(["iron", "copper", "coal", "oil"]);
    for (const lane of ["copper", "coal", "oil"])
      await expect(page.locator(`[role="tab"][data-lane="${lane}"]`)).toHaveAttribute(
        "aria-disabled",
        "true",
      );
  });

  await test.step("Factory", async () => {
    await expect(page.locator('#view-factory [role="option"]').first()).toBeVisible();
    // U-9b: no TREND column on the phone (the drawer's meta line has the trend).
    await expect(
      page.locator('#view-factory [role="option"] [class*="_trend_"]').first(),
    ).toBeHidden();
    await expectNoOverflow(page, "factory");
  });

  await test.step("the floating TAP clears the command bar", async () => {
    const tap = await boxOf(page.locator("[data-power][data-with-command]"));
    const command = await boxOf(page.locator("[data-command]"));
    const overlap =
      tap.x < command.x + command.width &&
      command.x < tap.x + tap.width &&
      tap.y < command.y + command.height &&
      command.y < tap.y + tap.height;
    expect(overlap, `TAP ${JSON.stringify(tap)} vs command ${JSON.stringify(command)}`).toBe(false);
  });

  await test.step("the iron plate drawer sheet", async () => {
    await page.locator('[role="option"][data-item="iron_plate"]').click();
    const drawer = page.locator('[data-drawer="iron_plate"]');
    await expect(drawer).toBeVisible();
    // K-3: modal, over the scrim.
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await expect(drawer.locator("[data-ladder]")).toBeVisible();
    await expectNoOverflow(page, "the iron plate drawer");
    // A tap on the scrim, above the sheet's top, closes it.
    const top = (await boxOf(drawer)).y;
    expect(top).toBeGreaterThan(20);
    await page.mouse.click(160, top / 2);
    await expect(drawer).toHaveCount(0);
    await expect(page.locator("[data-drawer-host]")).toHaveCount(0);
    // Reopened, the x closes it.
    await page.locator('[role="option"][data-item="iron_plate"]').click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toHaveCount(0);
  });

  await test.step("the NEXT_BUY sheet", async () => {
    await page.locator("[data-why]").click();
    const next = page.locator("[data-next-buy]");
    await expect(next).toBeVisible();
    await expectNoOverflow(page, "the NEXT_BUY sheet");
    await page.keyboard.press("Escape");
    await expect(next).toHaveCount(0);
  });

  await test.step("the power tab", async () => {
    await view("power").click();
    await expect(page.locator("[data-power-panel]")).toBeVisible();
    await expectNoOverflow(page, "the power tab");
  });

  await test.step("Priority, in Simple and in Advanced", async () => {
    await view("priority").click();
    await expect(page.locator("#view-priority")).toBeVisible();
    await expect(page.getByRole("button", { name: "Simple", pressed: true })).toBeVisible();
    await expectNoOverflow(page, "priority, Simple");
    await page.getByRole("button", { name: "Advanced" }).click();
    await expect(page.getByRole("button", { name: "Advanced", pressed: true })).toBeVisible();
    await expectNoOverflow(page, "priority, Advanced");
    await page.getByRole("button", { name: "Simple" }).click();
  });

  await test.step("the handbook index, and the longest entry", async () => {
    await view("handbook").click();
    await expect(page.locator('[data-handbook="index"]')).toBeVisible();
    await expect(page.locator("dl[data-glossary]")).toBeVisible();
    await expectNoOverflow(page, "the handbook index");
    await page.locator(`button[data-handbook-item="${LONGEST}"]`).click();
    await expect(page.locator(`article[data-handbook-entry="${LONGEST}"]`)).toBeVisible();
    await expect(page.locator("[data-traces]")).toBeVisible();
    await expectNoOverflow(page, "the Encased Industrial Beam entry");
    await view("factory").click();
  });

  const sheet = page.getByRole("dialog", { name: "Settings" });

  await test.step("the settings sheet", async () => {
    await page.locator("[data-open-settings]").click();
    await expect(sheet).toBeVisible();
    await expectNoOverflow(page, "the settings sheet");
  });

  await test.step("the Account section", async () => {
    const buttons = sheet.locator("[data-provider]");
    await expect(buttons).toHaveCount(2);
    for (const name of ["Discord", "GitHub"])
      await expect(sheet.getByRole("button", { name: `Sign in with ${name}` })).toBeVisible();
    await expectNoOverflow(page, "the Account section");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  await test.step("a sign-in toast", async () => {
    await page.goto("/account/callback/github?error=access_denied&state=x");
    const toast = page.locator('[data-notice="sign-in-failed"]');
    await expect(toast).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expectNoOverflow(page, "a sign-in toast");
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
    await view("priority").click();
    const ore = page.locator('#view-priority li[data-entry="item:iron_ore"]');
    await ore.focus();
    await ore.press("Alt+ArrowDown");
    const toast = page.locator('[data-notice="rejected"]');
    await expect(toast).toBeVisible();
    await expectNoOverflow(page, "a rejection toast");
  });
});

// U-9a / L-10 / L-11: the phone's log. A buy puts a line in it; the ticker shows it, clear of the
// floating TAP, and opens the modal log sheet, which fits 320 px and gives focus back on close.
test("the log ticker and its sheet fit 320 px", async ({ page }) => {
  const { root } = await startGuest(page);
  const ticker = page.locator("[data-log-ticker]");

  await test.step("a Miner bought from the drawer sheet puts a line in the log", async () => {
    await expect(ticker).toHaveCount(0);
    await page.locator('[role="option"][data-item="iron_ore"]').click();
    const drawer = page.locator('[data-drawer="iron_ore"]');
    await expect(drawer).toBeVisible();
    const buy = drawer.locator('[data-mark-buy="1"][data-count="1"]');
    await expect(buy).toHaveAttribute("aria-disabled", "false", { timeout: 60_000 });
    await buy.click();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toHaveCount(0);
  });

  await test.step("the ticker", async () => {
    await expect(ticker).toBeVisible();
    await expect(ticker).toHaveAccessibleName("Factory log, 1 entry");
    await expect(ticker).toContainText(/bought 1 MINER/);
    const t = await boxOf(ticker);
    const tap = await boxOf(page.locator("[data-power][data-with-command]"));
    const overlap =
      tap.x < t.x + t.width &&
      t.x < tap.x + tap.width &&
      tap.y < t.y + t.height &&
      t.y < tap.y + tap.height;
    expect(overlap, `TAP ${JSON.stringify(tap)} vs ticker ${JSON.stringify(t)}`).toBe(false);
    await expectNoOverflow(page, "the log ticker");
  });

  await test.step("the log sheet", async () => {
    await ticker.click();
    const sheet = page.locator('[data-log-sheet][aria-modal="true"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("li")).toHaveCount(1);
    await expectNoOverflow(page, "the log sheet");
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(ticker).toBeFocused();
  });
});

test("About in Settings links the source at the built commit, and the source maps are served", async ({
  page,
  request,
}) => {
  await startGuest(page);
  await page.locator("[data-open-settings]").click();
  const about = page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("region", { name: "About" });
  const source = about.locator("a[data-source-link]");
  await expect(source).toBeVisible();
  expect(await source.getAttribute("href")).toMatch(/\/tree\/[0-9a-f]{40}$/);
  await expect(about.locator("a[data-license-link]")).toHaveAttribute(
    "href",
    /\/blob\/[0-9a-f]{40}\/LICENSE$/,
  );
  await expectNoOverflow(page, "About");

  const src = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(src).toMatch(/\.js$/);
  const map = await request.get(new URL(`${src}.map`, page.url()).href);
  expect(map.status()).toBe(200);
  const json = (await map.json()) as { sources?: unknown };
  expect(Array.isArray(json.sources)).toBe(true);
  expect((json.sources as unknown[]).length).toBeGreaterThan(0);
});

// U-2e / U-6c: the notices never lie over the floating TAP. The notices (35) are above the TAP
// (20), so where they met the guest's save button covered the TAP's top and a thumb aimed at
// TAP could hit save. The overlay stops short of the TAP's column instead. The save chip is
// up for a guest from tier 1 on (S-12), so the API's answers are read one tier up: the chip
// shows from the first frame. Each tab places the TAP differently.
test("the notices clear the floating TAP at 390 and 320 px, on every tab", async ({ page }) => {
  const tierUp = async (route: Route) => {
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    const body = (await res.json()) as {
      state?: { tier: number };
      world?: { state: { tier: number } };
    };
    const world = body.world ?? body;
    if (world.state !== undefined) world.state.tier += 1;
    return route.fulfill({ response: res, json: body });
  };
  for (const path of ["**/api/guests", "**/api/world", "**/api/actions"])
    await page.route(path, tierUp);
  await startGuest(page);
  const panels = page.getByRole("tablist", { name: "Panels" });
  const tap = page.locator("[data-power] button[data-tap]");
  const notices = page.locator(".notice-overlay [data-notice]");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 640 });
    for (const name of ["factory", "power", "priority", "handbook"]) {
      await panels.getByRole("tab", { name: new RegExp(`${name}$`) }).click();
      await expect(tap).toBeVisible();
      await expect(
        page.locator('.notice-overlay [data-notice="save"]'),
        `${width} ${name}`,
      ).toBeVisible();
      const t = await boxOf(tap);
      for (const n of await notices.all()) {
        const b = await boxOf(n);
        const meet =
          b.x < t.x + t.width &&
          t.x < b.x + b.width &&
          b.y < t.y + t.height &&
          t.y < b.y + b.height;
        expect(
          meet,
          `${width} px, ${name}: a notice over the TAP (${JSON.stringify({ b, t })})`,
        ).toBe(false);
      }
    }
  }
});

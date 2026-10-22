// 4b (W-21, W-23, Q-15): the hand-rolled priority drag in a real browser, which jsdom can't
// lay out. A drag reorders at once (optimistic) and persists; moving power off the top asks
// first (C.4) and Cancel sends nothing; Alt+↓ is the keyboard path.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { actionPosts, startGuest } from "./helpers.js";

const list = (page: Page) => page.locator('#pane-priority ol[aria-label="Output priority"]');
const entry = (page: Page, id: string) => list(page).locator(`li[data-entry="${id}"]`);
const order = (page: Page) =>
  list(page)
    .locator("li[data-entry]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-entry")));

async function boxOf(l: Locator) {
  const box = await l.boundingBox();
  if (box === null) throw new Error("no layout box");
  return box;
}

/** Down on the row's handle, a 5-step move to `toY`, up. */
async function dragTo(page: Page, id: string, toY: number) {
  const handle = await boxOf(entry(page, id).getByRole("button", { name: /^Drag to reorder / }));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, toY, { steps: 5 });
  await page.mouse.up();
}

test("the priority list reorders by drag and by Alt+↓, and guards power", async ({ page }) => {
  const posts = actionPosts(page);
  const { root } = await startGuest(page);
  await expect(list(page)).toBeVisible();
  const before = await order(page);
  expect(before.indexOf("item:iron_plate")).toBeLessThan(before.indexOf("item:iron_rod"));
  const dragged = [...before];
  dragged.splice(dragged.indexOf("item:iron_rod"), 1);
  dragged.splice(dragged.indexOf("item:iron_plate"), 0, "item:iron_rod");

  await test.step("drag Iron Rod above Iron Plate", async () => {
    // The drop lands before the row whose midpoint is below the pointer: aim just inside
    // Iron Plate's top edge, above its midpoint and below the row before it.
    const plate = await boxOf(entry(page, "item:iron_plate"));
    await dragTo(page, "item:iron_rod", plate.y + 3);
    expect(await order(page)).toEqual(dragged);
    await expect(root).toHaveAttribute("data-state-version", "1");
    expect(await order(page)).toEqual(dragged);
    expect(posts.map((p) => p.body.actions[0]?.type)).toEqual(["REORDER_PRIORITY"]);
  });

  await test.step("the order persists across a reload", async () => {
    await page.reload();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(list(page)).toBeVisible();
    expect(await order(page)).toEqual(dragged);
  });

  await test.step("dragging power down asks first; Cancel sends nothing", async () => {
    const sent = posts.length;
    const next = await boxOf(entry(page, dragged[1]!));
    // Below the second row's midpoint, above the third's: one place down.
    await dragTo(page, "power", next.y + next.height * 0.75);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(root).toHaveAttribute("data-state-version", "1");
    expect(posts.length).toBe(sent);
    expect(await order(page)).toEqual(dragged);
  });

  await test.step("Alt+↓ moves Iron Ore down one", async () => {
    const ore = entry(page, "item:iron_ore");
    await ore.focus();
    await ore.press("Alt+ArrowDown");
    await expect(root).toHaveAttribute("data-state-version", "2");
    const after = await order(page);
    expect(after.indexOf("item:iron_ore")).toBe(dragged.indexOf("item:iron_ore") + 1);
  });
});

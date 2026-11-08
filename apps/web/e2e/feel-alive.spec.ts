// UI-3 (U-9, U-8c, L-19, L-20): the factory feels alive in a real browser, on the guest world
// at 1280×820 with motion on. A buy writes a line to the log box (no live region, no
// role="log"), and the rows don't move for it; the TREND column shows ten cells a row; the glow
// costs no long task and the frames are recorded with it on and with CRT off; Enter while the
// advice types runs it once and completes the text, and a reader's copy is never partial.
// Every wait is on the DOM, a store attribute or a request (P-9); the long ones are real time
// for a buy to become affordable (P-10), as keyboard.spec.
import { expect, test, type Page } from "@playwright/test";
import { actionPosts, startGuest } from "./helpers.js";

test.use({ viewport: { width: 1280, height: 820 } });

/** L-20: no long task over this with the glow on. 50 ms is the spec's number, and by
 * definition the shortest long task; a CI runner is 10–20× slower than a desktop, so there the
 * budget is ten times as generous. The medians are recorded, not asserted. */
const LONG_TASK_MS = process.env.CI ? 500 : 50;

/** What the page records for the frame check; see `collect`. */
interface Frames {
  longTasks: number[];
  medianFrameMs: number;
  ticks: number;
}

/**
 * L-20's window. A buffered longtask observer, of which only the entries from now on count (the
 * page's load is not the glow's cost), and a count of the app's DOM text changes: the 4 Hz text
 * tick moves the stock and the countdowns, so 20 of them is about 5 s of the store's ticking.
 */
async function startWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      fx: { t0: number; longTasks: number[]; ticks: number; stop(): void };
    };
    const t0 = performance.now();
    const longTasks: number[] = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.startTime >= t0) longTasks.push(e.duration);
    });
    po.observe({ type: "longtask", buffered: true });
    const fx = { t0, longTasks, ticks: 0, stop: () => {} };
    const mo = new MutationObserver(() => (fx.ticks += 1));
    mo.observe(document.querySelector(".app")!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    fx.stop = () => {
      po.disconnect();
      mo.disconnect();
    };
    w.fx = fx;
  });
}

/** Waits for 20 ticks of the DOM (a DOM wait, not a sleep), then the median rAF interval over
 * 120 frames, and stops the window. */
async function collect(page: Page): Promise<Frames> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { fx: { ticks: number } }).fx.ticks), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(20);
  return page.evaluate(
    () =>
      new Promise<Frames>((resolve) => {
        const w = window as unknown as {
          fx: { longTasks: number[]; ticks: number; stop(): void };
        };
        const stamps: number[] = [];
        const frame = (t: number) => {
          stamps.push(t);
          if (stamps.length <= 120) {
            requestAnimationFrame(frame);
            return;
          }
          const gaps = stamps.slice(1).map((s, i) => s - stamps[i]!);
          gaps.sort((a, b) => a - b);
          const mid = gaps.length / 2;
          const median = (gaps[Math.floor(mid) - 1]! + gaps[Math.floor(mid)]!) / 2;
          // The rAF frames are inside the window too: a long task among them counts.
          w.fx.stop();
          resolve({ longTasks: [...w.fx.longTasks], medianFrameMs: median, ticks: w.fx.ticks });
        };
        requestAnimationFrame(frame);
      }),
  );
}

const appShadow = (page: Page) =>
  page.locator(".app").evaluate((el) => getComputedStyle(el).textShadow);

test.describe("feel alive", () => {
  // Two real-time waits for affordability (up to 120 s each) on top of the steps.
  test.describe.configure({ timeout: 300_000 });
  test("the log, the trend, the glow's frames and Enter while the advice types", async ({
    page,
  }) => {
    const posts = actionPosts(page);
    const buys = () => posts.filter((p) => p.body.actions[0]?.type !== "TAP");
    const { root } = await startGuest(page);
    const version = async () => Number(await root.getAttribute("data-state-version"));
    const run = page.locator("[data-command] [data-run]");
    const log = page.locator("section[data-factory-log]");
    const firstRow = page.locator('#view-factory [role="option"]').first();
    const top = () => firstRow.evaluate((el) => el.getBoundingClientRect().top);

    let topBefore = 0;
    let topAfter = 0;
    await test.step("1. a buy writes a line to the log, which is no live region", async () => {
      await expect(log).toBeVisible();
      await expect(log).toHaveAttribute("aria-live", "off");
      await expect(page.locator('[role="log"]')).toHaveCount(0);
      await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
      const before = await version();
      topBefore = await top();
      // At rest (nothing focused), Enter runs the advice (K-4).
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Enter");
      await expect.poll(version).toBeGreaterThan(before);
      await expect(log.locator("li").filter({ hasText: /bought \d+ / })).toHaveCount(1);
      topAfter = await top();
      expect(buys()).toHaveLength(1);
    });

    await test.step("5. the rows don't move when the log gains a line", async () => {
      expect(topAfter).toBe(topBefore);
    });

    await test.step("3. the trend: LAST 10 MIN, and ten cells in each visible row", async () => {
      await expect(page.getByText("LAST 10 MIN", { exact: true })).toBeVisible();
      const cells = await page
        .locator('#view-factory [role="option"] [class*="_trend_"]')
        .evaluateAll((els) =>
          els
            .filter((el) => el.getBoundingClientRect().height > 0)
            .map((el) => [...(el.textContent ?? "")].length),
        );
      expect(cells.length).toBeGreaterThan(0);
      expect(
        cells.every((n) => n === 10),
        `cells per row: ${cells.join(", ")}`,
      ).toBe(true);
    });

    await test.step("4. the glow costs no long task; the frames with it and with CRT off", async () => {
      expect(await appShadow(page)).not.toBe("none");
      await startWindow(page);
      const on = await collect(page);
      test.info().annotations.push({
        type: "frames, glow on",
        description: `median rAF ${on.medianFrameMs.toFixed(2)} ms over 120 frames; ${on.ticks} DOM ticks; long tasks ${JSON.stringify(on.longTasks.map(Math.round))}`,
      });
      expect(
        on.longTasks.filter((d) => d > LONG_TASK_MS),
        `long tasks over ${LONG_TASK_MS} ms with the glow on`,
      ).toEqual([]);

      await page.locator("[data-open-settings]").click();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      await sheet.getByRole("checkbox", { name: "Glow and scanlines" }).uncheck();
      await expect(page.locator("html")).toHaveAttribute("data-crt", "off");
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      expect(await appShadow(page)).toBe("none");
      await startWindow(page);
      const off = await collect(page);
      test.info().annotations.push({
        type: "frames, CRT off",
        description: `median rAF ${off.medianFrameMs.toFixed(2)} ms over 120 frames; ${off.ticks} DOM ticks; long tasks ${JSON.stringify(off.longTasks.map(Math.round))}`,
      });
    });

    await test.step("2. Enter while the advice types: one POST, and the text completes", async () => {
      // The next buy, affordable; then its words, typed out and settled: the full shell text.
      await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 120_000 });
      const typed = page.locator("[data-command] [data-typed]");
      await expect(typed).not.toHaveAttribute("data-typing");
      const full = (await typed.textContent()) ?? "";
      const said = (await page.locator("[data-command-text]").textContent()) ?? "";
      expect(full.length).toBeGreaterThan(0);

      // A reload types the same advice again, from its first render. From the document's start
      // the page records every text [data-command-text] holds, the typed text when Enter goes
      // down, the typed text once the run's click has rendered (a microtask after React's
      // own, from a window listener that runs after the root's), and whether it ever typed.
      await page.addInitScript(() => {
        const w = window as unknown as {
          saidSeen: string[];
          atEnter: { typing: boolean; typed: string }[];
          afterRun: string[];
          sawTyping: boolean;
        };
        w.saidSeen = [];
        w.sawTyping = false;
        w.atEnter = [];
        w.afterRun = [];
        const typedNow = () => document.querySelector("[data-command] [data-typed]");
        new MutationObserver(() => {
          if (document.querySelector("[data-command] [data-typed][data-typing]") !== null)
            w.sawTyping = true;
          const el = document.querySelector("[data-command-text]");
          if (el === null) return;
          const text = el.textContent ?? "";
          if (w.saidSeen.at(-1) !== text) w.saidSeen.push(text);
        }).observe(document, { subtree: true, childList: true, characterData: true });
        window.addEventListener(
          "keydown",
          (e) => {
            if (e.key !== "Enter") return;
            const el = typedNow();
            w.atEnter.push({
              typing: el?.hasAttribute("data-typing") ?? false,
              typed: el?.textContent ?? "",
            });
          },
          true,
        );
        window.addEventListener("click", (e) => {
          if ((e.target as Element | null)?.closest("[data-run]") == null) return;
          queueMicrotask(() => w.afterRun.push(typedNow()?.textContent ?? ""));
        });
      });
      const sent = buys().length;
      const before = await version();
      // From the commit, not the load event: the typing starts with the first snapshot's
      // render and lasts at most 600 ms. The wait is for the run to be live (affordable, not
      // busy), checked in the page every frame, so the press lands while the words type on a
      // desktop. A slow runner may only get there after the 600 ms: the wait doesn't depend on
      // the typing, so it never times out for it, the path taken is annotated below, and the
      // POST and full-text checks run either way.
      await page.reload({ waitUntil: "commit" });
      await page.waitForFunction(
        () => document.querySelector('[data-command] [data-run][aria-disabled="false"]') !== null,
        null,
        { polling: "raf", timeout: 60_000 },
      );
      await page.keyboard.press("Enter");
      await expect.poll(version).toBeGreaterThan(before);
      expect(buys().length - sent, "one POST for one Enter").toBe(1);

      const w = await page.evaluate(() => {
        const r = window as unknown as {
          saidSeen: string[];
          atEnter: { typing: boolean; typed: string }[];
          afterRun: string[];
          sawTyping: boolean;
        };
        return {
          saidSeen: r.saidSeen,
          atEnter: r.atEnter,
          afterRun: r.afterRun,
          sawTyping: r.sawTyping,
        };
      });
      expect(w.atEnter).toHaveLength(1);
      const at = w.atEnter[0]!;
      const path = at.typing
        ? "mid-typing"
        : w.sawTyping
          ? "after the typing (a slow runner)"
          : "the typing never seen";
      test.info().annotations.push({
        type: "Enter while typing",
        description: `path: ${path}; typed at Enter: "${at.typed}" of "${full}"`,
      });
      // The page typed after the reload (the init script saw [data-typing]) in every path but
      // the last, which would mean typing is off: that fails here.
      expect(w.sawTyping, "the advice typed after the reload").toBe(true);
      if (at.typing) expect(full.startsWith(at.typed) && at.typed.length < full.length).toBe(true);
      // Right after the run's click, the typed text is the whole command (finish).
      const plainNow = w.saidSeen.at(0);
      if (plainNow === said) expect(w.afterRun).toEqual([full]);
      else expect(w.afterRun[0]).toMatch(/^(buy|storage|qs|reserve|#) /);
      // A reader's copy is whole from the first render: no value it held is a part of another.
      expect(w.saidSeen.length).toBeGreaterThan(0);
      for (const s of w.saidSeen) {
        expect(s, "a complete sentence").toMatch(/^[A-Z].*[A-Za-z0-9.%)]$/);
        const longer = w.saidSeen.filter((o) => o !== s && o.startsWith(s));
        expect(longer, `"${s}" is a partial of another`).toEqual([]);
      }
    });
  });
});

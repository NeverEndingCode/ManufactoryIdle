// Shared e2e helpers (Q-15). Every wait is on the DOM, a store attribute or a request (P-9).
import { expect, type Locator, type Page } from "@playwright/test";
import type { ActionsRequest } from "../src/sync/wire.js";

/** A fresh guest: goto("/"), then wait for the store's ready status on the root. */
export async function startGuest(page: Page): Promise<{ root: Locator }> {
  const root = page.locator("[data-sync]");
  await page.goto("/");
  await expect(root).toHaveAttribute("data-sync", "ready");
  return { root };
}

/** A live log of every POST /api/actions the page makes, failed and aborted ones included:
 * `at` is the test process's Date.now() when the request was seen. */
export function actionPosts(page: Page): { at: number; body: ActionsRequest }[] {
  const log: { at: number; body: ActionsRequest }[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || new URL(req.url()).pathname !== "/api/actions") return;
    log.push({ at: Date.now(), body: req.postDataJSON() as ActionsRequest });
  });
  return log;
}

/** True for a POST /api/actions request whose batch is a TAP flush. */
export function isTapPost(url: string, method: string, body: unknown): boolean {
  if (method !== "POST" || new URL(url).pathname !== "/api/actions") return false;
  const b = body as ActionsRequest | null;
  return b?.actions?.[0]?.type === "TAP";
}

/** What expectNoOverflow found: each entry names the element and what is wrong with it. */
interface OverflowReport {
  page: { scroll: number; client: number };
  body: { scroll: number; client: number };
  outside: string[];
  small: string[];
}

/**
 * S-16 / W-19 / W-20 at the current viewport, on the view as it is now:
 * 1. the page doesn't scroll sideways. `body { overflow-x: hidden }` (base.css) would clip
 *    that from the player and from this check, so it is lifted while measuring;
 * 2. every visible button, a, input, select, .num and [role=meter] lies within
 *    [0, innerWidth]: overflow clipped inside a row's own `overflow: hidden` (a cut-off
 *    number) is invisible to scrollWidth;
 * 3. every visible button, a, input and select is a 44 × 44 px target. An input's target is
 *    its box together with its labels' (the settings radios are 20 px inside a 44 px label).
 * "Visible" is a laid-out box (width and height > 0) not under visibility: hidden.
 */
export async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const report = await page.evaluate((): OverflowReport => {
    const doc = document.documentElement;
    const body = document.body;
    const before = body.style.overflowX;
    body.style.overflowX = "visible";
    const pageSize = { scroll: doc.scrollWidth, client: doc.clientWidth };
    const bodySize = { scroll: body.scrollWidth, client: body.clientWidth };
    body.style.overflowX = before;

    const width = window.innerWidth;
    const name = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      const attrs = Array.from(el.attributes)
        .filter((a) => a.name.startsWith("data-") || a.name === "class" || a.name === "aria-label")
        .map((a) => `${a.name}="${a.value.slice(0, 40)}"`)
        .join(" ");
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${tag}${attrs ? " " + attrs : ""}> "${text}"`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const px = (n: number) => Math.round(n * 10) / 10;

    const outside: string[] = [];
    for (const el of document.querySelectorAll("button, a, input, select, .num, [role=meter]")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Half a pixel of slack for subpixel layout.
      if (r.left < -0.5 || r.right > width + 0.5)
        outside.push(`${name(el)} spans ${px(r.left)}..${px(r.right)} of 0..${width}`);
    }

    const small: string[] = [];
    for (const el of document.querySelectorAll("button, a, input, select")) {
      if (!visible(el)) continue;
      const boxes = [el.getBoundingClientRect()];
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)
        for (const l of Array.from(el.labels ?? []))
          if (visible(l)) boxes.push(l.getBoundingClientRect());
      const left = Math.min(...boxes.map((b) => b.left));
      const right = Math.max(...boxes.map((b) => b.right));
      const top = Math.min(...boxes.map((b) => b.top));
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      const w = right - left;
      const h = bottom - top;
      if (w < 43.5 || h < 43.5) small.push(`${name(el)} is ${px(w)} × ${px(h)}`);
    }
    return { page: pageSize, body: bodySize, outside, small };
  });
  expect
    .soft(report.page.scroll, `${label}: the page scrolls sideways`)
    .toBeLessThanOrEqual(report.page.client);
  expect
    .soft(report.body.scroll, `${label}: the body overflows`)
    .toBeLessThanOrEqual(report.body.client);
  expect.soft(report.outside, `${label}: elements outside [0, innerWidth]`).toEqual([]);
  expect.soft(report.small, `${label}: targets under 44 × 44 px`).toEqual([]);
}

/**
 * K-16 / U-8d's 9a in a browser: on a coarse pointer, every visible button, [role=tab],
 * [data-key] and block link (a[href] not laid out inline) inside each scope is a 44 × 44 px
 * target. expectNoOverflow covers buttons and links page-wide; this adds the tabs and letter-key
 * targets that are neither, and names the scope each small one sits in. Each scope maps to the
 * fewest targets it must have checked, so a missing scope or an empty one can't pass vacuously.
 */
export async function expectCoarseTargets(
  page: Page,
  label: string,
  scopes: Readonly<Record<string, number>>,
): Promise<void> {
  const r = await page.evaluate((sels: readonly string[]) => {
    const small: string[] = [];
    const checked: Record<string, number> = {};
    const seen = new Set<Element>();
    for (const sel of sels) {
      checked[sel] = 0;
      for (const scope of document.querySelectorAll(sel))
        for (const el of scope.querySelectorAll('button, [role="tab"], [data-key], a[href]')) {
          if (seen.has(el)) continue;
          seen.add(el);
          const cs = getComputedStyle(el);
          if (el.tagName === "A" && cs.display === "inline") continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || cs.visibility === "hidden") continue;
          checked[sel]! += 1;
          if (r.width < 43.5 || r.height < 43.5) {
            const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
            const w = Math.round(r.width * 10) / 10;
            const h = Math.round(r.height * 10) / 10;
            small.push(`${sel} <${el.tagName.toLowerCase()}> "${text}" is ${w} × ${h}`);
          }
        }
    }
    return { small, checked };
  }, Object.keys(scopes));
  for (const [sel, min] of Object.entries(scopes))
    expect
      .soft(r.checked[sel] ?? 0, `${label}: targets checked in ${sel}`)
      .toBeGreaterThanOrEqual(min);
  expect.soft(r.small, `${label}: coarse targets under 44 × 44 px`).toEqual([]);
}

/** No sideways scroll on the page or the body (base.css's overflow-x: hidden lifted). */
export async function expectNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const before = body.style.overflowX;
    body.style.overflowX = "visible";
    const out = {
      page: [doc.scrollWidth, doc.clientWidth],
      body: [body.scrollWidth, body.clientWidth],
    };
    body.style.overflowX = before;
    return out;
  });
  expect.soft(r.page[0]!, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(r.page[1]!);
  expect.soft(r.body[0]!, `${label}: the body overflows`).toBeLessThanOrEqual(r.body[1]!);
}

/** The fake provider's display names (the client's PROVIDER_NAMES). */
const PROVIDER_NAME = { discord: "Discord", github: "GitHub" } as const;

/** Sets the fake provider's user (cookie dev-oauth-user, O-14), opens Settings, presses
 * "Sign in with <Name>", and resolves once the page is back on "/" with data-sync="ready":
 * after the callback page's navigation, so a still-"/" page before the redirect never counts. */
export async function signInThroughSettings(
  page: Page,
  provider: "discord" | "github",
  user: string,
): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "dev-oauth-user", value: user, url: origin }]);
  await page.locator("[data-open-settings]").click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await expect(sheet).toBeVisible();
  const callback = page.waitForRequest(
    (r) => r.isNavigationRequest() && new URL(r.url()).pathname === `/account/callback/${provider}`,
  );
  await sheet.getByRole("button", { name: `Sign in with ${PROVIDER_NAME[provider]}` }).click();
  await callback;
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator("[data-sync]")).toHaveAttribute("data-sync", "ready");
}

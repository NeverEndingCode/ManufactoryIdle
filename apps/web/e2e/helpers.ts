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

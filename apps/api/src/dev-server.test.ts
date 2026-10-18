import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devServer } from "./dev-server.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function open(opts: Parameters<typeof devServer>[0] = {}) {
  const dev = await devServer(opts);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dev.app.close();
    await dev.db.close();
  };
  cleanups.push(close);
  return { ...dev, close };
}

describe("devServer", () => {
  it("reports accounts: false", async () => {
    const { app } = await open();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toHaveProperty("accounts", false);
  });

  it("allows far more than five guests per IP", async () => {
    const { app } = await open();
    for (let i = 0; i < 6; i++) {
      expect((await app.inject({ method: "POST", url: "/api/guests" })).statusCode).toBe(201);
    }
  });

  it("has no /auth/signin and no admin route", async () => {
    const { app } = await open();
    expect((await app.inject({ method: "POST", url: "/auth/signin" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/admin/migrate-world" })).statusCode).toBe(404);
  });

  it("keeps a guest across restarts on the same pgliteDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mi-pglite-"));
    const first = await open({ pgliteDir: dir });
    const created = await first.app.inject({ method: "POST", url: "/api/guests" });
    const token = (created.json() as { guestToken: string }).guestToken;
    await first.close();

    const second = await open({ pgliteDir: dir });
    // Registered last, so it runs after both PGlite instances have closed.
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const res = await second.app.inject({
      method: "GET",
      url: "/api/world",
      headers: { authorization: `Guest ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

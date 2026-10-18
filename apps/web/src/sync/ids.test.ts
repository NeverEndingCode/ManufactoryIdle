import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { newIdempotencyKey } from "./ids.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noUUID = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
    webcrypto.getRandomValues(array as Uint8Array) as unknown as T,
};

describe("newIdempotencyKey (W-10)", () => {
  it("builds a v4 UUID from getRandomValues when randomUUID is absent", () => {
    expect(newIdempotencyKey(noUUID)).toMatch(V4);
  });

  it("sets the version and variant bits whatever the random bytes", () => {
    const zeros = { getRandomValues: <T>(a: T): T => a };
    const ones = {
      getRandomValues: <T>(a: T): T => {
        (a as Uint8Array).fill(0xff);
        return a;
      },
    };
    expect(newIdempotencyKey(zeros)).toBe("00000000-0000-4000-8000-000000000000");
    expect(newIdempotencyKey(ones)).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("makes distinct keys", () => {
    const keys = new Set(Array.from({ length: 1_000 }, () => newIdempotencyKey(noUUID)));
    expect(keys.size).toBe(1_000);
  });

  it("uses randomUUID when present", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555" as const);
    expect(newIdempotencyKey({ ...noUUID, randomUUID })).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("defaults to the global crypto", () => {
    expect(newIdempotencyKey()).toMatch(V4);
  });
});

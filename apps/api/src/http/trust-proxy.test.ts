import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./trust-proxy.js";

describe("parseTrustProxy (TRUST_PROXY)", () => {
  it("is off when unset, empty or false", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy(" false ")).toBe(false);
  });

  it("refuses a hop count, which Fastify would silently treat as trusting nothing", () => {
    expect(() => parseTrustProxy("1")).toThrow(/hop count/);
    expect(() => parseTrustProxy(" 2 ")).toThrow(/hop count/);
  });

  it("passes true, or an address list, through to Fastify", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("10.0.0.1, 10.0.0.0/8")).toBe("10.0.0.1,10.0.0.0/8");
    expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
  });
});

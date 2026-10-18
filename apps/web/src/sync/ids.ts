// Idempotency keys (W-10): made when a batch is queued and reused for every retry of it.

type KeySource = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

/** crypto.randomUUID() when present, else a v4 UUID from getRandomValues. randomUUID exists
 * only in a secure context, so a phone on LAN dev (plain http) takes the fallback. */
export function newIdempotencyKey(c: KeySource = globalThis.crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

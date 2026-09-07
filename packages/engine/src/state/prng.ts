// Spec A.5: no Math.random anywhere in the engine. A seeded PRNG is passed
// explicitly and its state is part of the save, so a replay reproduces a session
// exactly (spec E.4).
//
// xoshiro128** with a splitmix32 seeder. Every operation is integer arithmetic --
// Math.imul, shifts, XOR -- so the stream is byte-identical on every platform and
// Node version. No transcendentals, per spec E.4's libm hazard.

export interface PrngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

function splitmix32(seed: number): { value: number; seed: number } {
  const advanced = (seed + 0x9e3779b9) | 0;
  let x = advanced;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x = x ^ (x >>> 15);
  return { value: x >>> 0, seed: advanced };
}

export function makePrng(seed: number): PrngState {
  let s = seed | 0;
  const draw = (): number => {
    const step = splitmix32(s);
    s = step.seed;
    return step.value;
  };
  const a = draw();
  const b = draw();
  const c = draw();
  const d = draw();
  // The all-zero state is a fixed point of xoshiro; nudge it if it ever appears.
  if ((a | b | c | d) === 0) return { a: 1, b: 2, c: 3, d: 4 };
  return { a, b, c, d };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function nextUint32(state: PrngState): { value: number; state: PrngState } {
  const value = Math.imul(rotl(Math.imul(state.b, 5) >>> 0, 7), 9) >>> 0;
  const t = (state.b << 9) >>> 0;
  let c = (state.c ^ state.a) >>> 0;
  let d = (state.d ^ state.b) >>> 0;
  const b = (state.b ^ c) >>> 0;
  const a = (state.a ^ d) >>> 0;
  c = (c ^ t) >>> 0;
  d = rotl(d, 11);
  return { value, state: { a, b, c, d } };
}

export function nextFloat(state: PrngState): { value: number; state: PrngState } {
  const step = nextUint32(state);
  // Divide by 2^32 rather than multiplying by a decimal literal: exact in float64.
  return { value: step.value / 4294967296, state: step.state };
}

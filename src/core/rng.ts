/** A source of uniform numbers in [0, 1). Every random choice in the engine goes through one, so tests can seed it. */
export type Rng = () => number;

/** Mulberry32: small, fast, deterministic. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mathRng: Rng = () => Math.random();

/** Integer in [0, n). */
export const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);
/** Integer in [a, b]. */
export const randRange = (rng: Rng, a: number, b: number): number => a + Math.floor(rng() * (b - a + 1));

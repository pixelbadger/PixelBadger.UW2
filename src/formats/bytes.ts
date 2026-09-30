// Little-endian reads with bounds checks, and the error type every parser throws for malformed input.
// Game data is treated as hostile: a parser either returns something within LIMITS or throws DataError.

export class DataError extends Error {
  override name = 'DataError';
}

export function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new DataError(msg);
}

export function u8(b: Uint8Array, o: number): number {
  if (o < 0 || o >= b.length) throw new DataError(`read past end (u8 at ${o} of ${b.length})`);
  return b[o]!;
}

export function u16(b: Uint8Array, o: number): number {
  if (o < 0 || o + 2 > b.length) throw new DataError(`read past end (u16 at ${o} of ${b.length})`);
  return b[o]! | (b[o + 1]! << 8);
}

export function u32(b: Uint8Array, o: number): number {
  if (o < 0 || o + 4 > b.length) throw new DataError(`read past end (u32 at ${o} of ${b.length})`);
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Signed 16-bit view of a word. */
export const s16 = (v: number): number => (v << 16) >> 16;

/** Byte at o, or 0 past the end (for decoders whose original behaviour reads zeros off the end). */
export const at = (b: Uint8Array, o: number): number => (o >= 0 && o < b.length ? b[o]! : 0);

export const ascii = (b: Uint8Array, o: number, n: number): string => {
  let s = '';
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]!);
  return s;
};

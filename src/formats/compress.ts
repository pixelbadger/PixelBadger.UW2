import { DataError, u32 } from './bytes';
import { LIMITS } from './limits';

/**
 * UW2 ark compression: u32 output size, then flag bytes read LSB first. 1 = literal byte; 0 = two-byte back reference:
 * ofs = m1 | (m2 & 0xF0) << 4 (12-bit signed) + 18, moved into the current 4K window; len = (m2 & 0xF) + 3.
 * References before the start of the output read as zero.
 */
export function uw2Decompress(src: Uint8Array, maxOut: number = LIMITS.maxDecompressed): Uint8Array {
  const size = u32(src, 0);
  if (size > maxOut) throw new DataError(`compressed block claims ${size} bytes (limit ${maxOut})`);
  const out = new Uint8Array(size);
  let i = 4, o = 0;
  while (o < size && i < src.length) {
    let bits = src[i++]!;
    for (let k = 0; k < 8 && o < size && i < src.length; k++, bits >>= 1) {
      if (bits & 1) {
        out[o++] = src[i++]!;
      } else {
        if (i + 1 >= src.length) { i = src.length; break; } // truncated reference: stop, keep what we have
        const m1 = src[i++]!, m2 = src[i++]!;
        let ofs = m1 | ((m2 & 0xf0) << 4);
        let len = (m2 & 0x0f) + 3;
        if (ofs & 0x800) ofs |= ~0xfff; // sign extend 12 bit
        ofs += 18;
        while (ofs < o - 0x1000) ofs += 0x1000;
        while (len-- && o < size) { out[o++] = ofs >= 0 && ofs < o ? out[ofs]! : 0; ofs++; }
      }
    }
  }
  return out;
}

/** Literal-only encoder: produces data uw2Decompress reads back unchanged (used by tests and fixtures). */
export function uw2CompressLiteral(data: Uint8Array): Uint8Array {
  const groups = Math.ceil(data.length / 8);
  const out = new Uint8Array(4 + groups + data.length);
  out[0] = data.length & 255; out[1] = (data.length >> 8) & 255; out[2] = (data.length >> 16) & 255; out[3] = (data.length >>> 24) & 255;
  let p = 4;
  for (let g = 0; g < groups; g++) {
    const n = Math.min(8, data.length - g * 8);
    out[p++] = (1 << n) - 1;
    for (let k = 0; k < n; k++) out[p++] = data[g * 8 + k]!;
  }
  return out.subarray(0, p);
}

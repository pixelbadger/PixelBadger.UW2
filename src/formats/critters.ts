import { u16 } from './bytes';
import { rleDecode } from './rle';

export interface CritFrame {
  w: number;
  h: number;
  /** Hotspot: the frame's anchor on the ground. */
  hx: number;
  hy: number;
  type: number;
  px: Uint8Array;
}

/**
 * One critter page file CRxx.yy: 4 aux palettes x 32 bytes at 0, then 256 u16 frame offsets at 0x80 in GLOBAL
 * frame-index space (pages are merged). Frame: w, h, hotx, hoty, type (6 = 5-bit RLE, 8 = 4-bit), u16 word count.
 */
export function readCritPage(buf: Uint8Array, aux: number): (CritFrame | null)[] {
  const map = buf.subarray(aux * 32, aux * 32 + 32);
  const frames: (CritFrame | null)[] = [];
  for (let i = 0; i < 256; i++) {
    const off = 0x80 + i * 2 + 2 <= buf.length ? u16(buf, 0x80 + i * 2) : 0;
    if (!off || off + 7 > buf.length) { frames.push(null); continue; }
    const w = buf[off]!, h = buf[off + 1]!, hx = buf[off + 2]!, hy = buf[off + 3]!, type = buf[off + 4]!, words = u16(buf, off + 5);
    const bits = type === 6 ? 5 : 4;
    frames.push({ w, h, hx, hy, type, px: rleDecode(buf, off + 7, words, w, h, bits, map) });
  }
  return frames;
}

/** CR.AN: 512 bytes per critter, 64 animations x 8 bytes (7 frame indices, count; 255 = none). */
export function readCritAnims(an: Uint8Array, num: number, hasFrame: (f: number) => boolean): number[][] {
  const anims: number[][] = [];
  for (let a = 0; a < 64; a++) {
    const base = num * 512 + a * 8;
    if (base + 8 > an.length) { anims.push([]); continue; }
    const e = an.subarray(base, base + 8);
    const n = e[7] === 255 ? 0 : e[7]!;
    anims.push(Array.from(e.subarray(0, Math.min(7, n))).filter(f => f !== 255 && hasFrame(f)));
  }
  return anims;
}

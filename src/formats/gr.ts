import { DataError, at, need, u16, u32 } from './bytes';
import { LIMITS } from './limits';
import { rleDecode } from './rle';

/** A decoded palette-indexed image. px holds palette indices; 0 is transparent unless `opaque`. */
export interface Img {
  w: number;
  h: number;
  px: Uint8Array;
  type?: number;
  opaque?: boolean;
  /** Flask art: the pixels before the background was cleared. */
  bgMask?: Uint8Array;
}

/**
 * .GR image files: u8 type, u16 count, u32 offsets. Image: type, w, h, then 4 = raw 8-bit (u16 len),
 * 8 = 4-bit RLE, 0xA = 4-bit raw (u8 aux palette, u16 nibble count). Aux palettes come from ALLPALS.DAT (16 bytes each).
 * Images that point past the file are null; unknown types decode as blank.
 */
export function readGR(buf: Uint8Array, allpals: Uint8Array): (Img | null)[] {
  const n = u16(buf, 1);
  need(n <= LIMITS.maxGrImages, `.GR claims ${n} images`);
  need(3 + n * 4 <= buf.length, '.GR offset table runs past the end of the file');
  const imgs: (Img | null)[] = [];
  let budget: number = LIMITS.maxGrPixels;
  for (let i = 0; i < n; i++) {
    const off = u32(buf, 3 + i * 4);
    if (off + 3 > buf.length) { imgs.push(null); continue; }
    const type = buf[off]!, w = buf[off + 1]!, h = buf[off + 2]!;
    budget -= w * h;
    if (budget < 0) throw new DataError('.GR images exceed the pixel budget');
    let px: Uint8Array = new Uint8Array(w * h);
    if (type === 4) {
      px.set(buf.subarray(off + 5, Math.min(buf.length, off + 5 + w * h)));
    } else if (type === 0xa || type === 8) {
      const aux = at(buf, off + 3), len = off + 6 <= buf.length ? u16(buf, off + 4) : 0;
      const ap = allpals.subarray(aux * 16, aux * 16 + 16);
      if (type === 8) px = rleDecode(buf, off + 6, len, w, h, 4, ap);
      else {
        let p = off + 6, hi = true;
        for (let k = 0; k < w * h && k < len; k++) {
          const b = buf[p] ?? 0;
          px[k] = ap[hi ? b >> 4 : b & 15] ?? 0;
          if (!hi) p++;
          hi = !hi;
        }
      }
    }
    imgs.push({ w, h, px, type });
  }
  return imgs;
}

/** PANELS.GR: headerless 79x112 8-bit bitmaps (0 inventory, 1 rune bag, 2 statistics). */
export function readPanels(buf: Uint8Array): (Img | null)[] {
  const n = u16(buf, 1);
  need(n <= LIMITS.maxGrImages && 3 + n * 4 <= buf.length, 'PANELS.GR header is malformed');
  const out: (Img | null)[] = [];
  for (let i = 0; i < n; i++) {
    const o = u32(buf, 3 + i * 4), e = i + 1 < n ? u32(buf, 7 + i * 4) : buf.length;
    out.push(e - o >= 79 * 112 && o + 79 * 112 <= buf.length ? { w: 79, h: 112, px: buf.subarray(o, o + 79 * 112), opaque: true } : null);
  }
  return out;
}

/** Creature icons in OBJECTS.GR carry editor labels beside the figure: keep only the figure (its largest blob). */
export function keepLargestBlob(im: Img): void {
  const { w, h, px } = im, lab = new Int32Array(w * h).fill(-1), sizes: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!px[i] || lab[i]! >= 0) continue;
    const id = sizes.length; let n = 0; const st = [i]; lab[i] = id;
    while (st.length) {
      const p = st.pop()!; n++;
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X;
        if (px[q] && lab[q]! < 0) { lab[q] = id; st.push(q); }
      }
    }
    sizes.push(n);
  }
  if (sizes.length < 2) return;
  const big = Math.max(...sizes);
  for (let i = 0; i < w * h; i++) if (px[i] && sizes[lab[i]!]! < big * 0.35) px[i] = 0;
}

/** Builds a .GR file of raw (type 4) images: for tests and fixtures. */
export function writeGR(images: { w: number; h: number; px: Uint8Array }[]): Uint8Array {
  const n = images.length;
  let p = 3 + n * 4;
  const offs = images.map(im => { const o = p; p += 5 + im.w * im.h; return o; });
  const out = new Uint8Array(p), dv = new DataView(out.buffer);
  out[0] = 1; dv.setUint16(1, n, true);
  images.forEach((im, i) => {
    const o = offs[i]!;
    dv.setUint32(3 + i * 4, o, true);
    out[o] = 4; out[o + 1] = im.w; out[o + 2] = im.h; dv.setUint16(o + 3, im.w * im.h, true);
    out.set(im.px, o + 5);
  });
  return out;
}

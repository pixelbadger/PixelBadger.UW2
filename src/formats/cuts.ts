import { DataError, ascii, need, s16, u16, u32 } from './bytes';
import { LIMITS } from './limits';

// Cutscene data (UW2/CUTS, UW2/SOUND): DeluxePaint Animator .LPF animations, the .N00 control scripts, LBACK panorama
// backdrops and Creative Voice speech. See docs/CUTSCENES.md for the research these follow.

/** "CS" + octal(n, 3) + ".N" + octal(ext, 2): cutscene 9 ext 8 -> CS011.N10. */
export function cutsName(n: number, ext: number): string {
  const o = (v: number, d: number) => (v & ((1 << (3 * d)) - 1)).toString(8).padStart(d, '0');
  return `CS${o(n, 3)}.N${o(ext, 2)}`;
}

// ---------- LPF ----------

export const LPF_HEADER = 0x80;
const LPF_CRNG = 0x80, LPF_PAL = 0x100, LPF_PAGES = 0x500, LPF_DATA = 0xb00, LPF_PAGE_SIZE = 0x10000;

/** One IFF CRNG colour-cycling range. */
export interface Crng { rate: number; flags: number; low: number; high: number }

export interface Lpf {
  w: number;
  h: number;
  /** Frames in the file, including a trailing loop delta. */
  nFrames: number;
  /** Frames to show (the loop delta, when present, is not one). */
  frames: number;
  fps: number;
  loopDelta: boolean;
  /** RGBA, 8 bits a channel (the file stores BGRx). */
  pal: Uint8Array;
  crng: Crng[];
  /** Applies frame i's delta record to px (w*h indices). Marks written pixels in mask if given. False = no change. */
  decode(i: number, px: Uint8Array, mask?: Uint8Array): boolean;
}

/**
 * DeluxePaint Animator large-page file. Header 128 B (u16 pages @6, u32 records @8, w @0x14, h @0x16, byte @0x1a
 * != 0: the last frame is a loop delta, u32 frames @0x40, u16 fps @0x44), 16 CRNG ranges x 8 B (big-endian u16 pad,
 * rate, flags; u8 low, high), 256 BGRx palette entries, 256 page descriptors x 6 B, then 64K pages from 0xB00:
 * u16 base record, u16 records, u16 bytes, u16 0, u16 sizes[records], records. A record is 2 bytes and a u16 extra
 * length (skipped, rounded even, when byte 1 != 0) followed by run/skip/dump RLE; records of 4 bytes or fewer leave
 * the frame unchanged.
 */
export function readLpf(buf: Uint8Array): Lpf {
  need(buf.length >= LPF_DATA, 'LPF file is truncated');
  need(ascii(buf, 0, 4) === 'LPF ', 'not an LPF animation');
  const pages = u16(buf, 6), w = u16(buf, 0x14), h = u16(buf, 0x16), nFrames = u32(buf, 0x40), fps = u16(buf, 0x44);
  const loopDelta = buf[0x1a]! !== 0;
  need(pages <= 256, `LPF claims ${pages} pages`);
  need(w > 0 && h > 0 && w * h <= LIMITS.maxLpfPixels, `LPF frame ${w}x${h} is implausible`);
  need(nFrames <= LIMITS.maxLpfFrames, `LPF claims ${nFrames} frames`);
  const crng: Crng[] = [];
  for (let i = 0; i < 16; i++) {
    const p = LPF_CRNG + i * 8;
    crng.push({ rate: (buf[p + 2]! << 8) | buf[p + 3]!, flags: (buf[p + 4]! << 8) | buf[p + 5]!, low: buf[p + 6]!, high: buf[p + 7]! });
  }
  const pal = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    const p = LPF_PAL + i * 4;
    pal[i * 4] = buf[p + 2]!; pal[i * 4 + 1] = buf[p + 1]!; pal[i * 4 + 2] = buf[p]!; pal[i * 4 + 3] = 255;
  }
  const desc: { base: number; n: number }[] = [];
  for (let i = 0; i < pages; i++) desc.push({ base: u16(buf, LPF_PAGES + i * 6), n: u16(buf, LPF_PAGES + i * 6 + 2) });

  /** The byte range of record f's RLE data, or null when the frame is unchanged. */
  const record = (f: number): [number, number] | null => {
    const i = desc.findIndex(d => d.base <= f && f < d.base + d.n);
    if (i < 0) return null;
    const pg = LPF_DATA + i * LPF_PAGE_SIZE;
    const base = u16(buf, pg), n = u16(buf, pg + 2), k = f - base;
    need(k >= 0 && k < n, `LPF page ${i} does not hold record ${f}`);
    let off = pg + 8 + n * 2;
    for (let j = 0; j < k; j++) off += u16(buf, pg + 8 + j * 2);
    const size = u16(buf, pg + 8 + k * 2);
    if (size <= 4) return null;
    const end = Math.min(off + size, buf.length);
    let p = off + 4;
    if (buf[off + 1]) { const extra = u16(buf, off + 2); p += extra + (extra & 1); }
    need(p < end, `LPF record ${f} has no data`);
    return [p, end];
  };

  const frames = loopDelta ? Math.max(0, nFrames - 1) : nFrames;
  return {
    w, h, nFrames, frames, fps, loopDelta, pal, crng,
    decode(i, px, mask) {
      need(i >= 0 && i < nFrames, `LPF frame ${i} of ${nFrames}`);
      const r = record(i);
      if (!r) return false;
      runSkipDump(buf, r[0], r[1], px, w * h, mask);
      return true;
    },
  };
}

/**
 * The LPF delta coder. s8 n: n > 0 dump n bytes; 0 run (u8 count, pixel); n < 0 skip n & 0x7f, or when that is 0 a
 * long op: s16 0 ends, > 0 skips, else & 0x7fff: >= 0x4000 runs (count - 0x4000, pixel), else dumps.
 * Every op consumes input and output stays inside the frame, so decoding always terminates.
 */
function runSkipDump(src: Uint8Array, p: number, end: number, px: Uint8Array, size: number, mask?: Uint8Array): void {
  let o = 0;
  const byte = () => { need(p < end, 'LPF record runs past its end'); return src[p++]!; };
  const put = (v: number) => { need(o < size, 'LPF record writes past the frame'); px[o] = v; if (mask) mask[o] = 1; o++; };
  for (;;) {
    const c = byte();
    if (c > 0 && c < 0x80) for (let k = 0; k < c; k++) put(byte());
    else if (c === 0) { const n = byte(), v = byte(); for (let k = 0; k < n; k++) put(v); }
    else if (c & 0x7f) o += c & 0x7f;
    else {
      const lo = byte(), w = s16(lo | (byte() << 8));
      if (w === 0) return;
      if (w > 0) { o += w; continue; }
      const n = w & 0x7fff;
      if (n >= 0x4000) { const v = byte(); for (let k = 0; k < n - 0x4000; k++) put(v); }
      else for (let k = 0; k < n; k++) put(byte());
    }
  }
}

/** Encodes frame `cur` as a delta on `prev` (skips where equal, runs where repeated, dumps elsewhere). */
function encodeDelta(prev: Uint8Array, cur: Uint8Array): number[] {
  const out: number[] = [], n = cur.length;
  const long = (v: number) => out.push(0x80, v & 255, (v >> 8) & 255);
  let i = 0;
  while (i < n) {
    let s = i;
    while (s < n && cur[s] === prev[s]) s++;
    if (s === n) break;
    for (let skip = s - i; skip > 0;) { const k = Math.min(skip, 0x7fff); if (k < 0x80) out.push(0x80 | k); else long(k); skip -= k; }
    i = s;
    let r = i;
    while (r < n && cur[r] === cur[i] && r - i < 0x3fff) r++;
    if (r - i >= 3) {
      const k = r - i;
      if (k < 256) out.push(0, k, cur[i]!); else { long(0x8000 | 0x4000 | k); out.push(cur[i]!); }
      i = r;
      continue;
    }
    let d = i;
    while (d < n && d - i < 0x7f && cur[d] !== prev[d] && !(d + 2 < n && cur[d] === cur[d + 1] && cur[d] === cur[d + 2])) d++;
    if (d === i) d = i + 1;
    out.push(d - i);
    for (let k = i; k < d; k++) out.push(cur[k]!);
    i = d;
  }
  out.push(0x80, 0, 0);
  return out;
}

export interface LpfSpec {
  w: number;
  h: number;
  fps: number;
  /** RGBA palette (1024 bytes); alpha is ignored. */
  pal: Uint8Array;
  crng?: Crng[];
  /** Whole frames; each is stored as a delta on the one before (the first on zeros). */
  frames: Uint8Array[];
  /** Appends a record that turns the last frame back into the first. */
  loopDelta?: boolean;
  /** Records per page (default 256); small values exercise page lookup. */
  perPage?: number;
}

/** Builds an LPF from whole frames: for tests and fixtures. */
export function writeLpf(s: LpfSpec): Uint8Array {
  const recs: number[][] = [];
  let prev: Uint8Array = new Uint8Array(s.w * s.h);
  const all = s.loopDelta && s.frames.length ? [...s.frames, s.frames[0]!] : s.frames;
  for (const f of all) {
    const body = encodeDelta(prev, f);
    recs.push(body.length > 4 ? [0x42, 0, 0, 0, ...body] : [0x42, 0, 0, 0]);
    prev = f;
  }
  const per = Math.max(1, Math.min(256, s.perPage ?? 256));
  const pages: number[][][] = [];
  for (let i = 0; i < recs.length; i += per) pages.push(recs.slice(i, i + per));
  const out = new Uint8Array(LPF_DATA + pages.length * LPF_PAGE_SIZE), dv = new DataView(out.buffer);
  out.set([0x4c, 0x50, 0x46, 0x20]);
  dv.setUint16(4, 256, true); dv.setUint16(6, pages.length, true); dv.setUint32(8, recs.length, true);
  out.set([0x41, 0x4e, 0x49, 0x4d], 0x10);
  dv.setUint16(0x14, s.w, true); dv.setUint16(0x16, s.h, true); out[0x1a] = s.loopDelta ? 1 : 0;
  dv.setUint32(0x40, recs.length, true); dv.setUint16(0x44, s.fps, true);
  (s.crng ?? []).slice(0, 16).forEach((c, i) => { const p = LPF_CRNG + i * 8; dv.setUint16(p + 2, c.rate); dv.setUint16(p + 4, c.flags); out[p + 6] = c.low; out[p + 7] = c.high; });
  for (let i = 0; i < 256; i++) { const p = LPF_PAL + i * 4; out[p] = s.pal[i * 4 + 2]!; out[p + 1] = s.pal[i * 4 + 1]!; out[p + 2] = s.pal[i * 4]!; }
  let base = 0;
  pages.forEach((pg, i) => {
    const bytes = pg.reduce((a, r) => a + r.length, 0);
    if (8 + pg.length * 2 + bytes > LPF_PAGE_SIZE) throw new DataError('LPF page overflow: use a smaller perPage');
    for (const [o, v] of [[0, base], [2, pg.length], [4, bytes]] as const) dv.setUint16(LPF_PAGES + i * 6 + o, v, true);
    const p0 = LPF_DATA + i * LPF_PAGE_SIZE;
    dv.setUint16(p0, base, true); dv.setUint16(p0 + 2, pg.length, true); dv.setUint16(p0 + 4, bytes, true);
    let p = p0 + 8 + pg.length * 2;
    pg.forEach((r, k) => { dv.setUint16(p0 + 8 + k * 2, r.length, true); out.set(r, p); p += r.length; });
    base += pg.length;
  });
  return out;
}

// ---------- the .N00 control script ----------

export interface CutsCmd { frame: number; cmd: number; args: number[] }

/** Arguments per command (UW2). 16 and 17 never occur in UW2 and their shape is unknown. */
export const CUTS_ARGS: Record<number, number> = {
  0: 2, 1: 0, 2: 2, 3: 1, 4: 2, 5: 0, 6: 0, 7: 1, 8: 2, 9: 1, 10: 1, 11: 1, 12: 1, 13: 3, 14: 2, 15: 0,
  18: 4, 19: 3, 20: 3, 21: 2, 22: 3, 23: 3, 24: 1, 25: 1, 26: 1, 27: 1,
};

/** Records {u16 frame, u16 command, u16 args...}. A record cut short at the end of the file is dropped. */
export function readCutsScript(buf: Uint8Array): CutsCmd[] {
  const out: CutsCmd[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const frame = u16(buf, p), cmd = u16(buf, p + 2), n = CUTS_ARGS[cmd];
    if (n === undefined) throw new DataError(`cutscene script: unknown command ${cmd} at ${p}`);
    if (p + 4 + n * 2 > buf.length) break;
    const args: number[] = [];
    for (let i = 0; i < n; i++) args.push(u16(buf, p + 4 + i * 2));
    out.push({ frame, cmd, args });
    if (out.length > LIMITS.maxCutsCommands) throw new DataError('cutscene script is implausibly long');
    p += 4 + n * 2;
  }
  return out;
}

export function writeCutsScript(cmds: CutsCmd[]): Uint8Array {
  const words = cmds.flatMap(c => [c.frame, c.cmd, ...c.args]);
  const out = new Uint8Array(words.length * 2), dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setUint16(i * 2, w & 0xffff, true));
  return out;
}

// ---------- VOC ----------

export interface Voc { rate: number; pcm: Uint8Array }

const VOC_MAGIC = 'Creative Voice File\x1a';

/**
 * Creative Voice File: 20-byte magic, u16 data offset @0x14, then blocks (u8 type, u24 size). Type 1: u8 rate
 * (Hz = 1e6 / (256 - r)), u8 codec (0 = 8-bit unsigned PCM), samples; type 2 continues it; 0 ends. Other block
 * types (silence, markers, text, repeats) are skipped. Mono 8-bit only, as UW2 uses.
 */
export function readVoc(buf: Uint8Array): Voc {
  need(buf.length >= 0x1a && ascii(buf, 0, 20) === VOC_MAGIC, 'not a Creative Voice file');
  let p = u16(buf, 0x14), rate = 0;
  const parts: Uint8Array[] = [];
  let total = 0;
  while (p < buf.length) {
    const type = buf[p]!;
    if (type === 0) break;
    need(p + 4 <= buf.length, 'VOC block header is truncated');
    const size = buf[p + 1]! | (buf[p + 2]! << 8) | (buf[p + 3]! << 16), d = p + 4, end = Math.min(buf.length, d + size);
    if (type === 1) {
      need(size >= 2, 'VOC sound block is too short');
      need(buf[d + 1] === 0, `VOC codec ${buf[d + 1]} is not 8-bit PCM`);
      rate = Math.round(1e6 / (256 - buf[d]!));
      parts.push(buf.subarray(d + 2, end));
    } else if (type === 2) parts.push(buf.subarray(d, end));
    total += type === 1 ? Math.max(0, end - d - 2) : type === 2 ? end - d : 0;
    need(total <= LIMITS.maxVocBytes, 'VOC file is implausibly long');
    p = d + size;
  }
  need(rate > 0, 'VOC file has no sound');
  const pcm = new Uint8Array(total);
  let o = 0;
  for (const s of parts) { pcm.set(s, o); o += s.length; }
  return { rate, pcm };
}

/** One sound block, for tests. `rate` is rounded to what the divisor byte can say. */
export function writeVoc(v: Voc): Uint8Array {
  const out = new Uint8Array(0x1a + 4 + 2 + v.pcm.length + 1);
  for (let i = 0; i < 20; i++) out[i] = VOC_MAGIC.charCodeAt(i);
  out[0x14] = 0x1a; out[0x16] = 0x0a; out[0x17] = 0x01;
  const size = v.pcm.length + 2;
  out.set([1, size & 255, (size >> 8) & 255, size >> 16, Math.max(0, Math.min(255, Math.round(256 - 1e6 / v.rate))), 0], 0x1a);
  out.set(v.pcm, 0x1a + 6);
  return out;
}

/** Seconds of sound in a VOC. */
export const vocSeconds = (v: Voc): number => v.pcm.length / v.rate;

// ---------- raw bitmaps ----------

export const SCREEN_W = 320, SCREEN_H = 200, SCREEN_PX = SCREEN_W * SCREEN_H;

/** LBACKnnn.BYT and BYT.ARK screens: 320x200 palette indices, no header. */
export function readScreen(buf: Uint8Array): Uint8Array {
  need(buf.length >= SCREEN_PX, `a 320x200 screen needs ${SCREEN_PX} bytes, not ${buf.length}`);
  return buf.subarray(0, SCREEN_PX);
}

/** Palette k of PALS.DAT (768-byte VGA palettes, 6 bits a channel) as RGBA, or null past the end. */
export function palsEntry(pals: Uint8Array, k: number): Uint8Array | null {
  if (k < 0 || (k + 1) * 768 > pals.length) return null;
  const out = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) { const v = pals[k * 768 + i * 3 + c]! & 63; out[i * 4 + c] = v * 4 + (v >> 4); }
    out[i * 4 + 3] = 255;
  }
  return out;
}

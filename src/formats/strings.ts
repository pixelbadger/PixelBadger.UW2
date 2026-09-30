import { DataError, need, u16, u32 } from './bytes';
import { LIMITS } from './limits';

export type StringBlocks = Map<number, string[]>;

/**
 * STRINGS.PAK: huffman nodes (char, parent, left, right; root = last; a leaf has left = 255), bits MSB first,
 * each string ends with '|'. Then u16 block count and (u16 id, u32 offset) per block; a block is u16 count, u16 offsets
 * (relative to the end of the offset table), then the bit streams.
 */
export function readStrings(buf: Uint8Array): StringBlocks {
  const nn = u16(buf, 0);
  need(nn > 0 && nn <= LIMITS.maxHuffmanNodes, `STRINGS.PAK claims ${nn} huffman nodes`);
  need(2 + nn * 4 + 2 <= buf.length, 'STRINGS.PAK node table runs past the end of the file');
  const nodes: [number, number, number, number][] = [];
  for (let i = 0; i < nn; i++) { const p = 2 + i * 4; nodes.push([buf[p]!, buf[p + 1]!, buf[p + 2]!, buf[p + 3]!]); }
  const p = 2 + nn * 4, nb = u16(buf, p);
  need(nb <= LIMITS.maxStringBlocks && p + 2 + nb * 6 <= buf.length, `STRINGS.PAK claims ${nb} blocks`);
  const res: StringBlocks = new Map();
  let chars = 0;
  for (let b = 0; b < nb; b++) {
    const id = u16(buf, p + 2 + b * 6), off = u32(buf, p + 2 + b * 6 + 2);
    const ns = u16(buf, off);
    need(off + 2 + ns * 2 <= buf.length, `string block ${id} runs past the end of the file`);
    const strs: string[] = [];
    for (let s = 0; s < ns; s++) {
      let bp = off + 2 + ns * 2 + u16(buf, off + 2 + s * 2), bit = 7, out = '';
      decode: for (let guard = 0; guard < LIMITS.maxStringLength; guard++) {
        let n = nn - 1;
        for (let depth = 0; nodes[n]![2] !== 255; depth++) {
          if (depth > nn || bp >= buf.length) break decode; // a cycle in the tree, or the stream ran off the end
          const v = (buf[bp]! >> bit) & 1;
          if (--bit < 0) { bit = 7; bp++; }
          n = v ? nodes[n]![3] : nodes[n]![2];
          if (n >= nn) break decode;
        }
        const ch = nodes[n]![0];
        if (ch === 124) break;
        out += String.fromCharCode(ch);
      }
      chars += out.length;
      if (chars > LIMITS.maxStringChars) throw new DataError('STRINGS.PAK decodes to too much text');
      strs.push(out);
    }
    res.set(id, strs);
  }
  return res;
}

/** Huffman-encodes string blocks into STRINGS.PAK layout: for tests and fixtures. Strings must be 8-bit and not contain '|';
 * node indices are bytes, so keep the alphabet under ~120 symbols. */
export function writeStrings(blocks: Map<number, string[]>): Uint8Array {
  const freq = new Map<number, number>();
  const bump = (c: number) => freq.set(c, (freq.get(c) ?? 0) + 1);
  bump(124);
  for (const strs of blocks.values()) for (const s of strs) { for (const ch of s) bump(ch.charCodeAt(0) & 255); bump(124); }
  if (freq.size < 2) bump(32);
  // nodes: [char, parent, left, right]; leaves first, internal after, root last
  type N = { ch: number; w: number; l: number; r: number; parent: number; idx: number };
  const all: N[] = [...freq].map(([ch, w]) => ({ ch, w, l: 255, r: 255, parent: 0, idx: 0 }));
  const pool = all.slice();
  while (pool.length > 1) {
    pool.sort((a, b) => a.w - b.w);
    const a = pool.shift()!, b = pool.shift()!;
    const n: N = { ch: 0, w: a.w + b.w, l: -1, r: -1, parent: 0, idx: 0 };
    (n as N & { kids: N[] }).kids = [a, b];
    all.push(n); pool.push(n);
  }
  all.forEach((n, i) => (n.idx = i));
  for (const n of all) {
    const kids = (n as N & { kids?: N[] }).kids;
    if (kids) { n.l = kids[0]!.idx; n.r = kids[1]!.idx; kids[0]!.parent = n.idx; kids[1]!.parent = n.idx; }
  }
  const code = new Map<number, number[]>();
  const walk = (n: N, bits: number[]) => {
    const kids = (n as N & { kids?: N[] }).kids;
    if (!kids) { code.set(n.ch, bits); return; }
    walk(kids[0]!, [...bits, 0]); walk(kids[1]!, [...bits, 1]);
  };
  walk(all[all.length - 1]!, []);
  const bytes: number[] = [];
  const u16w = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  u16w(all.length);
  for (const n of all) bytes.push(n.ch, n.parent, n.l, n.r);
  u16w(blocks.size);
  const dirAt = bytes.length;
  for (let i = 0; i < blocks.size * 6; i++) bytes.push(0);
  let b = 0;
  for (const [id, strs] of blocks) {
    const off = bytes.length;
    const d = dirAt + b * 6; bytes[d] = id & 255; bytes[d + 1] = id >> 8;
    const o = [off & 255, (off >> 8) & 255, (off >> 16) & 255, off >>> 24]; for (let k = 0; k < 4; k++) bytes[d + 2 + k] = o[k]!;
    u16w(strs.length);
    const tab = bytes.length; for (let s = 0; s < strs.length; s++) u16w(0);
    const base = bytes.length;
    strs.forEach((s, si) => {
      const rel = bytes.length - base; bytes[tab + si * 2] = rel & 255; bytes[tab + si * 2 + 1] = rel >> 8;
      const bits: number[] = [];
      for (const ch of s + '|') bits.push(...code.get(ch.charCodeAt(0) & 255)!);
      for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let k = 0; k < 8; k++) v |= (bits[i + k] ?? 0) << (7 - k); bytes.push(v); }
    });
    b++;
  }
  return Uint8Array.from(bytes);
}

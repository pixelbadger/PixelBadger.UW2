import { DataError, need, u16, u32 } from './bytes';
import { uw2Decompress } from './compress';
import { LIMITS } from './limits';

/**
 * UW2 ark container (LEV.ARK, CNV.ARK): u16 block count, u32 pad, then offsets[n], flags[n], datasize[n], availsize[n]
 * (u32 each). flags & 2 = compressed. Missing blocks (offset 0) and blocks that fail to decode are null.
 */
export function readArk(buf: Uint8Array, maxBlock: number = LIMITS.maxDecompressed): (Uint8Array | null)[] {
  const n = u16(buf, 0);
  need(n <= LIMITS.maxArkBlocks, `ark claims ${n} blocks`);
  need(6 + n * 16 <= buf.length, 'ark header runs past the end of the file');
  const blocks: (Uint8Array | null)[] = [];
  for (let i = 0; i < n; i++) {
    const off = u32(buf, 6 + i * 4), flags = u32(buf, 6 + n * 4 + i * 4), size = u32(buf, 6 + n * 8 + i * 4);
    if (!off || off >= buf.length) { blocks.push(null); continue; }
    try {
      if (flags & 2) {
        const avail = u32(buf, 6 + n * 12 + i * 4);
        blocks.push(uw2Decompress(buf.subarray(off, off + Math.max(size, avail)), maxBlock));
      } else {
        if (size > maxBlock) throw new DataError(`ark block ${i} claims ${size} bytes`);
        blocks.push(buf.slice(off, off + size));
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      blocks.push(null);
    }
  }
  return blocks;
}

/** Builds an uncompressed (or literal-compressed) ark: for tests and fixtures. */
export function writeArk(blocks: (Uint8Array | null)[], compress?: (b: Uint8Array) => Uint8Array): Uint8Array {
  const n = blocks.length, head = 6 + n * 16;
  const bodies = blocks.map(b => (b && compress ? compress(b) : b));
  const total = head + bodies.reduce((a, b) => a + (b ? b.length : 0), 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint16(0, n, true);
  let p = head;
  bodies.forEach((b, i) => {
    if (!b) return;
    dv.setUint32(6 + i * 4, p, true);
    dv.setUint32(6 + n * 4 + i * 4, compress ? 2 : 0, true);
    dv.setUint32(6 + n * 8 + i * 4, b.length, true);
    dv.setUint32(6 + n * 12 + i * 4, b.length, true);
    out.set(b, p); p += b.length;
  });
  return out;
}

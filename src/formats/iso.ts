import { DataError, ascii, need, u32 } from './bytes';
import { LIMITS } from './limits';

const SECTOR = 2048;

export interface IsoEntry { name: string; lba: number; size: number; dir: boolean }

/** Lists one ISO 9660 directory. Names are upper-cased without the ";1" version. Entries outside the image are dropped. */
export function isoList(u8: Uint8Array, lba: number, size: number): IsoEntry[] {
  const out: IsoEntry[] = [];
  let p = lba * SECTOR;
  const end = Math.min(u8.length, p + size);
  while (p < end) {
    const len = u8[p]!;
    if (!len) { p = (Math.floor(p / SECTOR) + 1) * SECTOR; continue; }
    if (p + 33 > u8.length) break;
    const nl = u8[p + 32]!;
    const name = ascii(u8, p + 33, nl).split(';')[0]!.toUpperCase();
    const e = { name, lba: u32(u8, p + 2), size: u32(u8, p + 10), dir: !!(u8[p + 25]! & 2) };
    if (e.lba * SECTOR + e.size <= u8.length || e.dir) out.push(e);
    if (out.length > LIMITS.maxIsoEntries) throw new DataError('an ISO directory has too many entries');
    p += len;
  }
  return out;
}

export interface IsoWant {
  /** UW2/DATA files to keep (returns the key to store under, or null). */
  data(name: string): string | null;
  /** UW2/CRIT files to keep. */
  crit(name: string): string | null;
  /** Files directly in UW2/ to keep (the executable holds the furniture models). */
  root(name: string): string | null;
}

/** Pulls the wanted UW2/* files out of an ISO 9660 image. Throws DataError with a player-facing message. */
export function isoExtract(u8: Uint8Array, want: IsoWant): Record<string, Uint8Array> {
  if (u8.length < 0x8000 + 190 || ascii(u8, 0x8001, 5) !== 'CD001') throw new DataError('That file is not an ISO 9660 disc image.');
  const root = isoList(u8, u32(u8, 0x8000 + 156 + 2), u32(u8, 0x8000 + 156 + 10));
  const uw2 = root.find(e => e.dir && e.name === 'UW2');
  const sub = uw2 ? isoList(u8, uw2.lba, uw2.size) : [];
  const data = sub.find(e => e.dir && e.name === 'DATA'), crit = sub.find(e => e.dir && e.name === 'CRIT');
  need(data, 'This disc image has no UW2/DATA folder. Choose the Ultima Underworld I & II disc.');
  const files: Record<string, Uint8Array> = {};
  const grab = (e: IsoEntry, key: string | null) => { if (key && !e.dir) files[key] = u8.slice(e.lba * SECTOR, e.lba * SECTOR + e.size); };
  for (const e of isoList(u8, data.lba, data.size)) grab(e, want.data(e.name));
  if (crit) for (const e of isoList(u8, crit.lba, crit.size)) grab(e, want.crit(e.name));
  for (const e of sub) grab(e, want.root(e.name));
  return files;
}

/** Builds a minimal ISO 9660 image holding UW2/DATA, UW2/CRIT and UW2/*: for tests and fixtures. */
export function writeIso(tree: { data: Record<string, Uint8Array>; crit?: Record<string, Uint8Array>; root?: Record<string, Uint8Array> }): Uint8Array {
  const sectors: Uint8Array[] = [];
  const alloc = (bytes: Uint8Array) => { const lba = 20 + sectors.reduce((a, s) => a + s.length / SECTOR, 0); const n = Math.max(1, Math.ceil(bytes.length / SECTOR)); const s = new Uint8Array(n * SECTOR); s.set(bytes); sectors.push(s); return lba; };
  const rec = (name: string, lba: number, size: number, dir: boolean) => {
    const nm = dir ? name : name + ';1', len = 33 + nm.length + ((33 + nm.length) & 1);
    const r = new Uint8Array(len), dv = new DataView(r.buffer);
    r[0] = len; dv.setUint32(2, lba, true); dv.setUint32(10, size, true); r[25] = dir ? 2 : 0; r[32] = nm.length;
    for (let i = 0; i < nm.length; i++) r[33 + i] = nm.charCodeAt(i);
    return r;
  };
  const dirOf = (entries: Uint8Array[]) => { const size = entries.reduce((a, e) => a + e.length, 0); const b = new Uint8Array(Math.max(SECTOR, size)); let p = 0; for (const e of entries) { b.set(e, p); p += e.length; } return b; };
  const filesDir = (files: Record<string, Uint8Array>) => { const recs = Object.entries(files).map(([n, b]) => rec(n, alloc(b), b.length, false)); const d = dirOf(recs); return { lba: alloc(d), size: d.length }; };
  const data = filesDir(tree.data), crit = filesDir(tree.crit ?? {});
  const rootFiles = Object.entries(tree.root ?? {}).map(([n, b]) => rec(n, alloc(b), b.length, false));
  const uw2d = dirOf([rec('DATA', data.lba, data.size, true), rec('CRIT', crit.lba, crit.size, true), ...rootFiles]);
  const uw2 = { lba: alloc(uw2d), size: uw2d.length };
  const rootd = dirOf([rec('UW2', uw2.lba, uw2.size, true)]);
  const root = { lba: alloc(rootd), size: rootd.length };
  const total = 20 * SECTOR + sectors.reduce((a, s) => a + s.length, 0);
  const out = new Uint8Array(total);
  const pvd = 16 * SECTOR; out[pvd] = 1; for (let i = 0; i < 5; i++) out[pvd + 1 + i] = 'CD001'.charCodeAt(i);
  out.set(rec('\0', root.lba, root.size, true), pvd + 156);
  let p = 20 * SECTOR; for (const s of sectors) { out.set(s, p); p += s.length; }
  return out;
}

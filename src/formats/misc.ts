import { need, u16 } from './bytes';

export interface Glyph { w: number; bit(x: number, y: number): number }
export interface Font { h: number; space: number; g: Glyph[] }

/** .SYS bitmap fonts: u16 ?, charsize, spacewidth, height, rowbytes, maxwidth; then per char rows (MSB first) + width byte. Index = ASCII. */
export function readFont(buf: Uint8Array): Font {
  need(buf.length >= 12, 'font header is truncated');
  const cs = u16(buf, 2), h = u16(buf, 6), rw = u16(buf, 8);
  need(h <= 64 && rw <= 16, 'font glyphs are implausibly large');
  const n = Math.min(256, Math.floor((buf.length - 12) / (cs + 1))), g: Glyph[] = [];
  for (let i = 0; i < n; i++) {
    const o = 12 + i * (cs + 1);
    g.push({ w: buf[o + cs] ?? 0, bit: (x, y) => ((buf[o + y * rw + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1 });
  }
  return { h, space: u16(buf, 4), g };
}

export interface DiscPlayer { name: string; str: number; dex: number; int: number; skills: number[]; vit: [number, number]; mana: [number, number] }

/** PLAYER.DAT (initial, unencrypted). STR/DEX/INT/skills per UA; vitality/mana are two bytes earlier than UA's UW1 layout (unverified). */
export function readPlayer(b: Uint8Array | undefined): DiscPlayer | null {
  if (!b || b.length < 0x40) return null;
  let name = '';
  for (let i = 0; i < 14 && b[i]; i++) name += String.fromCharCode(b[i]!);
  return { name, str: b[0x1e]!, dex: b[0x1f]!, int: b[0x20]!, skills: Array.from(b.subarray(0x21, 0x34)), vit: [b[0x34]!, b[0x35]!], mana: [b[0x36]!, b[0x37]!] };
}

export interface NpcInfo {
  who: number; hp: number; goal: number; gtarg: number; level: number; talked: number; att: number;
  xhome: number; yhome: number; hunger: number;
  /** Inventory already spawned (bit 12 of 0x0D). */
  loot: number;
  /** babl_hack 5's flag. */
  b0a7: number;
}

/**
 * Mobile (NPC) record extras, 27-byte record at a. whoami at 0x1a (UW2; UW1 had it at 0x19). The rest follows UW1's
 * layout, which fits level 0 (home tile matches the record's tile for every NPC; attitude 3 on Britannia's people).
 */
export function readNpc(L: Uint8Array, a: number): NpcInfo {
  need(a + 27 <= L.length, 'NPC record runs past the level');
  const g = u16(L, a + 0xb), d = u16(L, a + 0xd), h = u16(L, a + 0x16);
  return {
    who: L[a + 0x1a]!, hp: L[a + 8]!, goal: g & 15, gtarg: (g >> 4) & 255, level: d & 15, talked: (d >> 13) & 1, att: d >> 14,
    xhome: h >> 10, yhome: (h >> 4) & 63, hunger: L[a + 0x18]! & 127, loot: (d >> 12) & 1, b0a7: (L[a + 0xa]! >> 7) & 1,
  };
}

/** BABGLOBS.DAT: (u16 slot, u16 size) pairs. */
export function readBabGlobs(b: Uint8Array | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (b) for (let p = 0; p + 3 < b.length; p += 4) m.set(u16(b, p), u16(b, p + 2));
  return m;
}

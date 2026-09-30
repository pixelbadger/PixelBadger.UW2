import { need, u16 } from './bytes';
import { LIMITS } from './limits';
import { readNpc, type NpcInfo } from './misc';

/** Bytes a level block must have: tiles (0x4000), 256 mobile records (27 bytes), 768 static records (8 bytes). */
export const LEVEL_BYTES = 0x7300;

export interface Tile {
  /** 0 solid, 1 open, 2 open SE, 3 open SW, 4 open NE, 5 open NW, 6-9 slope rising N, S, E, W. */
  type: number;
  /** Floor height in quarter tiles (0-15). */
  h: number;
  /** Corner heights (sw, se, ne, nw). */
  c: [number, number, number, number];
  floor: number;
  wall: number;
  first: number;
}

/**
 * A level object record. The same shape lives in level lists, inventories, saves and conversations.
 * w0: id bits 0-8, flags 9-12, invisible 14, is_quantity 15. w1: z 0-6, heading 7-9, fy 10-12, fx 13-15.
 * w2: quality 0-5, next 6-15. w3: owner 0-5, link/quantity 6-15.
 */
export interface ObjRec {
  /** Index in the level's object table; -1 for objects made at runtime. */
  i: number;
  isq: number;
  id: number;
  /** The record's invisible bit. */
  invis: number;
  fl: number;
  z: number;
  hd: number;
  fy: number;
  fx: number;
  q: number;
  next: number;
  own: number;
  link: number;
  /** Tile the object sits on (unset for things carried by an NPC). */
  tx: number;
  ty: number;
  /** Level the record came from; -1 for objects made at runtime. */
  lvl: number;
  /** Mobile NPC data (ids 0x40-0x7f). */
  npc?: NpcInfo;
  /** What an NPC carries (its link chain, then spawned loot). */
  items?: ObjRec[];
  /** Conversation-writable fields with no known use yet (x_obj_stuff flag0 / flag1). */
  f0?: number;
  f1?: number;
}

export interface MoveTrigger { x: number; y: number; lv: number }

export interface DecodedLevel {
  tiles: Tile[];
  /** 64 T64 texture indices (0-15 floors, 16-47 walls, 32 ceiling, 48+ bridges) as used by this level. */
  texmap: number[];
  /** DOORS.GR image per door type. */
  doorTex: number[];
  /** Every object reachable from a tile, in tile order. */
  all: ObjRec[];
  /** Furniture, decals and wall objects (see isProp). */
  props: ObjRec[];
  /** Visible loose objects and creatures. */
  objs: ObjRec[];
  doors: ObjRec[];
  /** Move trigger -> teleport trap, keyed by tile index y*64+x. */
  triggers: Map<number, MoveTrigger>;
}

export const objAddr = (i: number): number => (i < 256 ? 0x4000 + i * 27 : 0x5b00 + (i - 256) * 8);

export function readObj(L: Uint8Array, i: number, lvl: number): ObjRec {
  const a = objAddr(i);
  const w0 = u16(L, a), w1 = u16(L, a + 2), w2 = u16(L, a + 4), w3 = u16(L, a + 6);
  const o: ObjRec = {
    i, isq: (w0 >> 15) & 1, id: w0 & 511, invis: (w0 >> 14) & 1, fl: (w0 >> 9) & 15, z: w1 & 127, hd: (w1 >> 7) & 7,
    fy: (w1 >> 10) & 7, fx: (w1 >> 13) & 7, q: w2 & 63, next: w2 >> 6, own: w3 & 63, link: w3 >> 6, tx: 0, ty: 0, lvl,
  };
  if (i < 256 && o.id >= 0x40 && o.id < 0x80) o.npc = readNpc(L, a);
  return o;
}

/**
 * Decodes level block L (with its texture map block TM) into tiles and object lists. isProp decides which static
 * objects become props (it depends on which optional art the disc supplied).
 */
export function decodeLevel(L: Uint8Array, TM: Uint8Array | null | undefined, n: number, isProp: (id: number) => boolean): DecodedLevel {
  need(L.length >= LEVEL_BYTES, `level ${n} block is too short (${L.length} bytes)`);
  const texmap: number[] = [];
  for (let i = 0; i < 64; i++) texmap.push(TM && TM.length >= i * 2 + 2 ? u16(TM, i * 2) : 0);
  const doorTex = TM && TM.length >= 134 ? Array.from(TM.subarray(128, 134)) : [0, 1, 2, 3, 4, 5];
  const tiles: Tile[] = new Array(4096);
  for (let i = 0; i < 4096; i++) {
    const w0 = u16(L, i * 4), w1 = u16(L, i * 4 + 2);
    const type = w0 & 15, h = (w0 >> 4) & 15;
    const c: [number, number, number, number] = [h, h, h, h];
    if (type === 6) { c[2]++; c[3]++; } else if (type === 7) { c[0]++; c[1]++; } else if (type === 8) { c[1]++; c[2]++; } else if (type === 9) { c[0]++; c[3]++; }
    tiles[i] = { type, h, c, floor: texmap[(w0 >> 10) & 15]!, wall: texmap[w1 & 63]!, first: w1 >> 6 };
  }
  const all: ObjRec[] = [], props: ObjRec[] = [], objs: ObjRec[] = [], doors: ObjRec[] = [];
  const triggers = new Map<number, MoveTrigger>(), seen = new Set<number>();
  for (let ty = 0; ty < 64; ty++) for (let tx = 0; tx < 64; tx++) {
    let i = tiles[ty * 64 + tx]!.first;
    while (i && !seen.has(i) && i < 1024) {
      seen.add(i);
      const o = readObj(L, i, n); o.tx = tx; o.ty = ty; all.push(o);
      if (o.id >= 0x140 && o.id < 0x150) doors.push(o);
      else if (o.id === 0x1a0 && o.link) { const t = readObj(L, o.link, n); if (t.id === 0x181) triggers.set(ty * 64 + tx, { x: t.q, y: t.own, lv: t.z ? t.z - 1 : n }); }
      else if (isProp(o.id) && !o.invis) props.push(o);
      else if (o.id < 0x160 && !o.invis) objs.push(o);
      i = o.next;
    }
  }
  // what each visible NPC carries: its link chain
  for (const o of all) if (o.npc && !o.invis) {
    o.items = [];
    const got = new Set<number>();
    let k = o.link;
    while (k && k < 1024 && !got.has(k) && o.items.length < 40 && got.size < LIMITS.maxChain) { got.add(k); const it = readObj(L, k, n); o.items.push(it); k = it.next; }
  }
  return { tiles, texmap, doorTex, all, props, objs, doors, triggers };
}

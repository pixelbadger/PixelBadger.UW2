import type { ObjRec } from '../formats';
import { critByte, critWord, objValue } from '../data/text';
import { randInt } from '../core/rng';
import type { Game } from './game';

// NPC inventories and loot (UnderworldGodot npcloot.cs): spawned the first time anyone looks at what an NPC carries.
// OBJECTS.DAT critter bytes 0x20-0x27 describe the loot.

/** A new object record made at runtime (not from any level's table). */
export function mkObj(game: Game, id: number, q = 40, qty = 0): ObjRec {
  return { i: -1, isq: qty ? 1 : 0, id, invis: 0, fl: 0, z: 0, hd: 0, fy: 3, fx: 3, q, next: 0, own: 0, link: qty || 0, tx: Math.floor(game.pose.x), ty: Math.floor(-game.pose.z), lvl: -1 };
}

/** What an NPC carries, spawning its loot on first look. */
export function npcInv(game: Game, o: ObjRec): ObjRec[] {
  if (!o.items) o.items = [];
  if (o.npc && !o.npc.loot && game.data.files['OBJECTS.DAT']) { o.npc.loot = 1; spawnLoot(game, o); }
  return o.items;
}

function lootQuality(game: Game): number {
  const rr = (n: number) => randInt(game.rng, n), lv = game.L.n + 1;
  return (rr(2) === 0 ? 1 + rr(63) : rr(lv << 2) + (lv << 2)) & 63;
}

function spawnLoot(game: Game, o: ObjRec): void {
  const D = game.data, id = o.id, rr = (n: number) => randInt(game.rng, n);
  const add = (iid: number, q = 40, qty = 0) => o.items!.unshift(mkObj(game, iid, q, qty));
  const mult = critByte(D, id, 0x26) & 15, prob = (critByte(D, id, 0x26) >> 4) & 15, world = game.L.n >> 3;
  if (rr(16) < prob) { // coins or gems
    let t = rr(Math.max(1, 37 - world * 3)) - (30 - world * 3);
    if (t < 0 || t === 1) t = 0;
    let bv = objValue(D, 0xa0 + t) || 1;
    if (bv >= 12) bv = 0xbc + (bv << 3); else if (bv >= 8) bv = (0xec + bv) << 2; else if (bv >= 4) bv = 0xfc + (t << 1);
    let qty = 0;
    if (mult < bv) { if (mult << 2 < rr(bv)) qty = 1; }
    else { const r = (((mult << 2) / bv) | 0) << 1; let d = 0; for (let k = 0; k < 4; k++) d += r ? 1 + rr(r) : 0; qty = d >> 2; }
    if (qty > 0) add(0xa0 + t, 40, qty);
  }
  const f = critByte(D, id, 0x27);
  if (rr(16) < (f & 15)) add(0xb0 + (f >> 4), 40);
  for (let k = 0; k < 2; k++) { // weapons
    const b = critByte(D, id, 0x20 + k);
    if (!(b & 1)) continue;
    const v = (b >> 1) & 0x7f, wid = (((v >> 4) & 3) << 4) + (v & 15);
    add(wid, lootQuality(game), wid >= 0x10 && wid < 0x13 ? 4 + rr(8) : 0);
  }
  for (let k = 0; k < 2; k++) { // other items
    const w = critWord(D, id, 0x22 + k * 2);
    if (rr(16) < (w & 15)) { const iid = (w >> 4) & 0xfff; if (iid && iid < 0x200) add(iid, lootQuality(game)); }
  }
}

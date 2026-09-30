import { writeArk } from '../../src/formats/ark';
import { uw2CompressLiteral } from '../../src/formats/compress';
import { writeGR } from '../../src/formats/gr';
import { writeIso } from '../../src/formats/iso';
import { writeStrings } from '../../src/formats/strings';
import { writeConv } from '../../src/formats/conv';
import { writeComObj, writeObjectsDat } from '../../src/formats/objdat';
import type { GameFiles } from '../../src/data/files';
import { assemble, menu, call, store } from './asm';

// A synthetic "disc": every NEEDED file plus a few OPTIONAL ones, built from scratch with the format writers. It holds
// no game content (no copyrighted data), just enough structure to drive the engine end to end:
//   level 0: a 9x9 room (tiles 28-36), a corridor south to a door and a move trigger that teleports back into the room,
//            Miranda's summons (0x136, the start tile), a sword to pick up, a lever, a bed, and an NPC (whoami 1) to talk to.
//   CNV.ARK slot 1: greets, offers a two-option menu, sets quest 5 on the first answer.

export const ROOM = { x0: 28, x1: 36, y0: 28, y1: 36 };
export const START = { x: 30, y: 30 };
export const SWORD = { x: 31, y: 31 };
export const NPC = { x: 34, y: 34, who: 1 };
export const DOOR = { x: 32, y: 37 };
export const TRIGGER = { x: 32, y: 39, destX: 29, destY: 33 };
export const BED = { x: 35, y: 29 };
/** With { combat: true }: a hostile-minded monster (0x46, attitude 0), a rune bag and two rune stones (In, Lor). */
export const MONSTER = { x: 33, y: 31, id: 0x46, hp: 20 };
export const RUNEBAG = { x: 29, y: 29 };
export const RUNES = { x: 29, y: 30, ids: [0xe8 + 8, 0xe8 + 11] };
/**
 * With { items: true }: a sack (0x80) holding an apple, a torch and a pouch (0x82) with key 5 in it; a leather vest
 * and a leather cap; a red potion whose linked spell object names Lesser Heal (runic spell 11); a barrel holding 12
 * gold coins; and the door locked by a lock (height 4) that key 5 fits.
 */
export const ITEMS = { bag: { x: 30, y: 32 }, armour: { x: 31, y: 33 }, potion: { x: 29, y: 34 }, barrel: { x: 35, y: 33 }, key: 5 };

const u16 = (a: number[] | Uint8Array, o: number, v: number) => { a[o] = v & 255; a[o + 1] = (v >> 8) & 255; };

function level0(combat = false, items = false): Uint8Array {
  const L = new Uint8Array(0x7e08);
  const tile = (x: number, y: number, type: number, h = 0, floor = 1, wall = 2) => { const i = (y * 64 + x) * 4; u16(L, i, type | (h << 4) | (floor << 10)); u16(L, i + 2, wall); };
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) tile(x, y, 0);
  for (let y = ROOM.y0; y <= ROOM.y1; y++) for (let x = ROOM.x0; x <= ROOM.x1; x++) tile(x, y, 1);
  for (let y = ROOM.y1 + 1; y <= TRIGGER.y; y++) tile(DOOR.x, y, 1);
  const first = (x: number, y: number, idx: number) => { const i = (y * 64 + x) * 4 + 2; u16(L, i, (L[i]! | (L[i + 1]! << 8)) & 63 | (idx << 6)); };
  // object record: w0 id | flags<<9 | invis<<14 | isq<<15; w1 z | hd<<7 | fy<<10 | fx<<13; w2 q | next<<6; w3 own | link<<6
  const obj = (i: number, o: { id: number; fl?: number; isq?: number; z?: number; hd?: number; fx?: number; fy?: number; q?: number; next?: number; own?: number; link?: number }) => {
    const a = i < 256 ? 0x4000 + i * 27 : 0x5b00 + (i - 256) * 8;
    u16(L, a, o.id | ((o.fl ?? 0) << 9) | ((o.isq ?? 0) << 15));
    u16(L, a + 2, (o.z ?? 0) | ((o.hd ?? 0) << 7) | ((o.fy ?? 3) << 10) | ((o.fx ?? 3) << 13));
    u16(L, a + 4, (o.q ?? 40) | ((o.next ?? 0) << 6));
    u16(L, a + 6, (o.own ?? 0) | ((o.link ?? 0) << 6));
    return a;
  };
  // NPC: mobile record 1, whoami at 0x1a, hp 0x08, attitude 3 (friendly), home = its tile
  const a = obj(1, { id: 0x40 + 5, hd: 4 });
  L[a + 8] = 30; u16(L, a + 0xd, 3 << 14); u16(L, a + 0x16, (NPC.x << 10) | (NPC.y << 4)); L[a + 0x1a] = NPC.who;
  first(NPC.x, NPC.y, 1);
  obj(257, { id: 0x136 }); first(START.x, START.y, 257);                 // Miranda's summons: the start tile
  obj(258, { id: 0x01 }); first(SWORD.x, SWORD.y, 258);                  // a sword
  obj(259, { id: 0x140, hd: 0, fy: 0, fx: 3, link: items ? 280 : 0 }); first(DOOR.x, DOOR.y, 259); // a door on the tile's south edge
  obj(260, { id: 0x1a0, link: 261 }); first(TRIGGER.x, TRIGGER.y, 260);    // move trigger -> teleport trap
  obj(261, { id: 0x181, q: TRIGGER.destX, own: TRIGGER.destY, z: 0 });
  obj(262, { id: 0x161, hd: 0, fx: 3, fy: 7, z: 40 }); first(33, ROOM.y1, 262); // a lever on the north wall
  obj(263, { id: 0x166, hd: 4, fx: 3, fy: 0, z: 40, isq: 1, link: 0x200 }); first(33, ROOM.y0, 263); // wall writing (block 8, 0)
  obj(264, { id: 0x167 }); first(BED.x, BED.y, 264);                     // a bed
  if (items) {
    obj(268, { id: 0x80, link: 269 }); first(ITEMS.bag.x, ITEMS.bag.y, 268);                // a sack:
    obj(269, { id: 0xb3, q: 40, next: 270 });                                               //   an apple,
    obj(270, { id: 0x91, q: 30, next: 271 });                                               //   an unlit torch,
    obj(271, { id: 0x82, link: 272 });                                                      //   a pouch with
    obj(272, { id: 0x102, own: ITEMS.key });                                                //     key 5
    obj(273, { id: 0x20, q: 40, next: 274 }); obj(274, { id: 0x2c, q: 40 }); first(ITEMS.armour.x, ITEMS.armour.y, 273); // vest, cap
    obj(275, { id: 0xe1, link: 276 }); first(ITEMS.potion.x, ITEMS.potion.y, 275);          // a potion
    obj(276, { id: 0x120, link: 11 });                                                      //   its spell: Lesser Heal
    obj(277, { id: 0x15b, link: 278 }); first(ITEMS.barrel.x, ITEMS.barrel.y, 277);         // a barrel with
    obj(278, { id: 0xa0, isq: 1, link: 12 });                                               //   12 coins
    obj(280, { id: 0x10f, fl: 1, z: 4, link: ITEMS.key });                                  // the door's lock
  }
  if (combat) {
    const m = obj(2, { id: MONSTER.id, hd: 0 }); // attitude 0, goal 0: it attacks once it sees the Avatar
    L[m + 8] = MONSTER.hp; u16(L, m + 0x16, (MONSTER.x << 10) | (MONSTER.y << 4));
    first(MONSTER.x, MONSTER.y, 2);
    obj(265, { id: 0x8f }); first(RUNEBAG.x, RUNEBAG.y, 265);
    obj(266, { id: RUNES.ids[0]!, next: 267 }); obj(267, { id: RUNES.ids[1]! }); first(RUNES.x, RUNES.y, 266);
  }
  return L;
}

function texmap(): Uint8Array {
  const t = new Uint8Array(134);
  for (let i = 0; i < 64; i++) u16(t, i * 2, i % 8);
  for (let i = 0; i < 6; i++) t[128 + i] = i;
  return t;
}

function t64(n: number): Uint8Array {
  const out = new Uint8Array(4 + n * 4 + n * 4096);
  u16(out, 2, n);
  for (let i = 0; i < n; i++) {
    const o = 4 + n * 4 + i * 4096;
    out[4 + i * 4] = o & 255; out[5 + i * 4] = (o >> 8) & 255; out[6 + i * 4] = (o >> 16) & 255;
    for (let p = 0; p < 4096; p++) out[o + p] = 16 + i * 8 + ((p >> 6) ^ p) % 8;
  }
  return out;
}

const img = (w: number, h: number, v: number) => ({ w, h, px: new Uint8Array(w * h).fill(v) });

export function synthStrings(extra: Map<number, string[]> = new Map()): Uint8Array {
  const b1 = Array.from({ length: 300 }, (_, i) => `msg ${i}`);
  b1[13] = 'Welcome to the Labyrinth.'; b1[107] = 'You cannot reach that.'; b1[109] = 'You cannot pick that up.'; b1[168] = 'You see nothing.';
  ['to the North', 'to the Northeast', 'to the East', 'to the Southeast', 'to the South', 'to the Southwest', 'to the West', 'to the Northwest'].forEach((s, i) => (b1[40 + i] = s));
  const b2 = Array.from({ length: 80 }, (_, i) => `Choice ${i}`);
  const b4 = Array.from({ length: 512 }, (_, i) => `a_thing${i}&things`);
  b4[0x01] = 'a_sword&swords'; b4[0x140] = 'a_door&doors'; b4[0x161] = 'a_lever&levers';
  b4[0x46] = 'a_goblin&goblins'; b4[0x8f] = 'a_rune_bag&rune_bags'; b4[0x12] = 'an_arrow&arrows'; b4[0x19] = 'a_bow&bows';
  ['An', 'Bet', 'Corp', 'Des', 'Ex', 'Flam', 'Grav', 'Hur', 'In', 'Jux', 'Kal', 'Lor', 'Mani', 'Nox', 'Ort', 'Por', 'Quas', 'Rel', 'Sanct', 'Tym', 'Uus', 'Vas', 'Wis', 'Ylem']
    .forEach((r, i) => (b4[0xe8 + i] = `an_${r}_stone&${r}_stones`));
  const b6 = Array.from({ length: 330 }, (_, i) => (i >= 256 ? `spell ${i - 256}` : ''));
  b6[256 + 5] = 'Light'; b6[256 + 2] = 'Magic Arrow'; b6[256 + 11] = 'Lesser Heal';
  const b7 = Array.from({ length: 64 }, (_, i) => `line ${i}`);
  b7[0] = 'You cannot talk to that!'; b7[1] = 'You get no response.'; b7[16 + NPC.who] = 'Testa';
  const b8 = ['Beware the slugs.'];
  const b10 = Array.from({ length: 8 }, (_, i) => `a_wall${i}`);
  const convStrings = ['Greetings, @GS8. I am @GS25.', 'Ask about the slugs', 'Leave', 'So be it.', 'Farewell.'];
  const m = new Map<number, string[]>([[1, b1], [2, b2], [3, ['A blank book.']], [4, b4], [6, b6], [7, b7], [8, b8], [10, b10], [0x0e01, convStrings]]);
  for (const [k, v] of extra) m.set(k, v);
  return writeStrings(m);
}

/** The conversation for whoami 1 (see the file comment); the first answer sets `quest` to `value`. */
export function synthConversation(quest = 5, value = 1): Uint8Array {
  const fns = ['babl_menu', 'set_quest'];
  const code = assemble([
    'PUSHI 0', 'SAY_OP',
    ...store(40, 1), ...store(41, 2), ...store(42, 0),
    ...menu('babl_menu', [40]), 'PUSH_REG',
    'PUSHI 1', 'TSTEQ', 'BEQ other',
    ...store(50, quest), ...store(51, value), ...call('set_quest', [51, 50]),
    'PUSHI 3', 'SAY_OP', 'EXIT_OP',
    'other:', 'PUSHI 4', 'SAY_OP', 'EXIT_OP',
  ], { fns });
  return writeConv({ strBlock: 0x0e01, G: 64, imports: fns.map((name, id) => ({ name, id, kind: 'fn', ret: 0 })), code });
}

/** OBJECTS.DAT for the synthetic disc: a sword, fists, a bow and arrows, two spell missiles, the goblin. */
export function synthObjectsDat(): Uint8Array {
  const weapons = Array.from({ length: 16 }, () => ({}));
  weapons[1] = { slash: 8, bash: 6, stab: 7, minCharge: 10, chargeSpeed: 20, maxCharge: 80, skill: 3 };
  weapons[15] = { slash: 2, bash: 2, stab: 2, minCharge: 5, chargeSpeed: 30, maxCharge: 60, skill: 2 };
  const ranged = Array.from({ length: 16 }, () => ({}));
  ranged[2] = { damage: 6, type: 0xc0 };  // 0x12 arrows: skilled ammunition, missile damage (0x40)
  ranged[9] = { type: 2 };                // 0x19 bow: shoots 0x10 + 2
  ranged[7] = { damage: 6, type: 0xfc };  // 0x17 magic arrow: physical
  ranged[4] = { damage: 12, type: 0xf8 }; // 0x14 fireball: fire
  const critters = Array.from({ length: 64 }, () => ({}));
  critters[6] = { avghit: MONSTER.hp, str: 10, defence: 5, baseHit: 4, bleed: 1, corpse: 1, sight: 4, exp: 40, attacks: [{ hit: 12, dmg: 4, prob: 100 }] };
  return writeObjectsDat({ weapons, ranged, critters });
}

/** A minimal CRIT folder: the goblin (0x46) is critter file 0 with no frames, so creatures exist headlessly. */
function synthCrit(): GameFiles {
  const as = new Uint8Array(128).fill(255);
  as[(MONSTER.id - 0x40) * 2] = 0; as[(MONSTER.id - 0x40) * 2 + 1] = 0;
  return { 'CRIT/AS.AN': as, 'CRIT/CR.AN': new Uint8Array(512), 'CRIT/CR00.00': new Uint8Array(0x80 + 512) };
}

/** OBJECTS.DAT with the item tables: armour, a sack of 20 stones' capacity, a pouch for keys only, torch light, food. */
export function synthItemsDat(): Uint8Array {
  const armour = Array.from({ length: 32 }, () => ({}));
  armour[0] = { protection: 3 }; armour[0xc] = { protection: 2 }; armour[0x1c] = { protection: 4 }; // vest, cap, a shield
  const containers = Array.from({ length: 16 }, () => ({ capacity: 0, accepts: -1 }));
  containers[0] = { capacity: 200, accepts: -1 }; containers[1] = { capacity: 200, accepts: -1 }; containers[2] = { capacity: 10, accepts: 516 };
  const lights = Array.from({ length: 16 }, () => ({}));
  lights[5] = { duration: 10, brightness: 3 };
  const food = Array(16).fill(0); food[3] = 30; food[12] = -5;
  const d = writeObjectsDat({ armour, containers, lights, food }), w = synthObjectsDat();
  d.set(w.subarray(2, 0xb2), 2); d.set(w.subarray(0x132, 0xd32), 0x132); // the combat tables as well
  return d;
}

/** Every file the engine reads, synthetic. { combat }: adds the monster, runes, OBJECTS.DAT, COMOBJ.DAT and CRIT; { items }: see ITEMS. */
export function synthFiles(opts: { combat?: boolean; items?: boolean } = {}): GameFiles {
  const pals = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { pals[i * 3] = (i * 7) & 63; pals[i * 3 + 1] = (i * 3) & 63; pals[i * 3 + 2] = (i * 5) & 63; }
  const light = new Uint8Array(4096);
  for (let r = 0; r < 16; r++) for (let c = 0; c < 256; c++) light[r * 256 + c] = r > 12 ? 0 : c;
  const allpals = new Uint8Array(16 * 32);
  for (let i = 0; i < allpals.length; i++) allpals[i] = i & 255;
  const blocks: (Uint8Array | null)[] = Array(320).fill(null);
  blocks[0] = level0(!!opts.combat, !!opts.items); blocks[80] = texmap();
  const objs = Array.from({ length: 512 }, (_, i) => img(8, 8, 32 + (i % 200)));
  const cnv: (Uint8Array | null)[] = Array(2).fill(null);
  cnv[1] = synthConversation();
  return {
    'LEV.ARK': writeArk(blocks, uw2CompressLiteral),
    'T64.TR': t64(8),
    'PALS.DAT': pals,
    'LIGHT.DAT': light,
    'OBJECTS.GR': writeGR(objs),
    'ALLPALS.DAT': allpals,
    'DOORS.GR': writeGR(Array.from({ length: 8 }, (_, i) => img(32, 64, 60 + i))),
    'STRINGS.PAK': synthStrings(),
    'TMOBJ.GR': writeGR(Array.from({ length: 54 }, (_, i) => img(16, 16, 100 + i))),
    'CNV.ARK': writeArk(cnv, uw2CompressLiteral),
    ...(opts.items ? {
      'OBJECTS.DAT': synthItemsDat(),
      'COMOBJ.DAT': writeComObj({ 0x80: { mass: 5 }, 0x82: { mass: 1 }, 0xb3: { mass: 2 }, 0x91: { mass: 10 }, 0x102: { mass: 1 }, 0x20: { mass: 50 }, 0x2c: { mass: 20 }, 0xa0: { mass: 1 }, 0xe1: { mass: 4 }, 0x01: { mass: 60 } }),
    } : {}),
    ...(opts.combat ? {
      ...synthCrit(), 'OBJECTS.DAT': synthObjectsDat(),
      'COMOBJ.DAT': writeComObj({ 1: { radius: 2 }, 15: { radius: 1 }, [MONSTER.id]: { height: 32, radius: 2 }, 127: { height: 24 } }),
    } : {}),
  };
}

/** The synthetic files as an ISO 9660 image laid out like the GOG disc (UW2/DATA). */
export function synthIso(): Uint8Array { return writeIso({ data: synthFiles() }); }

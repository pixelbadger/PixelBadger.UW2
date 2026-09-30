import { at } from './bytes';

// OBJECTS.DAT and COMOBJ.DAT: fixed-size property tables per object id, after UnderworldGodot (hankmorgan's port,
// traced from UW2.EXE: objectdata/*.cs, loaders/comobjloader.cs). The tables have a fixed shape, so decoding never
// allocates by what the file claims: bytes missing from a short file read as 0.
//
// OBJECTS.DAT (u16 header, then):
//   0x002  melee weapons 0x00-0x0f, 8 bytes: slash, bash, stab, min charge, charge speed, max charge, skill, durability
//   0x082  ranged/missiles 0x10-0x1f, 3 bytes: damage, ammo type (launchers) / damage type code, ranged type
//   0x0b2  armour 0x20-0x3f, 4 bytes: protection, durability, ?, slot type
//   0x132  critters 0x40-0x7f, 48 bytes (see CritterDat)
//   0xd32  containers 0x80-0x8f, 3 bytes: capacity (tenths of a stone), s16 accepts (-1 anything; 512 runes,
//          513 missiles and wands, 514 scrolls and books, 515 food, 516 keys; below 512 an object id it refuses)
//   0xd62  light sources 0x90-0x9f, 2 bytes: duration, brightness
//   0xd82  food 0xb0-0xbf, 1 signed byte: nutrition (negative: drink, its strength)
// COMOBJ.DAT: u16 header, then 11 bytes per id 0-511: height; u16 radius bits 0-2 / mass bits 4-15; flags (+3);
//   u16 value (+4); flags incl. quality class bits 2-3 (+6); +7; damage resistances (+8); render type (+9); +10.

export interface WeaponDat { slash: number; bash: number; stab: number; minCharge: number; chargeSpeed: number; maxCharge: number; skill: number; durability: number }
export interface RangedDat { damage: number; ammo: number; type: number }
export interface ArmourDat { protection: number; durability: number; slot: number }
export interface ContainerDat { capacity: number; accepts: number }
export interface LightDat { duration: number; brightness: number }

/** One creature's 48-byte record. Names follow the reference port; unknown bytes are left out. */
export interface CritterDat {
  level: number;
  /** Damage soaked per body part (0-3), signed; -1 = use part 0. */
  toughness: [number, number, number, number];
  /** Average (starting) hit points: the health scale for the "eyes". */
  avghit: number;
  str: number; dex: number; int: number;
  /** Blood (0 = bloodless, e.g. undead), fluids left on death, death sound class. */
  bleed: number; fluids: number;
  /** Faction (byte 9 & 63). */
  faction: number;
  damagesWeapon: boolean; corpse: number; flier: boolean; swimmer: boolean;
  speed: number;
  poison: number;
  /** Added (halved) to every attack's chance to hit. */
  baseHit: number;
  defence: number;
  /** Death sound class (byte 8 & 7: 1 humanoid, 2 creepy-crawly, 3 undead or demon, 4 monster). */
  deathSound: number;
  /** Three attacks: chance to hit, damage, probability (percent). */
  attacks: { hit: number; dmg: number; prob: number }[];
  /** Sight and hearing ranges (nibbles of byte 0x1e). */
  sight: number; hearing: number;
  exp: number;
  /** Spells (runic table index, or 0x40+ for special classes) and whether it casts at all. */
  spells: [number, number, number];
  caster: boolean;
}

export interface ComObj { height: number; radius: number; mass: number; value: number; qualityClass: number; resist: number }

export interface ObjectsDat { weapons: WeaponDat[]; ranged: RangedDat[]; armour: ArmourDat[]; critters: CritterDat[]; containers: ContainerDat[]; lights: LightDat[]; food: number[] }

const s8 = (v: number) => (v << 24) >> 24;
const w16 = (b: Uint8Array, o: number) => at(b, o) | (at(b, o + 1) << 8);

export function readObjectsDat(b: Uint8Array): ObjectsDat {
  const weapons: WeaponDat[] = [], ranged: RangedDat[] = [], armour: ArmourDat[] = [], critters: CritterDat[] = [];
  for (let i = 0; i < 16; i++) {
    const o = 2 + i * 8, g = (k: number) => at(b, o + k);
    weapons.push({ slash: g(0), bash: g(1), stab: g(2), minCharge: g(3), chargeSpeed: g(4), maxCharge: g(5), skill: g(6), durability: g(7) });
  }
  for (let i = 0; i < 16; i++) { const o = 0x82 + i * 3; ranged.push({ damage: at(b, o), ammo: at(b, o + 1), type: at(b, o + 2) }); }
  for (let i = 0; i < 32; i++) { const o = 0xb2 + i * 4; armour.push({ protection: at(b, o), durability: at(b, o + 1), slot: at(b, o + 3) }); }
  for (let i = 0; i < 64; i++) {
    const o = 0x132 + i * 48, g = (k: number) => at(b, o + k);
    critters.push({
      level: g(0), toughness: [s8(g(0)), s8(g(1)), s8(g(2)), s8(g(3))], avghit: g(4), str: g(5), dex: g(6), int: g(7),
      bleed: (g(8) >> 3) & 3, fluids: (g(8) >> 5) & 7, deathSound: g(8) & 7, faction: g(9) & 63,
      damagesWeapon: (g(0xa) & 1) === 1, corpse: (g(0xa) >> 2) & 7, swimmer: ((g(0xa) >> 6) & 1) === 1, flier: ((g(0xa) >> 7) & 1) === 1,
      speed: g(0xc), poison: g(0xf), baseHit: g(0x11), defence: g(0x12),
      attacks: [0, 1, 2].map(k => ({ hit: g(0x13 + k * 3), dmg: g(0x14 + k * 3), prob: g(0x15 + k * 3) })),
      sight: g(0x1e) >> 4, hearing: g(0x1e) & 15, exp: w16(b, o + 0x28),
      spells: [g(0x2a), g(0x2b), g(0x2c)], caster: (g(0x2d) & 1) === 1,
    });
  }
  const containers: ContainerDat[] = [], lights: LightDat[] = [], food: number[] = [];
  for (let i = 0; i < 16; i++) {
    const o = 0xd32 + i * 3;
    containers.push({ capacity: at(b, o), accepts: b.length >= 0xd32 + 48 ? (w16(b, o + 1) << 16) >> 16 : -1 });
    lights.push({ duration: at(b, 0xd62 + i * 2), brightness: at(b, 0xd63 + i * 2) });
    food.push(s8(at(b, 0xd82 + i)));
  }
  return { weapons, ranged, armour, critters, containers, lights, food };
}

export function readComObj(b: Uint8Array): ComObj[] {
  const out: ComObj[] = [];
  for (let id = 0; id < 512; id++) {
    const o = 2 + id * 11, w = w16(b, o + 1);
    out.push({ height: at(b, o), radius: w & 7, mass: (w >> 4) & 0xfff, value: w16(b, o + 4), qualityClass: (at(b, o + 6) >> 2) & 3, resist: at(b, o + 8) });
  }
  return out;
}

// ---------- writers (tests and fixtures) ----------

const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; };

/** Builds OBJECTS.DAT from partial tables (anything left out is 0). */
export function writeObjectsDat(t: {
  weapons?: Partial<WeaponDat>[]; ranged?: Partial<RangedDat>[]; armour?: Partial<ArmourDat>[]; critters?: Partial<CritterDat>[];
  containers?: Partial<ContainerDat>[]; lights?: Partial<LightDat>[]; food?: number[];
}): Uint8Array {
  const b = new Uint8Array(0xd92);
  for (let i = 0; i < 16; i++) put16(b, 0xd32 + i * 3 + 1, 0xffff); // containers take anything unless told otherwise
  put16(b, 0, 0x10f);
  (t.weapons ?? []).slice(0, 16).forEach((w, i) => {
    const o = 2 + i * 8;
    b.set([w.slash ?? 0, w.bash ?? 0, w.stab ?? 0, w.minCharge ?? 0, w.chargeSpeed ?? 0, w.maxCharge ?? 0, w.skill ?? 0, w.durability ?? 0], o);
  });
  (t.ranged ?? []).slice(0, 16).forEach((r, i) => b.set([r.damage ?? 0, r.ammo ?? 0, r.type ?? 0], 0x82 + i * 3));
  (t.armour ?? []).slice(0, 32).forEach((a, i) => b.set([a.protection ?? 0, a.durability ?? 0, 0, a.slot ?? 0], 0xb2 + i * 4));
  (t.critters ?? []).slice(0, 64).forEach((c, i) => {
    const o = 0x132 + i * 48, s = (k: number, v: number) => (b[o + k] = v & 255);
    const tg = c.toughness ?? [c.level ?? 0, 0, 0, 0];
    tg.forEach((v, k) => s(k, v)); // byte 0 is both the level and part 0's toughness
    s(4, c.avghit ?? 0); s(5, c.str ?? 0); s(6, c.dex ?? 0); s(7, c.int ?? 0);
    s(8, (c.deathSound ?? 0) | ((c.bleed ?? 0) << 3) | ((c.fluids ?? 0) << 5));
    s(9, c.faction ?? 0);
    s(0xa, (c.damagesWeapon ? 1 : 0) | ((c.corpse ?? 0) << 2) | (c.swimmer ? 64 : 0) | (c.flier ? 128 : 0));
    s(0xc, c.speed ?? 0); s(0xf, c.poison ?? 0); s(0x11, c.baseHit ?? 0); s(0x12, c.defence ?? 0);
    (c.attacks ?? []).slice(0, 3).forEach((a, k) => { s(0x13 + k * 3, a.hit); s(0x14 + k * 3, a.dmg); s(0x15 + k * 3, a.prob); });
    s(0x1e, ((c.sight ?? 0) << 4) | (c.hearing ?? 0));
    put16(b, o + 0x28, c.exp ?? 0);
    (c.spells ?? [0, 0, 0]).forEach((v, k) => s(0x2a + k, v));
    s(0x2d, c.caster ? 1 : 0);
  });
  (t.containers ?? []).slice(0, 16).forEach((c, i) => { b[0xd32 + i * 3] = c.capacity ?? 0; put16(b, 0xd32 + i * 3 + 1, (c.accepts ?? -1) & 0xffff); });
  (t.lights ?? []).slice(0, 16).forEach((l, i) => b.set([l.duration ?? 0, l.brightness ?? 0], 0xd62 + i * 2));
  (t.food ?? []).slice(0, 16).forEach((f, i) => (b[0xd82 + i] = f & 255));
  return b;
}

/** Builds COMOBJ.DAT from per-id partial records. */
export function writeComObj(recs: Record<number, Partial<ComObj>>): Uint8Array {
  const b = new Uint8Array(2 + 512 * 11);
  for (const [k, r] of Object.entries(recs)) {
    const id = +k;
    if (!(id >= 0 && id < 512)) continue;
    const o = 2 + id * 11;
    b[o] = r.height ?? 0;
    put16(b, o + 1, ((r.radius ?? 0) & 7) | (((r.mass ?? 0) & 0xfff) << 4));
    put16(b, o + 4, r.value ?? 0);
    b[o + 6] = ((r.qualityClass ?? 0) & 3) << 2;
    b[o + 8] = r.resist ?? 0;
  }
  return b;
}

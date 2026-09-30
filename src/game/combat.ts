import type { CritterDat, ObjRec, RangedDat, WeaponDat } from '../formats';
import { S1, nameOf, npcName } from '../data/text';
import { randInt } from '../core/rng';
import { CEILY, CRAD, EYE, RAD } from '../world/constants';
import { segDist } from '../world/collision';
import { MELEE_REACH, startAct, type Critter } from '../world/creatures';
import type { Game } from './game';
import { mkObj, npcInv } from './loot';
import { status } from './magic';
import { viewBasis } from './picking';
import { SK, dice, gainExp, skill, skillCheck } from './rules';
import { SPELLS } from './spells';

// Combat, after UnderworldGodot (hankmorgan's port, traced from UW2.EXE: combat.cs, combat_input.cs, combat_missile.cs,
// damage.cs, npcai.cs, npcdeath.cs). What follows the original and what is ours:
//   ORIGINAL  attack score and base damage (skill + attack/2 + dex/7, str/9 + weapon's slash/bash/stab; unarmed
//             4 + str/6 + unarmed*2/5); the skill check against the defender's defence (criticals double damage);
//             flanking bonus from relative headings; damage as d6s scaled by the swing's charge; per-body-part
//             toughness/armour; resistances (COMOBJ byte 8); easy difficulty (+7 to hit, half damage taken); NPC
//             attacks (chance/damage per attack + str/5, the swing-charge table); XP for kills; Britannia's people
//             cannot be killed; corpses (7 in 16), fluids and loot on death; missile damage and the missile skill.
//   OURS      where the swing lands (a sphere ahead of the attacker, reach from the weapon's COMOBJ radius), charge
//             timing (8 steps a second), creature decisions (4 a second), missile flight (straight, 7 tiles a second),
//             hostility on sight, no weapon wear, no sounds, no blood splashes.

/** Swing types, in OBJECTS.DAT's order: slash, bash, stab. */
export type SwingType = 0 | 1 | 2;
export interface SwingState { stage: 'idle' | 'charging' | 'striking' | 'recover'; type: SwingType; charge: number; acc: number; t: number }
export const newSwing = (): SwingState => ({ stage: 'idle', type: 0, charge: 0, acc: 0, t: 0 });

/** A projectile in flight (tile coordinates: x east, y north, h up). from = null: the Avatar's. */
export interface Missile { x: number; y: number; h: number; dx: number; dy: number; dh: number; id: number; from: Critter | null; life: number }

const FIST = 15;
/** How hard creature swings land, by build-up 0-15. */
const NPC_CHARGE = [0x32, 0x3c, 0x46, 0x50, 0x5a, 0x64, 0x6e, 0x78, 0x82, 0x8c, 0x9b, 0xaa, 0xb9, 0xcd, 0xe6, 0xff];
/** The Britannians (by whoami) who get back up (the original's SpecialDeathCasesUW2). */
const UNKILLABLE = (who: number) => (who >= 0x81 && who <= 0x8f) || who === 0xa8 || who === 0x95;
const MISSILE_SPEED = 7;

// ---------- data, with stand-ins when OBJECTS.DAT is missing ----------

const STANDIN_WEAPON: WeaponDat = { slash: 4, bash: 4, stab: 4, minCharge: 10, chargeSpeed: 12, maxCharge: 60, skill: 3, durability: 0 };
const STANDIN_FIST: WeaponDat = { ...STANDIN_WEAPON, skill: 2 };

function weaponDat(game: Game, id: number): WeaponDat {
  if (!game.data.hasObjDat) return id === FIST ? STANDIN_FIST : STANDIN_WEAPON;
  return game.data.objDat.weapons[id & 15]!;
}
const rangedDat = (game: Game, id: number): RangedDat => game.data.objDat.ranged[id & 15]!;

/** A creature's record, or a plain stand-in (level from the object) without OBJECTS.DAT. */
export function critDat(game: Game, id: number): CritterDat {
  if (game.data.hasObjDat) return game.data.objDat.critters[id & 63]!;
  return { level: 2, toughness: [0, 0, 0, 0], avghit: 20, str: 10, dex: 10, int: 10, bleed: 1, fluids: 0, faction: 0, damagesWeapon: false, corpse: 0, flier: false, swimmer: false, speed: 0, poison: 0, baseHit: 8, defence: 8, attacks: [{ hit: 8, dmg: 4, prob: 100 }, { hit: 0, dmg: 0, prob: 0 }, { hit: 0, dmg: 0, prob: 0 }], sight: 5, hearing: 5, exp: 20, spells: [0, 0, 0], caster: false };
}

/** Height (tiles) of an object id from COMOBJ.DAT, or a fallback. */
const heightOf = (game: Game, id: number, fb: number) => { const h = game.data.comObj[id]!.height; return h ? h / 32 : fb; };

// ---------- the Avatar's weapon ----------

/** The weapon hand's object (right hand unless left-handed). */
export function weaponInHand(game: Game): ObjRec | null { return game.inv.get(game.stats?.hand === 0 ? 'hl' : 'hr'); }
const isLauncher = (id: number) => id === 0x18 || id === 0x19 || id === 0x1a || id === 0x1f;
const isMelee = (id: number) => id < 0x10;

/** The melee weapon in use: the hand's object when it is a melee weapon, else the fist. */
function meleeWeapon(game: Game): number { const o = weaponInHand(game); return o && isMelee(o.id) ? o.id : FIST; }

/** The ammunition a launcher shoots, and the first stack of it carried. */
function ammoFor(game: Game, launcher: number): { id: number; o: ObjRec | undefined } {
  const id = 0x10 + (rangedDat(game, launcher).type & 15);
  return { id, o: game.inv.items().find(x => x.id === id) };
}

// ---------- the Avatar's swing: hold to draw back, release to strike ----------

/** Starts drawing back (fight mode press). Swing type from where on the view (top bash, middle slash, bottom stab). */
export function beginSwing(game: Game, type: SwingType): void {
  const s = game.swing;
  if (game.dead || game.talk || !game.stats || s.stage !== 'idle') return;
  const w = weaponInHand(game);
  if (w && isLauncher(w.id)) {
    const a = ammoFor(game, w.id);
    if (!a.o) { game.say(`${S1(game.data, 207) || 'Sorry, you have no '}${plural(game, a.id)}.`); return; }
  }
  Object.assign(s, { stage: 'charging', type, charge: 0, acc: 0, t: 0 });
}

/** Swing type from a screen point's height (ny: -1 bottom .. 1 top). */
export const swingAt = (ny: number): SwingType => (ny > 1 / 3 ? 1 : ny < -1 / 3 ? 2 : 0);

/** Lets go: a charge short of the weapon's minimum does nothing; a launcher shoots; anything else swings. */
export function releaseSwing(game: Game, aim: [number, number] = [0, 0]): void {
  const s = game.swing;
  if (s.stage !== 'charging') return;
  const w = weaponInHand(game), wd = weaponDat(game, w && isLauncher(w.id) ? w.id : meleeWeapon(game));
  if (s.charge < wd.minCharge) { s.stage = 'idle'; s.charge = 0; return; }
  if (w && isLauncher(w.id)) { shoot(game, w.id, aim); s.stage = 'recover'; s.t = 0.4; return; }
  s.stage = 'striking'; s.t = 0.3;
}

/** Charge build-up and the swing's timing. */
export function tickSwing(game: Game, dt: number): void {
  const s = game.swing;
  if (s.stage === 'charging') {
    const w = weaponInHand(game), wd = weaponDat(game, w && isLauncher(w.id) ? w.id : meleeWeapon(game));
    s.acc += dt;
    while (s.acc >= 1 / 8) { s.acc -= 1 / 8; s.charge = Math.min(100, s.charge + Math.max(1, wd.chargeSpeed)); }
  } else if (s.stage === 'striking') {
    s.t -= dt;
    if (s.t <= 0) { playerStrike(game); s.stage = 'recover'; s.t = 0.3; }
  } else if (s.stage === 'recover') {
    s.t -= dt;
    if (s.t <= 0) { s.stage = 'idle'; s.charge = 0; }
  }
}

const hd8 = (a: number) => ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
/** Bonus for striking from the side or behind (the defender's heading against the attacker's). */
export function flankBonus(defAng: number, atkAng: number): number {
  const b = (hd8(defAng) + 12 - hd8(atkAng)) & 7;
  return b > 4 ? 8 - b : b;
}

/** Body part 0-3 struck, from the heights of the blow and the defender (the original's PickBodyHitPoint). */
export function bodyPart(game: Game, defZ: number, defTop: number, atkZ: number, atkTop: number): number {
  const e = 1 / 32, dm = (defZ + defTop) / 2, am = (atkZ + atkTop) / 2, r = (n: number) => randInt(game.rng, n);
  if (defZ + e > am) return 2;
  if (defTop - e < atkZ) return 3;
  if (am >= dm) { if (r(3) === 0) return 3; }
  else if (r(2) !== 0) return 2;
  return r(3) === 0 ? 1 : 0;
}

/** The swing lands: whoever is nearest in a sphere ahead of the Avatar. */
function playerStrike(game: Game): void {
  const pl = game.stats, L = game.level;
  if (!pl || !L || game.dead) return;
  const P = game.pose, wid = meleeWeapon(game), wd = weaponDat(game, wid), s = game.swing;
  const rad = game.data.comObj[wid]!.radius, reach = (rad + 3) / 8, hitR = (rad + 1) / 8;
  const px = P.x, py = -P.z, fx = px + Math.sin(P.yaw) * reach, fy = py + Math.cos(P.yaw) * reach;
  let best: Critter | null = null, bd = Infinity;
  for (const c of L.critters) {
    if (c.dying) continue;
    const r = Math.max(CRAD, game.data.comObj[c.o.id]!.radius / 8);
    if (Math.hypot(c.x - fx, c.y - fy) > hitR + r + 0.2) continue;
    const d = Math.hypot(c.x - px, c.y - py);
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) return;
  const st = status(game), sk = wd.skill >= 6 || wid === FIST ? SK.unarmed : wd.skill;
  const score = skill(pl, sk) + (skill(pl, SK.attack) >> 1) + Math.trunc(pl.dex / 7) + st.valour + (pl.diff === 1 ? 7 : 0);
  let dmg = sk === SK.unarmed ? 4 + Math.trunc(pl.str / 6) + Math.trunc((skill(pl, SK.unarmed) << 1) / 5) : Math.trunc(pl.str / 9) + [wd.slash, wd.bash, wd.stab][s.type]!;
  const charge = wd.minCharge + Math.trunc(((wd.maxCharge - wd.minCharge) * s.charge) / 100);
  const H = heightOf(game, 127, 0.75), atkZ = P.y + (H * Math.trunc([5, 8, 2][s.type]! / 3)) / 3 + P.pitch * 0.3;
  const part = bodyPart(game, best.h, best.h + heightOf(game, best.o.id, 0.8), atkZ, atkZ + ((rad * 2 + 1) * 4) / 32);
  const cd = critDat(game, best.o.id);
  if (st.poisonWeapon && cd.bleed && wid !== FIST) dmg += Math.trunc((skill(pl, SK.casting) + 30) / 40);
  const flank = flankBonus(best.ang, P.yaw);
  const r = skillCheck(game.rng, score + flank, cd.defence);
  if (r === 2) dmg *= (48 + randInt(game.rng, 30)) >> 5;
  if (r <= 0) { provoke(game, best); return; }
  finalDamage(game, null, best, dmg, charge, flank, part, 4);
}

// ---------- damage ----------

/** Damage after resistances (the original's ScaleDamageUW2): 1/2 magic, 4 physical, 8 fire, 0x10 poison, 0x20 ice, 0x40 missiles. */
export function scaleDamage(game: Game, resist: number, n: number, type: number): number {
  if (resist & type) {
    if (type & 3) { if (randInt(game.rng, 3) >= (resist & 3)) type &= 0xfc; else return 0; }
    if (resist & type) return 0;
  }
  if (type & 8 && resist & 0x20) return Math.min(127, n * 2);
  if (!(type & 0x20) || !(resist & 8) || (resist & 0x28) === 0x28) return n;
  return Math.min(127, n * 2);
}

/** Rolls a hit's damage (d6s, scaled by the charge out of 128), takes off armour and applies it. */
function finalDamage(game: Game, from: Critter | null, to: Critter | null, base: number, charge: number, flank: number, part: number, type: number): void {
  base = Math.max(2, base);
  const q = Math.trunc(base / 6), rem = base % 6;
  const roll = (q ? dice(game.rng, q, 6) : 0) + (rem ? dice(game.rng, 1, rem) : 0);
  let fin = ((roll * charge) >> 7) + flank;
  if (to) {
    const t = critDat(game, to.o.id).toughness;
    let a = t[part & 3]!;
    if (a === -1) a = t[0]!;
    fin = Math.max(0, fin - a);
    damageCritter(game, to, fin, type, !from);
  } else {
    fin = Math.max(0, fin - status(game).armour[part & 3]!);
    if (game.stats?.diff === 1) fin >>= 1;
    damagePlayer(game, fin, type);
  }
}

/** A creature the Avatar attacked turns on the Avatar. */
function provoke(game: Game, c: Critter): void {
  const n = c.o.npc;
  if (n && !(n.goal === 5 && n.gtarg === 1)) { n.att = 0; n.goal = 5; n.gtarg = 1; }
}

export function damageCritter(game: Game, c: Critter, n: number, type: number, byPlayer: boolean): void {
  const npc = c.o.npc;
  if (!npc || c.dying) return;
  n = scaleDamage(game, game.data.comObj[c.o.id]!.resist, n, type);
  npc.hp = Math.max(0, npc.hp - n);
  if (byPlayer) { provoke(game, c); game.ui.foeHealth(npc.hp, critDat(game, c.o.id).avghit || npc.hp || 1); }
  if (npc.hp === 0) kill(game, c, byPlayer);
}

function kill(game: Game, c: Critter, byPlayer: boolean): void {
  const npc = c.o.npc!, cd = critDat(game, c.o.id);
  if (UNKILLABLE(npc.who) && !npc.b0a7 && !(npc.who === 0x8d && (game.conv.c[1] ?? 0) >= 8)) { // Lady Tori may die once x_clock 1 reaches 8
    npc.hp = Math.max(1, Math.trunc(cd.avghit / 3) - 1);
    return;
  }
  c.dying = true; c.act = undefined;
  startAct(c, 7);
  if (byPlayer) {
    const e = cd.exp;
    game.say(`You have killed ${npc.who ? npcName(game.data, npc.who, c.o) : nameOf(game.data, c.o.id)}.`);
    gainExp(game, e + dice(game.rng, 2, e));
  }
}

/** The death animation ended: the body leaves the level, dropping what it carried, maybe a corpse and fluids. */
export function removeDead(game: Game, c: Critter): void {
  const L = game.L, o = c.o, cd = critDat(game, o.id);
  L.critters.splice(L.critters.indexOf(c), 1);
  const at = L.objs.indexOf(o);
  if (at >= 0) L.objs.splice(at, 1);
  const tx = Math.floor(c.x), ty = Math.floor(c.y), z = Math.round((L.floorAt(c.x, -c.y) ?? c.h) * 32);
  const place = (it: ObjRec) => {
    Object.assign(it, { tx, ty, lvl: L.n, z: Math.max(0, Math.min(127, z)), fx: Math.max(0, Math.min(7, Math.floor((c.x - tx) * 8) + randInt(game.rng, 3) - 1)), fy: Math.max(0, Math.min(7, Math.floor((c.y - ty) * 8) + randInt(game.rng, 3) - 1)) });
    L.objs.push(it);
  };
  for (const it of npcInv(game, o).splice(0)) place(it);
  if (cd.fluids) place(mkObj(game, 0xd9 + cd.fluids));
  if (cd.corpse && L.n >> 3 !== 7 && randInt(game.rng, 16) < 7) place(mkObj(game, 0xc0 + cd.corpse));
  game.refreshObjects();
}

export function damagePlayer(game: Game, n: number, type: number): void {
  const pl = game.stats;
  if (!pl || game.dead) return;
  n = scaleDamage(game, game.data.comObj[127]!.resist | status(game).proof, n, type);
  if (!n) return;
  pl.vit[0] = Math.max(0, pl.vit[0] - n);
  game.ui.hurt(n);
  game.ui.playerChanged();
  if (pl.vit[0] <= 0) die(game);
}

function die(game: Game): void {
  game.dead = true;
  game.swing = newSwing();
  game.say('You have died.');
  game.ui.died();
}

// ---------- creatures' side ----------

function inSight(game: Game, c: Critter, range: number): boolean {
  const L = game.L, P = game.pose, px = P.x, py = -P.z, d = Math.hypot(px - c.x, py - c.y);
  if (d > range) return false;
  const top = Math.max(c.h, P.y) + 1.2;
  for (let s = 0.25; s < d; s += 0.25) {
    const x = c.x + ((px - c.x) * s) / d, y = c.y + ((py - c.y) * s) / d, f = L.floorAt(x, -y);
    if (f == null || f > top) return false;
  }
  return true;
}

/** Is c fighting the Avatar? A hostile-minded creature (attitude 0) starts when it sees the Avatar (ours: range from its sight nibble). */
export function isHostile(game: Game, c: Critter, d: number): boolean {
  const n = c.o.npc;
  if (!n || game.dead || !game.stats || c.dying) return false;
  if (n.goal === 5 && n.gtarg === 1) return true;
  if (n.att !== 0) return false;
  const cd = critDat(game, c.o.id);
  if (d <= Math.min(8, Math.max(3, cd.sight)) && inSight(game, c, 8)) { n.goal = 5; n.gtarg = 1; return true; }
  return false;
}

/** A creature's projectile spell (UW2's table: magic arrow, lightning, fireball, acid, homing dart, snowball), or 0. */
function npcMissile(game: Game, cd: CritterDat): number {
  if (!cd.caster) return 0;
  for (const s of cd.spells) {
    if (!s || s & 0xc0) continue;
    const sp = SPELLS[s];
    if (sp && sp[0] === 5) return missileOfSpell(sp[1]);
  }
  return 0;
}

/** Which attack a creature makes: out of reach, a projectile spell if it has one (and sight); in reach, one of its three by their odds. */
export function pickAttack(game: Game, c: Critter, d: number): number {
  const cd = critDat(game, c.o.id);
  if (d > MELEE_REACH) return npcMissile(game, cd) && d < 8 && inSight(game, c, 8) ? -1 : 0;
  const w = cd.attacks.map(a => (a.dmg || a.hit ? Math.max(1, a.prob) : 0)), tot = w.reduce((a, b) => a + b, 0);
  if (!tot) return 0;
  let r = randInt(game.rng, tot);
  for (let k = 0; k < 3; k++) { r -= w[k]!; if (r < 0) return k; }
  return 0;
}

/** A creature's attack reaches its striking frame. */
export function npcStrike(game: Game, c: Critter, n: number): void {
  const pl = game.stats;
  if (!pl || game.dead || c.dying) return;
  const cd = critDat(game, c.o.id), P = game.pose;
  if (n < 0) {
    const id = npcMissile(game, cd);
    if (!id) return;
    const h0 = c.h + heightOf(game, c.o.id, 0.8) * 0.6, dx = P.x - c.x, dy = -P.z - c.y, dh = P.y + 0.5 - h0, l = Math.hypot(dx, dy, dh) || 1;
    launch(game, c, id, c.x + (dx / l) * 0.3, c.y + (dy / l) * 0.3, h0, [dx / l, dy / l, dh / l]);
    return;
  }
  const charge = NPC_CHARGE[c.swing ?? 0]!;
  c.swing = 0;
  if (Math.hypot(P.x - c.x, -P.z - c.y) > MELEE_REACH + 0.25) return; // stepped out of reach
  const a = cd.attacks[n] ?? cd.attacks[0]!;
  const dmg = a.dmg + Math.trunc(cd.str / 5), st = status(game);
  const H = heightOf(game, c.o.id, 0.8), atkZ = c.h + H / 3;
  const part = bodyPart(game, P.y, P.y + heightOf(game, 127, 0.75), atkZ, atkZ + 12 / 32);
  const score = a.hit + (cd.baseHit >> 1) - st.protect[part]!, flank = flankBonus(P.yaw, c.ang);
  let d = dmg;
  const r = skillCheck(game.rng, score + flank, skill(pl, SK.defense));
  if (r <= 0) return;
  if (r === 2) d *= (48 + randInt(game.rng, 30)) >> 5;
  finalDamage(game, c, null, d, charge, flank, part, 4);
  if (cd.poison && game.poison < cd.poison && randInt(game.rng, 6 + cd.poison) > st.armour[part]! && scaleDamage(game, game.data.comObj[127]!.resist | st.proof, 1, 0x10)) game.poison = cd.poison;
}

// ---------- missiles ----------

/** UW2's projectile spells by minor class 1-6, as missile object ids (0x10 + the original's table 7, 5, 4, 6, 0xb, 0xc). */
const SPELL_MISSILES = [0x17, 0x15, 0x14, 0x16, 0x1b, 0x1c];
export const missileOfSpell = (minor: number): number => SPELL_MISSILES[minor - 1] ?? 0;

export function launch(game: Game, from: Critter | null, id: number, x: number, y: number, h: number, dir: [number, number, number]): void {
  game.missiles.push({ x, y, h, dx: dir[0] * MISSILE_SPEED, dy: dir[1] * MISSILE_SPEED, dh: dir[2] * MISSILE_SPEED, id, from, life: 3 });
}

/** Direction (tiles: east, north, up) through screen point (nx, ny). */
export function aimDir(game: Game, nx: number, ny: number): [number, number, number] {
  const { aspect, fovY } = game.view, t = Math.tan(fovY / 2), { F, R, U } = viewBasis(game.pose.yaw, game.pose.pitch);
  const d = [0, 1, 2].map(i => F[i]! + R[i]! * nx * t * aspect + U[i]! * ny * t), l = Math.hypot(...d) || 1;
  return [d[0]! / l, -d[2]! / l, d[1]! / l];
}

/** The Avatar launches a missile object along the aim. */
export function playerLaunch(game: Game, id: number, aim: [number, number]): void {
  const P = game.pose, d = aimDir(game, aim[0], aim[1]);
  launch(game, null, id, P.x + d[0] * 0.3, -P.z + d[1] * 0.3, P.y + EYE - 0.1 + d[2] * 0.3, d);
}

function shoot(game: Game, launcher: number, aim: [number, number]): void {
  const a = ammoFor(game, launcher);
  if (!a.o) return;
  if (a.o.isq && a.o.link > 1 && a.o.link < 0x200) a.o.link--;
  else game.inv.remove(a.o);
  game.ui.inventoryChanged();
  playerLaunch(game, a.id, aim);
}

function missileHit(game: Game, m: Missile, to: Critter | null): void {
  const rd = rangedDat(game, m.id), pl = game.stats;
  let dmg = game.data.hasObjDat ? rd.damage : 6;
  if (!m.from && pl && rd.type === 0xc0) { // shot ammunition: the missile skill scales it
    let mult = (skill(pl, SK.missile) << 3) + 0xc0;
    const r = skillCheck(game.rng, skill(pl, SK.missile), 10);
    if (r === -1) mult -= 0x80; else if (r === 2) mult += 0xc0;
    dmg = (dmg * mult) >> 8;
  }
  const type = (256 - rd.type) & 255, P = game.pose;
  const part = to ? bodyPart(game, to.h, to.h + heightOf(game, to.o.id, 0.8), m.h, m.h + 0.1) : bodyPart(game, P.y, P.y + 0.75, m.h, m.h + 0.1);
  finalDamage(game, m.from, to, dmg, 0x80, 0, part, type || 4);
}

export function tickMissiles(game: Game, dt: number): void {
  const L = game.L, P = game.pose, px = P.x, py = -P.z;
  game.missiles = game.missiles.filter(m => {
    m.life -= dt;
    if (m.life <= 0) return false;
    const steps = Math.max(1, Math.ceil((MISSILE_SPEED * dt) / 0.1));
    for (let i = 0; i < steps; i++) {
      m.x += (m.dx * dt) / steps; m.y += (m.dy * dt) / steps; m.h += (m.dh * dt) / steps;
      const f = L.floorAt(m.x, -m.y);
      if (f == null || m.h < f || m.h > CEILY) return false;
      for (const [p, q] of L.scene.doorSegs) if (segDist(p, q, m.x, m.y) < 0.08) return false;
      for (const c of L.critters) {
        if (c === m.from || c.dying) continue;
        if (Math.hypot(c.x - m.x, c.y - m.y) < 0.3 && m.h >= c.h - 0.05 && m.h <= c.h + heightOf(game, c.o.id, 0.8) + 0.1) { missileHit(game, m, c); return false; }
      }
      if (m.from && Math.hypot(px - m.x, py - m.y) < RAD + 0.12 && m.h >= P.y - 0.05 && m.h <= P.y + 0.85) { missileHit(game, m, null); return false; }
    }
    return true;
  });
}

// ---------- helpers ----------

function plural(game: Game, id: number): string {
  const s = game.data.names[id] ?? '', p = s.split('&')[1];
  return (p || nameOf(game.data, id) + 's').replace(/_/g, ' ').trim();
}

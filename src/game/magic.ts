import { S1, nameOf } from '../data/text';
import { randInt } from '../core/rng';
import type { Critter } from '../world/creatures';
import { damagePlayer, missileOfSpell, playerLaunch } from './combat';
import { SPELLS } from './spells';
import type { Game } from './game';
import { mkObj } from './loot';
import { pick } from './picking';
import { SK, dice, heal, levelOf, restoreMana, skill, skillCheck } from './rules';

// Runic magic, after UnderworldGodot (runicmagic.cs, spellcasting*.cs, playerdatloop.cs), traced from UW2.EXE.
//   Runes: 24 (An .. Ylem), known once a rune stone (0xE8 + rune) goes into the rune bag (0x8F). Up to three sit on the
//   shelf; casting looks the triplet up in SPELLS (rune0 << 10 | rune1 << 5 | rune2, 24 = empty).
//   Rules (original): circle = 1 + index / 8; mana 3 x circle; the Avatar needs level >= 2 x circle - 1; circles 3+
//   fail in Britannia; Casting skill vs 3 x circle: critical failure backfires (a curse), failure fizzles (no mana
//   spent), success casts; a pause before the next cast. Up to three lasting effects, each losing one point of
//   stability every 20 seconds (light 3d24 points, others 2d3 or 2d8 by the spell's bits 6-7).
//   Built: light (0), motion (1: leap, slow fall, levitate, fly), resistance (2), luck / x-proof / poison weapon /
//   valour (3), healing (4), projectiles (5), paralyze (7/5), create food (8/1), curses (9), mana (10), speed (11/0).
//   Everything else says it is not built and costs nothing.


export { SPELLS };
export const RUNE_STONE = 0xe8, RUNE_BAG = 0x8f, NO_RUNE = 24;
export const isRuneStone = (id: number): boolean => id >= RUNE_STONE && id < RUNE_STONE + 24;

export interface Effect { major: number; minor: number; stab: number }
/** A spell waiting for the Avatar to point: a projectile, or a spell cast on a creature. */
export interface Pending { major: number; minor: number; cost: number; name: string }
export interface MagicState {
  /** Runes in the bag. */
  runes: boolean[];
  /** The shelf: up to three rune numbers. */
  shelf: number[];
  effects: Effect[];
  pending: Pending | null;
  /** Game clock (game.minutes) before which another spell cannot be cast. */
  ready: number;
}
export const newMagic = (): MagicState => ({ runes: Array(24).fill(false), shelf: [], effects: [], pending: null, ready: 0 });

export const circleOf = (i: number): number => { const c = 1 + (i >> 3); return c > 8 ? 1 : c; };
export const spellName = (game: Game, i: number): string => game.data.str(6, 256 + i).trim() || `spell ${i}`;
export const runeName = (game: Game, r: number): string => nameOf(game.data, RUNE_STONE + r).replace(/^(an?|the) /, '').replace(/ ?(rune ?)?stone$/i, '');

/** The spell index the shelf spells, or -1. */
export function shelfSpell(shelf: number[]): number {
  if (!shelf.length) return -1;
  const r = (k: number) => shelf[k] ?? NO_RUNE, seq = (r(0) << 10) | (r(1) << 5) | r(2);
  return SPELLS.findIndex(s => s[2] === seq && seq !== 25368);
}

// ---------- the rune bag and the shelf ----------

/** Puts a rune stone into the bag (the stone is used up). */
export function addRune(game: Game, r: number): void {
  if (r < 0 || r >= 24) return;
  game.magic.runes[r] = true;
  game.ui.magicChanged();
}

/** Adds a known rune to the shelf; a full shelf shifts left (as the original). */
export function selectRune(game: Game, r: number): void {
  const m = game.magic;
  if (!m.runes[r]) return;
  if (m.shelf.length >= 3) m.shelf.shift();
  m.shelf.push(r);
  game.ui.magicChanged();
}
export function clearShelf(game: Game): void { game.magic.shelf = []; game.ui.magicChanged(); }

const BUILT: Record<number, (minor: number) => boolean> = {
  0: () => true, 1: m => [1, 2, 3, 5].includes(m), 2: () => true, 3: m => [1, 5, 6, 7, 8, 9, 0xb, 0x10].includes(m),
  4: () => true, 5: m => m >= 1 && m <= 6, 7: m => m === 5, 8: m => m === 1, 9: () => true, 10: () => true, 11: m => m === 0,
};
export const isBuilt = (major: number, minor: number): boolean => !!BUILT[major]?.(minor & 0x3f);

// ---------- casting ----------

/** Casts what is on the shelf, under the original's rules. */
export function castShelf(game: Game): void {
  const pl = game.stats, m = game.magic, D = game.data;
  if (!pl || game.dead || game.talk) return;
  if (!m.shelf.length) { game.say('Choose runes from your rune bag first.'); return; }
  if (game.minutes < m.ready) { game.say(S1(D, 11) || 'You are not ready to cast another spell yet.'); return; }
  const i = shelfSpell(m.shelf);
  if (i < 0) { game.say('Not a spell.'); return; }
  const [major, minor] = SPELLS[i]!, c = circleOf(i), cost = c * 3, name = spellName(game, i);
  if (game.L.n >> 3 === 0 && c >= 3) { game.say(S1(D, 227) || 'The incantation failed.'); return; }
  if ((levelOf(pl) + 1) >> 1 < c) { game.say(S1(D, 225) || 'You are not experienced enough to cast spells of that circle.'); return; }
  if (pl.mana[0] < cost) { game.say(S1(D, 226) || 'You do not have enough mana to cast the spell.'); return; }
  if (!isBuilt(major, minor)) { game.say(`${cap(name)}: this spell is not built yet.`); return; }
  const r = skillCheck(game.rng, skill(pl, SK.casting), c * 3);
  if (r !== 0) m.ready = game.minutes + ((((c << 1) - levelOf(pl)) << 2) + 0x80 & 255) / 64; // ours: the original's delay byte read as 1/64 s
  if (r === 0) { game.say(S1(D, 227) || 'The incantation failed.'); return; }
  if (r === -1) { curse(game, c >> 1); spend(game, cost); game.say(S1(D, 229) || 'The spell backfires.'); return; }
  castSpell(game, major, minor, cost, name);
}

function spend(game: Game, n: number): void {
  const pl = game.stats!;
  pl.mana[0] = Math.max(0, pl.mana[0] - n);
  game.ui.playerChanged();
}

/** Applies a spell (the original's CastSpell for the classes built here). */
export function castSpell(game: Game, major: number, minor: number, cost: number, name: string): void {
  const pl = game.stats!;
  switch (major) {
    case 0: case 1: case 2: case 3: addEffect(game, major, minor); break;
    case 4:
      pl.vit[0] = minor === 15 ? pl.vit[1] : Math.min(pl.vit[1], pl.vit[0] + dice(game.rng, minor, 8));
      game.ui.playerChanged();
      break;
    case 5: case 7:
      game.magic.pending = { major, minor, cost, name };
      game.say(major === 5 ? `Point where to release ${name}.` : `Point at the one to cast ${name} on.`);
      game.ui.magicChanged();
      return; // the mana goes when it is released
    case 8: if (!createFood(game)) return; break;
    case 9: curse(game, minor); break;
    case 10: restoreMana(game, minor); break;
    case 11: addEffect(game, 11, 2 | (minor & 0xc0)); break; // speed is kept as enchantment 11/2, as the original
  }
  spend(game, cost);
  game.say(`You cast ${name}.`);
}

/** A lasting effect (at most three); stability by the minor class's bits 6-7. */
function addEffect(game: Game, major: number, minor: number): void {
  const m = game.magic;
  if (m.effects.length >= 3) { game.say(S1(game.data, 287) || 'The spell has no discernable effect.'); return; }
  const b = minor & 0xc0, stab = b === 0x80 ? dice(game.rng, 3, 24) : b === 0x40 ? dice(game.rng, 2, 8) : dice(game.rng, 2, 3);
  m.effects.push({ major, minor: minor & 0x3f, stab });
  game.ui.magicChanged();
}

function curse(game: Game, minor: number): void {
  const pl = game.stats!, d = dice(game.rng, minor, 8);
  pl.vit[0] = Math.max(Math.min(pl.vit[0], 3), pl.vit[0] - d);
  game.ui.hurt(d);
  game.ui.playerChanged();
}

function createFood(game: Game): boolean {
  const L = game.L, P = game.pose, x = P.x + Math.sin(P.yaw) * 0.6, y = -P.z + Math.cos(P.yaw) * 0.6, f = L.floorAt(x, -y);
  if (f == null) { game.say('There is no room to create that.'); return false; }
  const o = mkObj(game, 0xb0 + randInt(game.rng, 7));
  Object.assign(o, { tx: Math.floor(x), ty: Math.floor(y), fx: Math.min(7, Math.floor((x % 1) * 8)), fy: Math.min(7, Math.floor((y % 1) * 8)), z: Math.round(f * 32), lvl: L.n });
  L.objs.push(o);
  game.refreshObjects();
  return true;
}

/** Releases a pending spell at screen point (nx, ny). */
export function releasePending(game: Game, nx: number, ny: number): void {
  const p = game.magic.pending;
  if (!p) return;
  game.magic.pending = null;
  game.ui.magicChanged();
  if (p.major === 5) {
    playerLaunch(game, missileOfSpell(p.minor), [nx, ny]);
    spend(game, p.cost);
    return;
  }
  const h = pick(game, nx, ny), c = h && h.kind === 'obj' ? h.sp.crit : undefined;
  spend(game, p.cost);
  if (!c) { game.say(S1(game.data, 287) || 'The spell has no discernable effect.'); return; }
  paralyse(game, c);
}

function paralyse(game: Game, c: Critter): void {
  if (game.data.comObj[c.o.id]!.resist & 0x80) { game.say(S1(game.data, 287) || 'The spell has no discernable effect.'); return; }
  const dur = 0x10 + randInt(game.rng, 16) * Math.trunc(skill(game.stats!, SK.casting) / 3);
  c.para = dur / 8; c.act = undefined; // ours: the original's duration counted in eighths of a second
}

/** Ends an effect early (a tap on its icon). Levitate and fly become slow fall, as the original. */
export function cancelEffect(game: Game, k: number): void {
  const e = game.magic.effects[k];
  if (!e) return;
  if (e.major === 1 && (e.minor === 3 || e.minor === 5)) e.minor = 2;
  else game.magic.effects.splice(k, 1);
  game.ui.magicChanged();
}

// ---------- what the effects add up to ----------

export interface Status {
  /** Magical light level (0 none). */
  light: number;
  /** Motion bits: 1 leap, 2 slow fall, 4 levitate, 16 fly; speed separately. */
  motion: number;
  speed: boolean;
  /** Armour per body part (resistance spells) and protection (harder to hit). */
  armour: [number, number, number, number];
  protect: [number, number, number, number];
  /** Damage types proofed against (COMOBJ resistance bits). */
  proof: number;
  valour: number;
  poisonWeapon: boolean;
}

export function status(game: Game): Status {
  const st: Status = { light: 0, motion: 0, speed: false, armour: [0, 0, 0, 0], protect: [0, 0, 0, 0], proof: 0, valour: 0, poisonWeapon: false };
  let res = 0;
  for (const e of game.magic.effects) {
    if (e.major === 0) st.light = Math.max(st.light, e.minor);
    else if (e.major === 1) st.motion |= 1 << (e.minor - 1);
    else if (e.major === 2) res = Math.max(res, e.minor);
    else if (e.major === 3) {
      if (e.minor === 1) st.protect = st.protect.map(v => v + 3) as Status['protect'];
      else if (e.minor >= 5 && e.minor <= 9) st.proof |= [0x40, 8, 0x10, 1, 2][e.minor - 5]!;
      else if (e.minor === 0x10) st.valour = 10 + Math.trunc(skill(game.stats!, SK.casting) / 5);
      else if (e.minor === 0xb) st.poisonWeapon = true;
    } else if (e.major === 11 && e.minor === 2) st.speed = true;
  }
  st.armour = st.armour.map(v => v + res) as Status['armour'];
  return st;
}

/** The renderer's light (an index into LIGHTS) for the magical light level, or -1. */
export const magicLight = (game: Game): number => { const l = status(game).light; return l >= 5 ? 3 : l >= 3 ? 2 : l >= 1 ? 1 : -1; };

// ---------- the 20-second clock (the original's PlayerTimedLoop) ----------

/**
 * Every 20 seconds effects lose stability; every minute poison bites and mana may return (a Mana skill check); every
 * 10 minutes vitality may return (a strength check). (The reference's comment says 5 minutes; its counter says 10.)
 */
export function tickTimers(game: Game, dt: number): void {
  const T = game.timers;
  T.t += dt;
  while (T.t >= 20) {
    T.t -= 20; T.n = (T.n + 1) % 60;
    const m = game.magic;
    for (let k = m.effects.length - 1; k >= 0; k--) {
      const e = m.effects[k]!;
      if (--e.stab <= 1) {
        if (e.major === 1 && (e.minor === 3 || e.minor === 5)) { e.minor = 2; e.stab = dice(game.rng, 2, 3); }
        else m.effects.splice(k, 1);
      }
    }
    game.ui.magicChanged();
    const pl = game.stats;
    if (!pl || game.dead) continue;
    if (T.n % 3 === 0) {
      if (game.poison > 0) damagePlayer(game, game.poison--, 0x10);
      const r = skillCheck(game.rng, skill(pl, SK.mana), 10);
      if (r > 0) restoreMana(game, -r);
    }
    if (T.n % 30 === 0) { const r = skillCheck(game.rng, pl.str, 10); if (r > 0) heal(game, r); }
  }
}

/** Walking into a pickup: rune stones go straight into a carried rune bag. True when it took the stone. */
export function stowRune(game: Game, id: number): boolean {
  if (!isRuneStone(id) || !game.inv.all().some(o => o.id === RUNE_BAG)) return false;
  addRune(game, id - RUNE_STONE);
  game.say(`You put the ${runeName(game, id - RUNE_STONE)} rune in your rune bag.`);
  return true;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

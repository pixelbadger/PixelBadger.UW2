import type { ObjRec } from '../formats';
import { LIMITS } from '../formats/limits';
import { levelName } from '../data/text';
import type { LevelSnapshot } from '../world/level';
import { newConvState, type ConvState, type Game } from './game';
import { SLOT_KEYS, type SlotKey } from './inventory';
import type { PlayerStats } from './player';
import { newMagic } from './magic';
import { releaseMusic } from './sound';

// Saves: four slots like the original, kept in this browser. A save is plain data with an explicit schema version.
// Loading goes: raw -> migrate (one step per version) -> validate -> apply. Anything that fails is rejected with a
// SaveError before a single piece of game state is touched.
//
// Versions
//   1  (single-file engine) {v, when, PL, INV, lvl, P, visited, levels, conv?, time?}; object records overloaded `inv`
//      (the invisible bit, or an NPC's inventory array) and carried derived render data (f, panel).
//   2  {v, when, player, inventory, level, pose, visited, levels, conv, minutes}; objects carry `invis` and `items`.
//   3  v2 + {magic: {runes, shelf, effects}, poison}. Creature hit points, hostility and deaths live in the level
//      snapshots' NPC records (v2 already carried them); positions are still not saved (they reset to their posts).
//   4  v3 + the full paperdoll (helm, body, gloves, legs, boots, rings rgl/rgr), containers' contents as `items`
//      (carried or lying in levels, nested up to 8 deep), player.hunger (0-255) and player.drunk.

export const SAVE_VERSION = 4;
export const SAVE_SLOTS = 4;

export class SaveError extends Error { override name = 'SaveError'; }

export interface SavedMagic { runes: boolean[]; shelf: number[]; effects: { major: number; minor: number; stab: number }[] }

export interface SaveV4 {
  v: 4;
  when: number;
  player: PlayerStats;
  inventory: Partial<Record<SlotKey | 'held', ObjRec | null>>;
  level: number;
  pose: { x: number; y: number; z: number; yaw: number };
  visited: Record<number, { x: number; z: number; yaw: number }>;
  levels: Record<number, LevelSnapshot>;
  conv: ConvState;
  minutes: number;
  magic: SavedMagic;
  poison: number;
}

type Raw = Record<string, unknown>;
const isObj = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x);

// ---------- migrations ----------

/** v1 -> v2: rename the top level, split each record's overloaded `inv`, drop derived render data. */
function migrate1to2(d: Raw): Raw {
  const seen = new Set<unknown>();
  const fixObj = (o: unknown): void => {
    if (!isObj(o) || seen.has(o)) return;
    seen.add(o);
    const inv = o.inv;
    if (Array.isArray(inv)) { o.items = inv; o.invis = 0; inv.forEach(fixObj); }
    else o.invis = typeof inv === 'number' ? inv & 1 : 0;
    delete o.inv; delete o.f; delete o.panel;
  };
  const INV = isObj(d.INV) ? d.INV : {};
  Object.values(INV).forEach(fixObj);
  const levels = isObj(d.levels) ? d.levels : {};
  for (const st of Object.values(levels)) if (isObj(st)) for (const k of ['objs', 'doors', 'props']) if (Array.isArray(st[k])) (st[k] as unknown[]).forEach(fixObj);
  return {
    v: 2, when: d.when, player: d.PL, inventory: INV, level: d.lvl, pose: d.P, visited: d.visited ?? {}, levels,
    conv: d.conv ?? newConvState(), minutes: d.time ?? 0,
  };
}

/** v2 -> v3: no runes, no effects, no poison. */
const migrate2to3 = (d: Raw): Raw => ({ ...d, v: 3, magic: { runes: Array(24).fill(false), shelf: [], effects: [] }, poison: 0 });

/** v3 -> v4: the Avatar starts well fed; the old slots keep their names. */
const migrate3to4 = (d: Raw): Raw => ({ ...d, v: 4, player: isObj(d.player) ? { hunger: 0xc0, drunk: 0, ...d.player } : d.player });

const MIGRATIONS: Record<number, (d: Raw) => Raw> = { 1: migrate1to2, 2: migrate2to3, 3: migrate3to4 };

/** Brings any known version up to SAVE_VERSION. */
export function migrateSave(raw: unknown): Raw {
  if (!isObj(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v)) throw new SaveError('That slot does not hold a saved game.');
  if (raw.v > SAVE_VERSION) throw new SaveError('That game was saved by a newer version of the engine.');
  if (raw.v < 1) throw new SaveError('That save is from an unknown version.');
  let d: Raw = raw;
  while ((d.v as number) < SAVE_VERSION) {
    const step = MIGRATIONS[d.v as number];
    if (!step) throw new SaveError(`Saves from version ${d.v} cannot be read.`);
    d = step(d);
  }
  return d;
}

// ---------- validation ----------

function fail(what: string): never { throw new SaveError(`That save is damaged (${what}).`); }
const int = (x: unknown, lo: number, hi: number, what: string): number => (typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : fail(what));
const num = (x: unknown, lo: number, hi: number, what: string): number => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : fail(what));
const str = (x: unknown, max: number, what: string): string => (typeof x === 'string' && x.length <= max ? x : fail(what));
const numArray = (x: unknown, max: number, what: string): number[] => {
  if (!Array.isArray(x) || x.length > max) return fail(what);
  return x.map(v => (v == null ? v : num(v, -1e9, 1e9, what)));
};

const NPC_KEYS = ['who', 'hp', 'goal', 'gtarg', 'level', 'talked', 'att', 'xhome', 'yhome', 'hunger', 'loot', 'b0a7'] as const;

function checkObj(o: unknown, depth: number, count: { n: number }): ObjRec {
  if (!isObj(o)) return fail('object record');
  if (++count.n > 64 * 1024) fail('too many objects');
  int(o.id, 0, 511, 'object id');
  for (const k of ['isq', 'invis'] as const) int(o[k], 0, 1, 'object bit');
  // conversations may write any 16-bit value into these (x_obj_stuff), so only the type and word range are checked
  for (const k of ['fl', 'q', 'own', 'fx', 'fy', 'hd', 'link'] as const) int(o[k], -32768, 65535, 'object field');
  int(o.z, 0, 255, 'object height');
  int(o.next, 0, 1023, 'object link');
  int(o.i, -1, 1023, 'object index');
  int(o.lvl, -1, 79, 'object level');
  if (o.tx !== undefined) int(o.tx, 0, 63, 'object tile');
  if (o.ty !== undefined) int(o.ty, 0, 63, 'object tile');
  if (o.npc !== undefined) { if (!isObj(o.npc)) fail('NPC'); for (const k of NPC_KEYS) int((o.npc as Raw)[k], -32768, 65535, 'NPC'); }
  if (o.items !== undefined) {
    if (!Array.isArray(o.items) || o.items.length > 256 || depth > 8) fail('contents');
    (o.items as unknown[]).forEach(it => checkObj(it, depth + 1, count));
  }
  return o as unknown as ObjRec;
}

function checkPlayer(p: unknown): PlayerStats {
  if (!isObj(p)) return fail('player');
  str(p.name, 64, 'name');
  for (const k of ['sex', 'hand', 'body', 'diff'] as const) if (p[k] !== undefined) int(p[k], 0, 9, 'player');
  int(p.cls, -1, 7, 'class');
  for (const k of ['str', 'dex', 'int'] as const) int(p[k], 0, 255, 'attributes');
  for (const k of ['vit', 'mana'] as const) { const a = numArray(p[k], 2, k); if (a.length !== 2) fail(k); }
  numArray(p.skills, 32, 'skills');
  if (p.exp !== null && p.exp !== undefined) num(p.exp, -1e9, 1e9, 'experience');
  if (p.level !== undefined) int(p.level, 1, 16, 'level');
  if (p.hunger !== undefined) int(p.hunger, 0, 255, 'hunger');
  if (p.drunk !== undefined) int(p.drunk, -255, 255, 'drink');
  return p as unknown as PlayerStats;
}

/** Checks a migrated save against the disc it will load into. */
function checkMagic(m: unknown): SavedMagic {
  if (!isObj(m)) return fail('magic');
  if (!Array.isArray(m.runes) || m.runes.length !== 24 || !m.runes.every(r => typeof r === 'boolean')) fail('runes');
  if (!Array.isArray(m.shelf) || m.shelf.length > 3) fail('rune shelf');
  (m.shelf as unknown[]).forEach(r => int(r, 0, 23, 'rune shelf'));
  if (!Array.isArray(m.effects) || m.effects.length > 3) fail('spell effects');
  for (const e of m.effects as unknown[]) { if (!isObj(e)) fail('spell effect'); int(e.major, 0, 15, 'spell effect'); int(e.minor, 0, 63, 'spell effect'); int(e.stab, 0, 255, 'spell effect'); }
  return m as unknown as SavedMagic;
}

export function validateSave(d: Raw, levelExists: (n: number) => boolean): SaveV4 {
  if (d.v !== SAVE_VERSION) fail('version');
  num(d.when, 0, 1e15, 'date');
  checkPlayer(d.player);
  const lvl = int(d.level, 0, 79, 'level');
  if (!levelExists(lvl)) throw new SaveError('That save is for a level this disc does not have.');
  const pose = isObj(d.pose) ? d.pose : fail('position');
  num(pose.x, 0, 64, 'position'); num(pose.z, -64, 0, 'position'); num(pose.y, -8, 8, 'position'); num(pose.yaw, -1e6, 1e6, 'position');
  const count = { n: 0 };
  const inv = isObj(d.inventory) ? d.inventory : fail('inventory');
  for (const [k, o] of Object.entries(inv)) {
    if (k !== 'held' && !(SLOT_KEYS as readonly string[]).includes(k)) fail('inventory slot');
    if (o != null) checkObj(o, 0, count);
  }
  const visited = isObj(d.visited) ? d.visited : fail('visited levels');
  for (const [k, v] of Object.entries(visited)) { int(+k, 0, 79, 'visited level'); if (!isObj(v)) fail('visited'); num(v.x, 0, 64, 'visited'); num(v.z, -64, 0, 'visited'); num(v.yaw, -1e6, 1e6, 'visited'); }
  const levels = isObj(d.levels) ? d.levels : fail('levels');
  for (const [k, st] of Object.entries(levels)) {
    int(+k, 0, 79, 'level number');
    if (!isObj(st)) fail('level state');
    for (const list of ['objs', 'doors', 'props'] as const) {
      const a = st[list];
      if (!Array.isArray(a) || a.length > LIMITS.maxChain * 4) fail('level objects');
      (a as unknown[]).forEach(o => checkObj(o, 0, count));
    }
  }
  const conv = isObj(d.conv) ? d.conv : fail('conversations');
  if (!isObj(conv.g)) fail('conversation memory');
  for (const [k, g] of Object.entries(conv.g)) { int(+k, 0, 1023, 'conversation slot'); numArray(g, 65536, 'conversation memory'); }
  for (const k of ['q', 'c', 't'] as const) numArray(conv[k], 4096, 'quests');
  num(d.minutes, 0, 1e12, 'game clock');
  checkMagic(d.magic);
  int(d.poison, 0, 255, 'poison');
  return d as unknown as SaveV4;
}

/** raw (from storage) -> a save this engine can load, or SaveError. */
export function parseSave(raw: unknown, levelExists: (n: number) => boolean): SaveV4 {
  return validateSave(migrateSave(raw), levelExists);
}

/** One line for the slot list; never throws (a damaged slot still gets a label). */
export function describeSave(raw: unknown): { title: string; when: string } | null {
  if (raw == null) return null;
  try {
    const d = migrateSave(structuredClone(raw));
    const p = isObj(d.player) ? d.player : {};
    const name = typeof p.name === 'string' ? p.name.slice(0, 64) : '?';
    const lv = typeof d.level === 'number' && Number.isInteger(d.level) && d.level >= 0 && d.level < 80 ? levelName(d.level) : '?';
    return { title: `${name} · ${lv}`, when: typeof d.when === 'number' ? new Date(d.when).toLocaleString() : '' };
  } catch (e) {
    return { title: 'Unreadable save', when: e instanceof Error ? e.message : '' };
  }
}

// ---------- to and from the game ----------

export function makeSave(game: Game): SaveV4 {
  game.snapshotLevel();
  const P = game.pose, L = game.L;
  game.visited[L.n] = { x: P.x, z: P.z, yaw: P.yaw };
  return {
    v: 4, when: Date.now(), player: game.stats!, inventory: game.inv.toJSON(), level: L.n, pose: { x: P.x, y: P.y, z: P.z, yaw: P.yaw },
    visited: game.visited, levels: game.levelStates, conv: game.conv, minutes: game.minutes,
    magic: { runes: game.magic.runes, shelf: game.magic.shelf, effects: game.magic.effects }, poison: game.poison,
  };
}

/** Replaces the game's state with a validated save. */
export function applySave(game: Game, d: SaveV4): void {
  game.stats = d.player;
  game.inv.load(d.inventory);
  game.levelStates = d.levels; game.visited = d.visited; game.level = null;
  const conv = newConvState();
  game.conv = { g: d.conv.g ?? conv.g, q: d.conv.q ?? conv.q, c: d.conv.c ?? conv.c, t: d.conv.t ?? conv.t };
  game.minutes = d.minutes;
  game.resetCombat();
  game.magic = { ...newMagic(), runes: [...d.magic.runes], shelf: [...d.magic.shelf], effects: d.magic.effects.map(e => ({ ...e })) };
  game.poison = d.poison;
  game.useOn = null;
  releaseMusic(game);
  game.loadLevel(d.level);
  game.ui.levelChanged(d.level);
  const P = game.pose;
  P.x = d.pose.x; P.z = d.pose.z; P.y = d.pose.y; P.yaw = d.pose.yaw; P.vy = 0; P.tile = Math.floor(-P.z) * 64 + Math.floor(P.x);
  game.unstick();
  game.setPlayer(game.stats);
  game.ui.inventoryChanged();
  game.ui.magicChanged();
}


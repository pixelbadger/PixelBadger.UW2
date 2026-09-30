import type { ObjRec } from '../formats';
import type { GameData } from '../data/gamedata';
import { S1, levelName } from '../data/text';
import { mathRng, type Rng } from '../core/rng';
import { playerBlocked, supportAt } from '../world/collision';
import { buildCritters, settleCritters, type CritterAtlas } from '../world/creatures';
import { Level, type LevelSnapshot } from '../world/level';
import { Inventory } from './inventory';
import { newPose, type PlayerStats, type Pose } from './player';
import { nullUi, type UiPort } from './ports';
import type { TalkSession } from './talk';
import { newSwing, type Missile, type SwingState } from './combat';
import { newMagic, type MagicState } from './magic';
import { levelMusic, newMusic, releaseMusic, type MusicState } from './sound';

/** Conversation memory that outlives a talk: per-NPC private globals, quest flags, x_clock clocks, x_traps variables. */
export interface ConvState { g: Record<number, number[]>; q: number[]; c: number[]; t: number[] }
export const newConvState = (): ConvState => ({ g: {}, q: [], c: [], t: [] });

export type Mode = 'use' | 'look' | 'get' | 'talk' | 'fight';

/** Movement intent for one frame, filled by the controls. */
export interface Input { forward: number; strafe: number; turn: number; run: boolean; jump: boolean }

/**
 * One play session: the decoded disc plus every piece of mutable game state. Systems (movement, interaction,
 * inventory, conversations, saves) are functions over a Game; the page reaches the state only through here.
 * State groups:
 *   world    level (the loaded one), levelStates (snapshots of levels left), visited (where you stood on each)
 *   player   stats (PL), pose (P), inv
 *   story    conv (quests, clocks, NPC memory), minutes (game clock)
 *   session  talk (an open conversation), mode (command icon), rng
 *   combat   swing (the Avatar's attack), missiles (in flight on this level), poison, dead
 *   magic    runes, shelf, lasting effects, a spell waiting to be aimed; timers (the 20-second clock)
 *   items    useOn (a key, lockpick or other tool waiting for its target), hunger, drunk
 *   sound    music (what plays and why), steps (the footstep clock)
 */
export class Game {
  ui: UiPort = nullUi();
  level: Level | null = null;
  atlas: CritterAtlas | null = null;
  levelStates: Record<number, LevelSnapshot> = {};
  visited: Record<number, { x: number; z: number; yaw: number }> = {};
  readonly pose: Pose = newPose();
  stats: PlayerStats | null = null;
  readonly inv = new Inventory();
  conv: ConvState = newConvState();
  /** Game minutes since the start (approximation: one game minute per real second). */
  minutes = 0;
  talk: TalkSession | null = null;
  mode: Mode = 'use';
  readonly input: Input = { forward: 0, strafe: 0, turn: 0, run: false, jump: false };
  swing: SwingState = newSwing();
  missiles: Missile[] = [];
  magic: MagicState = newMagic();
  /** Poison strength (lost one a minute, doing that much damage). */
  poison = 0;
  dead = false;
  /** An inventory item waiting to be used on something the Avatar points at next. */
  useOn: ObjRec | null = null;
  music: MusicState = newMusic();
  readonly steps = { t: 0, foot: 0 };
  /** The 20-second clock: seconds into the current tick, and ticks (mod 60). */
  timers = { t: 0, n: 0 };
  /** The last rendered view, for picking: aspect ratio and vertical field of view. */
  view = { aspect: 16 / 10, fovY: 1.05 };

  constructor(readonly data: GameData, readonly rng: Rng = mathRng) {}

  /** The loaded level (throws before one is loaded: every in-game system runs after start-up). */
  get L(): Level { if (!this.level) throw new Error('no level loaded'); return this.level; }

  say(t: string): void { this.ui.say(t); }

  // ---------- levels ----------

  loadLevel(n: number): void {
    const L = new Level(this.data, n, this.levelStates[n]);
    this.level = L;
    this.missiles = [];
    this.atlas = buildCritters(L, this.rng);
    L.scene.version.critters++;
    L.scene.rebuildAll();
    settleCritters(L);
  }

  snapshotLevel(): void { if (this.level) this.levelStates[this.level.n] = this.level.snapshot(); }

  /** Leaves the current level (remembering where you stood and what changed) and enters level n. */
  goLevel(n: number, place = true): void {
    const P = this.pose;
    if (this.level) { this.visited[this.level.n] = { x: P.x, z: P.z, yaw: P.yaw }; this.snapshotLevel(); }
    this.loadLevel(n);
    this.ui.levelChanged(n);
    levelMusic(this);
    if (!place) return;
    const v = this.visited[n];
    if (v) { P.x = v.x; P.z = v.z; P.yaw = v.yaw; P.y = this.L.floorAt(P.x, P.z) ?? 0; P.tile = Math.floor(-P.z) * 64 + Math.floor(P.x); this.unstick(); }
    else this.placeStart();
  }

  /** Objects were taken, dropped or moved: rebuild what shows them. */
  refreshObjects(): void { this.L.scene.rebuildSprites(); }
  /** A door, lever, switch or button changed. */
  refreshDynamic(): void { this.L.scene.rebuildDynamic(); }
  /** A conversation changed objects in ways we don't track individually: rebuild everything but the walls. */
  refreshAll(): void { const s = this.L.scene; s.rebuildFixed(); s.rebuildSprites(); s.rebuildDynamic(); }
  /** Creatures changed kind (a transformed talker): new frame sets, new atlas. */
  rebuildCreatures(): void {
    const L = this.L;
    this.atlas = buildCritters(L, this.rng);
    L.scene.version.critters++;
    this.refreshAll();
    settleCritters(L);
  }

  // ---------- placing the Avatar ----------

  blocked(x: number, z: number, feet: number): boolean { return playerBlocked(this.L, x, z, feet); }

  /** Face the most open of the four directions. */
  faceOpen(): void {
    const P = this.pose;
    let by = 0, bd = -1;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      let d = 0;
      while (d < 6 && this.L.floorAt(P.x + Math.sin(a) * d, P.z - Math.cos(a) * d) != null) d += 0.1;
      if (d > bd) { bd = d; by = a; }
    }
    P.yaw = by;
  }

  /** Level 0: the tile holding Miranda's summons (0x136). Elsewhere: the most open tile near the middle of the map. */
  placeStart(): void {
    const L = this.L;
    const note = L.n === 0 && L.all.find(o => o.id === 0x136);
    if (note) { this.teleport(note.tx, note.ty); this.faceOpen(); return; }
    let best: [number, number] | null = null, bs = -1, cx = 0, cy = 0, cn = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (L.tileAt(x, y)!.type === 1) { cx += x; cy += y; cn++; }
    cx /= cn || 1; cy /= cn || 1;
    for (let y = 2; y < 62; y++) for (let x = 2; x < 62; x++) {
      const t = L.tileAt(x, y)!;
      if (t.type !== 1) continue;
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const u = L.tileAt(x + dx, y + dy)!; if (u.type === 1 && u.h === t.h) s++; }
      s -= Math.hypot(x - cx, y - cy) * 0.15;
      if (s > bs) { bs = s; best = [x, y]; }
    }
    if (best) { this.teleport(best[0], best[1]); this.faceOpen(); }
  }

  /** Puts the Avatar on tile (tx, ty), or the nearest open tile within 5. */
  teleport(tx: number, ty: number): void {
    const L = this.L, P = this.pose;
    const ok = (x: number, y: number) => { const t = L.tileAt(x, y); return !!t && t.type !== 0 && L.floorAt(x + 0.5, -(y + 0.5)) != null; };
    if (!ok(tx, ty)) outer: for (let r = 1; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (ok(tx + dx, ty + dy)) { tx += dx; ty += dy; break outer; }
    P.x = tx + 0.5; P.z = -(ty + 0.5);
    P.y = L.floorAt(P.x, P.z) ?? 0; P.vy = 0; P.tile = ty * 64 + tx;
    this.unstick();
  }

  /** Landed inside furniture: stand on it if low enough, else shuffle to the nearest clear spot. */
  unstick(): void {
    const L = this.L, P = this.pose, X = P.x, Y = -P.z;
    P.y = supportAt(L, X, Y, P.y) ?? P.y;
    if (!this.blocked(P.x, P.z, P.y)) return;
    for (let r = 0.1; r <= 0.9; r += 0.1) for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8, x = X + Math.cos(a) * r, y = Y + Math.sin(a) * r, f = L.floorAt(x, -y);
      if (f == null) continue;
      const ft = supportAt(L, x, y, f)!;
      if (!this.blocked(x, -y, ft)) { P.x = x; P.z = -y; P.y = ft; return; }
    }
  }

  /** Walks the level list (PageUp/PageDown). */
  stepLevel(d: number): void {
    const ok = [...Array(80).keys()].filter(i => this.data.levels[i]);
    const k = ok.indexOf(this.L.n);
    this.goLevel(ok[(k + d + ok.length) % ok.length]!);
  }

  // ---------- the Avatar ----------

  setPlayer(pl: PlayerStats): void { this.stats = pl; this.ui.playerChanged(); }

  /** Starts over with a new character on level 1. */
  newGame(pl: PlayerStats): void {
    this.stats = pl; this.inv.clear(); this.levelStates = {}; this.visited = {}; this.level = null;
    this.conv = newConvState(); this.minutes = 0;
    this.resetCombat(); this.magic = newMagic(); this.useOn = null; releaseMusic(this);
    this.goLevel(0);
    this.setPlayer(pl);
    this.ui.inventoryChanged();
    this.ui.magicChanged();
    this.say(S1(this.data, 13));
  }

  /** Alive, nothing in flight, no poison, no swing (a new game or a loaded one). */
  resetCombat(): void { this.dead = false; this.swing = newSwing(); this.missiles = []; this.poison = 0; this.timers = { t: 0, n: 0 }; }

  levelLabel(): string { return levelName(this.L.n); }
}

import type { Game } from './game';

// Sound effects and the choice of music, after UnderworldGodot (hankmorgan's port, traced from UW2.EXE:
// UWSoundEffects.cs, sfx/PositionalAudio.cs, loaders/xmimusic.cs and the call sites named below). The game decides
// what to play and how loud; the page (UiPort.sound / UiPort.music) makes the noise.
//
// ORIGINAL  effect numbers at each event; volume = SOUNDS.DAT's base velocity + a per-call delta, full within 1 tile,
//           fading to nothing at 6 tiles ((48 - d) / 40 in eighths of a tile), culled beyond; the stereo split (Miles
//           AIL's pan graph: 0 hard right, 0x40 centre, 0x7F hard left); music themes by world (three per world,
//           one picked at random), fight mode's "armed" theme, the combat themes by who is losing, the fanfare on
//           a kill, cutscene command 25.
// OURS      the pan is the source's bearing against the Avatar's facing (the original's heading/rotation
//           bookkeeping, resolved by ear in the reference, reduces to this); the combat music's timers (back to the
//           world's theme 10 s after the last blow, at most one combat theme change every 8 s: the original counts
//           PIT ticks we have not calibrated); footsteps every 0.45 s of walking (the original times them by momentum).

/** Effect numbers (SOUNDS.DAT / SPnn.VOC). */
export const SFX = {
  waterEdge: 0x00, stepL: 0x01, stepR: 0x02, hurt: 0x03, hit: 0x04, humanoidDeath: 0x06, strike: 0x07, strikeSoft: 0x08,
  bow: 0x09, whiff: 0x0a, door: 0x0b, landing: 0x0f, spell: 0x10, klang: 0x11, rumble: 0x12, button: 0x13, portcullis: 0x14,
  notReady: 0x15, fizzle: 0x16, splash: 0x1a, hitBlade: 0x1b, eat: 0x1e, drink: 0x1f, light: 0x20, crawlerDeath: 0x22,
  undeadDeath: 0x23, monsterDeath: 0x24, spellOther: 0x29, spellRing1: 0x2a, spellRing2: 0x2b, spellRing3: 0x2c, fail: 0x2d,
  snowL: 0x2f, snowR: 0x30, ice: 0x1d,
} as const;

/** Death sound by OBJECTS.DAT critter byte 8 & 7: humanoids, creepy-crawlies, undead and demons, monsters. */
export const DEATH_SFX = [-1, SFX.humanoidDeath, SFX.crawlerDeath, SFX.undeadDeath, SFX.monsterDeath] as const;

const PAN_CENTRE = 0x40;

/** SOUNDS.DAT's base velocity for an effect (0x7F without the table). */
export function baseVelocity(game: Game, id: number): number { return game.data.sounds[id]?.velocity ?? 0x7f; }

/** An effect at the Avatar: pan 0x40 is centred; volDelta is added to the base velocity. */
export function sfx(game: Game, id: number, volDelta = 0, pan = PAN_CENTRE): void {
  if (id < 0) return;
  const vol = Math.max(0, Math.min(0x7f, baseVelocity(game, id) + volDelta));
  if (vol > 0) game.ui.sound(id, vol, pan);
}

/**
 * Volume and pan of an effect at tile coordinates (x east, y north) as the Avatar hears it, or null when out of
 * earshot. The original works in eighths of a tile.
 */
export function falloff(game: Game, id: number, x: number, y: number, volDelta = 0): { vol: number; pan: number } | null {
  const P = game.pose, dx = Math.round((x - P.x) * 8), dy = Math.round((y + P.z) * 8), d = Math.floor(Math.hypot(dx, dy));
  if (d > 48) return null;
  const raw = baseVelocity(game, id) + volDelta;
  const vol = Math.max(0, Math.min(0x7f, d < 8 ? raw : Math.trunc((raw * (48 - d)) / 40)));
  if (d === 0) return { vol, pan: PAN_CENTRE };
  // how far to the Avatar's right the source is (-1 left .. 1 right); facing yaw: (sin, cos) = (east, north)
  const right = (dx * Math.cos(P.yaw) - dy * Math.sin(P.yaw)) / Math.hypot(dx, dy);
  return { vol, pan: Math.max(0, Math.min(0x7f, PAN_CENTRE - Math.round(right * 63))) };
}

/** An effect at a place in the level. */
export function sfxAt(game: Game, id: number, x: number, y: number, volDelta = 0): void {
  if (id < 0) return;
  const f = falloff(game, id, x, y, volDelta);
  if (f && f.vol > 0) game.ui.sound(id, f.vol, f.pan);
}

// ---------- footsteps ----------

/** Called by movement with the distance walked this frame: alternate feet (panned a little either side). */
export function footsteps(game: Game, dist: number, dt: number, running: boolean): void {
  const s = game.steps;
  if (dist < 0.3 * dt) { s.t = 0.3; return; }
  s.t += dt * (running ? 1.4 : 1);
  if (s.t < 0.45) return;
  s.t = 0;
  s.foot ^= 1;
  sfx(game, s.foot ? SFX.stepR : SFX.stepL, 0x0f + (running ? 6 : 3) - 0x40, s.foot ? 0x48 : 0x38);
}

// ---------- music ----------

/** Theme numbers (UWAnn.XMI, nn in octal). */
export const THEME = { intro: 1, winning: 2, combat: 3, losing: 4, armed: 5, fanfare: 6 } as const;
/** Three themes per world, in world order (UW2's UW2WorldThemes). */
const WORLD_THEMES = [0xa, 0xc, 0xe, 0x9, 0xa, 0xf, 0xb, 0xd, 0xa, 0xc, 0xd, 0x9, 0x8, 0xb, 0xe, 0xd, 0x8, 0xf, 0xe, 0x9, 0x8, 0xf, 0xb, 0xa, 0x8, 0xc, 0x9];
const COMBAT_HOLD = 10, COMBAT_SWITCH = 8;

export interface MusicState {
  /** The theme playing (0 none), the one asked for, the world whose theme it is. */
  cur: number; want: number; world: number;
  /** A menu or cutscene owns the music: the game leaves it alone. */
  hold: boolean;
  /** Seconds since the last blow in a fight, and since the combat theme last changed. */
  sinceBlow: number; sinceChange: number;
}
export const newMusic = (): MusicState => ({ cur: 0, want: 0, world: -1, hold: false, sinceBlow: 99, sinceChange: 99 });

const isCombat = (t: number) => t >= THEME.winning && t <= THEME.losing;
const isWorld = (t: number) => t >= 8 && t <= 15;
/** Does a theme loop? World themes and the fanfare play once (another world theme follows); the rest repeat. */
export const themeLoops = (t: number): boolean => !isWorld(t) && t !== THEME.fanfare;

/** Asks for a theme (the fanfare is never cut short). */
export function wantTheme(game: Game, t: number): void { if (game.music.cur !== THEME.fanfare) game.music.want = t; }

/** One of the current world's three themes: offset 0 the first, -1 a random one. */
export function pickWorldTheme(game: Game, offset = -1): void {
  const M = game.music, w = game.level ? Math.min(8, game.level.n >> 3) : 0;
  if (M.world !== w) { M.world = w; offset = 0; }
  if (offset < 0) offset = Math.floor(game.rng() * 3);
  wantTheme(game, WORLD_THEMES[w * 3 + offset]!);
}

function start(game: Game, t: number): void {
  const M = game.music;
  M.cur = t; M.want = 0;
  if (isCombat(t)) M.sinceChange = 0;
  game.ui.music(t, themeLoops(t));
}

/** A blow landed in a fight: the combat themes by who is losing (health below a quarter). */
export function combatBlow(game: Game, avatarHurt: boolean, hp: number, max: number): void {
  game.music.sinceBlow = 0;
  const low = (hp * 64) / (max + 1) < 16;
  wantTheme(game, avatarHurt ? (low ? THEME.losing : THEME.combat) : low ? THEME.winning : THEME.combat);
}

/** Per frame: settles what should play. */
export function tickMusic(game: Game, dt: number): void {
  const M = game.music;
  M.sinceBlow += dt; M.sinceChange += dt;
  if (game.dead || M.hold || !game.level) return;
  if (isCombat(M.cur) && M.sinceBlow > COMBAT_HOLD && !M.want) { if (game.mode === 'fight') wantTheme(game, THEME.armed); else pickWorldTheme(game, -1); }
  if (game.mode === 'fight' && !isCombat(M.cur) && M.cur !== THEME.armed && M.cur !== THEME.fanfare && !M.want) wantTheme(game, THEME.armed);
  if (game.mode !== 'fight' && M.cur === THEME.armed && !M.want) pickWorldTheme(game, -1);
  if (!M.cur && !M.want) pickWorldTheme(game, 0);
  if (!M.want || M.want === M.cur) { M.want = 0; return; }
  if (isCombat(M.cur) && isCombat(M.want) && M.sinceChange < COMBAT_SWITCH) { M.want = 0; return; }
  start(game, M.want);
}

/** A menu takes the music (the intro theme under the main menu). */
export function holdMusic(game: Game, theme: number): void {
  const M = game.music;
  M.hold = true; M.cur = theme; M.want = 0;
  game.ui.music(theme, true);
}
/** Back to the game's own choice (the world's theme, or what a fight calls for). */
export function releaseMusic(game: Game): void {
  const M = game.music;
  M.hold = false; M.cur = 0; M.want = 0; M.world = -1;
}

/** The page finished a theme that does not loop: another of the world's themes follows. */
export function musicEnded(game: Game): void {
  const M = game.music;
  if (M.hold) return;
  if (M.cur === THEME.fanfare) M.cur = 0;
  if (isWorld(M.cur) || !M.cur) { M.cur = 0; if (game.level) pickWorldTheme(game, -1); }
}

/** The level changed: a new world gets its first theme. */
export function levelMusic(game: Game): void {
  const w = game.level ? Math.min(8, game.level.n >> 3) : 0;
  if (w !== game.music.world && !isCombat(game.music.cur)) pickWorldTheme(game, 0);
}

import { S1 } from '../data/text';
import { randInt, type Rng } from '../core/rng';
import type { Game } from './game';
import type { PlayerStats } from './player';

// Character rules shared by combat and magic, after UnderworldGodot (playerdatskills.cs, playerdat.cs, rng.cs), which
// traced UW2.EXE.

/** Skill numbers (the order of STRINGS block 2's skill names and PLAYER.DAT's skill bytes). */
export const SK = {
  attack: 0, defense: 1, unarmed: 2, sword: 3, axe: 4, mace: 5, missile: 6, mana: 7, lore: 8, casting: 9,
  traps: 10, search: 11, track: 12, sneak: 13, repair: 14, charm: 15, picklock: 16, acrobat: 17, appraise: 18, swimming: 19,
} as const;

export const skill = (pl: PlayerStats, k: number): number => pl.skills[k] ?? 0;
export const levelOf = (pl: PlayerStats): number => pl.level ?? 1;

/** n dice of 1..d (the original's DiceRoll: n + n x rand(0..d-1)); n or d <= 0 gives n. */
export function dice(rng: Rng, n: number, d: number): number {
  if (d <= 0 || n <= 0) return n;
  let s = n;
  for (let i = 0; i < n; i++) s += randInt(rng, d);
  return s;
}

/** -1 critical failure, 0 failure, 1 success, 2 critical success: (skill - target) + 0..30 against 2 / 15 / 28. */
export type Check = -1 | 0 | 1 | 2;
export function skillCheck(rng: Rng, value: number, target: number): Check {
  const s = value - target + randInt(rng, 31);
  return s > 28 ? 2 : s > 15 ? 1 : s > 2 ? 0 : -1;
}

/** Maximum vitality and mana for a level (the original's UpdateHPManaMax). */
export const maxVit = (pl: PlayerStats): number => 30 + Math.trunc((pl.str * levelOf(pl)) / 5);
export const maxMana = (pl: PlayerStats): number => ((skill(pl, SK.mana) + 1) * pl.int) >> 3;

/** Experience points (in 500s) each level needs, by current level. */
const LEVEL_AT = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192];

/**
 * Awards (or takes) experience as the original's ChangeExperience: gains are halved (rounded at random) and halved
 * again on a world far below the Avatar's level; levels come every LEVEL_AT x 500 points up to 16.
 */
export function gainExp(game: Game, n: number): void {
  const pl = game.stats;
  if (!pl) return;
  const exp = pl.exp ?? 0;
  if (n < 0) { pl.exp = Math.max(0, exp + n); return; }
  n = (n + randInt(game.rng, 2)) >> 1;
  const world = game.level ? ((game.level.n >> 3) << 1) + 2 : 99;
  if (world < levelOf(pl)) n = 1 + (n >> 1);
  pl.exp = Math.min(exp + n, 0x7fff0);
  if (pl.exp > 0x17700) return;
  const pts = Math.trunc(pl.exp / 500), lv = levelOf(pl);
  let up = 0;
  while (lv + up < 16 && LEVEL_AT[lv + up]! <= pts) up++;
  if (!up) return;
  pl.level = lv + up;
  pl.vit[1] = Math.max(pl.vit[1], maxVit(pl));
  pl.mana[1] = Math.max(pl.mana[1], maxMana(pl));
  if (!game.talk) game.say(`${S1(game.data, 161) || 'You have attained experience level '}${pl.level}.`);
  game.ui.playerChanged();
}

/** Heals (n > 0: a random share of the maximum, as the original's HPRegenerationChange; n < 0: exactly -n). */
export function heal(game: Game, n: number): void {
  const pl = game.stats;
  if (!pl) return;
  const add = n >= 0 ? 1 + (((randInt(game.rng, 4) + n) * pl.vit[1]) >> 4) : -n;
  pl.vit[0] = Math.min(pl.vit[1], pl.vit[0] + add);
  game.ui.playerChanged();
}

/** Restores mana (n > 0: a random share of the maximum, as the original's ManaRegenChange; n < 0: exactly -n). */
export function restoreMana(game: Game, n: number): void {
  const pl = game.stats;
  if (!pl) return;
  const add = n >= 0 ? 1 + ((pl.mana[1] * (n + randInt(game.rng, 4))) >> 4) : -n;
  pl.mana[0] = Math.min(pl.mana[1], pl.mana[0] + add);
  game.ui.playerChanged();
}

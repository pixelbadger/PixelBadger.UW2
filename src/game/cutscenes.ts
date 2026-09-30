import { cutsName } from '../formats';
import type { GameData } from '../data/gamedata';
import { randInt } from '../core/rng';
import type { Game } from './game';

// When cutscenes play (the rules as UnderworldGodot has them; see docs/CUTSCENES.md). The page plays them through
// UiPort.cutscene; here is only the story: which one, and what it changes.

export const CUTSCENE = {
  /** The letter, the cart, the bridge and the Guardian's attack. */
  intro: 0,
  /** Blackrock closes over the castle. */
  blackrock: 1,
  /** The ending. */
  ending: 2,
  /** The animated title (after the Origin and LGS screens). */
  title: 9,
  /** Acknowledgements. */
  credits: 10,
  /** Dreams: 24-27 carry speech and wait on the story; 28-30 are the random ones. */
  dream: 24,
} as const;

/** What plays when the game starts: the title, then the introduction. Skipping any of it goes to the menu. */
export const STARTUP = [CUTSCENE.title, CUTSCENE.intro, CUTSCENE.blackrock] as const;
export const INTRODUCTION = [CUTSCENE.intro, CUTSCENE.blackrock] as const;

/** Quest flag a conversation sets to ask for a cutscene when it ends (value = cutscene + 1). */
export const QUEST_CUTSCENE = 143;
/** Dream bits: 0-3 = story dreams waiting to be had, 4-6 = random dreams already had. */
export const QUEST_DREAMS = 145;
/** x_clock 1 must reach these before story dream k can come. */
export const DREAM_CLOCK = [4, 6, 10, 14] as const;

export const hasCutscene = (D: GameData, n: number): boolean => !!D.files['CUTS/' + cutsName(n, 0)];

/**
 * After a conversation closes: a program that set quest 143 asked for cutscene (value - 1). It is cleared, and the
 * ending is followed by the victory. (UNVERIFIED: taken from UnderworldGodot; no conversation was seen setting 143.)
 */
export async function afterTalk(game: Game): Promise<void> {
  const q = game.conv.q[QUEST_CUTSCENE] ?? 0;
  if (!q) return;
  game.conv.q[QUEST_CUTSCENE] = 0;
  const n = q - 1;
  await game.ui.cutscene(n);
  if (n === CUTSCENE.ending) game.ui.victory();
}

/**
 * Which dream (0-6) comes tonight, or null. A story dream k (0-3) comes once x_clock 1 has reached DREAM_CLOCK[k] while
 * its bit in quest 145 is set; otherwise one of the random dreams 4-6 is drawn, and comes if its bit is still clear.
 */
export function pickDream(game: Game): number | null {
  const bits = game.conv.q[QUEST_DREAMS] ?? 0, clock = game.conv.c[1] ?? 0;
  for (let k = 0; k < 4; k++) if (clock >= DREAM_CLOCK[k]! && bits & (1 << k)) return k;
  const k = 4 + randInt(game.rng, 3);
  return bits & (1 << k) ? null : k;
}

/**
 * Sleep in a bed: the night's dream, if any, then waking. The dream's bit flips when it is shown. The wording is ours
 * (the original's sleep messages have not been located in STRINGS.PAK yet), and sleep does not yet heal or pass time.
 */
export async function sleep(game: Game): Promise<void> {
  game.say('You lie down and sleep.');
  const k = pickDream(game);
  if (k != null && hasCutscene(game.data, CUTSCENE.dream + k)) {
    game.conv.q[QUEST_DREAMS] = (game.conv.q[QUEST_DREAMS] ?? 0) ^ (1 << k);
    await game.ui.cutscene(CUTSCENE.dream + k);
  }
  game.say('You wake.');
}

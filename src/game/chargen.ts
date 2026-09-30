import type { GameData } from '../data/gamedata';
import { randRange, type Rng } from '../core/rng';
import type { PlayerStats } from './player';

// Character creation rules. Steps and wording follow the original (STRINGS block 2): sex, handedness, class, the
// class's skill picks, appearance, difficulty, name, keep. SKILLS.DAT: 32 bytes = 8 classes x (STR, DEX, INT, ?)
// bases (4th unknown), then 8 classes x 5 groups (u8 n, n skill ids 0-19); n = 1 is granted, n > 1 the player picks one.
//
// The ROLLS are OUR APPROXIMATION (the real UW2 rules are not decoded; CHRGEN.DAT looks like screen scripting):
// attribute = class base + 0..10; each granted/picked skill + 4..13; vitality 33..36; max mana by class from
// Underworld Adventures' UW1 script.

export interface ClassData { base: number[]; groups: number[][] }

export function classData(D: GameData): ClassData[] | null {
  const b = D.files['SKILLS.DAT'];
  if (!b || b.length < 0x20) return null;
  const out: ClassData[] = [];
  let p = 0x20;
  for (let c = 0; c < 8; c++) {
    const groups: number[][] = [];
    for (let e = 0; e < 5; e++) {
      const n = b[p] ?? 0;
      groups.push(Array.from(b.subarray(p + 1, p + 1 + n)).filter(k => k < 20));
      p += 1 + n;
    }
    out.push({ base: Array.from(b.subarray(c * 4, c * 4 + 4)), groups });
  }
  return out;
}

export const CLASS_MANA = [2, 35, 15, 2, 27, 3, 2, 2];

export const newCharacter = (): PlayerStats => ({ name: 'Avatar', cls: -1, sex: 0, hand: 0, body: 0, diff: 0, str: 0, dex: 0, int: 0, vit: [0, 0], mana: [0, 0], skills: Array(20).fill(0), exp: 0 });

/** Rolls a class's attributes and granted skills; returns the skill groups the player still picks from. */
export function rollClass(pl: PlayerStats, c: number, cd: ClassData[] | null, rng: Rng): number[][] {
  const base = cd ? cd[c]!.base : [15, 15, 15, 0];
  pl.cls = c;
  pl.str = base[0]! + randRange(rng, 0, 10); pl.dex = base[1]! + randRange(rng, 0, 10); pl.int = base[2]! + randRange(rng, 0, 10);
  const v = randRange(rng, 33, 36);
  pl.vit = [v, v]; pl.mana = [CLASS_MANA[c]!, CLASS_MANA[c]!]; pl.skills = Array(20).fill(0);
  const queue: number[][] = [];
  for (const g of cd ? cd[c]!.groups : [[0], [1]]) {
    if (g.length === 1) pl.skills[g[0]!]! += randRange(rng, 4, 13);
    else if (g.length) queue.push(g);
  }
  return queue;
}

export function pickSkill(pl: PlayerStats, k: number, rng: Rng): void { pl.skills[k]! += randRange(rng, 4, 13); }

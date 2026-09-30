import { readPlayer } from '../formats';
import type { GameData } from '../data/gamedata';

/** The Avatar's record: the only player data the engine reads (flasks, stats page, conversations, saves). */
export interface PlayerStats {
  name: string;
  /** 0 male, 1 female. */
  sex: number;
  /** 0 left, 1 right. */
  hand: number;
  /** Class 0-7, or -1 for the disc's default character. */
  cls: number;
  /** Portrait/body 0-9 (0-4 male, 5-9 female). */
  body: number;
  diff: number;
  str: number;
  dex: number;
  int: number;
  vit: [number, number];
  mana: [number, number];
  skills: number[];
  exp: number | null;
  level?: number;
  /** The disc's PLAYER.DAT template rather than a created character. */
  disc?: boolean;
}

/** Where the Avatar is: world position (x east, z = -north), feet height y, vertical speed, view angles, current tile. */
export interface Pose { x: number; y: number; z: number; vy: number; yaw: number; pitch: number; tile: number }

export const newPose = (): Pose => ({ x: 32, z: -32, y: 0, vy: 0, yaw: 0, pitch: 0, tile: -1 });

/** PLAYER.DAT's development template ("GRONKEY"), or a plain Avatar without it. */
export function discPlayer(D: GameData): PlayerStats {
  const d = readPlayer(D.files['PLAYER.DAT']);
  if (!d) return { name: 'Avatar', hand: 0, diff: 0, cls: -1, sex: 0, body: 0, str: 15, dex: 15, int: 15, vit: [30, 30], mana: [0, 0], skills: Array(20).fill(0), exp: 0 };
  return { name: d.name, hand: 0, diff: 0, cls: -1, sex: 0, body: 0, str: d.str, dex: d.dex, int: d.int, vit: [d.vit[0], d.vit[1]], mana: [d.mana[0], d.mana[1]], skills: [...d.skills, 0], exp: null, disc: true };
}

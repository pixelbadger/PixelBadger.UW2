import type { ObjRec } from '../../src/formats';
import { seededRng, type Rng } from '../../src/core/rng';
import { GameData } from '../../src/data/gamedata';
import type { GameFiles } from '../../src/data/files';
import { Game } from '../../src/game/game';
import { eye } from '../../src/game/picking';
import { nullUi, type LineKind } from '../../src/game/ports';
import { closeTalk, startTalk } from '../../src/game/talk';
import { discPlayer } from '../../src/game/player';

export type Strategy = 'first' | 'last' | 'random';

export interface TalkRun {
  lines: { kind: LineKind; text: string }[];
  final: string;
  err: string | null;
  note: string | null;
  steps: number;
  /** The program's private globals after the talk, and every quest flag / clock / variable. */
  globals: number[];
  quests: number[];
  clocks: number[];
  traps: number[];
}

/** A Game on the given files with a no-op UI and a seeded RNG, standing on level 0 with the disc's default character. */
export function headlessGame(files: GameFiles, seed = 1): Game {
  const game = new Game(new GameData(files), seededRng(seed));
  game.ui = nullUi();
  game.goLevel(0);
  game.setPlayer(discPlayer(game.data));
  return game;
}

/**
 * Runs conversation slot `who` to the end through the real engine session (builtins included), answering menus by
 * strategy and typing `typed` at every question. The talker is a stand-in NPC placed at the Avatar's eye.
 */
export function runTalk(game: Game, who: number, strategy: Strategy, opts: { typed?: string; rng?: Rng; maxSteps?: number; talker?: ObjRec } = {}): TalkRun {
  const rng = opts.rng ?? seededRng(who * 7919 + strategy.length);
  const lines: TalkRun['lines'] = [];
  const ui = nullUi();
  ui.talk.line = (kind, text) => lines.push({ kind, text });
  game.ui = ui;
  const o: ObjRec = opts.talker ?? {
    i: -1, isq: 0, id: 0x40 + 5, invis: 0, fl: 0, z: 0, hd: 0, fx: 3, fy: 3, q: 40, next: 0, own: 0, link: 0, tx: Math.floor(game.pose.x), ty: Math.floor(-game.pose.z), lvl: -1,
    npc: { who, hp: 30, goal: 0, gtarg: 0, level: 1, talked: 0, att: 3, xhome: 0, yhome: 0, hunger: 0, loot: 1, b0a7: 0 }, items: [],
  };
  startTalk(game, { o, c: eye(game), r: 0.3, npc: true });
  const s = game.talk;
  if (!s) return { lines, final: 'refused', err: null, note: null, steps: 0, globals: [], quests: [], clocks: [], traps: [] };
  let steps = 0;
  const max = opts.maxSteps ?? 400;
  while (!s.over && steps++ < max) {
    const st = s.vm.state;
    if (st === 'menu') {
      const n = s.vm.menu!.length;
      if (!n) break;
      s.choose(strategy === 'first' ? 0 : strategy === 'last' ? n - 1 : Math.floor(rng() * n));
    } else if (st === 'ask') s.ask(opts.typed ?? 'xyzzy');
    else if (st === 'more') s.more();
    else break;
  }
  const vm = s.vm, run: TalkRun = {
    lines, final: vm.state, err: vm.err, note: vm.note, steps,
    globals: Array.from(vm.mem.subarray(31, vm.cv.G)), quests: [...game.conv.q], clocks: [...game.conv.c], traps: [...game.conv.t],
  };
  closeTalk(game);
  return run;
}

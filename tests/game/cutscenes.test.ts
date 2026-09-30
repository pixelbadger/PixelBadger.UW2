import { describe, expect, it } from 'vitest';
import { writeArk, uw2CompressLiteral } from '../../src/formats';
import { CUTSCENE, DREAM_CLOCK, QUEST_CUTSCENE, QUEST_DREAMS, afterTalk, pickDream, sleep } from '../../src/game/cutscenes';
import { use } from '../../src/game/interact';
import { pick } from '../../src/game/picking';
import type { Game } from '../../src/game/game';
import type { UiPort } from '../../src/game/ports';
import { BED, NPC, synthConversation, synthFiles } from '../helpers/synth';
import { synthCutsFiles } from '../helpers/synthCuts';
import { headlessGame, runTalk } from '../helpers/talk';

/** Records cutscene requests and messages; every cutscene "plays" at once. */
function recorder(game: Game) {
  const played: number[] = [], said: string[] = [];
  let won = 0;
  const ui: Partial<UiPort> = { cutscene: async n => { played.push(n); return 'done'; }, victory: () => { won++; }, say: t => { said.push(t); } };
  Object.assign(game.ui, ui);
  return { played, said, ui, won: () => won };
}

const settle = () => new Promise(r => setTimeout(r, 0));

/** The synthetic disc plus stand-in control scripts for the dreams (only their presence matters here). */
function discWithDreams() {
  const f = { ...synthFiles(), ...synthCutsFiles() };
  for (let n = 24; n <= 30; n++) f[`CUTS/CS0${n.toString(8)}.N00`] = new Uint8Array(0);
  return f;
}

describe('cutscene triggers', () => {
  it('a conversation that sets quest 143 plays cutscene (value - 1) when it closes, then clears it', async () => {
    const files = synthFiles();
    files['CNV.ARK'] = writeArk([null, synthConversation(QUEST_CUTSCENE, CUTSCENE.credits + 1)], uw2CompressLiteral);
    const game = headlessGame(files);
    const played: number[] = [];
    runTalk(game, NPC.who, 'first', { ui: { cutscene: async n => { played.push(n); return 'done'; } } });
    await settle();
    expect(played).toEqual([CUTSCENE.credits]);
    expect(game.conv.q[QUEST_CUTSCENE]).toBe(0);
  });

  it('the ending is followed by the victory; nothing plays when quest 143 is clear', async () => {
    const game = headlessGame(synthFiles()), r = recorder(game);
    await afterTalk(game);
    expect(r.played).toEqual([]);
    game.conv.q[QUEST_CUTSCENE] = CUTSCENE.ending + 1;
    await afterTalk(game);
    expect(r.played).toEqual([CUTSCENE.ending]);
    expect(r.won()).toBe(1);
  });

  it('story dreams wait for their clock and their bit; random ones come once each', () => {
    const game = headlessGame(synthFiles(), 3);
    game.conv.q[QUEST_DREAMS] = 0b0110;
    game.conv.c[1] = DREAM_CLOCK[1] - 1;
    expect(pickDream(game)).toBeGreaterThanOrEqual(4); // dream 1 is not due yet: a random one
    game.conv.c[1] = DREAM_CLOCK[1];
    expect(pickDream(game)).toBe(1);
    game.conv.q[QUEST_DREAMS] = 0b1110000; // every random dream already had
    expect(pickDream(game)).toBeNull();
  });

  it('sleeping shows the dream and flips its bit; the next night brings no repeat', async () => {
    const game = headlessGame(discWithDreams(), 5), r = recorder(game);
    game.conv.q[QUEST_DREAMS] = 1; game.conv.c[1] = DREAM_CLOCK[0];
    await sleep(game);
    expect(r.played).toEqual([CUTSCENE.dream]);
    expect(game.conv.q[QUEST_DREAMS]).toBe(0);
    const seen = new Set<number>();
    for (let night = 0; night < 30; night++) await sleep(game);
    for (const n of r.played.slice(1)) { expect(n).toBeGreaterThanOrEqual(28); expect(seen.has(n)).toBe(false); seen.add(n); }
    expect(game.conv.q[QUEST_DREAMS]).toBe([...seen].reduce((a, n) => a | (1 << (n - 24)), 0));
    expect(r.said.at(-1)).toBe('You wake.');
  });

  it('without the dream on the disc, sleep still wakes and the dream stays owed', async () => {
    const game = headlessGame(synthFiles(), 5), r = recorder(game);
    game.conv.q[QUEST_DREAMS] = 1; game.conv.c[1] = DREAM_CLOCK[0];
    await sleep(game);
    expect(r.played).toEqual([]);
    expect(game.conv.q[QUEST_DREAMS]).toBe(1);
  });

  it('using a bed goes to sleep; looking at it does not', async () => {
    const game = headlessGame(discWithDreams(), 5), r = recorder(game);
    game.conv.q[QUEST_DREAMS] = 1; game.conv.c[1] = DREAM_CLOCK[0];
    const bed = game.L.scene.picks().find(p => p.o.id === 0x167)!;
    game.teleport(BED.x - 1, BED.y); game.pose.yaw = Math.PI / 2;
    const E = [game.pose.x, game.pose.y + 0.62, game.pose.z];
    game.pose.pitch = Math.atan2(bed.c[1] - E[1]!, bed.c[0] - E[0]!);
    const h = pick(game, 0, 0);
    expect(h?.kind === 'obj' && h.sp.o.id).toBe(0x167);
    use(game, 0, 0, true);
    expect(r.played).toEqual([]);
    use(game, 0, 0);
    await settle();
    expect(r.played).toEqual([CUTSCENE.dream]);
  });
});

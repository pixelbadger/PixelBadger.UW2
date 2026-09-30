import { describe, expect, it } from 'vitest';
import { writeSoundsDat } from '../../src/formats';
import type { Game } from '../../src/game/game';
import { use } from '../../src/game/interact';
import { update } from '../../src/game/movement';
import { nullUi } from '../../src/game/ports';
import { SFX, THEME, combatBlow, falloff, holdMusic, musicEnded, releaseMusic, sfx, themeLoops, tickMusic, wantTheme } from '../../src/game/sound';
import { DOOR, synthFiles } from '../helpers/synth';
import { headlessGame } from '../helpers/talk';

/** A game whose UI records sounds and music. SOUNDS.DAT gives every effect base velocity 100. */
function soundGame() {
  const files = synthFiles();
  files['SOUND/SOUNDS.DAT'] = writeSoundsDat(Array.from({ length: 48 }, () => ({ patch: 0, note: 60, velocity: 100, duration: 0 })));
  const g = headlessGame(files);
  const heard: { id: number; vol: number; pan: number }[] = [], played: { n: number; loop: boolean }[] = [];
  g.ui = { ...nullUi(), sound: (id, vol, pan) => heard.push({ id, vol, pan }), music: (n, loop) => played.push({ n, loop }) };
  return { g, heard, played };
}
const place = (g: Game, x: number, y: number, yaw = 0) => { g.pose.x = x; g.pose.z = -y; g.pose.yaw = yaw; };

describe('where a sound is heard from', () => {
  it('full volume within a tile, fading to nothing at six, pan by bearing', () => {
    const { g } = soundGame();
    place(g, 32, 32);
    expect(falloff(g, 1, 32, 32)).toEqual({ vol: 100, pan: 0x40 });
    expect(falloff(g, 1, 32.5, 32)!.vol).toBe(100);
    expect(falloff(g, 1, 35, 32)!.vol).toBe(Math.trunc((100 * (48 - 24)) / 40));
    expect(falloff(g, 1, 38.2, 32)).toBeNull();
    // facing north: a sound to the east is on the right (Miles pan: below 0x40), to the west on the left
    expect(falloff(g, 1, 34, 32)!.pan).toBeLessThan(0x40);
    expect(falloff(g, 1, 30, 32)!.pan).toBeGreaterThan(0x40);
    expect(falloff(g, 1, 32, 34)!.pan).toBe(0x40);
    // turned to face east, the same sound ahead is centred and one to the north is on the left
    g.pose.yaw = Math.PI / 2;
    expect(falloff(g, 1, 34, 32)!.pan).toBe(0x40);
    expect(falloff(g, 1, 32, 34)!.pan).toBeGreaterThan(0x40);
  });

  it('volume deltas are clamped to 0-127 and a silent effect is not sent', () => {
    const { g, heard } = soundGame();
    sfx(g, 3, 100); sfx(g, 3, -200);
    expect(heard).toEqual([{ id: 3, vol: 127, pan: 0x40 }]);
  });
});

describe('what makes a sound', () => {
  it('a door opening, and footsteps while walking', () => {
    const { g, heard } = soundGame();
    g.teleport(DOOR.x, DOOR.y - 1); g.pose.yaw = 0; g.pose.pitch = 0;
    use(g, 0, 0);
    expect(heard.some(h => h.id === SFX.door)).toBe(true);
    heard.length = 0;
    g.teleport(30, 30); g.pose.yaw = Math.PI / 2;
    g.input.forward = 1;
    for (let t = 0; t < 2; t += 0.05) update(g, 0.05);
    g.input.forward = 0;
    const steps = heard.filter(h => h.id === SFX.stepL || h.id === SFX.stepR);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(steps.map(s => s.id)).size).toBe(2); // left, right
  });
});

describe('music', () => {
  it('a world theme starts, plays once, and another of the world follows', () => {
    const { g, played } = soundGame();
    tickMusic(g, 0.1);
    expect(played[0]).toEqual({ n: 0xa, loop: false }); // Britannia's first theme
    musicEnded(g);
    tickMusic(g, 0.1);
    expect([0xa, 0xc, 0xe]).toContain(played[1]!.n);
  });

  it('fight mode arms, blows bring combat themes by who is losing, quiet brings the world back', () => {
    const { g, played } = soundGame();
    tickMusic(g, 0.1);
    g.mode = 'fight'; tickMusic(g, 0.1);
    expect(played.at(-1)).toEqual({ n: THEME.armed, loop: true });
    combatBlow(g, true, 30, 40); tickMusic(g, 0.1);
    expect(played.at(-1)!.n).toBe(THEME.combat);
    combatBlow(g, true, 5, 40); tickMusic(g, 0.1);
    expect(played.at(-1)!.n).toBe(THEME.combat);        // too soon to change combat themes
    for (let t = 0; t < 9; t += 0.5) tickMusic(g, 0.5);
    combatBlow(g, true, 5, 40); tickMusic(g, 0.1);
    expect(played.at(-1)!.n).toBe(THEME.losing);
    g.mode = 'use';
    for (let t = 0; t < 11; t += 0.5) tickMusic(g, 0.5);
    expect([0xa, 0xc, 0xe]).toContain(played.at(-1)!.n);
  });

  it('the fanfare is not cut short, and plays once', () => {
    const { g, played } = soundGame();
    tickMusic(g, 0.1);
    wantTheme(g, THEME.fanfare); tickMusic(g, 0.1);
    expect(played.at(-1)).toEqual({ n: THEME.fanfare, loop: false });
    combatBlow(g, false, 1, 40); tickMusic(g, 0.1);
    expect(played.at(-1)!.n).toBe(THEME.fanfare);
    musicEnded(g); tickMusic(g, 0.1);
    expect(played.at(-1)!.n).not.toBe(THEME.fanfare);
    expect(themeLoops(THEME.armed)).toBe(true);
    expect(themeLoops(0xa)).toBe(false);
  });

  it('a menu holds the music until a game starts', () => {
    const { g, played } = soundGame();
    holdMusic(g, THEME.intro);
    g.mode = 'fight';
    for (let t = 0; t < 3; t += 0.5) tickMusic(g, 0.5);
    expect(played).toEqual([{ n: THEME.intro, loop: true }]);
    releaseMusic(g); g.mode = 'use'; tickMusic(g, 0.1);
    expect(played.at(-1)!.n).toBe(0xa);
  });
});

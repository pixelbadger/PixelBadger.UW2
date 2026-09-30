import { describe, expect, it } from 'vitest';
import { CutscenePlayer } from '../../src/cuts/player';
import { palsEntry, writeCutsScript } from '../../src/formats';
import { INTRO_FPS, PAL, VOICE, synthHost, synthPals } from '../helpers/synthCuts';

const STEP = 1 / 70;

/** Steps the player, calling `at` after each step with the time. */
function play(p: CutscenePlayer, seconds: number, at?: (t: number) => void): void {
  for (let t = 0; t < seconds && !p.done; t += STEP) { p.update(STEP); at?.(p.t); }
}

const px = (p: CutscenePlayer, x: number, y: number) => p.screen[y * 320 + x]!;

describe('the cutscene player (synthetic cutscenes)', () => {
  it('plays the intro: fade in, voiced subtitle, timed text, the next file, fade out, end', () => {
    const { host, voices } = synthHost();
    const p = new CutscenePlayer(0, host);
    expect(p.bright).toBe(0);
    const seen: { t: number; sub: string | null; px: number; b: number }[] = [];
    play(p, 30, t => seen.push({ t, sub: p.subtitle?.text ?? null, px: px(p, 0, 0), b: p.bright }));
    expect(p.done).toBe(true);
    expect(p.skipped).toBe(false);
    expect(p.problems).toEqual([]);
    // the voiced line starts at once with its colour, and the voice clip is handed over
    expect(seen[0]!.sub).toBe('Dear Avatar,');
    expect(voices[0]).toBeCloseTo(VOICE.seconds, 2);
    // fade-in rate 4 = half a second
    expect(seen.find(s => s.t >= 0.25)!.b).toBeCloseTo(0.5, 1);
    expect(seen.find(s => s.t >= 0.55)!.b).toBe(1);
    // frame 3 (at 0.3 s) brings the second line; the first file's frames show at 10 fps
    expect(seen.find(s => s.t >= 0.32)!.sub).toBe('Second line.');
    expect(seen.find(s => s.t >= 0.05)!.px).toBe(10);
    expect(seen.find(s => s.t >= 0.15)!.px).toBe(11);
    // segment 2 moves on to N02 and clears the text (after the first voice clip ends)
    const n02 = seen.find(s => s.px === 30)!;
    expect(n02.t).toBeCloseTo(5 / INTRO_FPS, 1);
    expect(n02.sub).toBeNull();
    // then the frame-999 fade out (rate 2 = a second, blocking) and the end
    expect(p.t).toBeGreaterThan(0.7 + 1);
    expect(p.t).toBeLessThan(0.7 + 1 + 0.1);
    expect(p.bright).toBe(0);
  });

  it('a voiced line waits for the one before to finish', () => {
    const { host, files } = synthHost();
    files['CUTS/CS000.N00'] = writeCutsScript([
      { frame: 0, cmd: 13, args: [241, 0, 5] }, { frame: 1, cmd: 13, args: [241, 1, 999] }, { frame: 3, cmd: 5, args: [] }, { frame: 0, cmd: 6, args: [] },
    ]);
    const p = new CutscenePlayer(0, host);
    let second = -1;
    play(p, 5, t => { if (second < 0 && p.subtitle?.text === 'Second line.') second = t; });
    expect(second).toBeGreaterThanOrEqual(VOICE.seconds - STEP);
    expect(second).toBeLessThan(VOICE.seconds + 0.05);
    expect(p.speaking).toBe(false);
  });

  it('skips on request and stops the voice', () => {
    const { host, voices } = synthHost();
    const p = new CutscenePlayer(0, host);
    play(p, 0.1);
    p.skip();
    expect(p.done && p.skipped).toBe(true);
    expect(voices.at(-1)).toBeNull();
    const t = p.t; p.update(1); expect(p.t).toBe(t);
  });

  it('a pause of 999 or more waits until skipped', () => {
    const { host, files } = synthHost();
    files['CUTS/CS000.N00'] = writeCutsScript([{ frame: 0, cmd: 3, args: [999] }, { frame: 0, cmd: 6, args: [] }]);
    const p = new CutscenePlayer(0, host);
    p.update(3600);
    expect(p.done).toBe(false);
    p.skip();
    expect(p.done).toBe(true);
  });

  it('keeps going past missing files and says what was missing', () => {
    const { host, files } = synthHost();
    delete files['CUTS/CS000.N02']; delete files['SOUND/BSP05.VOC'];
    const p = new CutscenePlayer(0, host);
    play(p, 30);
    expect(p.done).toBe(true);
    expect(p.problems).toEqual(['missing SOUND/BSP05.VOC', 'missing CUTS/CS000.N02']);
    const none = new CutscenePlayer(77, host);
    none.update(1);
    expect(none.done).toBe(true);
    expect(none.problems).toEqual(['missing CUTS/CS115.N00']);
  });

  it('scrolls a panorama with the sprite over it, and swaps in the cart-less backdrop', () => {
    const { host } = synthHost();
    const p = new CutscenePlayer(2, host);
    const frames: Uint8Array[] = [];
    let v = -1;
    play(p, 5, () => { if (p.version !== v) { v = p.version; frames.push(p.screen.slice()); } });
    expect(p.problems).toEqual([]);
    expect(p.sceneH).toBe(160);
    // frame 0 (scroll x = 71): LBACK000 (1 + odd rows) left of x 249, LBACK001 (50 + odd columns) after
    const f0 = frames.find(f => f[0] !== 0)!;
    expect(f0[0]).toBe(1); expect(f0[320]).toBe(2);
    expect(f0[249]).toBe(50 + ((249 + 71 - 320) & 1));
    expect(f0[170 * 320]).toBe(0); // the subtitle band
    // frame 1 (x = 72): the sprite draws the cart, so the backdrop is now the cart-less one; the cart is at x 100
    const f1 = frames.find(f => f[55 * 320 + 100] === 200)!;
    expect(f1[0]).toBe(90);
    expect(f1[55 * 320 + 99]).toBe(90);
    expect(f1[55 * 320 + 247]).toBe(90); expect(f1[55 * 320 + 248]).toBe(50);
    // frame 2 has no new sprite data: the cart slides a pixel with the scene
    const f2 = frames[frames.indexOf(f1) + 1]!;
    expect(f2[55 * 320 + 99]).toBe(200); expect(f2[55 * 320 + 109]).toBe(90);
  });

  it('opens a random Guardian backdrop (996) and lerps the palette toward PALS.DAT', () => {
    const picks = new Set<number>();
    for (let seed = 1; seed < 40; seed++) {
      const p = new CutscenePlayer(4, synthHost(undefined, seed).host);
      p.update(0.05);
      picks.add(px(p, 0, 0));
    }
    expect([...picks].sort()).toEqual([28, 29, 30, 31]);
    const p = new CutscenePlayer(4, synthHost().host);
    play(p, 0.45);
    const dst = palsEntry(synthPals(), 1)!;
    expect([...p.pal.subarray(40, 43)]).toEqual([...dst.subarray(40, 43)]);
    expect([...p.pal.subarray(40, 43)]).not.toEqual([...PAL.subarray(40, 43)]);
  });

  it('the title shows the Origin and LGS screens first, then cycles colours', () => {
    const { host } = synthHost();
    const p = new CutscenePlayer(9, host);
    p.update(0.01);
    expect(px(p, 5, 5)).toBe(6);
    expect(p.bright).toBe(1);
    expect([...p.pal.subarray(0, 3)]).toEqual([...palsEntry(synthPals(), 5)!.subarray(0, 3)]);
    p.update(2.2); expect(p.bright).toBe(0);
    p.update(0.5); expect(px(p, 5, 5)).toBe(7);
    p.update(2.5);
    expect(px(p, 5, 5)).toBe(100);
    expect(p.subtitle?.text).toBe('Labyrinth of Worlds');
    const before = [...p.pal.subarray(400, 416)];
    p.update(1 / 18.2 + 0.001);
    expect([...p.pal.subarray(400, 404)]).toEqual(before.slice(4, 8)); // colour 100 takes 101's place
    expect([...p.pal.subarray(412, 416)]).toEqual(before.slice(0, 4));
    play(p, 10);
    expect(p.done).toBe(true);
    expect(p.problems).toEqual([]);
  });

  it('big steps and small steps give the same show', () => {
    const run = (dt: number) => {
      const p = new CutscenePlayer(0, synthHost().host), shots: string[] = [];
      for (let t = 0; t < 3; t += dt) { p.update(dt); shots.push(`${p.subtitle?.text}`); }
      return { done: p.done, end: p.t > 1.7 && p.t < 1.8 + 0.5, screen: [...p.screen.subarray(0, 4)], subs: [...new Set(shots)] };
    };
    const fine = run(1 / 60), coarse = run(0.25);
    expect(coarse.done && fine.done).toBe(true);
    expect(coarse.screen).toEqual(fine.screen);
    expect(fine.subs).toEqual(['Dear Avatar,', 'Second line.', 'undefined']);
  });
});

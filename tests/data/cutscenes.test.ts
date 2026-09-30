import { describe, expect, it } from 'vitest';
import { CUTS_ARGS, DataError, cutsName, readCutsScript, readLpf, readScreen, readStrings, readVoc, s16, type CutsCmd } from '../../src/formats';
import { CutscenePlayer } from '../../src/cuts/player';
import { hasCutscenes } from '../../src/data/files';
import { seededRng } from '../../src/core/rng';
import { disc, needDisc } from './disc';

// Every cutscene on the real disc: its script parses, every file it names is there and decodes, every string and
// voice clip it names exists, and it plays through headless to the end without the player reporting a problem.
// Facts asserted here come from docs/CUTSCENES.md, where they are marked as verified against the disc.

/** The catalogue (docs/CUTSCENES.md). 3, 8, 11-23 and 31 are not used by UW2. */
const CATALOGUE = [0, 1, 2, 4, 5, 6, 7, 9, 10, 24, 25, 26, 27, 28, 29, 30, 32];
const EVERY_4TH = 'CS012.N01';
/**
 * Problems the disc's own data causes, by cutscene. CS040.N00 (32) says open-file 40 / 1, which names CS050.N01 (the
 * number is octal-encoded, as for every other open-file, and UnderworldGodot reads it the same way); the disc has no
 * such file. The script evidently meant its own CS040.N01, which is already showing: the original keeps showing the
 * current file when an open fails, and so does the player, so the picture is unaffected.
 */
const KNOWN_PROBLEMS: Record<number, string[]> = { 32: ['missing CUTS/CS050.N01'] };

describe.runIf(needDisc())('cutscenes on the real disc', () => {
  const files = disc() ?? {}; // (the body is still collected when skipped)
  const strings = files['STRINGS.PAK'] ? readStrings(files['STRINGS.PAK']) : new Map<number, string[]>();
  const script = (n: number): CutsCmd[] => readCutsScript(files['CUTS/' + cutsName(n, 0)]!);
  const voices = (n: number) => script(n).filter(c => c.cmd === 13 && c.args[2]! < 998).map(c => c.args[2]!);

  it('the disc copy carries the cutscenes and their speech', () => {
    expect(hasCutscenes(files)).toBe(true);
    for (const n of CATALOGUE) expect(files['CUTS/' + cutsName(n, 0)], cutsName(n, 0)).toBeDefined();
    expect(Object.keys(files).filter(k => k.startsWith('SOUND/BSP')).length).toBeGreaterThan(0);
  });

  it('every control script parses with known commands', () => {
    for (const n of CATALOGUE) {
      const cmds = script(n);
      expect(cmds.length, cutsName(n, 0)).toBeGreaterThan(0);
      for (const c of cmds) expect(CUTS_ARGS[c.cmd], `${cutsName(n, 0)} command ${c.cmd}`).toBeDefined();
      expect(cmds.some(c => c.cmd === 6), `${cutsName(n, 0)} ends`).toBe(true);
    }
  });

  it('every animation decodes every frame, at 320x200', () => {
    const lpfs = Object.keys(files).filter(k => /^CUTS\/CS[0-7]{3}\.N[0-7]{2}$/.test(k) && !k.endsWith('.N00'));
    expect(lpfs.length).toBeGreaterThan(20);
    for (const k of lpfs) {
      const L = readLpf(files[k]!);
      expect([L.w, L.h], k).toEqual([320, 200]);
      expect(L.fps, k).toBeGreaterThan(0);
      const px = new Uint8Array(L.w * L.h);
      for (let i = 0; i < L.nFrames; i++) {
        if (k.endsWith(EVERY_4TH) && i % 4) continue; // the credits' in-between frames are known to be damaged
        try { L.decode(i, px); } catch (e) { throw new Error(`${k} frame ${i}: ${e instanceof DataError ? e.message : e}`); }
      }
    }
  });

  it('every panorama backdrop is a 320x200 screen', () => {
    const backs = Object.keys(files).filter(k => k.startsWith('CUTS/LBACK'));
    expect(backs.length).toBeGreaterThan(0);
    for (const k of backs) expect(readScreen(files[k]!).length, k).toBe(64000);
  });

  it('every subtitle a script shows exists in its string block', () => {
    for (const n of CATALOGUE) {
      const block = strings.get(0xc00 + n) ?? [];
      for (const c of script(n)) {
        const i = c.cmd === 0 ? c.args[1]! : c.cmd === 13 ? c.args[1]! : -1;
        if (i < 0 || (c.cmd === 13 && s16(i) < 0)) continue;
        expect(block[i], `${cutsName(n, 0)} string ${(0xc00 + n).toString(16)}:${i}`).toBeTruthy();
      }
    }
  });

  it('the texts the research names are where it says', () => {
    // the disc wraps subtitles over several lines: compare with whitespace collapsed
    const at = (b: number) => (strings.get(b) ?? []).join('\n').toLowerCase().replace(/\s+/g, ' ');
    expect(at(0xc00)).toContain('dear avatar');
    expect(at(0xc18)).toContain('i hear the beaches near cove are nice');
    expect(at(0xc20)).toContain('yes, british, hasten to thy vain struggle');
  });

  it('the Guardian\'s taunts and the story dreams speak with the clips the research names', () => {
    ([[4, 5], [5, 6], [6, 7], [7, 12], [24, 0], [25, 2], [26, 3], [27, 4]] as const).forEach(([n, v]) => expect(voices(n), cutsName(n, 0)).toContain(v));
    for (const n of [28, 29, 30, 32]) expect(voices(n), cutsName(n, 0)).toEqual([]);
  });

  it('every voice clip a script names is 8-bit PCM at a plausible rate', () => {
    const named = new Set(CATALOGUE.flatMap(voices));
    for (const v of named) {
      const k = `SOUND/BSP${String(v).padStart(2, '0')}.VOC`;
      expect(files[k], k).toBeDefined();
      const voc = readVoc(files[k]!);
      expect(voc.rate, k).toBeGreaterThanOrEqual(4000);
      expect(voc.rate, k).toBeLessThanOrEqual(45000);
      expect(voc.pcm.length / voc.rate, k).toBeGreaterThan(0.2);
    }
  });

  it.each(CATALOGUE)('cutscene %i plays through to the end', n => {
    const said = new Set<string>();
    let voiced = 0;
    const p = new CutscenePlayer(n, {
      file: k => files[k], str: (b, i) => strings.get(b)?.[i], rng: seededRng(n), voice: v => { if (v) voiced++; },
    });
    for (let k = 0; k < 20 * 60 * 10 && !p.done && !p.held; k++) { p.update(0.1); if (p.subtitle) said.add(p.subtitle.text); }
    if (p.held) p.skip(); // "pause forever": the original waits for a key
    expect(p.done, `still playing after ${p.t.toFixed(0)} s`).toBe(true);
    expect(p.problems).toEqual(KNOWN_PROBLEMS[n] ?? []);
    expect(p.t).toBeGreaterThan(1);
    expect(voiced).toBe(voices(n).length);
    const shown = script(n).filter(c => c.cmd === 0 || (c.cmd === 13 && s16(c.args[1]!) >= 0)).length;
    if (shown) expect(said.size).toBeGreaterThan(0);
  });
});

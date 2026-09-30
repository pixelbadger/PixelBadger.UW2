import { describe, expect, it } from 'vitest';
import { readSoundsDat, readTimbres, readVoc, readXmi } from '../../src/formats';
import { FmDriver, TimbreBank, XmiPlayer } from '../../src/audio/music';
import { hasSound } from '../../src/data/files';
import { disc, needDisc } from './disc';

// The real disc's sound folder: SOUNDS.DAT and every effect clip parse, the instrument bank parses, and every theme
// parses and renders its first seconds through the synth (finite, not silent) with timbres the bank has.

describe.runIf(needDisc())('sound on the real disc', () => {
  const files = disc() ?? {};
  const keys = Object.keys(files);

  it('the disc copy carries SOUNDS.DAT, the effects, the bank and the themes', () => {
    expect(hasSound(files)).toBe(true);
    expect(keys.some(k => /^SOUND\/SP\d\d\.VOC$/.test(k))).toBe(true);
    expect(files['SOUND/UW.OPL'] ?? files['SOUND/UW.AD']).toBeDefined();
    expect(keys.filter(k => /^SOUND\/UWA[0-7]{2}\.XMI$/.test(k)).length).toBeGreaterThan(8);
  });

  it('SOUNDS.DAT and every effect clip parse', () => {
    const s = readSoundsDat(files['SOUND/SOUNDS.DAT']!);
    expect(s.length).toBeGreaterThan(30);
    for (const k of keys.filter(k => /^SOUND\/(SP|UW)\d\d\.VOC$/.test(k))) expect(readVoc(files[k]!).pcm.length, k).toBeGreaterThan(0);
  });

  it('every theme renders through the disc\'s own instruments', () => {
    const bank = new TimbreBank(readTimbres(files['SOUND/UW.OPL'] ?? files['SOUND/UW.AD']!));
    expect(bank.size).toBeGreaterThan(20);
    for (const k of keys.filter(k => /^SOUND\/UWA[0-7]{2}\.XMI$/.test(k))) {
      const x = readXmi(files[k]!);
      expect(x.events.length, k).toBeGreaterThan(0);
      const known = x.timbres.filter(t => bank.get(t.bank, t.patch)).length;
      expect(known, `${k}: timbres the bank has`).toBeGreaterThanOrEqual(Math.ceil(x.timbres.length * 0.8));
      const p = new XmiPlayer(x, new FmDriver(bank, 11025), false), l = new Float32Array(11025 * 10), r = new Float32Array(11025 * 10);
      p.render(l, r);
      expect(l.every(Number.isFinite), k).toBe(true);
      expect(l.some(v => Math.abs(v) > 1e-3), `${k} is silent`).toBe(true);
    }
  });
});

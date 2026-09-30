import { describe, expect, it } from 'vitest';
import { readTimbres, readXmi, writeTimbres, writeXmi } from '../../src/formats';
import { DRUM, ORGAN } from '../helpers/synthSound';
import { FmDriver, TimbreBank, XmiPlayer } from '../../src/audio/music';
import { FmVoice, attackSeconds, blockFnum, decaySeconds, wave } from '../../src/audio/fm';

const rms = (a: Float32Array, s = 0, e = a.length) => { let t = 0; s = Math.floor(s); for (let i = s; i < e; i++) t += a[i]! * a[i]!; return Math.sqrt(t / Math.max(1, e - s)); };
const RATE = 22050;

describe('FM voice', () => {
  it('has the chip\'s waveforms, frequency split and envelope times', () => {
    expect(wave(0, 0.25)).toBeCloseTo(1, 2);
    expect(wave(1, 0.75)).toBe(0);
    expect(wave(2, 0.75)).toBeCloseTo(1, 2);
    expect(wave(6, 0.7)).toBe(-1);
    const { block, fnum } = blockFnum(440);
    expect(fnum).toBeLessThan(1024);
    expect((fnum * 49716) / 2 ** (20 - block)).toBeCloseTo(440, 0);
    expect(attackSeconds(60)).toBe(0);
    expect(decaySeconds(0)).toBe(Infinity);
    expect(decaySeconds(60)).toBeCloseTo(0.0024, 3);
    expect(decaySeconds(4)).toBeCloseTo(39.28, 1);
  });

  it('sounds while held, holds a sustaining envelope, and dies away once released', () => {
    const v = new FmVoice(ORGAN);
    v.setFreq(440); v.keyOn();
    const on = new Float32Array(RATE / 2);
    v.render(on, 0, on.length, RATE, 1, 1, 0);
    expect(rms(on, on.length / 2)).toBeGreaterThan(0.05);
    v.keyOff();
    const off = new Float32Array(RATE * 6); // release rate 4: about 5 s through the full 96 dB
    v.render(off, 0, off.length, RATE, 1, 1, 0);
    expect(rms(off, off.length - 1000)).toBeLessThan(rms(on, on.length / 2) / 50);
    expect(v.done).toBe(true);
  });
});

describe('timbre bank and XMI', () => {
  it('round-trip through the writers', () => {
    expect(readTimbres(writeTimbres([ORGAN, DRUM]))).toEqual([ORGAN, DRUM]);
    const x = readXmi(writeXmi({ timbres: [{ patch: 0, bank: 0 }], events: [
      { tick: 0, data: [0xc0, 0] }, { tick: 0, data: [0x90, 60, 100], dur: 300 }, { tick: 400, data: [0xb0, 7, 90] }, { tick: 500, data: [0x99, 36, 127], dur: 10 },
    ] }));
    expect(x.timbres).toEqual([{ patch: 0, bank: 0 }]);
    expect(x.events.map(e => e.tick)).toEqual([0, 0, 400, 500]);
    expect(x.events[1]!.dur).toBe(300);
    expect(x.ticks).toBe(510);
  });

  it('a song plays its notes, ends, and loops when asked', () => {
    const bank = new TimbreBank([ORGAN, DRUM]);
    const song = readXmi(writeXmi({ events: [{ tick: 0, data: [0xc0, 0] }, { tick: 0, data: [0x90, 60, 110], dur: 60 }, { tick: 60, data: [0x99, 36, 120], dur: 5 }] }));
    const fm = new FmDriver(bank, RATE), p = new XmiPlayer(song, fm, false);
    expect(p.seconds).toBeCloseTo(65 / 120, 3);
    const l = new Float32Array(RATE / 4), r = new Float32Array(RATE / 4);
    p.render(l, r);
    expect(rms(l)).toBeGreaterThan(0.01);
    expect(fm.active).toBeGreaterThan(0);
    for (let k = 0; k < 16; k++) { l.fill(0); r.fill(0); p.render(l, r); }
    expect(p.ended).toBe(true);
    const q = new XmiPlayer(song, new FmDriver(bank, RATE), true);
    for (let k = 0; k < 8; k++) { l.fill(0); q.render(l, r); }
    expect(q.ended).toBe(false);
  });

  it('renders a busy second of music quickly enough for real time', () => {
    const bank = new TimbreBank([ORGAN, DRUM]);
    const events = [];
    for (let t = 0; t < 120; t += 4) for (let c = 0; c < 8; c++) events.push({ tick: t, data: [0x90 | c, 40 + c * 5 + (t % 12), 100], dur: 30 });
    const p = new XmiPlayer(readXmi(writeXmi({ events })), new FmDriver(bank, 44100), false);
    const l = new Float32Array(4410), r = new Float32Array(4410), t0 = performance.now();
    for (let k = 0; k < 10; k++) p.render(l, r);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

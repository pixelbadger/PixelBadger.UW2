import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DataError, cutsName, palsEntry, readCutsScript, readLpf, readScreen, readVoc, vocSeconds, writeCutsScript, writeIso, writeLpf, writeVoc,
} from '../../src/formats';
import { filesFromIso, filesFromPicked, hasCutscenes } from '../../src/data/files';
import { PAL, synthCutsFiles, synthPals } from '../helpers/synthCuts';
import { synthFiles } from '../helpers/synth';

describe('cutscene file names', () => {
  it('are octal: cutscene 9 is CS011, extension 8 is N10', () => {
    expect(cutsName(0, 0)).toBe('CS000.N00');
    expect(cutsName(9, 8)).toBe('CS011.N10');
    expect(cutsName(10, 10)).toBe('CS012.N12');
    expect(cutsName(24, 1)).toBe('CS030.N01');
    expect(cutsName(0x103, 1)).toBe('CS403.N01');
  });
});

describe('LPF animations', () => {
  const frames = (w: number, h: number) => fc.array(fc.uint8Array({ minLength: w * h, maxLength: w * h }).chain(a =>
    // mix in runs and unchanged stretches so every opcode is exercised
    fc.nat(3).map(k => (k === 0 ? new Uint8Array(w * h).fill(a[0] ?? 0) : a))), { minLength: 1, maxLength: 6 });

  it('decode back to the frames they were written from (delta on delta, across pages)', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 30 }), fc.boolean(), fc.integer({ min: 1, max: 3 }), (w, h, loop, perPage) => {
      fc.assert(fc.property(frames(w, h), fs => {
        const L = readLpf(writeLpf({ w, h, fps: 12, pal: PAL, frames: fs, loopDelta: loop, perPage }));
        expect([L.w, L.h, L.fps, L.frames, L.loopDelta]).toEqual([w, h, 12, fs.length, loop]);
        const px = new Uint8Array(w * h);
        fs.forEach((f, i) => { L.decode(i, px); expect(px).toEqual(f); });
        if (loop) { L.decode(fs.length, px); expect(px).toEqual(fs[0]); }
      }), { numRuns: 5 });
    }), { numRuns: 40 });
  });

  it('long runs, skips and dumps round-trip on a full screen', () => {
    const a = new Uint8Array(64000).fill(7), b = a.slice();
    b.fill(9, 100, 30000); for (let i = 40000; i < 41000; i++) b[i] = i & 255; b[63999] = 1;
    const L = readLpf(writeLpf({ w: 320, h: 200, fps: 10, pal: PAL, frames: [a, b, b] }));
    const px = new Uint8Array(64000);
    expect(L.decode(0, px)).toBe(true); expect(px).toEqual(a);
    expect(L.decode(1, px)).toBe(true); expect(px).toEqual(b);
    expect(L.decode(2, px)).toBe(false); // an unchanged frame is an empty record
  });

  it('marks only the pixels a record writes', () => {
    const a = new Uint8Array(16), b = a.slice(); b[3] = 5; b[4] = 5; b[10] = 1;
    const L = readLpf(writeLpf({ w: 4, h: 4, fps: 10, pal: PAL, frames: [a, b] }));
    const px = new Uint8Array(16).fill(99), mask = new Uint8Array(16);
    L.decode(1, px, mask);
    expect([...mask].map((m, i) => (m ? i : -1)).filter(i => i >= 0)).toEqual([3, 4, 10]);
    expect(px[0]).toBe(99); // skipped pixels keep what was there
  });

  it('reads the palette (BGRx -> RGBA) and the colour cycling ranges', () => {
    const L = readLpf(writeLpf({ w: 1, h: 1, fps: 10, pal: PAL, frames: [Uint8Array.of(0)], crng: [{ rate: 18, flags: 1, low: 16, high: 31 }] }));
    expect([...L.pal.subarray(200 * 4, 200 * 4 + 4)]).toEqual([...PAL.subarray(200 * 4, 200 * 4 + 3), 255]);
    expect(L.crng[0]).toEqual({ rate: 18, flags: 1, low: 16, high: 31 });
    expect(L.crng[1]!.rate).toBe(0);
  });

  it('refuses what is not an LPF, and absurd sizes', () => {
    const ok = writeLpf({ w: 2, h: 2, fps: 10, pal: PAL, frames: [new Uint8Array(4)] });
    expect(() => readLpf(ok.subarray(0, 100))).toThrow(DataError);
    const bad = ok.slice(); bad[0] = 0x58;
    expect(() => readLpf(bad)).toThrow(DataError);
    const big = ok.slice(); big[0x14] = 0xff; big[0x15] = 0xff; big[0x16] = 0xff; big[0x17] = 0xff;
    expect(() => readLpf(big)).toThrow(DataError);
  });
});

describe('cutscene control scripts', () => {
  it('round-trip with each command\'s argument count', () => {
    const cmds = [{ frame: 0, cmd: 13, args: [241, 0, 5] }, { frame: 3, cmd: 0, args: [242, 1] }, { frame: 5, cmd: 5, args: [] }, { frame: 999, cmd: 9, args: [2] }];
    expect(readCutsScript(writeCutsScript(cmds))).toEqual(cmds);
  });
  it('drop a record cut short at the end; refuse unknown commands', () => {
    const b = writeCutsScript([{ frame: 0, cmd: 10, args: [4] }, { frame: 1, cmd: 13, args: [1, 2, 3] }]);
    expect(readCutsScript(b.subarray(0, b.length - 2))).toEqual([{ frame: 0, cmd: 10, args: [4] }]);
    expect(() => readCutsScript(writeCutsScript([{ frame: 0, cmd: 16, args: [] }]))).toThrow(DataError);
  });
});

describe('VOC speech', () => {
  it('round-trips 8-bit PCM and its rate', () => {
    const pcm = Uint8Array.from({ length: 500 }, (_, i) => i & 255);
    const v = readVoc(writeVoc({ rate: 11025, pcm }));
    expect(v.pcm).toEqual(pcm);
    expect(Math.abs(v.rate - 11025)).toBeLessThan(100); // the divisor byte can only say 1e6 / (256 - r)
    expect(vocSeconds(readVoc(writeVoc({ rate: 8000, pcm: new Uint8Array(4000) })))).toBeCloseTo(0.5, 3);
  });
  it('refuses other files and other codecs', () => {
    expect(() => readVoc(new Uint8Array(64))).toThrow(DataError);
    const b = writeVoc({ rate: 8000, pcm: new Uint8Array(10) }); b[0x1a + 5] = 4; // ADPCM
    expect(() => readVoc(b)).toThrow(DataError);
  });
});

describe('screens and palettes', () => {
  it('LBACK screens are 64000 bytes', () => {
    expect(readScreen(new Uint8Array(64000)).length).toBe(64000);
    expect(() => readScreen(new Uint8Array(100))).toThrow(DataError);
  });
  it('PALS.DAT palettes widen 6 bits to 8', () => {
    const p = palsEntry(synthPals(), 3)!;
    expect([...p.subarray(255 * 4, 255 * 4 + 4)]).toEqual([24 * 4 + 1, 63 * 4 + 3, 0, 255]);
    expect(palsEntry(synthPals(), 8)).toBeNull();
  });
});

describe('cutscene data intake', () => {
  const cuts = synthCutsFiles();
  const folder = (prefix: string) => Object.fromEntries(Object.entries(cuts).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  it('takes UW2/CUTS and the speech, effects and music from UW2/SOUND out of a disc image, and nothing else there', () => {
    const iso = writeIso({ data: synthFiles(), sub: { CUTS: { ...folder('CUTS/'), 'README.TXT': new Uint8Array(3) }, SOUND: { ...folder('SOUND/'), 'SP01.VOC': new Uint8Array(3), 'UWA12.XMI': new Uint8Array(3), 'UW.OPL': new Uint8Array(3), 'SOUNDS.DAT': new Uint8Array(3), 'UW.MT': new Uint8Array(3), 'DRIVER.ADV': new Uint8Array(3) } } });
    const files = filesFromIso(iso);
    for (const k of Object.keys(cuts).filter(k => k.includes('/'))) expect(files[k], k).toEqual(cuts[k]);
    expect(files['CUTS/README.TXT']).toBeUndefined();
    for (const k of ['SP01.VOC', 'UWA12.XMI', 'UW.OPL', 'SOUNDS.DAT']) expect(files['SOUND/' + k], k).toBeDefined();
    expect(files['SOUND/UW.MT']).toBeUndefined();
    expect(files['SOUND/DRIVER.ADV']).toBeUndefined();
    expect(hasCutscenes(files)).toBe(true);
    expect(hasCutscenes(filesFromIso(writeIso({ data: synthFiles() })))).toBe(false);
  });
  it('sorts loose cutscene files into place', async () => {
    const pick = (name: string, b: Uint8Array) => ({ name, arrayBuffer: async () => b.slice().buffer });
    const files = await filesFromPicked([...Object.entries(synthFiles()).map(([n, b]) => pick(n, b)), pick('cs000.n00', cuts['CUTS/CS000.N00']!), pick('BSP05.VOC', cuts['SOUND/BSP05.VOC']!), pick('LBACK001.BYT', cuts['CUTS/LBACK001.BYT']!)]);
    expect(files['CUTS/CS000.N00']).toEqual(cuts['CUTS/CS000.N00']);
    expect(files['SOUND/BSP05.VOC']).toEqual(cuts['SOUND/BSP05.VOC']);
    expect(files['CUTS/LBACK001.BYT']).toBeDefined();
  });
});

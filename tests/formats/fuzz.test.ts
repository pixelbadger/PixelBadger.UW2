import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DataError, LEVEL_BYTES, LIMITS, decodeLevel, readArk, readConv, readCritPage, readGR, readModels, readStrings, rleDecode,
  uw2CompressLiteral, uw2Decompress, writeArk, writeGR, writeStrings,
  CUTS_ARGS, readCutsScript, readLpf, readVoc, writeCutsScript, writeLpf, writeVoc,
} from '../../src/formats';
import { CutscenePlayer } from '../../src/cuts/player';
import { synthHost } from '../helpers/synthCuts';
import { ConvVM } from '../../src/conv/vm';
import { filesFromIso } from '../../src/data/files';
import { GameData } from '../../src/data/gamedata';
import { seededRng } from '../../src/core/rng';
import { synthConversation, synthFiles, synthIso } from '../helpers/synth';

// Adversarial tests for everything that reads game data. The contract: a parser returns something within LIMITS or
// throws DataError. Any other exception, a hang or a huge allocation is a bug.

const RUNS = { numRuns: 300 };

/** Runs f; a DataError is an acceptable answer, anything else thrown fails the property. */
function hostile<T>(f: () => T): T | DataError {
  try { return f(); } catch (e) { if (e instanceof DataError) return e; throw e; }
}

const bytes = (max = 2048) => fc.uint8Array({ minLength: 0, maxLength: max });

/** A valid file with some bytes overwritten and maybe truncated or extended. */
const mutated = (base: Uint8Array) =>
  fc.record({
    edits: fc.array(fc.tuple(fc.nat(Math.max(0, base.length - 1)), fc.integer({ min: 0, max: 255 })), { maxLength: 24 }),
    cut: fc.option(fc.nat(base.length), { nil: undefined }),
    tail: bytes(64),
  }).map(({ edits, cut, tail }) => {
    const b = Uint8Array.from(base);
    for (const [i, v] of edits) b[i] = v;
    const t = cut === undefined ? b : b.subarray(0, cut);
    const out = new Uint8Array(t.length + tail.length); out.set(t); out.set(tail, t.length);
    return out;
  });

describe('uw2Decompress', () => {
  it('literal encoding round-trips any data', () => {
    fc.assert(fc.property(bytes(5000), d => { expect(uw2Decompress(uw2CompressLiteral(d))).toEqual(d); }), RUNS);
  });
  it('never exceeds its declared size or the limit, whatever the input', () => {
    fc.assert(fc.property(bytes(), src => {
      const r = hostile(() => uw2Decompress(src, 1 << 16));
      if (r instanceof DataError) return;
      expect(r.length).toBeLessThanOrEqual(1 << 16);
    }), RUNS);
  });
  it('refuses a size claim above the limit without allocating it', () => {
    expect(() => uw2Decompress(Uint8Array.of(0xff, 0xff, 0xff, 0x7f, 1, 2))).toThrow(DataError);
  });
});

describe('readArk', () => {
  const base = writeArk([Uint8Array.of(1, 2, 3), null, new Uint8Array(100).fill(7)], uw2CompressLiteral);
  it('survives random and mutated arks', () => {
    fc.assert(fc.property(fc.oneof(bytes(), mutated(base)), buf => {
      const r = hostile(() => readArk(buf));
      if (r instanceof DataError) return;
      for (const b of r) if (b) expect(b.length).toBeLessThanOrEqual(LIMITS.maxDecompressed);
    }), RUNS);
  });
  it('rejects a block count whose header cannot fit', () => {
    expect(() => readArk(Uint8Array.of(0xff, 0x0f, 0, 0, 0, 0))).toThrow(DataError);
  });
});

describe('.GR images and RLE', () => {
  const pal = new Uint8Array(512).map((_, i) => i & 255);
  const base = writeGR([{ w: 4, h: 4, px: new Uint8Array(16).fill(3) }, { w: 8, h: 2, px: new Uint8Array(16).fill(9) }]);
  it('survives random and mutated files within the pixel budget', () => {
    fc.assert(fc.property(fc.oneof(bytes(), mutated(base)), buf => {
      const r = hostile(() => readGR(buf, pal));
      if (r instanceof DataError) return;
      let total = 0;
      for (const im of r) if (im) { expect(im.px.length).toBe(im.w * im.h); total += im.w * im.h; }
      expect(total).toBeLessThanOrEqual(LIMITS.maxGrPixels);
    }), RUNS);
  });
  it('refuses a file that repeats one huge image to exhaust memory', () => {
    const n = 4000, b = new Uint8Array(3 + n * 4 + 8), dv = new DataView(b.buffer);
    dv.setUint16(1, n, true);
    for (let i = 0; i < n; i++) dv.setUint32(3 + i * 4, 3 + n * 4, true);
    b.set([4, 255, 255], 3 + n * 4);
    expect(() => readGR(b, pal)).toThrow(DataError);
  });
  it('RLE output is always w*h and decoding terminates', () => {
    fc.assert(fc.property(bytes(512), fc.nat(600), fc.integer({ min: 0, max: 64 }), fc.integer({ min: 0, max: 64 }), fc.constantFrom(4, 5), (buf, words, w, h, bits) => {
      expect(rleDecode(buf, 0, words, w, h, bits, pal).length).toBe(w * h);
    }), RUNS);
  });
  it('critter pages decode or yield nulls', () => {
    fc.assert(fc.property(bytes(4096), fc.integer({ min: 0, max: 3 }), (buf, aux) => {
      const r = hostile(() => readCritPage(buf, aux));
      if (!(r instanceof DataError)) expect(r).toHaveLength(256);
    }), { numRuns: 100 });
  });
});

describe('STRINGS.PAK', () => {
  const base = writeStrings(new Map([[1, ['alpha', 'beta gamma', 'delta']], [4, ['a_sword&swords']]]));
  it('survives random and mutated files, bounded per string', () => {
    fc.assert(fc.property(fc.oneof(bytes(), mutated(base)), buf => {
      const r = hostile(() => readStrings(buf));
      if (r instanceof DataError) return;
      for (const strs of r.values()) for (const s of strs) expect(s.length).toBeLessThanOrEqual(LIMITS.maxStringLength);
    }), RUNS);
  });
  it('terminates on a huffman tree with a cycle', () => {
    const b = Uint8Array.from(base);
    // point the root's children back at the root
    const nn = b[0]! | (b[1]! << 8), root = 2 + (nn - 1) * 4;
    b[root + 2] = nn - 1; b[root + 3] = nn - 1;
    const r = hostile(() => readStrings(b));
    if (!(r instanceof DataError)) for (const strs of r.values()) for (const s of strs) expect(s).toBe('');
  });
});

describe('conversation bytecode', () => {
  const base = synthConversation();
  it('readConv survives random and mutated blocks', () => {
    fc.assert(fc.property(fc.oneof(bytes(), mutated(base)), buf => { hostile(() => readConv(buf)); }), RUNS);
  });
  it('ConvVM always stops in a known state on random code', () => {
    const cv = readConv(base)!;
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 0x2b }), { minLength: 1, maxLength: 200 }), fc.array(fc.integer({ min: -3, max: 300 }), { maxLength: 200 }), fc.integer(), (ops, imms, seed) => {
      const code = new Uint16Array(ops.length * 2);
      ops.forEach((op, i) => { code[i * 2] = op; code[i * 2 + 1] = (imms[i] ?? 0) & 0xffff; });
      const rng = seededRng(seed);
      const vm = new ConvVM({ ...cv, code }, ['a', '@GS1', 'b'], { rng, fn: () => Math.floor(rng() * 5), gstr: () => 'g' });
      let st = vm.run(20000);
      for (let k = 0; k < 5 && (st === 'menu' || st === 'ask' || st === 'more'); k++) st = vm.answer(st === 'ask' ? 'xyzzy' : 1);
      expect(['done', 'error', 'menu', 'ask', 'more']).toContain(st);
    }), RUNS);
  });
  it('a builtin call with an absurd argument count is capped, not looped over', () => {
    const cv = readConv(base)!;
    const code = Uint16Array.of(0x16, 0x7fff, 0x14, 1, 0x26); // PUSHI 32767; CALLI set_quest; EXIT
    let seen = -1;
    const vm = new ConvVM({ ...cv, code }, [], { fn: (_n, v) => { seen = v.length; return 0; } });
    expect(['done', 'error']).toContain(vm.run());
    expect(seen).toBeLessThanOrEqual(LIMITS.vmMaxArgs);
  });
});

describe('UW2.EXE models', () => {
  const sig = [0xd4, 0x64, 0xaa, 0x59];
  it('decoding random tables terminates within the limits', () => {
    fc.assert(fc.property(bytes(4096), fc.nat(100), (body, at) => {
      const exe = new Uint8Array(body.length + 400);
      exe.set(body, 0);
      exe.set(sig, Math.min(at, exe.length - 4));
      const r = hostile(() => readModels(exe));
      if (r && !(r instanceof DataError)) { expect(r).toHaveLength(32); for (const m of r) expect(m.tris.length).toBeLessThanOrEqual(LIMITS.maxModelTris); }
    }), { numRuns: 150 });
  });
  it('a self-referencing sort node cannot recurse exponentially', () => {
    const exe = new Uint8Array(0x400);
    exe.set(sig, 0);
    // every model starts at base+10 with a 0x0c sort node whose both children point back at itself
    const base = 0x9a + 10;
    exe[base] = 0x0c; exe[base + 1] = 0;
    const l = base + 2 + 8, lo = (base - (l + 2)) & 0xffff, ro = (base - (l + 4)) & 0xffff;
    exe[l] = lo & 255; exe[l + 1] = lo >> 8; exe[l + 2] = ro & 255; exe[l + 3] = ro >> 8;
    const t0 = Date.now();
    readModels(exe);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('ISO extraction', () => {
  const iso = synthIso();
  it('mutated images extract or fail with DataError', () => {
    // mutate only the first 40 sectors (volume descriptor and directories) to keep the test fast
    const head = iso.subarray(0, Math.min(iso.length, 40 * 2048));
    fc.assert(fc.property(mutated(head), h => {
      const b = Uint8Array.from(iso); b.set(h.subarray(0, Math.min(h.length, head.length)));
      hostile(() => filesFromIso(b));
    }), { numRuns: 100 });
  });
});

describe('levels and the whole data set', () => {
  it('decodeLevel survives random level blocks', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: LEVEL_BYTES, maxLength: LEVEL_BYTES }), L => {
      const r = hostile(() => decodeLevel(L, null, 0, id => id >= 0x160 && id < 0x170));
      if (!(r instanceof DataError)) expect(r.tiles).toHaveLength(4096);
    }), { numRuns: 40 });
  });
  it('GameData on mutated files fails only with DataError', () => {
    const files = synthFiles();
    const names = Object.keys(files);
    fc.assert(fc.property(fc.constantFrom(...names), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 16 }), fc.boolean(), (name, edits, cut) => {
      const f = { ...files }, b = Uint8Array.from(f[name]!);
      for (const [i, v] of edits) b[i % b.length] = v;
      f[name] = cut ? b.subarray(0, b.length >> 1) : b;
      hostile(() => { const D = new GameData(f); D.conversations(); });
    }), { numRuns: 120 });
  });
});

describe('cutscene data', () => {
  const lpf = writeLpf({ w: 16, h: 8, fps: 10, pal: new Uint8Array(1024), frames: [new Uint8Array(128).fill(3), new Uint8Array(128).map((_, i) => i)], loopDelta: true });
  it('LPF files decode every frame or throw DataError, never writing outside the frame', () => {
    // mutate the header and the first page (the rest of a 64K page is padding)
    const head = lpf.subarray(0, 0xb00 + 600);
    fc.assert(fc.property(fc.oneof(bytes(4096), mutated(head)), buf => {
      const L = hostile(() => readLpf(buf));
      if (L instanceof DataError) return;
      expect(L.w * L.h).toBeLessThanOrEqual(LIMITS.maxLpfPixels);
      const px = new Uint8Array(L.w * L.h + 16).fill(0xee), view = px.subarray(0, L.w * L.h);
      for (let i = 0; i < Math.min(L.nFrames, 50); i++) hostile(() => L.decode(i, view));
      expect([...px.subarray(L.w * L.h)].every(v => v === 0xee)).toBe(true);
    }), RUNS);
  });
  it('control scripts and VOC files parse or throw DataError', () => {
    const script = writeCutsScript([{ frame: 0, cmd: 13, args: [241, 0, 5] }, { frame: 5, cmd: 5, args: [] }, { frame: 0, cmd: 6, args: [] }]);
    const voc = writeVoc({ rate: 8000, pcm: new Uint8Array(300).fill(128) });
    fc.assert(fc.property(fc.oneof(bytes(), mutated(script)), buf => { const r = hostile(() => readCutsScript(buf)); if (!(r instanceof DataError)) expect(r.length).toBeLessThanOrEqual(buf.length / 4); }), RUNS);
    fc.assert(fc.property(fc.oneof(bytes(), mutated(voc)), buf => { const r = hostile(() => readVoc(buf)); if (!(r instanceof DataError)) expect(r.pcm.length).toBeLessThanOrEqual(buf.length); }), RUNS);
  });
  it('the player finishes (or waits for a skip) on any script over any files, without throwing', () => {
    const base = synthHost();
    const cmd = fc.record({ frame: fc.oneof(fc.nat(12), fc.constant(999)), cmd: fc.constantFrom(...Object.keys(CUTS_ARGS).map(Number)), a: fc.array(fc.oneof(fc.nat(12), fc.constantFrom(996, 998, 999, 0xffff, 640)), { minLength: 4, maxLength: 4 }) })
      .map(c => ({ frame: c.frame, cmd: c.cmd, args: c.a.slice(0, CUTS_ARGS[c.cmd]) }));
    const fileKeys = Object.keys(base.files);
    fc.assert(fc.property(fc.array(cmd, { maxLength: 24 }), fc.array(fc.tuple(fc.constantFrom(...fileKeys), fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }), fc.integer(), (cmds, edits, seed) => {
      const files: Record<string, Uint8Array> = { ...base.files, 'CUTS/CS000.N00': writeCutsScript(cmds) };
      for (const [k, at, v] of edits) { const b = files[k]!.slice(); b[at % b.length] = v; files[k] = b; }
      const p = new CutscenePlayer(0, synthHost(files, seed).host);
      for (let k = 0; k < 40 && !p.done; k++) p.update(0.5); // 20 s of show, then skip whatever is left
      if (!p.done) p.skip();
      expect(p.done).toBe(true);
      expect(p.screen.length).toBe(64000);
    }), { numRuns: 120 });
  });
});

import { cutsName, writeArk, writeCutsScript, writeLpf, writeStrings, writeVoc, type CutsCmd } from '../../src/formats';
import type { GameFiles } from '../../src/data/files';
import { seededRng } from '../../src/core/rng';
import type { CutsHost } from '../../src/cuts/player';

// Synthetic cutscenes built with the format writers (no game content):
//   0  two segments: fade in, a voiced line, a second line at frame 3; then the next file; a fade out after.
//   2  a panorama: two LBACKs side by side, scrolled right with a sprite over them and the backdrop swap.
//   4  a random backdrop (996) and a palette lerp.
//   9  the title: splash screens from BYT.ARK, then an animation with colour cycling.

/** RGBA palette: colour c = (c, 255 - c, c >> 1). */
export const PAL = Uint8Array.from({ length: 1024 }, (_, i) => ((i & 3) === 3 ? 255 : (i & 3) === 0 ? i >> 2 : (i & 3) === 1 ? 255 - (i >> 2) : i >> 3));

export const W = 320, H = 200;
export const frame = (f: (x: number, y: number) => number): Uint8Array => { const px = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = f(x, y) & 255; return px; };
export const solid = (v: number): Uint8Array => new Uint8Array(W * H).fill(v);

const script = (cmds: [number, number, ...number[]][]): Uint8Array => writeCutsScript(cmds.map(([frame, cmd, ...args]): CutsCmd => ({ frame, cmd, args })));

export const VOICE = { rate: 8000, seconds: 0.25 };
export const INTRO_FPS = 10;

export function synthCutsFiles(): GameFiles {
  const f: GameFiles = {};
  const cut = (n: number, ext: number, b: Uint8Array) => (f['CUTS/' + cutsName(n, ext)] = b);
  // 0: the intro
  cut(0, 0, script([
    [0, 10, 4], [0, 13, 241, 0, 5], [3, 0, 242, 1], [5, 5],
    [0, 13, 241, 0xffff, 999], [2, 5],
    [999, 9, 2],
    [0, 6],
  ]));
  cut(0, 1, writeLpf({ w: W, h: H, fps: INTRO_FPS, pal: PAL, frames: [solid(10), solid(11), frame((x, y) => (x + y) % 7 + 20)], loopDelta: true }));
  cut(0, 2, writeLpf({ w: W, h: H, fps: INTRO_FPS, pal: PAL, frames: [solid(30), solid(31)] }));
  f['SOUND/BSP05.VOC'] = writeVoc({ rate: VOICE.rate, pcm: new Uint8Array(VOICE.rate * VOICE.seconds).map((_, i) => 128 + Math.round(60 * Math.sin(i / 5))) });
  // 2: a panorama scrolled right by 1 a frame, starting at x 70; subtitle band 40 rows
  cut(2, 0, script([
    [0, 10, 0], [0, 20, 640, 200, 40], [0, 22, 0, 0, 0], [0, 22, 320, 0, 1], [0, 21, 70, 0], [0, 23, 1, 1, 0], [6, 5],
    [0, 6],
  ]));
  // the sprite: frame 0 draws nothing, 1 draws the cart at x 100, 2 is unchanged, 3 moves it to x 103 (erasing behind)
  const cart = (k: number) => frame((x, y) => (x >= 100 + k && x < 110 + k && y >= 50 && y < 60 ? 200 : 0));
  cut(2, 1, writeLpf({ w: W, h: H, fps: 10, pal: PAL, frames: [solid(0), cart(0), cart(0), cart(3), cart(3), cart(3)] }));
  cut(2, 2, writeLpf({ w: W, h: H, fps: 10, pal: PAL, frames: [solid(90)] })); // the backdrop without the cart
  f['CUTS/LBACK000.BYT'] = frame((x, y) => 1 + (y & 1));
  f['CUTS/LBACK001.BYT'] = frame((x, y) => 50 + (x & 1));
  // 4: a random backdrop from CS034-CS037, a palette lerp to PALS.DAT[1] over 4 frames
  cut(4, 0, script([[0, 8, 996, 1], [0, 19, 1, 1, 4], [4, 5], [0, 6]]));
  for (let n = 28; n < 32; n++) cut(n, 1, writeLpf({ w: W, h: H, fps: 10, pal: PAL, frames: [solid(n)] }));
  // 9: splash, then colour cycling (range 100-103 at rate 65: one step a tick)
  cut(9, 0, script([[0, 10, 0], [0, 0, 243, 0], [20, 6]]));
  cut(9, 1, writeLpf({ w: W, h: H, fps: 5, pal: PAL, crng: [{ rate: 65, flags: 0, low: 100, high: 103 }], frames: [solid(100)] }));
  const byt: (Uint8Array | null)[] = Array(8).fill(null);
  byt[6] = solid(6); byt[7] = solid(7);
  f['BYT.ARK'] = writeArk(byt);
  return f;
}

/** PALS.DAT with 8 palettes: palette k colour c = (k*8, c >> 2, 63 - (c >> 2)) in 6 bits. */
export function synthPals(): Uint8Array {
  const b = new Uint8Array(8 * 768);
  for (let k = 0; k < 8; k++) for (let c = 0; c < 256; c++) b.set([(k * 8) & 63, c >> 2, 63 - (c >> 2)], k * 768 + c * 3);
  return b;
}

export const CUTS_STRINGS = new Map<number, string[]>([
  [0xc00, ['Dear Avatar,', 'Second line.']],
  [0xc09, ['Labyrinth of Worlds']],
]);
export const cutsStrings = (): Uint8Array => writeStrings(CUTS_STRINGS);

/** A player host over synthetic files that records the voice calls. */
export function synthHost(files: GameFiles = { ...synthCutsFiles(), 'PALS.DAT': synthPals() }, seed = 1) {
  const voices: (number | null)[] = [];
  const host: CutsHost = {
    file: k => files[k],
    str: (b, i) => CUTS_STRINGS.get(b)?.[i],
    rng: seededRng(seed),
    voice: v => voices.push(v ? v.pcm.length / v.rate : null),
  };
  return { host, voices, files };
}

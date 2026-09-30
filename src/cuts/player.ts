import {
  DataError, SCREEN_H, SCREEN_PX, SCREEN_W, cutsName, palsEntry, readArk, readCutsScript, readLpf, readScreen, readVoc, s16,
  vocSeconds, type CutsCmd, type Lpf, type Voc,
} from '../formats';
import { randInt, type Rng } from '../core/rng';

// Plays one cutscene from its .N00 control script, the way UnderworldGodot's cutsplayer does (hankmorgan, traced from
// UW2.EXE ovr108); see docs/CUTSCENES.md. No DOM: the player keeps a 320x200 indexed screen, a palette, a brightness
// and a subtitle, advanced by update(dt) in virtual time. The page draws those and plays the voice clips it is handed;
// tests run the same code headless and fast-forward.
//
// The script is split into segments at frame-set (5) and end (6). Each new segment moves on to the next animation
// file (.N02, .N03, ...) unless open-file (8) picked one. Commands fire when the segment reaches their frame; frame 999
// commands run after the segment. Frames advance at the LPF's own rate.
//
// Our approximations, where the original's behaviour is not known:
//  - fades take 2/rate seconds; fired during an animation they run alongside it, elsewhere they block;
//  - a script with no fade-in starts at full brightness (the others start black and fade in);
//  - CRNG colour cycling runs whenever a range has a rate (the flags field is ignored), stepping at 18.2 Hz;
//  - rep-seg (7) and the unknown commands 1, 2, 11, 12, 15, 18, 24, 26 do nothing; music (25) goes to the host.

export interface CutsHost {
  /** A game file: 'CUTS/CS000.N01', 'SOUND/BSP05.VOC', 'BYT.ARK', 'PALS.DAT'. */
  file(key: string): Uint8Array | undefined;
  /** A STRINGS.PAK string. */
  str(block: number, i: number): string | undefined;
  rng: Rng;
  /** Start a voice clip (null stops it). The player keeps the time; the host only makes the sound. */
  voice?(v: Voc | null): void;
  /** Command 25: play music theme n (UWAnn.XMI). */
  music?(n: number): void;
}

export interface Subtitle { text: string; colour: number }

/** CUTS/ files that need special handling (UnderworldGodot's list). */
const EVERY_4TH_FRAME = new Set(['CS012.N01']); // the credits: only every 4th frame is real

const MAX_STEPS_PER_UPDATE = 100_000;
const CRNG_HZ = 18.2;

type Mode = 'frame' | 'boundary' | 'sequential';

interface Sprite { lpf: Lpf; base: Uint8Array; buf: Uint8Array; mask: Uint8Array; frame: number; stale: number }

export class CutscenePlayer {
  /** 320x200 palette indices. Rows from sceneH down are the subtitle band and should show black. */
  readonly screen = new Uint8Array(SCREEN_PX);
  /** The palette the screen shows now (RGBA), after colour cycling or a palette lerp. */
  readonly pal = new Uint8Array(1024);
  /** 0 = black, 1 = full. */
  bright = 0;
  subtitle: Subtitle | null = null;
  sceneH = SCREEN_H;
  /** Bumps whenever something visible changes. */
  version = 0;
  done = false;
  skipped = false;
  /** Seconds of virtual time played. */
  t = 0;
  /** What the data asked for that we could not do: missing or damaged files and records. */
  readonly problems: string[] = [];
  /** Commands we recognise but do not act on yet (rep-seg; music without a host that plays it). */
  readonly unsupported: string[] = [];

  private readonly cmds: CutsCmd[];
  private readonly gen: Generator<number, void, void>;
  private wake = 0;
  /** The virtual time of the step being run. */
  private now = 0;
  private fade = { from: 0, to: 0, t0: 0, dur: 0 };
  private voiceEnd = 0;
  // the animation
  private lpf: Lpf | null = null;
  private ext = 1;
  private frameNo = 0;
  private anim = new Uint8Array(0);
  private animBase = new Uint8Array(0);
  private nextDecode = 0;
  private fileKey = '';
  // palettes
  private basePal = new Uint8Array(1024);
  private cyclePal = new Uint8Array(1024);
  private crngAcc: number[] = [];
  private lerp: { src: Uint8Array; dst: Uint8Array; speed: number; total: number; step: number } | null = null;
  // panoramas
  private vp = {
    cw: 0, ch: 0, offY: 0, startX: 0, startY: 0, dx: 0, dy: 0, scroll: false, frameOffset: 0,
    maps: [] as { pos: number; px: Uint8Array | null }[], comp: null as Uint8Array | null, compW: 0, compH: 0, horiz: false,
    sprite: null as Sprite | null, pendingSwap: false, swapped: false,
  };

  constructor(readonly n: number, private readonly host: CutsHost) {
    const key = 'CUTS/' + cutsName(n, 0), buf = host.file(key);
    let cmds: CutsCmd[] = [];
    if (!buf) this.problem(`missing ${key}`);
    else try { cmds = readCutsScript(buf); } catch (e) { if (!(e instanceof DataError)) throw e; this.problem(`${key}: ${e.message}`); }
    this.cmds = cmds;
    this.gen = this.run();
  }

  /** Advances by dt seconds. */
  update(dt: number): void {
    if (this.done) return;
    const target = this.t + Math.max(0, dt);
    for (let k = 0; !this.done && this.wake <= target; k++) {
      if (k >= MAX_STEPS_PER_UPDATE) { this.problem('the script never waits'); this.finish(); break; }
      this.now = this.wake;
      const r = this.gen.next();
      if (r.done) this.finish();
      else this.wake = this.now + (Number.isFinite(r.value) ? Math.max(0, r.value) : Infinity);
    }
    this.cycle(this.t, target);
    this.t = target;
    const b = this.brightAt(target);
    if (b !== this.bright) { this.bright = b; this.version++; }
  }

  /** Stops here (Esc, a click). */
  skip(): void {
    if (this.done) return;
    this.skipped = true;
    this.gen.return();
    this.finish();
  }

  /** Waiting on the player (a pause of 999 or more): only skip() moves on. */
  get held(): boolean { return !this.done && this.wake === Infinity; }

  /** Is a voice clip still playing? */
  get speaking(): boolean { return this.voiceEnd > this.t; }

  private finish(): void {
    this.done = true;
    if (this.voiceEnd) this.host.voice?.(null);
    this.voiceEnd = 0;
  }

  private problem(m: string): void { if (!this.problems.includes(m)) this.problems.push(m); }
  private unsupport(m: string): void { if (!this.unsupported.includes(m)) this.unsupported.push(m); }
  private touch(): void { this.version++; }

  // ---------- the script ----------

  private *run(): Generator<number, void, void> {
    const cmds = this.cmds;
    if (!cmds.length) return;
    if (this.n === 9) yield* this.splash();
    const first = cmds[0]!;
    this.load(first.cmd === 8 && first.args[0] === 996 ? this.randomBackdrop() : this.n, 1);
    this.setFade(cmds.some(c => c.cmd === 10) ? 0 : 1, 0);
    let i = 0, firstSeg = true, fileChanged = false;
    while (i < cmds.length) {
      const seg: CutsCmd[] = [], post: CutsCmd[] = [];
      let len = 0, hasSet = false, end = false;
      while (i < cmds.length) {
        const c = cmds[i++]!;
        seg.push(c);
        if (c.cmd === 5) { len = c.frame; hasSet = true; break; }
        if (c.cmd === 6) { if (!hasSet && c.frame > 0) { len = c.frame; hasSet = true; } end = true; break; }
      }
      while (i < cmds.length && cmds[i]!.frame === 999) post.push(cmds[i++]!);
      const last = Math.max(0, ...seg.filter(c => c.frame < 999).map(c => c.frame));
      // a segment with nothing to show may have no file of its own (the intro's closing one has none)
      if (!firstSeg && !fileChanged) this.load(this.n, this.ext + 1, (hasSet && len > 0) || last > 0 || seg.some(c => c.cmd === 4));
      firstSeg = false; fileChanged = false;
      this.lerp = null;
      if (!seg.some(c => c.cmd === 23)) this.vp.scroll = false;
      const run = function* (this: CutscenePlayer, list: CutsCmd[], mode: Mode) {
        for (const c of list) { yield* this.exec(c, mode); if (c.cmd === 8) fileChanged = true; }
      }.bind(this);
      const at = (f: number) => seg.filter(c => c.frame === f && c.cmd !== 5);
      if (hasSet && len > 0) {
        for (let f = 0; f < len; f++) {
          yield* run(at(f), 'frame');
          this.display(f);
          yield this.frameTime();
        }
        yield* run(at(len), 'boundary');
        if (this.vp.scroll) this.vp.frameOffset += len;
      } else {
        if (last > 0) for (let f = 0; f <= last; f++) { yield* run(at(f), 'frame'); this.display(f); yield this.frameTime(); }
        else yield* run(seg, 'sequential');
      }
      yield* run(post, 'boundary');
      if (end) break;
    }
  }

  /**
   * One command. `frame`: fired while an animation runs (fades run alongside it). `boundary`: after a segment's last
   * frame or after it (frame 999; fades block). `sequential`: a segment with no frames, whose commands run one after
   * another (fades block; to-frame (4) and wait (14) only do anything here).
   */
  private *exec(c: CutsCmd, mode: Mode): Generator<number, void, void> {
    const a = c.args;
    switch (c.cmd) {
      case 0: this.say(a[1]!, a[0]!); break;
      case 3: if (a[0]! >= 999) yield Infinity; else if (a[0]! > 0) yield a[0]! / 2; break;
      case 4: if (mode === 'sequential') for (let k = 0; k < a[0]!; k++) { this.display(0); yield 0.2; } break;
      case 7: this.unsupport('rep-seg (7)'); break;
      case 8: this.load(a[0] === 996 ? this.randomBackdrop() : a[0]!, a[1]!); break;
      case 9: case 10: {
        const dur = a[0]! > 0 ? 2 / a[0]! : 0;
        this.setFade(c.cmd === 10 ? 1 : 0, dur);
        if (mode !== 'frame' && dur > 0) yield dur;
        break;
      }
      case 13: {
        if (this.voiceEnd > this.now) yield this.voiceEnd - this.now;
        if (s16(a[1]!) >= 0) this.say(a[1]!, a[0]!); else if (this.subtitle) { this.subtitle = null; this.touch(); }
        if (a[2]! !== 999 && a[2]! !== 998) this.speak(a[2]!);
        break;
      }
      case 14: if (mode === 'sequential') yield a[0]!; break;
      case 19: this.startLerp(a[0]!, a[1]!, a[2]!); break;
      case 20: this.viewport(a[0]!, a[1]!, a[2]!); break;
      case 21: this.vp.startX = a[0]!; this.vp.startY = a[1]!; this.buildComposite(); break;
      case 22: {
        const key = `CUTS/LBACK${String(a[2]!).padStart(3, '0')}.BYT`, b = this.host.file(key);
        let px: Uint8Array | null = null;
        try { if (b) px = readScreen(b); else this.problem(`missing ${key}`); } catch (e) { if (!(e instanceof DataError)) throw e; this.problem(`${key}: ${e.message}`); }
        this.vp.maps.push({ pos: a[0]!, px });
        break;
      }
      case 23: this.startScroll(a[0]!, a[1]!); break;
      case 25: if (this.host.music) this.host.music(a[0]!); else this.unsupport('music (25)'); break;
      case 27: {
        const limit = a[0]! > 0 ? a[0]! / 2 : 60;
        if (this.voiceEnd > this.now) yield Math.min(limit, this.voiceEnd - this.now);
        break;
      }
      default: break;
    }
  }

  /** The title's pre-roll: the Origin and LGS screens (BYT.ARK 6 and 7, palettes 5 and 6), two seconds each. */
  private *splash(): Generator<number, void, void> {
    const ark = this.host.file('BYT.ARK'), pals = this.host.file('PALS.DAT');
    if (!ark || !pals) return;
    let blocks: (Uint8Array | null)[];
    try { blocks = readArk(ark); } catch (e) { if (!(e instanceof DataError)) throw e; this.problem(`BYT.ARK: ${e.message}`); return; }
    for (const [b, p] of [[6, 5], [7, 6]] as const) {
      const img = blocks[b], pal = palsEntry(pals, p);
      if (!img || img.length < SCREEN_PX || !pal) { this.problem(`BYT.ARK screen ${b} is missing`); continue; }
      this.screen.set(img.subarray(0, SCREEN_PX)); this.pal.set(pal); this.setFade(1, 0); this.touch();
      yield 2;
      this.setFade(0, 0);
      yield 0.5;
    }
  }

  private randomBackdrop(): number { return 28 + randInt(this.host.rng, 4); } // CS034-CS037

  private frameTime(): number { const f = this.lpf?.fps ?? 0; return f > 0 ? 1 / Math.min(f, 100) : 0.1; }

  // ---------- text and voice ----------

  private say(i: number, colour: number): void {
    const text = this.host.str(0xc00 + this.n, i);
    if (text == null) this.problem(`missing string ${(0xc00 + this.n).toString(16)}:${i}`);
    this.subtitle = text ? { text, colour } : null;
    this.touch();
  }

  private speak(nn: number): void {
    const key = `SOUND/BSP${String(nn).padStart(2, '0')}.VOC`, b = this.host.file(key);
    if (!b) { this.problem(`missing ${key}`); return; }
    let v: Voc;
    try { v = readVoc(b); } catch (e) { if (!(e instanceof DataError)) throw e; this.problem(`${key}: ${e.message}`); return; }
    this.voiceEnd = this.now + vocSeconds(v);
    this.host.voice?.(v);
  }

  // ---------- brightness and palettes ----------

  private setFade(to: number, dur: number): void { this.fade = { from: this.brightAt(this.now), to, t0: this.now, dur }; if (!dur) this.touch(); }
  private brightAt(t: number): number {
    const f = this.fade;
    if (f.dur <= 0 || t >= f.t0 + f.dur) return f.to;
    return f.from + (f.to - f.from) * Math.max(0, (t - f.t0) / f.dur);
  }

  /** Colour cycling between two instants (18.2 Hz ticks; a range steps each time its counter passes 65). */
  private cycle(t0: number, t1: number): void {
    const L = this.lpf;
    if (!L) return;
    const ticks = Math.min(64, Math.floor(t1 * CRNG_HZ) - Math.floor(t0 * CRNG_HZ));
    let moved = false;
    for (let k = 0; k < ticks; k++) L.crng.forEach((r, i) => {
      if (r.rate <= 0 || r.high <= r.low) return;
      this.crngAcc[i] = (this.crngAcc[i] ?? 0) + r.rate;
      while (this.crngAcc[i]! >= 65) { this.crngAcc[i]! -= 65; rotate(this.cyclePal, r.low, r.high); moved = true; }
    });
    if (moved && !this.lerp) { this.pal.set(this.cyclePal); this.touch(); }
  }

  /** Palette lerp toward PALS.DAT[k] (19): one step per shown frame, every `speed` frames, over `total` frames. */
  private startLerp(k: number, speed: number, total: number): void {
    const pals = this.host.file('PALS.DAT'), dst = pals ? palsEntry(pals, k) : null;
    if (!dst) { this.problem(`PALS.DAT has no palette ${k}`); return; }
    this.lerp = { src: this.basePal.slice(), dst, speed: Math.max(1, speed), total: Math.max(1, total), step: 0 };
  }

  private applyLerp(): void {
    const l = this.lerp;
    if (!l) return;
    l.step++;
    const steps = Math.max(1, Math.floor(l.total / l.speed)), s = Math.min(steps, Math.max(1, Math.floor(l.step / l.speed)));
    for (let i = 0; i < 1024; i++) this.pal[i] = (i & 3) === 3 ? 255 : Math.max(0, Math.min(255, l.src[i]! + Math.trunc((s * (l.dst[i]! - l.src[i]!)) / steps)));
    this.touch();
  }

  // ---------- animation files ----------

  private load(cs: number, ext: number, needed = true): void {
    this.ext = ext; this.frameNo = 0;
    const name = cutsName(cs, ext), key = 'CUTS/' + name, b = this.host.file(key);
    if (!b) { if (needed) this.problem(`missing ${key}`); return; } // keeps showing the previous file, as the original does
    let L: Lpf;
    try { L = readLpf(b); } catch (e) { if (!(e instanceof DataError)) throw e; this.problem(`${key}: ${e.message}`); return; }
    const size = L.w * L.h;
    this.animBase = this.anim.length === size ? this.anim.slice() : new Uint8Array(size); // deltas may build on the last file
    this.anim = this.animBase.slice();
    this.nextDecode = 0;
    this.lpf = L; this.fileKey = name;
    this.basePal = L.pal.slice(); this.cyclePal = L.pal.slice(); this.crngAcc = [];
    this.pal.set(L.pal); this.touch();
  }

  /** Brings the animation buffer to frame k (decoding forward, or from the start of the file when going back). */
  private seek(k: number): void {
    const L = this.lpf!;
    if (k < this.nextDecode - 1) { this.anim.set(this.animBase); this.nextDecode = 0; }
    for (; this.nextDecode <= k; this.nextDecode++) {
      const f = this.nextDecode;
      if (EVERY_4TH_FRAME.has(this.fileKey) && f % 4) continue;
      this.decodeInto(L, f, this.anim);
    }
  }

  private decodeInto(L: Lpf, f: number, px: Uint8Array, mask?: Uint8Array): boolean {
    try { return L.decode(f, px, mask); } catch (e) {
      if (!(e instanceof DataError)) throw e;
      this.problem(`${this.fileKey} frame ${f}: ${e.message}`); // shows what was decoded, like the original
      return true;
    }
  }

  /** Shows the next frame: the panorama when scrolling, else the animation. */
  private display(f: number): void {
    const vp = this.vp;
    if (vp.scroll && vp.comp) { this.displayScroll(vp.frameOffset + f); this.frameNo++; return; }
    const L = this.lpf;
    if (!L || L.frames === 0) return;
    if (this.frameNo >= L.frames) this.frameNo = 0;
    this.seek(this.frameNo++);
    this.screen.fill(0);
    const w = Math.min(L.w, SCREEN_W), h = Math.min(L.h, this.sceneH);
    for (let y = 0; y < h; y++) this.screen.set(this.anim.subarray(y * L.w, y * L.w + w), y * SCREEN_W);
    if (this.lerp) this.applyLerp();
    this.touch();
  }

  // ---------- panoramas (20-23) ----------

  private viewport(w: number, h: number, offY: number): void {
    const vp = this.vp;
    Object.assign(vp, { cw: w, ch: h, offY, scroll: false, frameOffset: 0, maps: [], comp: null, sprite: null, pendingSwap: false, swapped: false });
    const panorama = w && h && (w !== SCREEN_W || h !== SCREEN_H);
    this.sceneH = panorama && offY > 0 && offY < SCREEN_H ? SCREEN_H - offY : SCREEN_H;
    this.touch();
  }

  /** LBACKs side by side at their positions (wide canvas) or stacked (tall canvas). */
  private buildComposite(): void {
    const vp = this.vp;
    if (!vp.maps.length) return;
    vp.horiz = vp.cw > SCREEN_W;
    const W = vp.horiz ? Math.max(vp.cw, ...vp.maps.map(m => m.pos + SCREEN_W)) : SCREEN_W;
    const H = Math.max(1, vp.ch);
    if (W * H > 16 * SCREEN_PX) { this.problem(`panorama ${W}x${H} is implausible`); return; }
    const comp = new Uint8Array(W * H);
    vp.maps.forEach((m, k) => {
      if (!m.px) return;
      const x0 = vp.horiz ? m.pos : 0, y0 = vp.horiz ? 0 : k * SCREEN_H;
      for (let y = 0; y < SCREEN_H && y0 + y < H; y++) for (let x = 0; x < SCREEN_W && x0 + x < W; x++) if (x0 + x >= 0) comp[(y0 + y) * W + x0 + x] = m.px[y * SCREEN_W + x]!;
    });
    vp.comp = comp; vp.compW = W; vp.compH = H;
  }

  /** Scroll direction (0 down, 1 right, 2 up, 3 left) and step; the current file becomes a sprite over the backdrop. */
  private startScroll(dir: number, delta: number): void {
    const vp = this.vp;
    if (dir < 4) { vp.dx = [0, 1, 0, -1][dir]! * delta; vp.dy = [1, 0, -1, 0][dir]! * delta; }
    vp.scroll = true; vp.frameOffset = 0; vp.sprite = null;
    const L = this.lpf;
    if (L && vp.maps.length && L.w * L.h <= SCREEN_PX) {
      const base = new Uint8Array(L.w * L.h);
      if (vp.horiz) {
        for (let y = 0; y < Math.min(L.h, SCREEN_H); y++) for (let c = 0; c < Math.min(L.w, SCREEN_W); c++) {
          const X = vp.startX + c, m = vp.maps[Math.floor(X / SCREEN_W)];
          if (m?.px) base[y * L.w + c] = m.px[y * SCREEN_W + (X % SCREEN_W)]!;
        }
      } else if (vp.maps[0]!.px) for (let y = 0; y < Math.min(L.h, SCREEN_H); y++) base.set(vp.maps[0]!.px.subarray(y * SCREEN_W, y * SCREEN_W + Math.min(L.w, SCREEN_W)), y * L.w);
      vp.sprite = { lpf: L, base, buf: base.slice(), mask: new Uint8Array(base.length), frame: 0, stale: 0 };
    }
    vp.pendingSwap = vp.horiz; vp.swapped = false;
  }

  private displayScroll(tf: number): void {
    const vp = this.vp, H = this.sceneH;
    const region = () => {
      this.screen.fill(0);
      const comp = vp.comp!;
      if (vp.horiz) {
        const x = clamp(vp.startX + vp.dx * (tf + 1), 0, vp.compW - SCREEN_W);
        for (let y = 0; y < Math.min(vp.compH, H); y++) this.screen.set(comp.subarray(y * vp.compW + x, y * vp.compW + x + SCREEN_W), y * SCREEN_W);
      } else {
        const y0 = clamp(((vp.startY + 1) % vp.compH) - vp.dy * tf, 0, Math.max(0, vp.compH - H));
        for (let y = 0; y < H && y0 + y < vp.compH; y++) this.screen.set(comp.subarray((y0 + y) * vp.compW, (y0 + y) * vp.compW + SCREEN_W), y * SCREEN_W);
      }
    };
    region();
    const s = vp.sprite;
    if (s && s.frame < s.lpf.frames) {
      const L = s.lpf, buf = s.base.slice(), mask = new Uint8Array(buf.length);
      const key = this.decodeInto(L, s.frame, buf, mask);
      if (key) { s.buf = buf; s.mask = mask; s.stale = 0; } else s.stale++;
      if (vp.pendingSwap && !vp.swapped && s.mask.includes(1)) { vp.swapped = true; this.swapBackdrop(); region(); }
      const ox = vp.horiz ? -s.stale * vp.dx : 0, oy = vp.horiz ? 0 : s.stale * vp.dy;
      for (let y = 0; y < Math.min(L.h, H); y++) for (let x = 0; x < Math.min(L.w, SCREEN_W); x++) {
        const rx = x + ox, ry = y + oy;
        if (rx < 0 || rx >= SCREEN_W || ry < 0 || ry >= H || !s.mask[y * L.w + x]) continue;
        this.screen[ry * SCREEN_W + rx] = s.buf[y * L.w + x]!;
      }
      s.frame++;
    }
    this.touch();
  }

  /**
   * The cart scroll (CS000): LBACK000 shows the cart at rest, and the sprite brings its own. When the sprite first
   * draws, the first 320 columns become the next file's frame 0, a cart-less backdrop (UnderworldGodot, matched
   * against DOSBox; the original's mechanism was not found).
   */
  private swapBackdrop(): void {
    const vp = this.vp, key = 'CUTS/' + cutsName(this.n, this.ext + 1), b = this.host.file(key);
    if (!b || !vp.comp) return;
    try {
      const L = readLpf(b), px = new Uint8Array(L.w * L.h);
      if (L.nFrames) L.decode(0, px);
      for (let y = 0; y < Math.min(L.h, vp.compH); y++) vp.comp.set(px.subarray(y * L.w, y * L.w + Math.min(L.w, SCREEN_W, vp.compW)), y * vp.compW);
    } catch (e) { if (!(e instanceof DataError)) throw e; this.problem(`${key}: ${e.message}`); }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Rotates palette entries low..high forward by one (the first moves to the end). */
function rotate(pal: Uint8Array, low: number, high: number): void {
  const first = pal.slice(low * 4, low * 4 + 4);
  pal.copyWithin(low * 4, (low + 1) * 4, (high + 1) * 4);
  pal.set(first, high * 4);
}

import { SCREEN_H, SCREEN_W, type Font, type Voc } from '../formats';
import { CutscenePlayer } from '../cuts/player';
import { hasCutscene } from '../game/cutscenes';
import type { Game } from '../game/game';
import type { CutsceneEnd } from '../game/ports';
import type { Art } from './art';
import { $, releasePointer } from './dom';

// The cutscene screen: the player's 320x200 indexed frame drawn full-bleed at 4:3 (the original's pixel aspect),
// subtitles in the disc's FONTBIG in the bottom band as the original draws them, speech through WebAudio. Esc, Space,
// Enter or a click skips. Subtitle text also goes to a live region for screen readers (and is shown as page text when
// the disc copy has no FONTBIG.SYS).

export class CutsceneView {
  player: CutscenePlayer | null = null;
  private resolve: ((e: CutsceneEnd) => void) | null = null;
  private drawn = -1;
  private readonly img: ImageData;
  private audio: AudioContext | null = null;
  private src: AudioBufferSourceNode | null = null;
  private hintTimer = 0;
  private played = false;
  /** Cutscene music (command 25) and its end: the page's audio decides what that means. */
  onMusic: (n: number) => void = () => {};
  onMusicDone: () => void = () => {};

  constructor(private readonly game: Game, private readonly art: Art) {
    const cv = $<HTMLCanvasElement>('#cutsCv');
    this.img = cv.getContext('2d')!.createImageData(SCREEN_W, SCREEN_H);
    $('#cuts').addEventListener('pointerdown', e => { e.preventDefault(); this.skip(); });
    $('#cutsSub').classList.toggle('sr', !!art.bigFont);
  }

  get active(): boolean { return !!this.player; }

  /** Plays cutscene n; resolves when it ends or is skipped. Without the data it resolves at once. */
  play(n: number): Promise<CutsceneEnd> {
    if (!hasCutscene(this.game.data, n)) return Promise.resolve('done');
    this.player?.skip();
    this.finish();
    const D = this.game.data;
    const p = new CutscenePlayer(n, {
      file: k => D.files[k], str: (b, i) => D.block(b)[i], rng: this.game.rng, voice: v => this.voice(v),
      music: m => { this.played = true; this.onMusic(m); },
    });
    this.player = p; this.drawn = -1;
    releasePointer();
    $('#cuts').hidden = false;
    const hint = $('#cutsHint');
    hint.classList.remove('gone'); clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => hint.classList.add('gone'), 3500);
    return new Promise(res => (this.resolve = res));
  }

  /** Plays several in turn; stops at the first one skipped. True if all ran to the end. */
  async playAll(ns: readonly number[]): Promise<boolean> {
    for (const n of ns) if ((await this.play(n)) === 'skipped') return false;
    return true;
  }

  skip(): void { this.player?.skip(); }

  /** Keys while a cutscene shows. Returns true when the key was taken. */
  key(e: KeyboardEvent): boolean {
    if (!this.player) return false;
    if (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); this.skip(); }
    return true;
  }

  /** Called every animation frame. */
  frame(dt: number): void {
    const p = this.player;
    if (!p) return;
    try { p.update(dt); } catch (e) { this.finish(); throw e; } // an engine bug must not leave the screen stuck
    if (p.version !== this.drawn) { this.drawn = p.version; this.draw(p); }
    if (p.done) {
      if (p.problems.length) console.warn(`cutscene ${p.n}:`, p.problems.join('; '));
      this.finish();
    }
  }

  private finish(): void {
    const p = this.player, res = this.resolve;
    this.player = null; this.resolve = null;
    this.voice(null);
    if (this.played) { this.played = false; this.onMusicDone(); }
    $('#cuts').hidden = true;
    $('#cutsSub').textContent = '';
    if (res) res(p?.skipped ? 'skipped' : 'done');
  }

  private draw(p: CutscenePlayer): void {
    const d = this.img.data, pal = p.pal, b = p.bright, s = p.screen, band = p.sceneH * SCREEN_W;
    for (let i = 0; i < s.length; i++) {
      const o = i * 4;
      if (i >= band) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 255; continue; }
      const c = s[i]! * 4;
      d[o] = pal[c]! * b; d[o + 1] = pal[c + 1]! * b; d[o + 2] = pal[c + 2]! * b; d[o + 3] = 255;
    }
    const sub = p.subtitle, F = this.art.bigFont;
    if (sub && F) this.text(F, sub.text, [pal[sub.colour * 4]! * b, pal[sub.colour * 4 + 1]! * b, pal[sub.colour * 4 + 2]! * b]);
    $<HTMLCanvasElement>('#cutsCv').getContext('2d')!.putImageData(this.img, 0, 0);
    const words = sub ? sub.text.replace(/\\n/g, '\n').replace(/_/g, ' ') : '';
    const live = $('#cutsSub');
    if (live.textContent !== words) live.textContent = words;
  }

  /** Subtitle lines in FONTBIG: wrapped at the screen width, centred, bottom-aligned 2 px above the edge. */
  private text(F: Font, t: string, rgb: number[]): void {
    const width = (w: string) => { let n = 0; for (const ch of w) n += F.g[ch.charCodeAt(0)]?.w ?? F.space; return n; };
    const lines: string[] = [];
    for (const para of t.replace(/\\n/g, '\n').split('\n')) {
      let line = '';
      for (const w of para.split(' ')) {
        const next = line ? line + ' ' + w : w;
        if (line && width(next) > SCREEN_W - 4) { lines.push(line); line = w; } else line = next;
      }
      lines.push(line);
    }
    const d = this.img.data;
    lines.forEach((line, k) => {
      let x = Math.floor((SCREEN_W - width(line)) / 2);
      const y0 = SCREEN_H - 2 - (lines.length - k) * F.h;
      for (const ch of line) {
        const g = F.g[ch.charCodeAt(0)];
        if (!g) { x += F.space; continue; }
        for (let y = 0; y < F.h; y++) for (let i = 0; i < g.w; i++) {
          const X = x + i, Y = y0 + y;
          if (!g.bit(i, y) || X < 0 || X >= SCREEN_W || Y < 0 || Y >= SCREEN_H) continue;
          const o = (Y * SCREEN_W + X) * 4;
          d[o] = rgb[0]!; d[o + 1] = rgb[1]!; d[o + 2] = rgb[2]!;
        }
        x += g.w;
      }
    });
  }

  /** 8-bit unsigned mono PCM at the clip's own rate. Browsers that refuse sound (no gesture yet) stay silent. */
  private voice(v: Voc | null): void {
    try { this.src?.stop(); } catch { /* already stopped */ }
    this.src = null;
    if (!v || !v.pcm.length) return;
    try {
      this.audio ??= new AudioContext();
      if (this.audio.state === 'suspended') void this.audio.resume();
      const buf = this.audio.createBuffer(1, v.pcm.length, v.rate), ch = buf.getChannelData(0);
      for (let i = 0; i < v.pcm.length; i++) ch[i] = (v.pcm[i]! - 128) / 128;
      const src = this.audio.createBufferSource();
      src.buffer = buf; src.connect(this.audio.destination); src.start();
      this.src = src;
    } catch (e) { console.warn('speech', e); }
  }
}

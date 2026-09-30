import { DataError, readTimbres, readVoc, readXmi, type Voc } from '../formats';
import { FmDriver, TimbreBank, XmiPlayer } from '../audio/music';
import type { GameFiles } from '../data/files';

// The page's sound: effects (SOUND/SPnn.VOC, 8-bit mono) and music (SOUND/UWAnn.XMI through the disc's own FM
// instrument bank, SOUND/UW.OPL) on one WebAudio context. Browsers start audio only after a user gesture, so the
// context is created (or resumed) on the first pointer or key press; anything asked for before that is dropped,
// except the theme, which starts once sound is allowed. Missing files mean silence, never an error.

const CHUNK = 2048;
/** Music is rendered at this rate and resampled by the browser (FM at 24 kHz loses nothing audible and halves the work). */
const MUSIC_HZ = 24000;
const AHEAD = 0.35;
/** Effects already playing that one more of the same effect is allowed to overlap. */
const MAX_SAME = 3;

export interface AudioPrefs { music: boolean; sfx: boolean }

export class AudioOut {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private readonly clips = new Map<number, AudioBuffer | null>();
  private readonly playing = new Map<number, number>();
  private readonly bank: TimbreBank | null;
  private song: { n: number; loop: boolean; player: XmiPlayer | null; next: number } | null = null;
  private pump = 0;
  private readonly queued: AudioBufferSourceNode[] = [];
  prefs: AudioPrefs = { music: true, sfx: true };
  /** Called when a theme that does not loop has played out. */
  onMusicEnd: () => void = () => {};

  constructor(private readonly files: GameFiles) {
    let bank: TimbreBank | null = null;
    const b = files['SOUND/UW.OPL'] ?? files['SOUND/UW.AD'];
    if (b) try { bank = new TimbreBank(readTimbres(b)); } catch (e) { if (!(e instanceof DataError)) throw e; console.warn('UW.OPL', e.message); }
    this.bank = bank;
    const wake = () => this.unlock();
    addEventListener('pointerdown', wake, { capture: true });
    addEventListener('keydown', wake, { capture: true });
  }

  /** Does this disc copy carry the sound folder? */
  get present(): boolean { return !!this.files['SOUND/SOUNDS.DAT'] || Object.keys(this.files).some(k => /^SOUND\/SP\d\d\.VOC$/.test(k)); }
  get hasMusic(): boolean { return !!this.bank && Object.keys(this.files).some(k => k.startsWith('SOUND/UWA')); }

  private unlock(): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
        this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.55; this.musicGain.connect(this.master);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      if (this.song && !this.song.player) this.startSong();
    } catch (e) { console.warn('audio', e); }
  }

  setPrefs(p: AudioPrefs): void {
    this.prefs = p;
    if (!p.music) this.stopPump();
    else if (this.song) this.startSong();
  }

  // ---------- effects ----------

  private clip(id: number): AudioBuffer | null {
    if (this.clips.has(id)) return this.clips.get(id)!;
    let buf: AudioBuffer | null = null;
    const f = this.files[`SOUND/${id >= 100 ? `UW${String(id - 100).padStart(2, '0')}` : `SP${String(id).padStart(2, '0')}`}.VOC`];
    if (f && this.ctx) {
      try {
        const v: Voc = readVoc(f);
        buf = this.ctx.createBuffer(1, Math.max(1, v.pcm.length), v.rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < v.pcm.length; i++) ch[i] = (v.pcm[i]! - 128) / 128;
      } catch (e) { if (!(e instanceof DataError)) throw e; console.warn(`SP${id}.VOC`, e.message); }
    }
    if (this.ctx) this.clips.set(id, buf);
    return buf;
  }

  /** Effect id at volume 0-127, pan 0-127 (Miles: 0 right, 0x40 centre, 0x7F left). */
  sound(id: number, vol: number, pan: number): void {
    const x = this.ctx;
    if (!x || x.state !== 'running' || !this.prefs.sfx) return;
    if ((this.playing.get(id) ?? 0) >= MAX_SAME) return;
    const buf = this.clip(id);
    if (!buf) return;
    // AIL's pan graph: 2 x pan up to 127 on the left, the mirror on the right, times the volume
    const g = (p: number) => (p <= 62 ? 2 * p : 127) / 127, v = Math.max(0, Math.min(127, vol)) / 127, p = Math.max(0, Math.min(127, pan));
    const src = x.createBufferSource(), split = x.createChannelMerger(2), gl = x.createGain(), gr = x.createGain();
    src.buffer = buf;
    gl.gain.value = g(p) * v; gr.gain.value = g(127 - p) * v;
    src.connect(gl); src.connect(gr); gl.connect(split, 0, 0); gr.connect(split, 0, 1); split.connect(this.master!);
    this.playing.set(id, (this.playing.get(id) ?? 0) + 1);
    src.onended = () => { this.playing.set(id, Math.max(0, (this.playing.get(id) ?? 1) - 1)); split.disconnect(); };
    src.start();
  }

  // ---------- music ----------

  /** Plays theme n (0 stops). The same theme asked for again keeps playing. */
  music(n: number, loop: boolean): void {
    if (this.song?.n === n && n) return;
    this.stopPump();
    this.song = n ? { n, loop, player: null, next: 0 } : null;
    if (this.song) this.startSong();
  }

  private startSong(): void {
    const s = this.song, x = this.ctx;
    if (!s || !x || x.state === 'closed' || !this.prefs.music || !this.bank) return;
    const name = `SOUND/UWA${s.n >> 3}${s.n & 7}.XMI`, f = this.files[name];
    if (!f) { this.song = null; return; }
    try { s.player = new XmiPlayer(readXmi(f), new FmDriver(this.bank, MUSIC_HZ), s.loop); }
    catch (e) { if (!(e instanceof DataError)) throw e; console.warn(name, e.message); this.song = null; return; }
    s.next = x.currentTime + 0.05;
    clearInterval(this.pump);
    this.pump = window.setInterval(() => this.fill(), 60);
    this.fill();
  }

  private fill(): void {
    const s = this.song, x = this.ctx;
    if (!s?.player || !x) return;
    if (s.next < x.currentTime) s.next = x.currentTime + 0.02; // fell behind (a hidden tab): skip ahead
    while (s.next < x.currentTime + AHEAD) {
      if (s.player.ended) { clearInterval(this.pump); this.pump = 0; this.song = null; this.onMusicEnd(); return; } // the queued tail plays out
      const l = new Float32Array(CHUNK), r = new Float32Array(CHUNK);
      s.player.render(l, r);
      const buf = x.createBuffer(2, CHUNK, MUSIC_HZ);
      buf.copyToChannel(soft(l), 0); buf.copyToChannel(soft(r), 1);
      const src = x.createBufferSource();
      src.buffer = buf; src.connect(this.musicGain!); src.start(s.next);
      this.queued.push(src); src.onended = () => { const k = this.queued.indexOf(src); if (k >= 0) this.queued.splice(k, 1); };
      s.next += CHUNK / MUSIC_HZ;
    }
  }

  /** Stops rendering and silences what was already queued. */
  private stopPump(): void {
    clearInterval(this.pump); this.pump = 0;
    if (this.song) this.song.player = null;
    for (const q of this.queued.splice(0)) try { q.stop(); } catch { /* not started yet or done */ }
  }
}

/** Gentle limiting so a thick chord never clips. */
function soft(a: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  for (let i = 0; i < a.length; i++) { const v = a[i]!; a[i] = v / (1 + Math.abs(v) * 0.6); }
  return a;
}

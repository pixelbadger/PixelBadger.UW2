import { XMI_HZ, type Timbre, type Xmi } from '../formats';
import { FmVoice } from './fm';

// Plays an XMI song through FmVoices, standing in for the Miles AIL OPL driver the original used. What follows AIL:
// timbres chosen by (bank, patch) with controller 114 picking the bank; percussion on channel 10 from bank 127 keyed
// by note; note-ons carrying their own length; 120 ticks a second. OURS: voice allocation (18 voices, a free one or
// the oldest), volume as velocity x volume x expression scaling the carrier's level (and the modulator's when
// additive), a +-2 semitone pitch bend, pan as equal-power stereo, the percussion pitch (the timbre's transpose byte
// when set, else the key), and the LFO rates (3.7 Hz tremolo up to 4.8 dB, 6.1 Hz vibrato 14 cents).

const VOICES = 18;
const PERC = 9;
const PERC_BANK = 127;

interface Chan { bank: number; timbre: Timbre | null; vol: number; expr: number; pan: number; bend: number; sustain: boolean }
const newChan = (): Chan => ({ bank: 0, timbre: null, vol: 100, expr: 127, pan: 64, bend: 0, sustain: false });

/** The timbre bank indexed by (bank << 8) | patch. */
export class TimbreBank {
  private readonly map = new Map<number, Timbre>();
  constructor(ts: Timbre[]) { for (const t of ts) this.map.set((t.bank << 8) | t.patch, t); }
  get(bank: number, patch: number): Timbre | null { return this.map.get((bank << 8) | patch) ?? (bank !== PERC_BANK ? this.map.get(patch) ?? null : null); }
  get size(): number { return this.map.size; }
}

const hzOf = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** A MIDI-driven bank of FM voices (the AIL driver's job). */
export class FmDriver {
  readonly chans: Chan[] = Array.from({ length: 16 }, newChan);
  private voices: (FmVoice | null)[] = Array(VOICES).fill(null);
  private clock = 0;
  private lfo = 0;
  constructor(private readonly bank: TimbreBank, readonly rate: number) {}

  reset(): void { this.voices.fill(null); this.chans.forEach((c, i) => (this.chans[i] = newChan())); }
  allOff(): void { for (const v of this.voices) v?.keyOff(); }
  get active(): number { return this.voices.filter(v => v && !v.done).length; }

  /** A channel message: status byte and data. */
  send(d: readonly number[]): void {
    const ch = d[0]! & 15, C = this.chans[ch]!;
    switch (d[0]! & 0xf0) {
      case 0x80: this.noteOff(ch, d[1]!); break;
      case 0x90: if (d[2]) this.noteOn(ch, d[1]!, d[2]!); else this.noteOff(ch, d[1]!); break;
      case 0xb0:
        switch (d[1]) {
          case 7: C.vol = d[2]!; this.revolume(ch); break;
          case 11: C.expr = d[2]!; this.revolume(ch); break;
          case 10: C.pan = d[2]!; break;
          case 64: C.sustain = d[2]! >= 64; if (!C.sustain) for (const v of this.voices) if (v && v.ch === ch && v.held) { v.held = false; v.keyOff(); } break;
          case 114: C.bank = d[2]!; break; // AIL: the bank for the next program change
          case 121: Object.assign(C, { vol: 100, expr: 127, pan: 64, bend: 0, sustain: false }); break;
          case 123: for (const v of this.voices) if (v && v.ch === ch) v.keyOff(); break;
        }
        break;
      case 0xc0: C.timbre = this.bank.get(C.bank, d[1]!); break;
      case 0xe0: C.bend = ((d[1]! | (d[2]! << 7)) - 8192) / 8192; for (const v of this.voices) if (v && v.ch === ch) v.setFreq(hzOf(v.note) * 2 ** ((C.bend * 2) / 12)); break;
    }
  }

  private level(ch: number, vel: number): number {
    const C = this.chans[ch]!;
    return (vel / 127) * (C.vol / 127) * (C.expr / 127);
  }

  private applyLevel(v: FmVoice, scale: number): void {
    // AIL-style: the operator's output level ((63 - TL) steps) scaled, expressed as extra attenuation
    const extra = (op: { r: { r40: number } }) => (63 - (op.r.r40 & 63)) * (1 - scale);
    v.car.tl = extra(v.car);
    v.mod.tl = v.additive ? extra(v.mod) : 0;
  }

  private revolume(ch: number): void { for (const v of this.voices) if (v && v.ch === ch && !v.releasing) this.applyLevel(v, this.level(ch, v.vel)); }

  noteOn(ch: number, note: number, vel: number): void {
    const C = this.chans[ch]!;
    let t = C.timbre, pitch = note;
    if (ch === PERC) { t = this.bank.get(PERC_BANK, note); if (t?.transpose) pitch = t.transpose & 127; }
    else if (!t) t = this.bank.get(0, 0);
    if (!t) return;
    if (ch !== PERC) pitch += t.transpose;
    pitch = Math.max(0, Math.min(127, pitch));
    const v = new FmVoice(t);
    v.ch = ch; v.key = note; v.note = pitch; v.vel = vel; v.age = ++this.clock;
    v.setFreq(hzOf(pitch) * 2 ** ((C.bend * 2) / 12));
    this.applyLevel(v, this.level(ch, vel));
    v.keyOn();
    this.voices[this.slot()] = v;
  }

  noteOff(ch: number, note: number): void {
    const C = this.chans[ch]!;
    for (const v of this.voices) {
      if (!v || v.ch !== ch || v.key !== note || v.releasing || v.held) continue;
      if (C.sustain) v.held = true; else v.keyOff();
      return;
    }
  }

  /** A free voice, else the oldest released one, else the oldest. */
  private slot(): number {
    let best = -1, bestAge = Infinity;
    for (let i = 0; i < VOICES; i++) {
      const v = this.voices[i];
      if (!v || v.done) return i;
      const a = v.age - (v.releasing ? 1e9 : 0);
      if (a < bestAge) { bestAge = a; best = i; }
    }
    return best;
  }

  /** Renders n stereo samples into l and r from off (added). */
  render(l: Float32Array, r: Float32Array, off: number, n: number, scratch: Float32Array): void {
    this.lfo += n / this.rate;
    const vib = 1 + 0.0081 * Math.sin(this.lfo * 2 * Math.PI * 6.07), trem = 2.4 * (1 + Math.sin(this.lfo * 2 * Math.PI * 3.7));
    for (let k = 0; k < VOICES; k++) {
      const v = this.voices[k];
      if (!v) continue;
      if (v.done) { this.voices[k] = null; continue; }
      scratch.fill(0, 0, n);
      v.render(scratch, 0, n, this.rate, 0.18, vib, trem);
      const p = (this.chans[v.ch]!.pan / 127) * Math.PI / 2, gl = Math.cos(p) * Math.SQRT2 * 0.8, gr = Math.sin(p) * Math.SQRT2 * 0.8;
      for (let i = 0; i < n; i++) { const s = scratch[i]!; l[off + i]! += s * gl; r[off + i]! += s * gr; }
    }
  }
}

interface Timed { t: number; d: readonly number[] }

/** A song on the timeline: the XMI's events plus the note-offs their lengths imply, in order. */
function timeline(x: Xmi): Timed[] {
  const out: Timed[] = [];
  for (const e of x.events) {
    out.push({ t: e.tick, d: e.data });
    if ((e.data[0]! & 0xf0) === 0x90 && e.data[2]) out.push({ t: e.tick + (e.dur ?? 0), d: [0x80 | (e.data[0]! & 15), e.data[1]!, 0] });
  }
  // stable sort: at the same tick, note-offs first so a repeated note is not cut by its predecessor's end
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || ((a.e.d[0]! & 0xf0) === 0x80 ? -1 : 0) - ((b.e.d[0]! & 0xf0) === 0x80 ? -1 : 0) || a.i - b.i).map(q => q.e);
}

/** Plays one XMI: render() pulls samples; `ended` turns true after the last event when not looping. */
export class XmiPlayer {
  private readonly ev: Timed[];
  private readonly length: number;
  private k = 0;
  private tick = 0;
  ended = false;
  private readonly scratch = new Float32Array(512);

  constructor(x: Xmi, private readonly fm: FmDriver, readonly loop: boolean) {
    this.ev = timeline(x);
    this.length = Math.max(x.ticks, this.ev.length ? this.ev[this.ev.length - 1]!.t : 0);
    fm.reset();
  }

  /** Seconds the song lasts (one pass). */
  get seconds(): number { return this.length / XMI_HZ; }

  render(l: Float32Array, r: Float32Array): void {
    const n = l.length, rate = this.fm.rate, perTick = rate / XMI_HZ;
    let i = 0;
    while (i < n) {
      if (!this.ended) {
        while (this.k < this.ev.length && this.ev[this.k]!.t <= this.tick) this.fm.send(this.ev[this.k++]!.d);
        if (this.k >= this.ev.length && this.tick >= this.length) {
          if (this.loop && this.length > 0) { this.fm.allOff(); this.k = 0; this.tick = 0; continue; }
          this.ended = true;
        }
      }
      const m = Math.min(n - i, this.scratch.length, Math.max(1, Math.round(perTick)));
      this.fm.render(l, r, i, m, this.scratch);
      i += m;
      this.tick += m / perTick;
    }
  }
}

import type { OpRegs, Timbre } from '../formats';

// A two-operator FM voice modelled on the Yamaha OPL2/OPL3 that the original's music was written for, fed the disc's
// own timbres (UW.OPL register bytes). This is OURS, not a chip emulator: it works in floating point at the output
// rate and follows the chip's documented behaviour (frequency multipliers, the eight waveforms, attack/decay/sustain/
// release rates with key scaling, total level, key-scale level, sustain vs. percussive envelopes, feedback, FM and
// additive connection, tremolo and vibrato) rather than its exact integer pipeline. Pure: no DOM, no WebAudio, so
// Node tests run it.

const OPL_HZ = 49716;
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
/** Key-scale level ROM (Nuked OPL3's kslrom), in 0.75 dB units after the scaling below. */
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];
const SILENT_DB = 96;
const TAB = 1024;
const SINE = Float32Array.from({ length: TAB }, (_, i) => Math.sin((i / TAB) * Math.PI * 2));

/** The eight OPL3 waveforms (OPL2 has the first four) at phase t in [0, 1). */
export function wave(w: number, t: number): number {
  const i = (t * TAB) | 0, s = SINE[i & (TAB - 1)]!;
  switch (w & 7) {
    case 0: return s;
    case 1: return s > 0 ? s : 0;
    case 2: return Math.abs(s);
    case 3: return (t % 0.5) < 0.25 ? Math.abs(s) : 0;
    case 4: return t < 0.5 ? SINE[(i * 2) & (TAB - 1)]! : 0;
    case 5: return t < 0.5 ? Math.abs(SINE[(i * 2) & (TAB - 1)]!) : 0;
    case 6: return t < 0.5 ? 1 : -1;
    default: return t < 0.5 ? 2 ** (-t * 16) : -(2 ** (-(1 - t) * 16));
  }
}

/** Seconds for a full attack (r = effective rate 0-63), or Infinity. */
export function attackSeconds(r: number): number {
  if (r >= 60) return 0;
  if (r < 4) return Infinity;
  return (2.82624 / 2 ** ((r >> 2) - 1)) * (4 / (4 + (r & 3)));
}
/** Seconds to decay through the whole 96 dB range, or Infinity. */
export function decaySeconds(r: number): number {
  if (r < 4) return Infinity;
  return (39.28064 / 2 ** (Math.min(r, 63) >> 2) * 2) * (4 / (4 + (r & 3)));
}

type Stage = 'attack' | 'decay' | 'sustain' | 'release' | 'off';

/** One operator: its registers and envelope state. */
class Op {
  phase = 0;
  att = SILENT_DB;
  stage: Stage = 'off';
  /** Extra attenuation from the driver (volume/velocity) in 0.75 dB steps, applied as a raised total level. */
  tl = 0;
  constructor(public r: OpRegs) {}

  get mult(): number { return MULT[this.r.r20 & 15]!; }
  get ksr(): boolean { return !!(this.r.r20 & 0x10); }
  get sustaining(): boolean { return !!(this.r.r20 & 0x20); }

  rate(r: number, kc: number): number { return r ? Math.min(63, r * 4 + (this.ksr ? kc : kc >> 2)) : 0; }

  keyOn(): void { this.stage = 'attack'; this.phase = 0; }
  keyOff(): void { if (this.stage !== 'off') this.stage = 'release'; }

  /** Advances the envelope by dt seconds (kc: key code for rate scaling). */
  step(dt: number, kc: number): void {
    const R = this.r;
    switch (this.stage) {
      case 'attack': {
        const T = attackSeconds(this.rate(R.r60 >> 4, kc));
        if (T === 0) { this.att = 0; this.stage = 'decay'; break; }
        if (T === Infinity) break;
        // attenuation falls exponentially, reaching 0 dB after T (the chip's attack is exponential too)
        this.att = (this.att + 8) * Math.exp((-2.565 * dt) / T) - 8;
        if (this.att <= 0) { this.att = 0; this.stage = 'decay'; }
        break;
      }
      case 'decay': {
        const sl = (R.r80 >> 4) === 15 ? 93 : (R.r80 >> 4) * 3;
        this.att += (SILENT_DB / decaySeconds(this.rate(R.r60 & 15, kc))) * dt;
        if (this.att >= sl) { this.att = sl; this.stage = 'sustain'; }
        break;
      }
      case 'sustain':
        if (this.sustaining) break;
        this.att += (SILENT_DB / decaySeconds(this.rate(R.r80 & 15, kc))) * dt; // percussive: keeps falling at the release rate
        break;
      case 'release':
        this.att += (SILENT_DB / decaySeconds(this.rate(R.r80 & 15, kc))) * dt;
        break;
      case 'off': break;
    }
    if (this.att >= SILENT_DB) { this.att = SILENT_DB; if (this.stage === 'release' || this.stage === 'sustain') this.stage = 'off'; }
  }

  /** Output amplitude factor for the current envelope plus total level, key scaling and tremolo (dB). */
  gain(kslDb: number, tremDb: number): number {
    const R = this.r, am = R.r20 & 0x80 ? tremDb : 0;
    const db = this.att + ((R.r40 & 63) + this.tl) * 0.75 + kslDb + am;
    return db >= SILENT_DB ? 0 : 2 ** (-db / 6.0206);
  }

  /** Key-scale attenuation (dB) for this operator at (block, fnum). */
  ksl(block: number, fnum: number): number {
    const k = this.r.r40 >> 6, v = (KSL_ROM[fnum >> 6]! << 2) - ((8 - block) << 5);
    return k && v > 0 ? (v >> KSL_SHIFT[k]!) * 0.1875 : 0;
  }
}

/** Frequency (Hz) to the chip's block and F-number. */
export function blockFnum(hz: number): { block: number; fnum: number } {
  for (let block = 0; block < 8; block++) {
    const fnum = Math.round((hz * 2 ** (20 - block)) / OPL_HZ);
    if (fnum < 1024) return { block, fnum };
  }
  return { block: 7, fnum: 1023 };
}

/** A sounding note: two operators wired by the timbre's connection bit. */
export class FmVoice {
  readonly mod: Op;
  readonly car: Op;
  fb: number;
  additive: boolean;
  wm: number;
  wc: number;
  hz = 440;
  private block = 4;
  private fnum = 0;
  private kc = 8;
  private o1 = 0;
  private o2 = 0;
  /** Bookkeeping for the driver. */
  ch = -1;
  /** The MIDI key that started it, the pitch it sounds, its velocity, when it started. */
  key = -1;
  note = -1;
  vel = 0;
  age = 0;
  /** Released while the sustain pedal was down. */
  held = false;

  constructor(t: Timbre, readonly opl3 = true) {
    this.mod = new Op(t.mod); this.car = new Op(t.car);
    this.fb = (t.fbc >> 1) & 7; this.additive = !!(t.fbc & 1);
    this.wm = t.mod.rE0 & (opl3 ? 7 : 3); this.wc = t.car.rE0 & (opl3 ? 7 : 3);
  }

  setFreq(hz: number): void {
    this.hz = hz;
    const { block, fnum } = blockFnum(hz);
    this.block = block; this.fnum = fnum; this.kc = block * 2 + ((fnum >> 9) & 1);
  }

  keyOn(): void { this.mod.keyOn(); this.car.keyOn(); this.o1 = this.o2 = 0; }
  keyOff(): void { this.mod.keyOff(); this.car.keyOff(); }
  get done(): boolean { return this.car.stage === 'off' && (!this.additive || this.mod.stage === 'off'); }
  get releasing(): boolean { return this.car.stage === 'release' || this.car.stage === 'off'; }

  /** Adds n samples at `rate` into out from off, scaled by amp. vib (a frequency factor) and tremDb are the LFOs' values for the block. */
  render(out: Float32Array, off: number, n: number, rate: number, amp: number, vib: number, tremDb: number): void {
    const M = this.mod, C = this.car, dt = 1 / rate;
    const fm = this.hz * (M.r.r20 & 0x40 ? vib : 1) * M.mult / rate, fc = this.hz * (C.r.r20 & 0x40 ? vib : 1) * C.mult / rate;
    const km = M.ksl(this.block, this.fnum), kc = C.ksl(this.block, this.fnum), fbk = this.fb ? 2 ** (this.fb - 7) : 0;
    for (let i = 0; i < n; i++) {
      M.step(dt, this.kc); C.step(dt, this.kc);
      const gm = M.gain(km, tremDb), gc = C.gain(kc, tremDb);
      let pm = M.phase + (this.o1 + this.o2) * fbk;
      pm -= Math.floor(pm);
      const om = wave(this.wm, pm) * gm;
      this.o2 = this.o1; this.o1 = om;
      let pc = C.phase + (this.additive ? 0 : om * 4);
      pc -= Math.floor(pc);
      const oc = wave(this.wc, pc) * gc;
      out[off + i]! += (this.additive ? om + oc : oc) * amp;
      M.phase += fm; if (M.phase >= 1) M.phase -= Math.floor(M.phase);
      C.phase += fc; if (C.phase >= 1) C.phase -= Math.floor(C.phase);
    }
  }
}

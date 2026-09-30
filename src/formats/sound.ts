import { DataError, ascii, need } from './bytes';
import { LIMITS } from './limits';

// UW2/SOUND: the sound-effect table, the AdLib instrument bank and the music. After UnderworldGodot (hankmorgan's
// port: audio/sfx/SoundsDatLoader.cs, loaders/xmimusic.cs) and the Miles AIL 2.0 formats it builds on.
//
// SOUNDS.DAT   u8 count, then 8 bytes per effect: patch, note, velocity (the base volume), u16 duration (big-endian),
//              3 unknown. The digital effects themselves are SPnn.VOC (nn = the effect number, two digits).
// UW.OPL       Miles "Global Timbre Library": 6-byte entries (u8 patch, u8 bank, u32 offset) until patch or bank is
//              0xFF; at each offset u16 size, s8 transpose, then the OPL registers: modulator 20/40/60/80/E0, C0,
//              carrier 20/40/60/80/E0 (4-operator timbres carry more; we read the first pair).
// UWAnn.XMI    Miles extended MIDI, IFF: [FORM XDIR] [CAT XMID] FORM XMID { [TIMB] EVNT }. EVNT is MIDI without
//              running status or note-offs: delays are sums of bytes < 0x80, a note-on carries its duration as a
//              variable-length number, time runs at 120 ticks a second.

export interface SoundEntry { patch: number; note: number; velocity: number; duration: number }

export function readSoundsDat(b: Uint8Array): SoundEntry[] {
  need(b.length >= 1, 'SOUNDS.DAT is empty');
  const n = b[0]!;
  need(1 + n * 8 <= b.length, `SOUNDS.DAT claims ${n} effects but holds ${Math.floor((b.length - 1) / 8)}`);
  const out: SoundEntry[] = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + i * 8;
    out.push({ patch: b[o]!, note: b[o + 1]!, velocity: b[o + 2]! & 0x7f, duration: (b[o + 3]! << 8) | b[o + 4]! });
  }
  return out;
}

export function writeSoundsDat(es: SoundEntry[]): Uint8Array {
  const b = new Uint8Array(1 + es.length * 8);
  b[0] = es.length;
  es.forEach((e, i) => b.set([e.patch, e.note, e.velocity, e.duration >> 8, e.duration & 255], 1 + i * 8));
  return b;
}

/** One FM instrument: two operators' register bytes (modulator first), the C0 feedback/connection byte, a transpose. */
export interface Timbre {
  bank: number; patch: number; transpose: number;
  mod: OpRegs; car: OpRegs; fbc: number;
}
/** Register bytes 20 (AM/VIB/EG/KSR/MULT), 40 (KSL/TL), 60 (AR/DR), 80 (SL/RR), E0 (waveform). */
export interface OpRegs { r20: number; r40: number; r60: number; r80: number; rE0: number }

const opFrom = (b: Uint8Array, o: number): OpRegs => ({ r20: b[o]!, r40: b[o + 1]!, r60: b[o + 2]!, r80: b[o + 3]!, rE0: b[o + 4]! });

export function readTimbres(b: Uint8Array): Timbre[] {
  const out: Timbre[] = [];
  for (let e = 0; ; e++) {
    const o = e * 6;
    need(o < b.length, 'timbre bank has no end mark');
    const patch = b[o]!, bank = b[o + 1] ?? 0xff;
    if (patch === 0xff || bank === 0xff) break;
    need(e < LIMITS.maxTimbres, 'timbre bank is implausibly long');
    need(o + 6 <= b.length, 'timbre bank index is truncated');
    const off = (b[o + 2]! | (b[o + 3]! << 8) | (b[o + 4]! << 16) | (b[o + 5]! << 24)) >>> 0;
    need(off + 14 <= b.length, `timbre ${bank}:${patch} lies past the end`);
    const size = b[off]! | (b[off + 1]! << 8);
    need(size >= 14, `timbre ${bank}:${patch} is too short`);
    out.push({ bank, patch, transpose: (b[off + 2]! << 24) >> 24, mod: opFrom(b, off + 3), fbc: b[off + 8]!, car: opFrom(b, off + 9) });
  }
  return out;
}

export function writeTimbres(ts: Timbre[]): Uint8Array {
  const head = ts.length * 6 + 2, b = new Uint8Array(head + ts.length * 14);
  ts.forEach((t, i) => {
    const off = head + i * 14, o = i * 6;
    b.set([t.patch, t.bank, off & 255, (off >> 8) & 255, 0, 0], o);
    const r = (x: OpRegs) => [x.r20, x.r40, x.r60, x.r80, x.rE0];
    b.set([14, 0, t.transpose & 255, ...r(t.mod), t.fbc, ...r(t.car)], off);
  });
  b[ts.length * 6] = 0xff; b[ts.length * 6 + 1] = 0xff;
  return b;
}

/** One MIDI event at an absolute tick (120 a second). Note-ons carry their length; `data` is status + data bytes. */
export interface MidiEvent { tick: number; data: number[]; dur?: number }
export interface Xmi { timbres: { patch: number; bank: number }[]; events: MidiEvent[]; ticks: number }

export const XMI_HZ = 120;

const be32 = (b: Uint8Array, o: number) => { need(o + 4 <= b.length, 'XMI chunk header is truncated'); return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0; };

/** Finds the first FORM XMID's chunks, walking through XDIR/CAT wrappers. */
function findXmid(b: Uint8Array): { timb: Uint8Array | null; evnt: Uint8Array } {
  let timb: Uint8Array | null = null, evnt: Uint8Array | null = null;
  const walk = (s: number, e: number, depth: number): void => {
    need(depth < 8, 'XMI nests too deeply');
    let p = s;
    while (p + 8 <= e && !evnt) {
      const id = ascii(b, p, 4), len = be32(b, p + 4), d = p + 8, end = Math.min(e, d + len);
      need(d + len <= b.length, `XMI chunk ${id} runs past the end`);
      if (id === 'FORM' || id === 'CAT ') walk(d + 4, end, depth + 1);
      else if (id === 'TIMB') timb = b.subarray(d, end);
      else if (id === 'EVNT') evnt = b.subarray(d, end);
      p = end + (len & 1);
    }
  };
  walk(0, b.length, 0);
  need(evnt, 'XMI has no EVNT chunk');
  return { timb, evnt };
}

export function readXmi(b: Uint8Array): Xmi {
  need(b.length >= 12 && ascii(b, 0, 4) === 'FORM', 'not an XMI file');
  const { timb, evnt: E } = findXmid(b);
  const timbres: Xmi['timbres'] = [];
  if (timb && timb.length >= 2) {
    const n = Math.min(timb[0]! | (timb[1]! << 8), (timb.length - 2) >> 1);
    for (let i = 0; i < n; i++) timbres.push({ patch: timb[2 + i * 2]!, bank: timb[3 + i * 2]! });
  }
  const events: MidiEvent[] = [];
  let p = 0, tick = 0, last = 0;
  const byte = () => { need(p < E.length, 'XMI event is truncated'); return E[p++]!; };
  const vlq = () => { let v = 0; for (let k = 0; k < 4; k++) { const c = byte(); v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) return v; } throw new DataError('XMI number is too long'); };
  while (p < E.length) {
    const c = E[p]!;
    if (c < 0x80) { while (p < E.length && E[p]! < 0x80) tick += E[p++]!; continue; }
    p++;
    need(events.length < LIMITS.maxXmiEvents, 'XMI has implausibly many events');
    const hi = c & 0xf0;
    if (c === 0xff) {
      const type = byte(), len = vlq();
      need(p + len <= E.length, 'XMI meta event is truncated');
      p += len;
      if (type === 0x2f) break;
      continue;
    }
    if (c === 0xf0 || c === 0xf7) { const len = vlq(); need(p + len <= E.length, 'XMI sysex is truncated'); p += len; continue; }
    need(c < 0xf0, `XMI status ${c.toString(16)} is not a channel event`);
    if (hi === 0x90) {
      const note = byte() & 0x7f, vel = byte() & 0x7f, dur = vlq();
      events.push({ tick, data: [c, note, vel], dur });
      last = Math.max(last, tick + dur);
    } else if (hi === 0xc0 || hi === 0xd0) events.push({ tick, data: [c, byte() & 0x7f] });
    else { const a = byte() & 0x7f, d = byte() & 0x7f; events.push({ tick, data: [c, a, d] }); }
  }
  return { timbres, events, ticks: Math.max(tick, last) };
}

/** Builds an XMI (FORM XMID with TIMB and EVNT) from events in tick order; for tests. */
export function writeXmi(x: { timbres?: { patch: number; bank: number }[]; events: MidiEvent[] }): Uint8Array {
  const ev: number[] = [];
  let t = 0;
  const vlq = (v: number) => { const s = [v & 0x7f]; while ((v >>= 7)) s.unshift((v & 0x7f) | 0x80); ev.push(...s); };
  for (const e of x.events) {
    let d = e.tick - t;
    while (d > 0) { const k = Math.min(127, d); ev.push(k); d -= k; }
    t = e.tick;
    ev.push(...e.data);
    if ((e.data[0]! & 0xf0) === 0x90) vlq(e.dur ?? 0);
  }
  ev.push(0xff, 0x2f, 0);
  const tb = x.timbres ?? [], timb = [tb.length & 255, tb.length >> 8, ...tb.flatMap(q => [q.patch, q.bank])];
  const chunk = (id: string, body: number[]) => [...id].map(ch => ch.charCodeAt(0)).concat([body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255], body, body.length & 1 ? [0] : []);
  const inner = [...'XMID'].map(ch => ch.charCodeAt(0)).concat(chunk('TIMB', timb), chunk('EVNT', ev));
  return Uint8Array.from(chunk('FORM', inner));
}

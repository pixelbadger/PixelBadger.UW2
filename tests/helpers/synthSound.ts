import type { Timbre } from '../../src/formats';

// Made-up FM timbres for tests (register bytes as UW.OPL holds them; no game data): a sustaining organ-ish sound and a
// percussive drum in the percussion bank (127) at key 36, sounding note 40.
export const ORGAN: Timbre = { bank: 0, patch: 0, transpose: 0, fbc: 0x06, mod: { r20: 0x21, r40: 0x10, r60: 0xf2, r80: 0x24, rE0: 0 }, car: { r20: 0x21, r40: 0x00, r60: 0xf2, r80: 0x24, rE0: 0 } };
export const DRUM: Timbre = { bank: 127, patch: 36, transpose: 40, fbc: 0x0e, mod: { r20: 0x01, r40: 0x08, r60: 0xf8, r80: 0x46, rE0: 0 }, car: { r20: 0x01, r40: 0x00, r60: 0xf6, r80: 0x46, rE0: 0 } };

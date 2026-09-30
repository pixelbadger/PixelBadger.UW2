import { u16, type ObjRec } from '../formats';
import type { GameData } from './gamedata';

// Names and text drawn from STRINGS.PAK, COMOBJ.DAT and OBJECTS.DAT. Prefer the game's own strings over our wording.

const WORLDS = ['Britannia', 'Prison Tower', 'Killorn Keep', 'Ice Caverns', 'Talorus', 'Scintillus Academy', 'Tomb of Praecor Loth', 'Pits of Carnage', 'Ethereal Void', 'Ethereal Void'];
export const levelName = (i: number): string => `${WORLDS[i >> 3] ?? 'Level'} ${(i & 7) + 1}`;

/** An object's name from block 4 ("a_sword&swords" -> "a sword"). */
export const nameOf = (D: GameData, id: number): string => {
  const s = (D.names[id] || 'something').split('&')[0]!;
  return s.replace(/^(an?|the|some)_/, '$1 ').replace(/^_/, '');
};

/** Block 1: game messages (13 welcome, 107 can't reach, 109 can't pick up, 168 you see nothing, 170 can't talk, 269/274 no space, 40-47 compass). */
export const S1 = (D: GameData, i: number): string => D.str(1, i).trim();
/** Block 2: character creation, incl. class names 23+ and skill names 31+ / 51+. */
export const S2 = (D: GameData, i: number): string => D.str(2, i).replace(/:\s*$/, '').trim();

/** NPC names: block 7 at whoami + 16 (NOT whoami). Falls back to the object's name. */
export const npcName = (D: GameData, who: number, o?: ObjRec | null): string => {
  const n = D.str(7, who + 16);
  return n && n.trim() ? n.trim() : o ? nameOf(D, o.id).replace(/^(an?|the|some) /, '') : 'Someone';
};

/** COMOBJ.DAT: 11 bytes per id after 2; value u16 at +4. */
export const objValue = (D: GameData, id: number): number => {
  const b = D.files['COMOBJ.DAT'];
  return b && 2 + id * 11 + 6 <= b.length ? u16(b, 2 + id * 11 + 4) : 0;
};

/** OBJECTS.DAT critter bytes: 48 per creature (id & 63) at 0x132. */
export const critByte = (D: GameData, id: number, k: number): number => {
  const b = D.files['OBJECTS.DAT'];
  const a = 0x132 + (id & 63) * 48 + k;
  return b && a < b.length ? b[a]! : 0;
};
export const critWord = (D: GameData, id: number, k: number): number => {
  const b = D.files['OBJECTS.DAT'];
  const a = 0x132 + (id & 63) * 48 + k;
  return b && a + 2 <= b.length ? u16(b, a) : 0;
};

export const qtyOf = (o: ObjRec): number => (o.isq && o.link < 0x200 ? Math.max(1, o.link) : 1);

export const itemName = (D: GameData, o: ObjRec): string => {
  const n = nameOf(D, o.id), q = qtyOf(o);
  return q > 1 ? `${q} × ${n.replace(/^(an?|some) /, '')}` : n;
};

/** Skill index whose block-2 name matches re, or -1. */
export const skillNo = (D: GameData, re: RegExp): number => {
  for (let k = 0; k < 20; k++) if (re.test(S2(D, 31 + k))) return k;
  return -1;
};

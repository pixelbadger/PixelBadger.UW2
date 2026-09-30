import { DataError, isoExtract } from '../formats';

/** Files the engine cannot run without (UW2/DATA). */
export const NEEDED = ['LEV.ARK', 'T64.TR', 'PALS.DAT', 'LIGHT.DAT', 'OBJECTS.GR', 'ALLPALS.DAT', 'DOORS.GR', 'STRINGS.PAK'] as const;
/** Files that add features when present: switches, 3D models, interface art, conversations + portraits. */
export const OPTIONAL = ['HEADS.GR', 'SKILLS.DAT', 'TMFLAT.GR', 'TMOBJ.GR', 'PANELS.GR', 'BODIES.GR', 'FLASKS.GR', 'COMPASS.GR', 'LFTI.GR', 'CHAINS.GR', 'CHRBTNS.GR', 'SCRLEDGE.GR', 'PLAYER.DAT', 'FONT5X6P.SYS', 'UW2.EXE', 'CNV.ARK', 'BABGLOBS.DAT', 'CHARHEAD.GR', 'GENHEAD.GR', 'OBJECTS.DAT', 'COMOBJ.DAT'] as const;

/** Extracted game files by name; creature files are keyed "CRIT/<name>". */
export type GameFiles = Record<string, Uint8Array>;

const WANTED = new Set<string>([...NEEDED, ...OPTIONAL]);
export const isCritName = (n: string): boolean => /^(AS\.AN|CR\.AN|PG\.MP|CR[0-7][0-7]\.[0-9][0-9])$/.test(n);
export const isWanted = (n: string): boolean => WANTED.has(n);

/** Pulls UW2/DATA/{NEEDED + OPTIONAL}, UW2/CRIT/* and UW2/UW2.EXE out of a disc image. */
export function filesFromIso(u8: Uint8Array): GameFiles {
  return isoExtract(u8, {
    data: n => (WANTED.has(n) ? n : null),
    crit: n => (isCritName(n) ? 'CRIT/' + n : null),
    root: n => (n === 'UW2.EXE' ? 'UW2.EXE' : null), // furniture models live in the executable
  });
}

/** Files the player picked or dropped: disc images (.iso/.bin) or loose files from UW2/DATA and UW2/CRIT. */
export async function filesFromPicked(list: { name: string; arrayBuffer(): Promise<ArrayBuffer> }[]): Promise<GameFiles> {
  const files: GameFiles = {};
  for (const f of list) {
    const name = f.name.toUpperCase();
    const u8 = new Uint8Array(await f.arrayBuffer());
    if (name.endsWith('.ISO') || name.endsWith('.BIN')) Object.assign(files, filesFromIso(u8));
    else if (WANTED.has(name)) files[name] = u8;
    else if (isCritName(name)) files['CRIT/' + name] = u8;
  }
  const missing = NEEDED.filter(n => !files[n]);
  if (missing.length) throw new DataError(`Missing ${missing.join(', ')}. Choose the disc image, or all of these files from UW2/DATA.`);
  return files;
}

export const hasNeeded = (files: GameFiles | null | undefined): files is GameFiles => !!files && NEEDED.every(n => files[n]);

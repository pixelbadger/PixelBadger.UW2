import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { filesFromIso, isCritName, isCutsName, isSpeechName, isWanted, type GameFiles } from '../../src/data/files';

// The user's own disc for integration tests. UW2_DATA is a disc image (.iso/.bin), a folder holding UW2/ (a GOG
// install, a mounted disc) or the UW2 folder itself. Never commit the data.

const env = process.env;
export const DATA_PATH = env.UW2_DATA ?? '';
/** Set in the deploy gate: missing data is a failure there, not a skip. */
export const REQUIRED = env.UW2_DATA_REQUIRED === '1';

/** Case-insensitive child lookup (disc copies differ in case). */
function child(dir: string, name: string): string | null {
  const hit = readdirSync(dir).find(n => n.toUpperCase() === name);
  return hit ? join(dir, hit) : null;
}

const hasData = (dir: string) => { const d = child(dir, 'DATA'); return !!d && statSync(d).isDirectory(); };

/** The first folder named UW2 with a DATA/ inside, a few levels down (the disc also has UW1's UW/DATA). */
function findUw2(dir: string, depth = 3): string | null {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (!statSync(p).isDirectory()) continue;
    if (n.toUpperCase() === 'UW2' && hasData(p)) return p;
    const hit = depth > 1 ? findUw2(p, depth - 1) : null;
    if (hit) return hit;
  }
  return null;
}

function fromFolder(root: string): GameFiles {
  const uw2 = hasData(root) ? root : findUw2(root) ?? root; // UW2_DATA may name the UW2 folder itself
  const files: GameFiles = {};
  const take = (sub: string, keep: (n: string) => string | null) => {
    const d = child(uw2, sub);
    if (d) for (const n of readdirSync(d)) { const k = keep(n.toUpperCase()); if (k && statSync(join(d, n)).isFile()) files[k] = new Uint8Array(readFileSync(join(d, n))); }
  };
  take('DATA', n => (isWanted(n) ? n : null));
  take('CRIT', n => (isCritName(n) ? 'CRIT/' + n : null));
  take('CUTS', n => (isCutsName(n) ? 'CUTS/' + n : null));
  take('SOUND', n => (isSpeechName(n) ? 'SOUND/' + n : null));
  const exe = child(uw2, 'UW2.EXE');
  if (exe) files['UW2.EXE'] = new Uint8Array(readFileSync(exe));
  return files;
}

let cached: GameFiles | null | undefined;

/** The disc's files, or null when UW2_DATA is not set (throws when it is set but unreadable). */
export function disc(): GameFiles | null {
  if (cached !== undefined) return cached;
  if (!DATA_PATH) return (cached = null);
  if (!existsSync(DATA_PATH)) throw new Error(`UW2_DATA=${DATA_PATH} does not exist`);
  cached = statSync(DATA_PATH).isDirectory() ? fromFolder(DATA_PATH) : filesFromIso(new Uint8Array(readFileSync(DATA_PATH)));
  if (!cached['LEV.ARK']) throw new Error(`UW2_DATA=${DATA_PATH} holds no UW2/DATA/LEV.ARK`);
  return cached;
}

/** describe-level guard: skip without data, unless the data is required. */
export function needDisc(): boolean {
  if (DATA_PATH) return true;
  if (REQUIRED) throw new Error('UW2_DATA_REQUIRED=1 but UW2_DATA is not set: the real-data tests cannot run');
  console.warn('UW2_DATA is not set: skipping the real-data tests');
  return false;
}

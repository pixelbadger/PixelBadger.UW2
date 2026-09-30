// IndexedDB "uw2-engine"/kv: "data" (the extracted disc files) and "save0".."save3".
// Storage is a convenience, never a gate: every call times out and failures resolve to null/false. (Inside embedded
// viewers IndexedDB may be slow, partitioned or unavailable; the game must start regardless. Nothing on the boot path
// awaits storage except the initial cache read, capped at 5 s.)

export const withTimeout = <T,>(pr: Promise<T>, ms: number, v: T): Promise<T> =>
  Promise.race([pr.catch(() => v), new Promise<T>(r => setTimeout(() => r(v), ms))]);

let dbP: Promise<IDBDatabase | null> | null = null;
function idb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return (dbP ??= withTimeout(new Promise<IDBDatabase | null>((res, rej) => {
    const r = indexedDB.open('uw2-engine', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  }), 5000, null));
}

export async function kvGet<T = unknown>(k: string): Promise<T | null> {
  try {
    const db = await idb();
    if (!db) return null;
    return await withTimeout(new Promise<T | null>(res => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res((q.result as T) ?? null);
      q.onerror = () => res(null);
    }), 5000, null);
  } catch { return null; }
}

export async function kvPut(k: string, v: unknown): Promise<boolean> {
  try {
    const db = await idb();
    if (!db) return false;
    return await withTimeout(new Promise<boolean>(res => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(v, k);
      t.oncomplete = () => res(true);
      t.onerror = t.onabort = () => res(false);
    }), 20000, false);
  } catch { return false; }
}

export async function kvDel(k: string): Promise<boolean> {
  try {
    const db = await idb();
    if (!db) return false;
    return await withTimeout(new Promise<boolean>(res => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').delete(k);
      t.oncomplete = () => res(true);
      t.onerror = t.onabort = () => res(false);
    }), 5000, false);
  } catch { return false; }
}

export const cacheGet = () => kvGet<Record<string, Uint8Array>>('data');
export const cachePut = (v: Record<string, Uint8Array>) => kvPut('data', v);
export const cacheClear = () => kvDel('data');
export const saveKey = (slot: number) => 'save' + slot;

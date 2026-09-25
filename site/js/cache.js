// Daily points already fetched, kept in IndexedDB - this app's stand-in for
// Boord's WeatherHistory table. One entry per location / field / aggregation /
// units / year, so ticking a year back on, or reopening the app tomorrow,
// costs no request at all.
//
// Falls back to an in-memory map where IndexedDB is unavailable (some private
// browsing modes): the app still works, it just forgets on reload.

const DB_NAME = "weather-pwa";
const STORE = "daily";

let _dbPromise = null;
const _memory = new Map();

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "k" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function cacheGet(k) {
  const db = await openDb();
  if (!db) return _memory.get(k);
  return tx(db, "readonly", (s) => s.get(k));
}

export async function cachePut(entry) {
  const db = await openDb();
  if (!db) { _memory.set(entry.k, entry); return; }
  await tx(db, "readwrite", (s) => s.put(entry));
}

export async function cacheClear() {
  _memory.clear();
  const db = await openDb();
  if (db) await tx(db, "readwrite", (s) => s.clear());
}

export async function cacheCount() {
  const db = await openDb();
  if (!db) return _memory.size;
  return (await tx(db, "readonly", (s) => s.count())) || 0;
}

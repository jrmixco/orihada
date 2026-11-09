// Persistence: a tiny IndexedDB key/value wrapper plus localStorage prefs.
// Every access is guarded so the app still works with storage disabled.

const DB_NAME = "folio";
const STORES = ["kv", "recent", "drafts", "signatures"];
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    try {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const idb = {
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  set: (store, key, val) => tx(store, "readwrite", (s) => s.put(val, key)),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  async all(store) {
    const d = await db();
    if (!d) return [];
    return new Promise((resolve) => {
      try {
        const out = [];
        const req = d.transaction(store, "readonly").objectStore(store).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } else resolve(out);
        };
        req.onerror = () => resolve(out);
      } catch {
        resolve([]);
      }
    });
  },
};

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`folio:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`folio:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

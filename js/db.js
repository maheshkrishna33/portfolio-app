// Everything is stored on the phone in IndexedDB. Nothing is uploaded anywhere.
const NAME = "portfolio", VERSION = 1;
const STORES = {
  instruments: { keyPath: "id", autoIncrement: true },
  txns: { keyPath: "id", autoIncrement: true },
  kv: { keyPath: "k" },
  rules: { keyPath: "id", autoIncrement: true },
  log: { keyPath: "id", autoIncrement: true },
  backups: { keyPath: "id", autoIncrement: true },
};
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [n, o] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(n)) {
          const s = db.createObjectStore(n, o);
          if (n === "txns") s.createIndex("instrument_id", "instrument_id");
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function all(store) { const db = await open(); return wrap(db.transaction(store).objectStore(store).getAll()); }
export async function get(store, key) { const db = await open(); return wrap(db.transaction(store).objectStore(store).get(key)); }
export async function put(store, obj) {
  const db = await open(); const tx = db.transaction(store, "readwrite");
  const k = await wrap(tx.objectStore(store).put(obj)); await done(tx); return k;
}
export async function del(store, key) { const db = await open(); const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); await done(tx); }

/** Run several writes atomically: fn(stores) receives {name: IDBObjectStore} */
export async function atomic(names, fn) {
  const db = await open(); const tx = db.transaction(names, "readwrite");
  const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
  let result;
  try { result = await fn(stores, wrap); } catch (e) { try { tx.abort(); } catch (_) { /* already done */ } throw e; }
  await done(tx);
  return result;
}

export async function kvGet(k, def = null) { const r = await get("kv", k); return r ? r.v : def; }
export async function kvSet(k, v) { return put("kv", { k, v }); }

export async function persist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch (e) { /* ignore */ }
  return false;
}

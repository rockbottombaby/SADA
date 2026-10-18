// Minimal local-first key/value store (IndexedDB). Notes, research findings and chats never leave the browser.
const DB = 'oam', STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export const kvGet = <T>(k: string) => tx<T>('readonly', s => s.get(k) as IDBRequest<T>);
export const kvSet = (k: string, v: unknown) => tx('readwrite', s => s.put(v, k));
export const kvDel = (k: string) => tx('readwrite', s => s.delete(k));
export const kvKeys = () => tx<IDBValidKey[]>('readonly', s => s.getAllKeys());

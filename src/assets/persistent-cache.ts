const LIMIT = 192 * 1048576;
interface Entry { key: string; bytes: ArrayBuffer; touched: number }
let unavailable = false;
/** Optional bounded cache. Browser policy, quota and corruption must never block loading. */
async function database(): Promise<IDBDatabase> {
  if (unavailable) throw new Error('Cache unavailable');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('path-tracer-assets', 1);
    let expired = false;
    const timeout = setTimeout(() => { expired = unavailable = true; reject(new Error('Cache timed out')); }, 1000);
    request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'key' });
    request.onsuccess = () => { clearTimeout(timeout); if (expired) request.result.close(); else resolve(request.result); };
    request.onerror = () => { clearTimeout(timeout); unavailable = true; reject(request.error); };
    request.onblocked = () => { clearTimeout(timeout); expired = unavailable = true; reject(new Error('Cache blocked')); };
  });
}
export async function readCached(key: string): Promise<ArrayBuffer | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const tx = db!.transaction('entries'), request = tx.objectStore('entries').get(key);
      let bytes: ArrayBuffer | undefined;
      const timeout = setTimeout(() => { try { tx.abort(); } catch { /* Native commit can precede its queued completion event. */ } }, 1000);
      tx.oncomplete = () => { clearTimeout(timeout); resolve(bytes); };
      tx.onabort = () => { clearTimeout(timeout); reject(tx.error); };
      request.onsuccess = () => { bytes = (request.result as Entry | undefined)?.bytes; };
      request.onerror = () => reject(request.error);
    });
  } catch { unavailable = true; return undefined; } finally { db?.close(); }
}
export async function writeCached(key: string, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength > LIMIT) return;
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('entries', 'readwrite'), store = tx.objectStore('entries');
      const timeout = setTimeout(() => { try { tx.abort(); } catch { /* Completion is queued. */ } }, 2000);
      const request = store.openCursor();
      const entries: { key: string; size: number; touched: number }[] = [];
      request.onsuccess = () => {
        try {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value as Entry;
          if (!(entry.bytes instanceof ArrayBuffer) || !Number.isFinite(entry.touched)) cursor.delete();
          else if (entry.key !== key) entries.push({key: entry.key, size: entry.bytes.byteLength, touched: entry.touched});
          cursor.continue(); return;
        }
        entries.sort((a,b) => a.touched - b.touched);
        let total = bytes.byteLength + entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries) { if (total <= LIMIT) break; store.delete(entry.key); total -= entry.size; }
        store.put({ key, bytes, touched: Date.now() } satisfies Entry);
        } catch (error) { clearTimeout(timeout); try { tx.abort(); } catch { /* Already completed. */ } reject(error); }
      };
      tx.oncomplete = () => { clearTimeout(timeout); resolve(); }; tx.onerror = () => { clearTimeout(timeout); reject(tx.error); }; tx.onabort = () => { clearTimeout(timeout); reject(tx.error); };
    });
  } catch { unavailable = true; } finally { db?.close(); }
}

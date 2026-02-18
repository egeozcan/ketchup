export interface StampEntry {
  id: string;
  blob: Blob;
  createdAt: number;
}

const DB_NAME = 'ketchup-stamps';
const STORE_NAME = 'stamps';
const DB_VERSION = 1;
const MAX_STAMPS = 20;

let cachedDB: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (cachedDB) return cachedDB;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => {
      cachedDB = req.result;
      resolve(cachedDB);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getRecentStamps(limit = MAX_STAMPS): Promise<StampEntry[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('createdAt');
    const entries: StampEntry[] = [];
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && entries.length < limit) {
        entries.push(cursor.value as StampEntry);
        cursor.continue();
      } else {
        resolve(entries);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addStamp(blob: Blob): Promise<StampEntry> {
  const entry: StampEntry = {
    id: crypto.randomUUID(),
    blob,
    createdAt: Date.now(),
  };
  const db = await openDB();

  // Add the new entry
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Prune oldest if over limit
  const all = await getRecentStamps(MAX_STAMPS + 10);
  if (all.length > MAX_STAMPS) {
    const toDelete = all.slice(MAX_STAMPS);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const old of toDelete) {
        store.delete(old.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return entry;
}

export async function deleteStamp(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

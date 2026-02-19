import { openDB, STAMPS_STORE } from './project-store.js';

export interface StampEntry {
  id: string;
  projectId: string;
  blob: Blob;
  createdAt: number;
}

const MAX_STAMPS = 20;

export async function getRecentStamps(projectId: string, limit = MAX_STAMPS): Promise<StampEntry[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STAMPS_STORE, 'readonly');
    const store = tx.objectStore(STAMPS_STORE);
    const index = store.index('projectId');
    const entries: StampEntry[] = [];
    const req = index.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        entries.push(cursor.value as StampEntry);
        cursor.continue();
      } else {
        // Sort by createdAt descending and apply limit
        entries.sort((a, b) => b.createdAt - a.createdAt);
        resolve(entries.slice(0, limit));
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addStamp(projectId: string, blob: Blob): Promise<StampEntry> {
  const entry: StampEntry = {
    id: crypto.randomUUID(),
    projectId,
    blob,
    createdAt: Date.now(),
  };
  const db = await openDB();

  // Add the new entry
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STAMPS_STORE, 'readwrite');
    tx.objectStore(STAMPS_STORE).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Prune oldest if over limit (per-project)
  const all = await getRecentStamps(projectId, MAX_STAMPS + 10);
  if (all.length > MAX_STAMPS) {
    const toDelete = all.slice(MAX_STAMPS);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STAMPS_STORE, 'readwrite');
      const store = tx.objectStore(STAMPS_STORE);
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
    const tx = db.transaction(STAMPS_STORE, 'readwrite');
    tx.objectStore(STAMPS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

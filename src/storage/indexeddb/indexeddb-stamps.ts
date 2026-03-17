// src/storage/indexeddb/indexeddb-stamps.ts
import type { BlobStore, StampEntry, StampStore } from '../types.js';
import { mapDOMException } from './error-utils.js';
import { generateUUID } from './migration.js';

const STAMPS_STORE = 'project-stamps';

export class IndexedDBStampStore implements StampStore {
  constructor(
    private _db: IDBDatabase,
    private _blobs: BlobStore,
  ) {}

  async list(projectId: string): Promise<StampEntry[]> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readonly');
      const index = tx.objectStore(STAMPS_STORE).index('projectId');
      const entries: StampEntry[] = [];
      const req = index.openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          entries.push(cursor.value as StampEntry);
          cursor.continue();
        } else {
          entries.sort((a, b) => b.createdAt - a.createdAt);
          resolve(entries);
        }
      };
      req.onerror = () => reject(mapDOMException(req.error));
    });
  }

  async add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
    const blobRef = await this._blobs.put(data);
    const entry: StampEntry = {
      id: generateUUID(),
      projectId,
      blobRef,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      tx.objectStore(STAMPS_STORE).add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
    return entry;
  }

  async delete(id: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      tx.objectStore(STAMPS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async deleteForProject(projectId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      const index = tx.objectStore(STAMPS_STORE).index('projectId');
      const req = index.openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      req.onerror = () => reject(mapDOMException(req.error));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }
}

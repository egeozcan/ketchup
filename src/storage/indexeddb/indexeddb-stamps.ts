// src/storage/indexeddb/indexeddb-stamps.ts
import type { BlobRef, BlobStore, StampEntry, StampStore } from '../types.js';
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
    // Read the stamp first to get the blobRef for cleanup
    const blobRef = await new Promise<BlobRef | null>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readonly');
      const req = tx.objectStore(STAMPS_STORE).get(id);
      req.onsuccess = () => {
        const entry = req.result as StampEntry | undefined;
        resolve(entry?.blobRef ?? null);
      };
      req.onerror = () => reject(mapDOMException(req.error));
    });

    // Delete the stamp record
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      tx.objectStore(STAMPS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });

    // Delete the payload blob (best-effort)
    if (blobRef) {
      this._blobs.delete(blobRef).catch(() => {});
    }
  }

  async deleteForProject(projectId: string): Promise<void> {
    // Collect blob refs and delete records in a single cursor pass
    const blobRefs: BlobRef[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      const index = tx.objectStore(STAMPS_STORE).index('projectId');
      const req = index.openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const entry = cursor.value as StampEntry;
          blobRefs.push(entry.blobRef);
          cursor.delete();
          cursor.continue();
        }
      };
      req.onerror = () => reject(mapDOMException(req.error));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
    // Best-effort blob cleanup
    if (blobRefs.length > 0) {
      this._blobs.deleteMany(blobRefs).catch(() => {});
    }
  }
}

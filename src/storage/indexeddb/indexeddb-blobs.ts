// src/storage/indexeddb/indexeddb-blobs.ts
import type { BlobRef, BlobStore } from '../types.js';
import { createBlobRef } from '../types.js';
import { StorageNotFoundError } from '../errors.js';
import { mapDOMException } from './error-utils.js';
import { generateUUID } from './migration.js';

const BLOBS_STORE = 'blobs';

export class IndexedDBBlobStore implements BlobStore {
  constructor(private _db: IDBDatabase) {}

  async put(data: Blob | ArrayBuffer): Promise<BlobRef> {
    const ref = createBlobRef(generateUUID());
    await this._tx('readwrite', (store) => store.put(data, ref));
    return ref;
  }

  async get(ref: BlobRef): Promise<Blob> {
    const result = await this._tx('readonly', (store) => store.get(ref));
    if (result === undefined) {
      throw new StorageNotFoundError(`Blob not found: ${ref}`);
    }
    return result instanceof Blob ? result : new Blob([result]);
  }

  async delete(ref: BlobRef): Promise<void> {
    await this._tx('readwrite', (store) => store.delete(ref));
  }

  async deleteMany(refs: BlobRef[]): Promise<void> {
    if (refs.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(BLOBS_STORE, 'readwrite');
      const store = tx.objectStore(BLOBS_STORE);
      for (const ref of refs) {
        store.delete(ref);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async gc(activeRefs: Set<BlobRef>): Promise<number> {
    let deleted = 0;
    const orphaned: BlobRef[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(BLOBS_STORE, 'readonly');
      const req = tx.objectStore(BLOBS_STORE).openKeyCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const key = cursor.key as string as BlobRef;
          if (!activeRefs.has(key)) orphaned.push(key);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
    if (orphaned.length > 0) {
      await this.deleteMany(orphaned);
      deleted = orphaned.length;
    }
    return deleted;
  }

  private _tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(BLOBS_STORE, mode);
      const req = fn(tx.objectStore(BLOBS_STORE));
      req.onsuccess = () => resolve(req.result);
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }
}

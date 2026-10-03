// src/storage/indexeddb/indexeddb-state.ts
import type { ProjectStateRecord, ProjectStateStore } from '../types.js';
import { mapDOMException, txAbortError, txRequestError } from './error-utils.js';

const STATE_STORE = 'project-state';

export class IndexedDBStateStore implements ProjectStateStore {
  constructor(private _db: IDBDatabase) {}

  async get(projectId: string): Promise<ProjectStateRecord | null> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(STATE_STORE, 'readonly');
      const req = tx.objectStore(STATE_STORE).get(projectId);
      req.onsuccess = () => resolve((req.result as ProjectStateRecord) ?? null);
      req.onerror = () => reject(mapDOMException(req.error));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async save(record: ProjectStateRecord): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async delete(projectId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }
}

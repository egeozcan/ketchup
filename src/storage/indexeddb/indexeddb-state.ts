// src/storage/indexeddb/indexeddb-state.ts
import type { ProjectStateRecord, ProjectStateStore } from '../types.js';
import { mapDOMException, txAbortError, txRequestError, openTx, type Connection } from './error-utils.js';

const STATE_STORE = 'project-state';

export class IndexedDBStateStore implements ProjectStateStore {
  constructor(private _connection: Connection) {}

  async get(projectId: string): Promise<ProjectStateRecord | null> {
    const db = await this._connection();
    return new Promise((resolve, reject) => {
      const tx = openTx(db, STATE_STORE, 'readonly');
      const req = tx.objectStore(STATE_STORE).get(projectId);
      req.onsuccess = () => resolve((req.result as ProjectStateRecord) ?? null);
      req.onerror = () => reject(mapDOMException(req.error));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async save(record: ProjectStateRecord): Promise<void> {
    const db = await this._connection();
    await new Promise<void>((resolve, reject) => {
      const tx = openTx(db, STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async delete(projectId: string): Promise<void> {
    const db = await this._connection();
    await new Promise<void>((resolve, reject) => {
      const tx = openTx(db, STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }
}

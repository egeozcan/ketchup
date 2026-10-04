// src/storage/indexeddb/indexeddb-history.ts
import type { ProjectHistoryRecord, ProjectHistoryStore } from '../types.js';
import { mapDOMException, txAbortError, txRequestError, openTx, type Connection } from './error-utils.js';

const HISTORY_STORE = 'project-history';

export class IndexedDBHistoryStore implements ProjectHistoryStore {
  constructor(private _connection: Connection) {}

  async getEntries(projectId: string): Promise<ProjectHistoryRecord[]> {
    const db = await this._connection();
    return new Promise((resolve, reject) => {
      const tx = openTx(db, HISTORY_STORE, 'readonly');
      const index = tx.objectStore(HISTORY_STORE).index('projectId');
      const entries: ProjectHistoryRecord[] = [];
      const req = index.openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          entries.push(cursor.value as ProjectHistoryRecord);
          cursor.continue();
        } else {
          entries.sort((a, b) => a.index - b.index);
          resolve(entries);
        }
      };
      req.onerror = () => reject(mapDOMException(req.error));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    if (entries.length === 0) return;
    const db = await this._connection();
    await new Promise<void>((resolve, reject) => {
      const tx = openTx(db, HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      for (const entry of entries) {
        // Strip the auto-increment `id` to avoid ConstraintError on re-insert
        const { id: _id, ...rest } = entry;
        store.add({ ...rest, projectId });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    const db = await this._connection();
    await new Promise<void>((resolve, reject) => {
      const tx = openTx(db, HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      const index = store.index('projectId');
      const cursorReq = index.openCursor(IDBKeyRange.only(projectId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          for (const entry of entries) {
            const { id: _id, ...rest } = entry;
            store.add({ ...rest, projectId });
          }
        }
      };
      cursorReq.onerror = () => reject(mapDOMException(cursorReq.error));
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async updateEntries(projectId: string, removeIndices: number[], entries: ProjectHistoryRecord[]): Promise<void> {
    if (removeIndices.length === 0 && entries.length === 0) return;
    const db = await this._connection();
    await new Promise<void>((resolve, reject) => {
      const tx = openTx(db, HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      if (removeIndices.length > 0) {
        const remove = new Set(removeIndices);
        const cursorReq = store.index('projectId').openCursor(IDBKeyRange.only(projectId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if (remove.has((cursor.value as ProjectHistoryRecord).index)) cursor.delete();
          cursor.continue();
        };
        cursorReq.onerror = () => reject(mapDOMException(cursorReq.error));
      }
      for (const entry of entries) {
        const { id: _id, ...rest } = entry;
        store.add({ ...rest, projectId });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(txRequestError(e, tx));
      // A quota failure at commit time aborts without an error event.
      tx.onabort = () => reject(txAbortError(tx));
    });
  }

  async deleteForProject(projectId: string): Promise<void> {
    const db = await this._connection();
    await new Promise<void>((resolve, reject) => {
      const tx = openTx(db, HISTORY_STORE, 'readwrite');
      const index = tx.objectStore(HISTORY_STORE).index('projectId');
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
      tx.onerror = e => reject(txRequestError(e, tx));
      tx.onabort = () => reject(txAbortError(tx));
    });
  }
}

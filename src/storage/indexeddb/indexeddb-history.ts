// src/storage/indexeddb/indexeddb-history.ts
import type { ProjectHistoryRecord, ProjectHistoryStore } from '../types.js';
import { mapDOMException } from './error-utils.js';

const HISTORY_STORE = 'project-history';

export class IndexedDBHistoryStore implements ProjectHistoryStore {
  constructor(private _db: IDBDatabase) {}

  async getEntries(projectId: string): Promise<ProjectHistoryRecord[]> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(HISTORY_STORE, 'readonly');
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
    });
  }

  async putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    if (entries.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      for (const entry of entries) {
        // Strip the auto-increment `id` to avoid ConstraintError on re-insert
        const { id: _id, ...rest } = entry;
        store.add({ ...rest, projectId });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(HISTORY_STORE, 'readwrite');
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
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async deleteForProject(projectId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(HISTORY_STORE, 'readwrite');
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
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }
}

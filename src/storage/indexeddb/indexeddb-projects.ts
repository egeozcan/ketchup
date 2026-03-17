// src/storage/indexeddb/indexeddb-projects.ts
import type { BlobRef, ProjectMeta, ProjectStore } from '../types.js';
import { StorageNotFoundError } from '../errors.js';
import { mapDOMException } from './error-utils.js';
import { generateUUID } from './migration.js';

const PROJECTS_STORE = 'projects';

export class IndexedDBProjectStore implements ProjectStore {
  constructor(private _db: IDBDatabase) {}

  async list(
    opts?: { orderBy?: 'updatedAt' | 'createdAt'; direction?: 'asc' | 'desc' },
  ): Promise<ProjectMeta[]> {
    const orderBy = opts?.orderBy ?? 'updatedAt';
    const direction = opts?.direction ?? 'desc';
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(PROJECTS_STORE, 'readonly');
      const store = tx.objectStore(PROJECTS_STORE);
      const entries: ProjectMeta[] = [];
      if (orderBy === 'updatedAt') {
        const index = store.index('updatedAt');
        const req = index.openCursor(null, direction === 'desc' ? 'prev' : 'next');
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            entries.push(cursor.value as ProjectMeta);
            cursor.continue();
          } else {
            resolve(entries);
          }
        };
        req.onerror = () => reject(mapDOMException(req.error));
      } else {
        const req = store.getAll();
        req.onsuccess = () => {
          const all = req.result as ProjectMeta[];
          all.sort((a, b) =>
            direction === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
          );
          resolve(all);
        };
        req.onerror = () => reject(mapDOMException(req.error));
      }
    });
  }

  async get(id: string): Promise<ProjectMeta | null> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(PROJECTS_STORE, 'readonly');
      const req = tx.objectStore(PROJECTS_STORE).get(id);
      req.onsuccess = () => resolve((req.result as ProjectMeta) ?? null);
      req.onerror = () => reject(mapDOMException(req.error));
    });
  }

  async create(
    meta: Omit<ProjectMeta, 'id' | 'createdAt' | 'updatedAt'> & { thumbnailRef?: BlobRef | null },
  ): Promise<ProjectMeta> {
    const now = Date.now();
    const record: ProjectMeta = {
      id: generateUUID(),
      name: meta.name,
      createdAt: now,
      updatedAt: now,
      thumbnailRef: meta.thumbnailRef ?? null,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(PROJECTS_STORE, 'readwrite');
      tx.objectStore(PROJECTS_STORE).add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
    return record;
  }

  async update(
    id: string,
    changes: Partial<Pick<ProjectMeta, 'name' | 'thumbnailRef'>>,
  ): Promise<ProjectMeta> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(PROJECTS_STORE, 'readwrite');
      const store = tx.objectStore(PROJECTS_STORE);
      let updated: ProjectMeta;
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const meta = getReq.result as ProjectMeta | undefined;
        if (!meta) {
          reject(new StorageNotFoundError(`Project ${id} not found`));
          return;
        }
        if (changes.name !== undefined) meta.name = changes.name;
        if (changes.thumbnailRef !== undefined) meta.thumbnailRef = changes.thumbnailRef;
        meta.updatedAt = Date.now();
        updated = meta;
        store.put(meta);
      };
      getReq.onerror = () => reject(mapDOMException(getReq.error));
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async delete(id: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(PROJECTS_STORE, 'readwrite');
      tx.objectStore(PROJECTS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }
}

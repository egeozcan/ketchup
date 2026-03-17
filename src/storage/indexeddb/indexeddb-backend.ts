// src/storage/indexeddb/indexeddb-backend.ts
import type { StorageBackend, BlobStore, ProjectStore, ProjectStateStore, ProjectHistoryStore, StampStore } from '../types.js';
import { IndexedDBBlobStore } from './indexeddb-blobs.js';
import { IndexedDBProjectStore } from './indexeddb-projects.js';
import { IndexedDBStateStore } from './indexeddb-state.js';
import { IndexedDBHistoryStore } from './indexeddb-history.js';
import { IndexedDBStampStore } from './indexeddb-stamps.js';
import { migrateV3toV4 } from './migration.js';

export interface IndexedDBBackendOptions {
  dbName?: string;
  version?: number;
}

const DEFAULT_DB_NAME = 'ketchup-projects';
const DEFAULT_VERSION = 4;

export class IndexedDBBackend implements StorageBackend {
  readonly projects!: ProjectStore;
  readonly state!: ProjectStateStore;
  readonly history!: ProjectHistoryStore;
  readonly stamps!: StampStore;
  readonly blobs!: BlobStore;

  private _db: IDBDatabase | null = null;
  private _dbName: string;
  private _version: number;

  constructor(opts?: IndexedDBBackendOptions) {
    this._dbName = opts?.dbName ?? DEFAULT_DB_NAME;
    this._version = opts?.version ?? DEFAULT_VERSION;
  }

  async init(): Promise<void> {
    // One-time cleanup of legacy stamps database
    const legacyReq = indexedDB.deleteDatabase('ketchup-stamps');
    legacyReq.onerror = () => {};
    legacyReq.onblocked = () => {};

    this._db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this._dbName, this._version);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction!;
        const oldVersion = event.oldVersion;

        // Create stores that don't exist yet (fresh install or partial upgrade)
        if (!db.objectStoreNames.contains('projects')) {
          const store = db.createObjectStore('projects', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('project-state')) {
          db.createObjectStore('project-state', { keyPath: 'projectId' });
        }
        if (!db.objectStoreNames.contains('project-history')) {
          const store = db.createObjectStore('project-history', {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('projectId', 'projectId');
        }
        if (!db.objectStoreNames.contains('project-stamps')) {
          const store = db.createObjectStore('project-stamps', { keyPath: 'id' });
          store.createIndex('projectId', 'projectId');
        }

        // v3→v4: create blobs store and migrate inline blobs
        if (oldVersion < 4 && !db.objectStoreNames.contains('blobs')) {
          migrateV3toV4(db, tx, oldVersion);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Wire sub-stores
    const db = this._db;
    const blobs = new IndexedDBBlobStore(db);
    (this as any).blobs = blobs;
    (this as any).projects = new IndexedDBProjectStore(db);
    (this as any).state = new IndexedDBStateStore(db);
    (this as any).history = new IndexedDBHistoryStore(db);
    (this as any).stamps = new IndexedDBStampStore(db, blobs);
  }

  async dispose(): Promise<void> {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

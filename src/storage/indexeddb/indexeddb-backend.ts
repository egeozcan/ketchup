// src/storage/indexeddb/indexeddb-backend.ts
import type { StorageBackend, BlobStore, ProjectStore, ProjectStateStore, ProjectHistoryStore, StampStore } from '../types.js';
import { StorageError } from '../errors.js';
import { IndexedDBBlobStore } from './indexeddb-blobs.js';
import { IndexedDBProjectStore } from './indexeddb-projects.js';
import { IndexedDBStateStore } from './indexeddb-state.js';
import { IndexedDBHistoryStore } from './indexeddb-history.js';
import { IndexedDBStampStore } from './indexeddb-stamps.js';
import { migrateV3toV4 } from './migration.js';

export interface IndexedDBBackendOptions {
  dbName?: string;
  version?: number;
  /** Called with true while opening waits on another connection, false once it proceeds or fails. */
  onBlocked?: (blocked: boolean) => void;
}

const DEFAULT_DB_NAME = 'ketchup-projects';
// v5 is a format gate, with no schema change from v4: layer and history blobs
// may now be stored as raw RGBA ("KTCH", see utils/canvas-helpers.ts). Builds
// that only know v4 can't decode those (createImageBitmap rejects them), so a
// project fails to load there and they carry on in a stray new project. A
// browser refuses to open a database at a version lower than the one it is at
// (VersionError), so those builds fail to open the database instead.
// Bumping on every upgrade (not only once a raw blob is written) keeps the gate
// independent of what any one session stores. New builds read v1-v4 data as is.
const DEFAULT_VERSION = 5;

export class IndexedDBBackend implements StorageBackend {
  private _projects?: ProjectStore;
  private _state?: ProjectStateStore;
  private _history?: ProjectHistoryStore;
  private _stamps?: StampStore;
  private _blobs?: BlobStore;

  get projects(): ProjectStore {
    if (!this._projects) throw new StorageError('Backend not initialized — call init() first');
    return this._projects;
  }
  get state(): ProjectStateStore {
    if (!this._state) throw new StorageError('Backend not initialized — call init() first');
    return this._state;
  }
  get history(): ProjectHistoryStore {
    if (!this._history) throw new StorageError('Backend not initialized — call init() first');
    return this._history;
  }
  get stamps(): StampStore {
    if (!this._stamps) throw new StorageError('Backend not initialized — call init() first');
    return this._stamps;
  }
  get blobs(): BlobStore {
    if (!this._blobs) throw new StorageError('Backend not initialized — call init() first');
    return this._blobs;
  }

  private _db: IDBDatabase | null = null;
  private _dbName: string;
  private _version: number;
  private _onBlocked?: (blocked: boolean) => void;

  constructor(opts?: IndexedDBBackendOptions) {
    this._dbName = opts?.dbName ?? DEFAULT_DB_NAME;
    this._version = opts?.version ?? DEFAULT_VERSION;
    this._onBlocked = opts?.onBlocked;
  }

  async init(): Promise<void> {
    // Reopened (an editor back in the document): one connection, not two.
    this._db?.close();
    this._db = null;
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
      // Another tab still on an older build (holding v4 open, not closing on
      // versionchange) delays the upgrade until it goes away.
      req.onblocked = () => {
        console.warn('Storage upgrade is waiting for another tab to close');
        this._onBlocked?.(true);
      };
      req.onsuccess = () => { this._onBlocked?.(false); resolve(req.result); };
      req.onerror = () => { this._onBlocked?.(false); reject(req.error); };
    });

    // Let a later upgrade (a newer build in another tab) go ahead.
    const db = this._db;
    db.onversionchange = () => {
      db.close();
      if (this._db === db) this._db = null;
    };

    // Wire sub-stores
    const blobs = new IndexedDBBlobStore(db);
    this._blobs = blobs;
    this._projects = new IndexedDBProjectStore(db);
    this._state = new IndexedDBStateStore(db);
    this._history = new IndexedDBHistoryStore(db);
    this._stamps = new IndexedDBStampStore(db, blobs);
  }

  async dispose(): Promise<void> {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

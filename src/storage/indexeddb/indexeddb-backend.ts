// src/storage/indexeddb/indexeddb-backend.ts
import type { StorageBackend, BlobStore, ProjectStore, ProjectStateStore, ProjectHistoryStore, StampStore } from '../types.js';
import { StorageError, StorageClosedError } from '../errors.js';
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
  /**
   * Called when another window wants to upgrade the database (a newer build).
   * The connection stays open until what it returns settles (at most
   * `VERSION_CHANGE_WAIT`), so work under way can be stored, then closes;
   * calls after that fail with a `StorageClosedError` whose `versionChange` is set.
   */
  onVersionChange?: () => Promise<void> | void;
}

/** How long a version change waits for `onVersionChange` before closing anyway. */
const VERSION_CHANGE_WAIT = 10000;

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
  private _onVersionChange?: () => Promise<void> | void;
  /** The open under way (`init`), which calls made meanwhile wait for. */
  private _opening: Promise<IDBDatabase> | null = null;
  /** Closed for another window's upgrade: only a reload opens it again. */
  private _versionChanged = false;

  constructor(opts?: IndexedDBBackendOptions) {
    this._dbName = opts?.dbName ?? DEFAULT_DB_NAME;
    this._version = opts?.version ?? DEFAULT_VERSION;
    this._onBlocked = opts?.onBlocked;
    this._onVersionChange = opts?.onVersionChange;
  }

  /**
   * How the stores reach the database for each call: the open one, the one
   * being reopened (an editor back in the page), or a typed error once closed.
   */
  private _connection = (): Promise<IDBDatabase> => {
    if (this._db) return Promise.resolve(this._db);
    if (this._opening) return this._opening;
    return Promise.reject(this._closedError());
  };

  private _closedError() {
    return this._versionChanged
      ? new StorageClosedError('Storage was upgraded by another window; reload to use it', true)
      : new StorageClosedError('Storage is closed');
  }

  async init(): Promise<void> {
    // Reopened (an editor back in the document): one connection, not two.
    this._db?.close();
    this._db = null;
    // This build may not read what the newer one that upgraded it writes.
    if (this._versionChanged) throw this._closedError();
    const opening = this._open();
    this._opening = opening;
    try {
      this._db = await opening;
    } finally {
      if (this._opening === opening) this._opening = null;
    }
    const db = this._db;

    // Let a later upgrade (a newer build in another tab) go ahead, once work
    // under way here is stored (`onVersionChange`).
    db.onversionchange = () => {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        db.close();
        if (this._db === db) {
          this._db = null;
          this._versionChanged = true;
        }
      };
      let wait: Promise<void> | void = undefined;
      try {
        wait = this._onVersionChange?.();
      } catch (e) {
        console.error('onVersionChange failed:', e);
      }
      if (!wait) {
        close();
        return;
      }
      const timer = setTimeout(close, VERSION_CHANGE_WAIT);
      void Promise.resolve(wait)
        .catch(e => console.error('onVersionChange failed:', e))
        .then(() => { clearTimeout(timer); close(); });
    };

    // Wired once: they reach the database through `_connection`, so stores
    // held across a close and a reopen keep working.
    if (!this._blobs) {
      const blobs = new IndexedDBBlobStore(this._connection);
      this._blobs = blobs;
      this._projects = new IndexedDBProjectStore(this._connection);
      this._state = new IndexedDBStateStore(this._connection);
      this._history = new IndexedDBHistoryStore(this._connection);
      this._stamps = new IndexedDBStampStore(this._connection, blobs);
    }
  }

  private _open(): Promise<IDBDatabase> {
    // One-time cleanup of legacy stamps database
    const legacyReq = indexedDB.deleteDatabase('ketchup-stamps');
    legacyReq.onerror = () => {};
    legacyReq.onblocked = () => {};

    return new Promise<IDBDatabase>((resolve, reject) => {
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
      // versionchange) delays the upgrade until it goes away; one on this
      // build or later, until it has stored its work (`onVersionChange`).
      req.onblocked = () => {
        console.warn('Storage upgrade is waiting for another tab to close');
        this._onBlocked?.(true);
      };
      req.onsuccess = () => { this._onBlocked?.(false); resolve(req.result); };
      req.onerror = () => { this._onBlocked?.(false); reject(req.error); };
    });
  }

  async dispose(): Promise<void> {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

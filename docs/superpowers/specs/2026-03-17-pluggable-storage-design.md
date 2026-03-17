# Pluggable Storage Layer

## Overview

Detach the storage layer from the ketchup drawing app and make it pluggable. The current IndexedDB-based storage becomes the default adapter. Third-party adapters can implement the `StorageBackend` interface to connect any persistence backend (filesystem, REST API, S3, etc.).

## Key Decisions

- **Plugin architecture** — `StorageBackend` interface with runtime registration via `@lit/context`
- **Grouped sub-interfaces** — `ProjectStore`, `ProjectStateStore`, `ProjectHistoryStore`, `StampStore`, `BlobStore`
- **Opaque `BlobRef`** — branded string type separating metadata from binary payloads
- **Typed error hierarchy** — `StorageError` base class with `StorageQuotaError`, `StorageNetworkError`, `StorageNotFoundError`, `StorageConflictError`, `StorageNotSupportedError`
- **`ProjectService` coordination layer** — owns cascade deletes and mark-and-sweep blob GC
- **Readiness gate** — three-state (`loading` | `ready` | `error`) to handle async init safely in Lit
- **Cursor-based IndexedDB migration** — safe v3→v4 upgrade without OOM or transaction timeout
- **In-memory mock backend** for testing
- **Canvas helpers extracted** to `utils/` — no DOM types in storage layer

## Core Types

### `BlobRef`

Branded string type — opaque to consumers, meaningful only to the adapter that created it. An IndexedDB adapter uses a UUID key; a remote adapter might use an S3 URL. The brand prevents accidental assignment of plain strings.

```ts
type BlobRef = string & { readonly __brand: unique symbol };

function createBlobRef(value: string): BlobRef {
  return value as BlobRef;
}
```

### Error Hierarchy

Defined in `storage/errors.ts` (separate from pure types to avoid bundling runtime code with type-only imports).

```ts
class StorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}
class StorageNotFoundError extends StorageError { name = 'StorageNotFoundError'; }
class StorageQuotaError extends StorageError { name = 'StorageQuotaError'; }
class StorageNetworkError extends StorageError { name = 'StorageNetworkError'; }
class StorageConflictError extends StorageError { name = 'StorageConflictError'; }
class StorageNotSupportedError extends StorageError { name = 'StorageNotSupportedError'; }
```

Every adapter is responsible for catching its native errors and mapping them to the appropriate `Storage*Error`. For example, the IndexedDB adapter catches `DOMException` with name `QuotaExceededError` and throws `StorageQuotaError`.

### `ToolSettings`

```ts
interface ToolSettings {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brushSize: number;
}
```

### `SerializedImageData`

Image pixel data with dimensions, stored as a `BlobRef` instead of an inline `Blob`.

```ts
interface SerializedImageData {
  width: number;
  height: number;
  blobRef: BlobRef;
}
```

### `SerializedLayerSnapshot`

Full layer snapshot used in history entries (add-layer, delete-layer, crop).

```ts
interface SerializedLayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageData: SerializedImageData;
}
```

### `SerializedHistoryEntry`

Discriminated union covering all history operations. Variants that contain pixel data use `SerializedImageData` (which holds `BlobRef`, not `Blob`).

```ts
type SerializedHistoryEntry =
  | { type: 'draw'; layerId: string; before: SerializedImageData; after: SerializedImageData }
  | { type: 'add-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'delete-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string }
  | {
      type: 'crop';
      beforeLayers: SerializedLayerSnapshot[];
      afterLayers: SerializedLayerSnapshot[];
      beforeWidth: number;
      beforeHeight: number;
      afterWidth: number;
      afterHeight: number;
    };
```

Variants without blob data (`reorder`, `visibility`, `opacity`, `rename`) are unchanged from the current types.

### `StorageBackend`

Root interface. Single registration point with grouped sub-objects.

```ts
interface StorageBackend {
  readonly projects: ProjectStore;
  readonly state: ProjectStateStore;
  readonly history: ProjectHistoryStore;
  readonly stamps: StampStore;
  readonly blobs: BlobStore;

  /** Called once before any other method. Opens connections, runs migrations. */
  init(): Promise<void>;

  /** Graceful shutdown. Flush pending writes, close connections. */
  dispose(): Promise<void>;
}
```

## Domain Store Interfaces

### `BlobStore`

```ts
interface BlobStore {
  put(data: Blob | ArrayBuffer): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Blob>;
  delete(ref: BlobRef): Promise<void>;

  /** Delete all blobs not in the active set. Optional — adapters that don't support it throw StorageNotSupportedError. */
  gc?(activeRefs: Set<BlobRef>): Promise<number>;
}
```

### `ProjectStore`

```ts
interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnailRef: BlobRef | null;
}

interface ProjectStore {
  list(opts?: { orderBy?: 'updatedAt' | 'createdAt'; direction?: 'asc' | 'desc' }): Promise<ProjectMeta[]>;
  get(id: string): Promise<ProjectMeta | null>;
  create(meta: Omit<ProjectMeta, 'id' | 'createdAt' | 'updatedAt'>): Promise<ProjectMeta>;
  update(id: string, changes: Partial<Pick<ProjectMeta, 'name' | 'thumbnailRef'>>): Promise<ProjectMeta>;
  delete(id: string): Promise<void>;
}
```

`delete` removes only the project record. Cascade deletion is orchestrated by `ProjectService`.

### `ProjectStateStore`

```ts
interface SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageBlobRef: BlobRef;
}

interface ProjectStateRecord {
  projectId: string;
  toolSettings: ToolSettings;
  canvasWidth: number;
  canvasHeight: number;
  layers: SerializedLayer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
  historyIndex: number;
}

interface ProjectStateStore {
  get(projectId: string): Promise<ProjectStateRecord | null>;
  save(record: ProjectStateRecord): Promise<void>;
  delete(projectId: string): Promise<void>;
}
```

### `ProjectHistoryStore`

```ts
interface ProjectHistoryRecord {
  id?: number;
  projectId: string;
  index: number;
  entry: SerializedHistoryEntry;
}

interface ProjectHistoryStore {
  getEntries(projectId: string): Promise<ProjectHistoryRecord[]>;
  putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void>;
  /** Replace all history for a project (full history rewrite). */
  replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}
```

### `StampStore`

```ts
interface StampEntry {
  id: string;
  projectId: string;
  blobRef: BlobRef;
  createdAt: number;
}

interface StampStore {
  list(projectId: string): Promise<StampEntry[]>;
  add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry>;
  delete(id: string): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}
```

`StampStore.add` accepts raw blob data and internally calls `blobs.put` — callers don't manage blob refs for stamps.

## Service Layer

### `ProjectService`

Coordinates cross-domain operations. Not part of the adapter interface — provided by the library, works with any `StorageBackend`.

```ts
class ProjectService {
  constructor(private storage: StorageBackend) {}

  async deleteProject(projectId: string): Promise<void> {
    // 1. Delete domain records in parallel
    await Promise.all([
      this.storage.state.delete(projectId),
      this.storage.history.deleteForProject(projectId),
      this.storage.stamps.deleteForProject(projectId),
    ]);

    // 2. Delete the root project record
    await this.storage.projects.delete(projectId);

    // 3. Trigger blob GC asynchronously
    this.collectGarbage().catch(console.error);
  }

  /** Mark-and-sweep: collect all live BlobRefs, delete orphans. */
  async collectGarbage(): Promise<number> {
    if (!this.storage.blobs.gc) return 0;

    const projects = await this.storage.projects.list();
    const activeRefs = new Set<BlobRef>();

    await Promise.all(projects.map(async (p) => {
      const [state, history, stamps] = await Promise.all([
        this.storage.state.get(p.id),
        this.storage.history.getEntries(p.id),
        this.storage.stamps.list(p.id),
      ]);
      if (p.thumbnailRef) activeRefs.add(p.thumbnailRef);
      state?.layers.forEach(l => activeRefs.add(l.imageBlobRef));
      history.forEach(h => collectBlobRefsFromEntry(h.entry, activeRefs));
      stamps.forEach(s => activeRefs.add(s.blobRef));
    }));

    return this.storage.blobs.gc(activeRefs);
  }
}
```

### `collectBlobRefsFromEntry`

Walks the discriminated union and extracts all `BlobRef` fields:

```ts
function collectBlobRefsFromEntry(entry: SerializedHistoryEntry, refs: Set<BlobRef>): void {
  switch (entry.type) {
    case 'draw':
      refs.add(entry.before.blobRef);
      refs.add(entry.after.blobRef);
      break;
    case 'add-layer':
    case 'delete-layer':
      refs.add(entry.layer.imageData.blobRef);
      break;
    case 'crop':
      for (const l of entry.beforeLayers) refs.add(l.imageData.blobRef);
      for (const l of entry.afterLayers) refs.add(l.imageData.blobRef);
      break;
    // reorder, visibility, opacity, rename — no blobs
  }
}
```

### Stamp Pruning

Pruning (max 20 stamps per project) is a `ProjectService` responsibility, not an adapter concern. This keeps adapters simple and ensures consistent behavior across backends.

```ts
// In ProjectService:
async addStamp(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
  const entry = await this.storage.stamps.add(projectId, data);
  const all = await this.storage.stamps.list(projectId);
  if (all.length > MAX_STAMPS) {
    // Prune oldest entries beyond limit
    const toDelete = all
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, all.length - MAX_STAMPS);
    for (const old of toDelete) {
      await this.storage.stamps.delete(old.id);
    }
    // Orphaned blobs cleaned up by next GC cycle
  }
  return entry;
}
```

### Why App-Orchestrated Cascade Delete

`ProjectStore.delete` intentionally does not cascade. Reasons:

1. **Domain boundaries** — `ProjectStore` has no knowledge of `HistoryStore` or `StampStore`. Forcing cascade would require cross-store dependencies or reliance on backend-specific magic (e.g., Postgres `ON DELETE CASCADE`) that isn't portable across adapters.

2. **Blob GC** — database cascades can't delete actual binary data behind `BlobRef`s. Only the app knows the total system state needed for safe cleanup.

3. **UI feedback** — app orchestration enables granular progress reporting for large deletions.

### Why Mark-and-Sweep GC

Reference counting requires strict transactional integrity across all stores (increment on save, decrement on delete), which is hard to guarantee across arbitrary adapter implementations. Mark-and-sweep is simpler: scan all live refs, delete everything else. It can run asynchronously without blocking user operations.

## Context Integration

### Context Definitions

```ts
// src/storage/storage-context.ts
import { createContext } from '@lit/context';

export const storageBackendContext = createContext<StorageBackend>('storage-backend');
export const projectServiceContext = createContext<ProjectService>('project-service');
```

### Readiness Gate in `drawing-app.ts`

Lit's `connectedCallback` is synchronous — even marked `async`, the browser calls `render()` before `await backend.init()` resolves. The root component uses a three-state gate:

```ts
@property({ attribute: false })
storageBackend?: StorageBackend;

@state() private _storageState: 'loading' | 'ready' | 'error' = 'loading';
@state() private _storageError?: string;
@state() private _backend?: StorageBackend;
@state() private _projectService?: ProjectService;

async connectedCallback() {
  super.connectedCallback();
  try {
    const backend = this.storageBackend ?? new IndexedDBBackend();
    await backend.init();
    this._backend = backend;
    this._projectService = new ProjectService(backend);
    this._storageState = 'ready';
  } catch (e) {
    this._storageState = 'error';
    this._storageError = e instanceof Error ? e.message : 'Unknown storage error';
  }
}

render() {
  if (this._storageState === 'loading') return html`<loading-screen></loading-screen>`;
  if (this._storageState === 'error') return html`<error-screen .message=${this._storageError}></error-screen>`;
  // Context values derived from this._backend / this._projectService in willUpdate()
  return html`<!-- main app tree, context guaranteed initialized -->`;
}
```

### Three-Context Model

The app now provides three contexts from `drawing-app.ts`:

1. **`drawingContext`** (existing) — `DrawingContextValue` with drawing state, tool settings, layer operations
2. **`storageBackendContext`** (new) — the `StorageBackend` instance
3. **`projectServiceContext`** (new) — the `ProjectService` instance

Components that need storage add a second `ContextConsumer`. For example, `tool-settings.ts`:

```ts
// Existing
private _drawingContext = new ContextConsumer(this, { context: drawingContext, subscribe: true });

// New — for stamp operations
private _storage = new ContextConsumer(this, { context: storageBackendContext, subscribe: true });
```

Stamp thumbnails require an async blob fetch since `StampEntry` now holds a `BlobRef` instead of an inline `Blob`. Components call `backend.blobs.get(entry.blobRef)` to obtain a `Blob` before creating an object URL with `URL.createObjectURL()`.

### Shutdown Lifecycle

`drawing-app.ts` wires `dispose()` in `disconnectedCallback`:

```ts
disconnectedCallback() {
  super.disconnectedCallback();
  // Flush pending debounced saves first (existing logic)
  this._flushPendingSave();
  // Then shut down the backend
  this._backend?.dispose();
}
```

### Component Consumption

- **Default usage** (no config): app creates `IndexedDBBackend` automatically
- **Custom backend**: `<drawing-app .storageBackend=${myRemoteBackend}></drawing-app>`
- **Testing**: provide mock backend in test fixtures
- Components consume storage from context — no direct module imports to store files

Component access:
- `drawing-app.ts` — uses `ProjectService` for project CRUD, cascade delete; uses `StorageBackend` for state save/load and history
- `tool-settings.ts` — consumes `StorageBackend.stamps` and `StorageBackend.blobs` from context (dual context consumer)
- `drawing-canvas.ts` — unchanged (no direct storage access)

## IndexedDB Adapter

### Object Store Mapping

| Sub-interface | Object store | Key |
|---|---|---|
| `ProjectStore` | `projects` | `id` |
| `ProjectStateStore` | `project-state` | `projectId` |
| `ProjectHistoryStore` | `project-history` | auto-increment, indexed by `projectId` |
| `StampStore` | `project-stamps` | `id`, indexed by `projectId` |
| `BlobStore` | `blobs` (new) | `BlobRef` UUID string |

### Configuration

```ts
interface IndexedDBBackendOptions {
  dbName?: string;   // default: 'ketchup-projects'
  version?: number;  // default: 4
}
```

### v3→v4 Migration

The migration extracts inline `Blob` fields into the new `blobs` object store, replacing them with `BlobRef`s. Critical constraints:

**Transaction safety**: IndexedDB upgrade transactions auto-commit if the event loop goes idle for even a microsecond. All migration work must happen within the `onupgradeneeded` transaction using the raw transaction object — not the adapter's own `blobs.put()` facade (DB init hasn't finished).

**Memory safety**: Using `getAll()` to load every project's inline blobs would cause OOM on mobile. Use cursors to process records one at a time.

**Atomicity**: If anything fails (e.g., quota exceeded), the entire upgrade transaction aborts and v3 data remains intact.

Note: The pseudocode below uses `openDB`/`await` syntax for clarity. The current codebase uses raw `indexedDB.open()` — the migration implementation should follow the existing pattern, not introduce a new `idb` dependency.

```ts
upgrade(db, oldVersion, newVersion, transaction) {
  if (oldVersion < 4) {
    const blobStore = db.createObjectStore('blobs');

    // --- 1. Migrate projects (thumbnail: Blob → thumbnailRef: BlobRef) ---
    const projStore = transaction.objectStore('projects');
    let projCursor = await projStore.openCursor();
    while (projCursor) {
      const record = projCursor.value;
      if (record.thumbnail) {
        const ref = crypto.randomUUID();
        blobStore.put(record.thumbnail, ref);
        record.thumbnailRef = ref;
        delete record.thumbnail;
        await projCursor.update(record);
      }
      projCursor = await projCursor.continue();
    }

    // --- 2. Migrate project-state (layer imageBlob → imageBlobRef) ---
    const stateStore = transaction.objectStore('project-state');
    let stateCursor = await stateStore.openCursor();
    while (stateCursor) {
      const record = stateCursor.value;
      let updated = false;
      for (const layer of record.layers) {
        if (layer.imageBlob) {
          const ref = crypto.randomUUID();
          blobStore.put(layer.imageBlob, ref);
          layer.imageBlobRef = ref;
          delete layer.imageBlob;
          updated = true;
        }
      }
      if (updated) await stateCursor.update(record);
      stateCursor = await stateCursor.continue();
    }

    // --- 3. Migrate project-history (nested blobs in SerializedHistoryEntry) ---
    const histStore = transaction.objectStore('project-history');
    let histCursor = await histStore.openCursor();
    while (histCursor) {
      const record = histCursor.value;
      const entry = record.entry;
      let updated = false;

      // Helper: extract blob from SerializedImageData
      function migrateImageData(imgData: any): boolean {
        if (imgData?.blob) {
          const ref = crypto.randomUUID();
          blobStore.put(imgData.blob, ref);
          imgData.blobRef = ref;
          delete imgData.blob;
          return true;
        }
        return false;
      }

      // Helper: extract blob from SerializedLayerSnapshot
      function migrateSnapshot(snapshot: any): boolean {
        return migrateImageData(snapshot?.imageData);
      }

      switch (entry.type) {
        case 'draw':
          if (migrateImageData(entry.before)) updated = true;
          if (migrateImageData(entry.after)) updated = true;
          break;
        case 'add-layer':
        case 'delete-layer':
          if (migrateSnapshot(entry.layer)) updated = true;
          break;
        case 'crop':
          for (const l of entry.beforeLayers) if (migrateSnapshot(l)) updated = true;
          for (const l of entry.afterLayers) if (migrateSnapshot(l)) updated = true;
          break;
        // reorder, visibility, opacity, rename — no blobs
      }

      if (updated) await histCursor.update(record);
      histCursor = await histCursor.continue();
    }

    // --- 4. Migrate project-stamps (blob → blobRef) ---
    const stampStore = transaction.objectStore('project-stamps');
    let stampCursor = await stampStore.openCursor();
    while (stampCursor) {
      const record = stampCursor.value;
      if (record.blob) {
        const ref = crypto.randomUUID();
        blobStore.put(record.blob, ref);
        record.blobRef = ref;
        delete record.blob;
        await stampCursor.update(record);
      }
      stampCursor = await stampCursor.continue();
    }
  }
}
```

### Error Mapping

The adapter catches native `DOMException` errors and maps them:

| `DOMException.name` | Thrown as |
|---|---|
| `QuotaExceededError` | `StorageQuotaError` |
| `NotFoundError` | `StorageNotFoundError` |
| `ConstraintError` | `StorageConflictError` |
| Other | `StorageError` (generic) |

### Atomicity Trade-off

The current monolithic `project-store.ts` deletes a project and all its related data in a single multi-store IndexedDB transaction, providing atomicity. After this refactor, `ProjectService.deleteProject` issues separate calls to each sub-store, which means separate transactions for the IndexedDB adapter. If one fails mid-cascade, the project is in a partially deleted state. This is an accepted trade-off for cross-backend portability — the `ProjectService` pattern works identically whether the adapter is IndexedDB, REST, or filesystem. The IndexedDB adapter could optionally optimize this internally by using a single transaction, but the interface does not require it.

## File Structure

```
src/
  storage/
    types.ts                  # All interfaces, BlobRef type — zero runtime code
    errors.ts                 # StorageError class hierarchy — runtime code
    storage-context.ts        # Lit context definitions
    project-service.ts        # Cross-domain coordination (cascade delete, GC)
    indexeddb/
      indexeddb-backend.ts    # IndexedDBBackend implements StorageBackend
      indexeddb-projects.ts   # ProjectStore implementation
      indexeddb-state.ts      # ProjectStateStore implementation
      indexeddb-history.ts    # ProjectHistoryStore implementation
      indexeddb-stamps.ts     # StampStore implementation
      indexeddb-blobs.ts      # BlobStore implementation
      migration.ts            # v3→v4 cursor-based migration
      index.ts                # re-exports IndexedDBBackend + options type
    testing/
      mock-backend.ts         # In-memory Maps/Arrays implementation
    index.ts                  # barrel export: types, errors, context, service, default backend
  utils/
    canvas-helpers.ts         # canvasToBlob, blobToImageData, serializeLayer, etc.
```

### Exports

The `storage/index.ts` barrel exports:
- All interfaces and types (the contract)
- Error classes
- `BlobRef` type + `createBlobRef` helper
- `ProjectService`
- Context symbols (`storageBackendContext`, `projectServiceContext`)
- `IndexedDBBackend` + `IndexedDBBackendOptions`

Adapter authors import only from the barrel — never reach into `indexeddb/`.

### Adapter Authoring

```ts
import type {
  StorageBackend,
  ProjectStore,
  ProjectStateStore,
  ProjectHistoryStore,
  StampStore,
  BlobStore,
} from 'ketchup/storage';

class MyRemoteBackend implements StorageBackend {
  readonly projects: ProjectStore;
  readonly state: ProjectStateStore;
  readonly history: ProjectHistoryStore;
  readonly stamps: StampStore;
  readonly blobs: BlobStore;

  constructor(config: { endpoint: string; apiKey: string }) {
    this.blobs = new RemoteBlobStore(config);
    this.projects = new RemoteProjectStore(config);
    this.state = new RemoteStateStore(config);
    this.history = new RemoteHistoryStore(config);
    this.stamps = new RemoteStampStore(config, this.blobs);
  }

  async init() { /* auth handshake, health check */ }
  async dispose() { /* close connections */ }
}

// Usage:
const backend = new MyRemoteBackend({ endpoint: 'https://api.example.com', apiKey: '...' });
html`<drawing-app .storageBackend=${backend}></drawing-app>`;
```

## Migration Strategy

### Phase 1: Extract without changing behavior

1. Create `storage/types.ts` and `storage/errors.ts`
2. Move canvas serialization helpers from `project-store.ts` to `utils/canvas-helpers.ts`
3. Decompose `project-store.ts` (535 lines) and `stamp-store.ts` (79 lines) into `storage/indexeddb/` files — same logic, new interface
4. Create `IndexedDBBackend` wiring class
5. Add v3→v4 cursor-based migration

### Phase 2: Wire context and service layer

1. Create `storage-context.ts` with context definitions
2. Create `project-service.ts` with cascade delete and GC
3. Update `drawing-app.ts`:
   - Add `storageBackend` property with `IndexedDBBackend` default
   - Add three-state readiness gate (`loading` | `ready` | `error`)
   - Provide backend and service via context
   - Replace direct store imports with context-consumed backend
   - Catch native `DOMException` errors and throw typed `Storage*Error` classes
4. Update `tool-settings.ts` — consume `StorageBackend.stamps` from context
5. Delete old `project-store.ts` and `stamp-store.ts`

### Phase 3: Testing and mock backend

1. Create `storage/testing/mock-backend.ts`
2. Verify app works identically with `IndexedDBBackend`
3. Verify existing data migrates cleanly (v3→v4)

### What doesn't change

- `drawing-canvas.ts` — no direct storage access
- `layers-panel.ts` — no direct storage access
- Tool system, history capture, composite rendering
- App UX and external behavior

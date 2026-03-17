# Pluggable Storage Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detach the storage layer from the ketchup drawing app, define a pluggable `StorageBackend` TypeScript interface, and re-implement the current IndexedDB persistence as the default adapter behind that interface.

**Architecture:** A `StorageBackend` root interface groups five domain sub-interfaces (`ProjectStore`, `ProjectStateStore`, `ProjectHistoryStore`, `StampStore`, `BlobStore`). Binary data is separated from metadata via opaque `BlobRef` branded strings. A `ProjectService` coordination layer handles cross-domain operations (cascade delete, GC, stamp pruning). The backend is injected into the Lit component tree via `@lit/context`. The current IndexedDB code is decomposed into adapter files implementing the new interface, with a v3→v4 cursor-based migration to extract inline blobs. Canvas↔Blob conversion helpers are extracted to `src/utils/canvas-helpers.ts` to keep DOM types out of the storage layer.

**Tech Stack:** Lit 3, TypeScript 5 (strict), `@lit/context`, IndexedDB (raw API, no wrapper library), Vite 6

**Spec:** `docs/superpowers/specs/2026-03-17-pluggable-storage-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/storage/types.ts` | All storage interfaces, `BlobRef`, `ToolSettings`, serialized types, `createBlobRef` — near-zero runtime (one cast function) | Create |
| `src/storage/errors.ts` | `StorageError` class hierarchy — runtime code | Create |
| `src/storage/storage-context.ts` | Lit context definitions for `storageBackendContext` and `projectServiceContext` | Create |
| `src/storage/project-service.ts` | `ProjectService` — cascade delete, mark-and-sweep GC, stamp pruning, `collectBlobRefsFromEntry` | Create |
| `src/storage/indexeddb/error-utils.ts` | `mapDOMException` — adapter-specific error mapping (keeps `errors.ts` DOM-free) | Create |
| `src/storage/indexeddb/indexeddb-blobs.ts` | `BlobStore` implementation using IndexedDB `blobs` object store | Create |
| `src/storage/indexeddb/indexeddb-projects.ts` | `ProjectStore` implementation using IndexedDB `projects` object store | Create |
| `src/storage/indexeddb/indexeddb-state.ts` | `ProjectStateStore` implementation using IndexedDB `project-state` object store | Create |
| `src/storage/indexeddb/indexeddb-history.ts` | `ProjectHistoryStore` implementation using IndexedDB `project-history` object store | Create |
| `src/storage/indexeddb/indexeddb-stamps.ts` | `StampStore` implementation using IndexedDB `project-stamps` object store | Create |
| `src/storage/indexeddb/migration.ts` | v3→v4 cursor-based migration (extract inline blobs) and UUID helper | Create |
| `src/storage/indexeddb/indexeddb-backend.ts` | `IndexedDBBackend` — wires sub-stores, manages DB connection, runs migration | Create |
| `src/storage/indexeddb/index.ts` | Re-exports `IndexedDBBackend` and `IndexedDBBackendOptions` | Create |
| `src/storage/testing/mock-backend.ts` | In-memory `StorageBackend` for testing | Create |
| `src/storage/index.ts` | Barrel export: types, errors, context, service, default backend | Create |
| `src/utils/canvas-helpers.ts` | `canvasToBlob`, `blobToCanvas`, `imageDataToBlob`, `blobToImageData` — pure canvas↔Blob conversions (no BlobRef dependency) | Create |
| `src/utils/storage-serialization.ts` | BlobRef-aware serialization: `serializeLayer`, `deserializeLayer`, `serializeHistoryEntry`, `deserializeHistoryEntry` — bridges runtime types and storage types via `BlobStore` | Create |
| `src/types.ts` | Remove serialized/storage types (moved to `storage/types.ts`), keep runtime-only types | Modify |
| `src/project-store.ts` | Delete after all consumers migrated | Delete |
| `src/stamp-store.ts` | Delete after all consumers migrated | Delete |
| `src/components/drawing-app.ts` | Readiness gate, storage context provider, save/load/CRUD via new interfaces | Modify |
| `src/components/tool-settings.ts` | Dual context consumer, stamp ops via storage context | Modify |
| `src/contexts/drawing-context.ts` | Remove `ProjectMeta` import (will come from storage types) | Modify |

---

## Chunk 1: Foundation — Types, Errors, Canvas Helpers

### Task 1: Create `src/storage/types.ts`

**Files:**
- Create: `src/storage/types.ts`

- [ ] **Step 1: Create the storage types file**

This file contains all storage interfaces. The only runtime code is the `createBlobRef` cast function (one line). Import `ToolType` from the main types file (it stays there since it's used by runtime drawing code too).

```ts
// src/storage/types.ts
import type { ToolType } from '../types.js';

// ---------------------------------------------------------------------------
// BlobRef — branded string, opaque to consumers
// ---------------------------------------------------------------------------

export type BlobRef = string & { readonly __brand: unique symbol };

export function createBlobRef(value: string): BlobRef {
  return value as BlobRef;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ToolSettings {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brushSize: number;
}

// ---------------------------------------------------------------------------
// Serialized types (use BlobRef, not Blob)
// ---------------------------------------------------------------------------

export interface SerializedImageData {
  width: number;
  height: number;
  blobRef: BlobRef;
}

export interface SerializedLayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageData: SerializedImageData;
}

export type SerializedHistoryEntry =
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

export interface SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageBlobRef: BlobRef;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnailRef: BlobRef | null;
}

export interface ProjectStateRecord {
  projectId: string;
  toolSettings: ToolSettings;
  canvasWidth: number;
  canvasHeight: number;
  layers: SerializedLayer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
  historyIndex: number;
}

export interface ProjectHistoryRecord {
  id?: number;
  projectId: string;
  index: number;
  entry: SerializedHistoryEntry;
}

export interface StampEntry {
  id: string;
  projectId: string;
  blobRef: BlobRef;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface BlobStore {
  put(data: Blob | ArrayBuffer): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Blob>;
  delete(ref: BlobRef): Promise<void>;
  deleteMany(refs: BlobRef[]): Promise<void>;
  gc?(activeRefs: Set<BlobRef>): Promise<number>;
}

export interface ProjectStore {
  list(opts?: { orderBy?: 'updatedAt' | 'createdAt'; direction?: 'asc' | 'desc' }): Promise<ProjectMeta[]>;
  get(id: string): Promise<ProjectMeta | null>;
  create(meta: Omit<ProjectMeta, 'id' | 'createdAt' | 'updatedAt'> & { thumbnailRef?: BlobRef | null }): Promise<ProjectMeta>;
  update(id: string, changes: Partial<Pick<ProjectMeta, 'name' | 'thumbnailRef'>>): Promise<ProjectMeta>;
  delete(id: string): Promise<void>;
}

export interface ProjectStateStore {
  get(projectId: string): Promise<ProjectStateRecord | null>;
  save(record: ProjectStateRecord): Promise<void>;
  delete(projectId: string): Promise<void>;
}

export interface ProjectHistoryStore {
  /** Returns entries sorted by index ascending. */
  getEntries(projectId: string): Promise<ProjectHistoryRecord[]>;
  putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void>;
  replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}

export interface StampStore {
  list(projectId: string): Promise<StampEntry[]>;
  add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry>;
  delete(id: string): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Root interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  readonly projects: ProjectStore;
  readonly state: ProjectStateStore;
  readonly history: ProjectHistoryStore;
  readonly stamps: StampStore;
  readonly blobs: BlobStore;
  init(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProjectServiceOptions {
  maxStampsPerProject?: number;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/storage/types.ts
git commit -m "feat(storage): add pluggable storage type definitions"
```

---

### Task 2: Create `src/storage/errors.ts`

**Files:**
- Create: `src/storage/errors.ts`

- [ ] **Step 1: Create the error hierarchy**

```ts
// src/storage/errors.ts

export class StorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

export class StorageNotFoundError extends StorageError {
  override name = 'StorageNotFoundError';
}

export class StorageQuotaError extends StorageError {
  override name = 'StorageQuotaError';
}

export class StorageNetworkError extends StorageError {
  override name = 'StorageNetworkError';
}

export class StorageConflictError extends StorageError {
  override name = 'StorageConflictError';
}

export class StorageNotSupportedError extends StorageError {
  override name = 'StorageNotSupportedError';
}
```

Note: `mapDOMException` is NOT in this file — it lives in `src/storage/indexeddb/error-utils.ts` because it references `DOMException` (browser-specific). This keeps `errors.ts` portable for non-browser adapter authors.

- [ ] **Step 2a: Create `src/storage/indexeddb/error-utils.ts`**

```ts
// src/storage/indexeddb/error-utils.ts
import {
  StorageError,
  StorageQuotaError,
  StorageNotFoundError,
  StorageConflictError,
} from '../errors.js';

/** Maps a native DOMException to the appropriate StorageError subclass. */
export function mapDOMException(e: unknown): StorageError {
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'QuotaExceededError':
        return new StorageQuotaError(e.message, e);
      case 'NotFoundError':
        return new StorageNotFoundError(e.message, e);
      case 'ConstraintError':
        return new StorageConflictError(e.message, e);
      default:
        return new StorageError(e.message, e);
    }
  }
  if (e instanceof Error) return new StorageError(e.message, e);
  return new StorageError(String(e));
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/storage/errors.ts
git commit -m "feat(storage): add typed error hierarchy with DOMException mapping"
```

---

### Task 3: Create `src/utils/canvas-helpers.ts`

**Files:**
- Create: `src/utils/canvas-helpers.ts`
- Modify: `src/project-store.ts:69-115` (remove moved functions, re-export from new location)

- [ ] **Step 1: Create canvas-helpers with the four pure conversion functions**

Move these from `src/project-store.ts:69-115`. These are pure canvas↔Blob conversions — they do NOT change and have no BlobRef dependency.

```ts
// src/utils/canvas-helpers.ts

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

export async function blobToCanvas(
  blob: Blob,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export async function imageDataToBlob(imageData: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas);
}

export async function blobToImageData(
  blob: Blob,
  width: number,
  height: number,
): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}
```

- [ ] **Step 2: Update `src/project-store.ts` — remove duplicated functions and re-export**

In `src/project-store.ts`, replace lines 65-115 (the four functions and the comment block above them) with:

```ts
// Re-export canvas helpers so existing consumers don't break during migration.
export {
  canvasToBlob,
  blobToCanvas,
  imageDataToBlob,
  blobToImageData,
} from './utils/canvas-helpers.js';
```

The private `serializeImageData` and `deserializeImageDataField` functions (lines 154-166) use `imageDataToBlob` and `blobToImageData` — these will now come from the re-export, so they continue to work. Update their references from local to the re-exported functions (they already reference them by name, so no change needed).

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS (all existing consumers still import from project-store.ts)

- [ ] **Step 4: Commit**

```bash
git add src/utils/canvas-helpers.ts src/project-store.ts
git commit -m "refactor: extract canvas-helpers to src/utils/ (re-exported for compat)"
```

---

### Task 4: Create `src/utils/storage-serialization.ts`

**Files:**
- Create: `src/utils/storage-serialization.ts`

- [ ] **Step 1: Create BlobRef-aware serialization helpers**

These bridge between runtime types (`Layer`, `ImageData`, `HistoryEntry`) and storage types (`SerializedLayer`, `SerializedImageData`, `SerializedHistoryEntry`) via a `BlobStore` parameter. They live in `utils/` alongside `canvas-helpers.ts`.

```ts
// src/utils/storage-serialization.ts
import type { Layer, LayerSnapshot, HistoryEntry } from '../types.js';
import type {
  BlobStore,
  SerializedLayer,
  SerializedImageData,
  SerializedLayerSnapshot,
  SerializedHistoryEntry,
} from '../storage/types.js';
import { canvasToBlob, blobToCanvas, imageDataToBlob, blobToImageData } from './canvas-helpers.js';

// ---------------------------------------------------------------------------
// ImageData ↔ SerializedImageData
// ---------------------------------------------------------------------------

async function serializeImageData(data: ImageData, blobs: BlobStore): Promise<SerializedImageData> {
  const blob = await imageDataToBlob(data);
  const blobRef = await blobs.put(blob);
  return { width: data.width, height: data.height, blobRef };
}

async function deserializeImageData(s: SerializedImageData, blobs: BlobStore): Promise<ImageData> {
  const blob = await blobs.get(s.blobRef);
  return blobToImageData(blob, s.width, s.height);
}

// ---------------------------------------------------------------------------
// LayerSnapshot ↔ SerializedLayerSnapshot
// ---------------------------------------------------------------------------

async function serializeSnapshot(snapshot: LayerSnapshot, blobs: BlobStore): Promise<SerializedLayerSnapshot> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    visible: snapshot.visible,
    opacity: snapshot.opacity,
    imageData: await serializeImageData(snapshot.imageData, blobs),
  };
}

async function deserializeSnapshot(s: SerializedLayerSnapshot, blobs: BlobStore): Promise<LayerSnapshot> {
  return {
    id: s.id,
    name: s.name,
    visible: s.visible,
    opacity: s.opacity,
    imageData: await deserializeImageData(s.imageData, blobs),
  };
}

// ---------------------------------------------------------------------------
// Layer ↔ SerializedLayer
// ---------------------------------------------------------------------------

export async function serializeLayer(layer: Layer, blobs: BlobStore): Promise<SerializedLayer> {
  const blob = await canvasToBlob(layer.canvas);
  const imageBlobRef = await blobs.put(blob);
  return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, imageBlobRef };
}

export async function serializeLayerFromImageData(
  meta: { id: string; name: string; visible: boolean; opacity: number },
  imageData: ImageData,
  blobs: BlobStore,
): Promise<SerializedLayer> {
  const blob = await imageDataToBlob(imageData);
  const imageBlobRef = await blobs.put(blob);
  return { id: meta.id, name: meta.name, visible: meta.visible, opacity: meta.opacity, imageBlobRef };
}

export async function deserializeLayer(
  sl: SerializedLayer,
  width: number,
  height: number,
  blobs: BlobStore,
): Promise<Layer> {
  const blob = await blobs.get(sl.imageBlobRef);
  const canvas = await blobToCanvas(blob, width, height);
  return { id: sl.id, name: sl.name, visible: sl.visible, opacity: sl.opacity, canvas };
}

// ---------------------------------------------------------------------------
// HistoryEntry ↔ SerializedHistoryEntry
// ---------------------------------------------------------------------------

export async function serializeHistoryEntry(
  entry: HistoryEntry,
  blobs: BlobStore,
): Promise<SerializedHistoryEntry> {
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        serializeImageData(entry.before, blobs),
        serializeImageData(entry.after, blobs),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
    }
    case 'add-layer':
      return { type: 'add-layer', layer: await serializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'delete-layer':
      return { type: 'delete-layer', layer: await serializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'crop': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => serializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => serializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'crop', beforeLayers, afterLayers,
        beforeWidth: entry.beforeWidth, beforeHeight: entry.beforeHeight,
        afterWidth: entry.afterWidth, afterHeight: entry.afterHeight,
      };
    }
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      return entry;
  }
}

export async function deserializeHistoryEntry(
  entry: SerializedHistoryEntry,
  blobs: BlobStore,
): Promise<HistoryEntry> {
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        deserializeImageData(entry.before, blobs),
        deserializeImageData(entry.after, blobs),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
    }
    case 'add-layer':
      return { type: 'add-layer', layer: await deserializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'delete-layer':
      return { type: 'delete-layer', layer: await deserializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'crop': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => deserializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => deserializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'crop', beforeLayers, afterLayers,
        beforeWidth: entry.beforeWidth, beforeHeight: entry.beforeHeight,
        afterWidth: entry.afterWidth, afterHeight: entry.afterHeight,
      };
    }
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      return entry;
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/utils/storage-serialization.ts
git commit -m "feat(storage): add BlobRef-aware serialization helpers"
```

---

## Chunk 2: IndexedDB Adapter — Blob Store and Migration

### Task 5: Create UUID helper and migration module

**Files:**
- Create: `src/storage/indexeddb/migration.ts`

- [ ] **Step 1: Create the migration module**

This contains the UUID fallback (for non-secure contexts) and the v3→v4 upgrade function. The upgrade function is called from within `onupgradeneeded` and operates on the raw transaction.

```ts
// src/storage/indexeddb/migration.ts

/**
 * Generate a UUID v4 string. Uses crypto.randomUUID() in secure contexts,
 * falls back to crypto.getRandomValues() otherwise.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Runs inside onupgradeneeded when upgrading from v3 to v4.
 * Extracts inline Blobs from all stores into the new 'blobs' store,
 * replacing them with string BlobRef keys.
 *
 * CRITICAL CONSTRAINTS:
 * - Uses cursors (not getAll) to avoid OOM on mobile
 * - Uses the raw upgrade transaction (not adapter facades)
 * - All awaits keep the transaction alive
 */
export function migrateV3toV4(
  db: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
): void {
  const blobStore = db.createObjectStore('blobs');

  // On fresh install (oldVersion === 0), stores are empty — nothing to migrate.
  if (oldVersion < 1) return;

  // Helper: extract blob from a SerializedImageData-like object
  function migrateImageData(imgData: any): boolean {
    if (imgData?.blob) {
      const ref = generateUUID();
      blobStore.put(imgData.blob, ref);
      imgData.blobRef = ref;
      delete imgData.blob;
      return true;
    }
    return false;
  }

  function migrateSnapshot(snapshot: any): boolean {
    return migrateImageData(snapshot?.imageData);
  }

  // --- 1. Migrate projects (thumbnail → thumbnailRef) ---
  const projStore = transaction.objectStore('projects');
  const projReq = projStore.openCursor();
  projReq.onsuccess = function () {
    const cursor = projReq.result;
    if (!cursor) return;
    const record = cursor.value;
    if (record.thumbnail) {
      const ref = generateUUID();
      blobStore.put(record.thumbnail, ref);
      record.thumbnailRef = ref;
      delete record.thumbnail;
      cursor.update(record);
    }
    cursor.continue();
  };

  // --- 2. Migrate project-state (layer imageBlob → imageBlobRef) ---
  const stateStore = transaction.objectStore('project-state');
  const stateReq = stateStore.openCursor();
  stateReq.onsuccess = function () {
    const cursor = stateReq.result;
    if (!cursor) return;
    const record = cursor.value;
    let updated = false;
    for (const layer of record.layers ?? []) {
      if (layer.imageBlob) {
        const ref = generateUUID();
        blobStore.put(layer.imageBlob, ref);
        layer.imageBlobRef = ref;
        delete layer.imageBlob;
        updated = true;
      }
    }
    if (updated) cursor.update(record);
    cursor.continue();
  };

  // --- 3. Migrate project-history ---
  const histStore = transaction.objectStore('project-history');
  const histReq = histStore.openCursor();
  histReq.onsuccess = function () {
    const cursor = histReq.result;
    if (!cursor) return;
    const record = cursor.value;
    const entry = record.entry;
    let updated = false;

    switch (entry?.type) {
      case 'draw':
        if (migrateImageData(entry.before)) updated = true;
        if (migrateImageData(entry.after)) updated = true;
        break;
      case 'add-layer':
      case 'delete-layer':
        if (migrateSnapshot(entry.layer)) updated = true;
        break;
      case 'crop':
        for (const l of entry.beforeLayers ?? []) if (migrateSnapshot(l)) updated = true;
        for (const l of entry.afterLayers ?? []) if (migrateSnapshot(l)) updated = true;
        break;
    }

    if (updated) cursor.update(record);
    cursor.continue();
  };

  // --- 4. Migrate project-stamps (blob → blobRef) ---
  const stampStore = transaction.objectStore('project-stamps');
  const stampReq = stampStore.openCursor();
  stampReq.onsuccess = function () {
    const cursor = stampReq.result;
    if (!cursor) return;
    const record = cursor.value;
    if (record.blob) {
      const ref = generateUUID();
      blobStore.put(record.blob, ref);
      record.blobRef = ref;
      delete record.blob;
      cursor.update(record);
    }
    cursor.continue();
  };
}
```

Note: This uses raw IDB event callbacks (not async/await) since `onupgradeneeded` runs within a versionchange transaction that must stay alive across all cursor operations. The cursor `.continue()` calls chain via `onsuccess` callbacks, keeping the transaction open.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/storage/indexeddb/migration.ts
git commit -m "feat(storage): add v3→v4 IndexedDB migration with cursor-based blob extraction"
```

---

### Task 6: Create `src/storage/indexeddb/indexeddb-blobs.ts`

**Files:**
- Create: `src/storage/indexeddb/indexeddb-blobs.ts`

- [ ] **Step 1: Implement BlobStore**

```ts
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
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/storage/indexeddb/indexeddb-blobs.ts
git commit -m "feat(storage): implement IndexedDB BlobStore with gc support"
```

---

## Chunk 3: IndexedDB Adapter — Domain Stores

### Task 7: Create `src/storage/indexeddb/indexeddb-projects.ts`

**Files:**
- Create: `src/storage/indexeddb/indexeddb-projects.ts`

- [ ] **Step 1: Implement ProjectStore**

Translate `listProjects`, `createProject`, `deleteProject`, `renameProject` from `src/project-store.ts:293-397` to the new `ProjectStore` interface. Key changes:
- `thumbnail: Blob | null` → `thumbnailRef: BlobRef | null`
- `create()` uses `Omit` signature with optional `thumbnailRef`
- `update()` returns the updated `ProjectMeta`
- `delete()` removes only the project record (no cascade)
- All IDB errors wrapped with `mapDOMException`

```ts
// src/storage/indexeddb/indexeddb-projects.ts
import type { BlobRef, ProjectMeta, ProjectStore } from '../types.js';
import { mapDOMException } from './error-utils.js';
import { StorageNotFoundError } from '../errors.js';
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
      // Only updatedAt has an index; createdAt falls back to full scan + sort
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
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/indexeddb/indexeddb-projects.ts
git commit -m "feat(storage): implement IndexedDB ProjectStore"
```

---

### Task 8: Create `src/storage/indexeddb/indexeddb-state.ts`

**Files:**
- Create: `src/storage/indexeddb/indexeddb-state.ts`

- [ ] **Step 1: Implement ProjectStateStore**

Translate the state read/write from `src/project-store.ts`. The `save` method writes the state record. The `get` method reads it. Simple key-value on `projectId`.

```ts
// src/storage/indexeddb/indexeddb-state.ts
import type { ProjectStateRecord, ProjectStateStore } from '../types.js';
import { mapDOMException } from './error-utils.js';

const STATE_STORE = 'project-state';

export class IndexedDBStateStore implements ProjectStateStore {
  constructor(private _db: IDBDatabase) {}

  async get(projectId: string): Promise<ProjectStateRecord | null> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(STATE_STORE, 'readonly');
      const req = tx.objectStore(STATE_STORE).get(projectId);
      req.onsuccess = () => resolve((req.result as ProjectStateRecord) ?? null);
      req.onerror = () => reject(mapDOMException(req.error));
    });
  }

  async save(record: ProjectStateRecord): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async delete(projectId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }
}
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/indexeddb/indexeddb-state.ts
git commit -m "feat(storage): implement IndexedDB ProjectStateStore"
```

---

### Task 9: Create `src/storage/indexeddb/indexeddb-history.ts`

**Files:**
- Create: `src/storage/indexeddb/indexeddb-history.ts`

- [ ] **Step 1: Implement ProjectHistoryStore**

Translate history read/write/clear from `src/project-store.ts:504-525` (read) and `src/project-store.ts:441-465` (write/clear). Key methods:
- `getEntries` — cursor on `projectId` index, sort by `index` field ascending
- `putEntries` — add records (append)
- `replaceAll` — delete all entries for project via cursor, then add new ones
- `deleteForProject` — cursor delete on `projectId` index

```ts
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
        store.add({ ...entry, projectId });
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
          // All old entries deleted — write new ones
          for (const entry of entries) {
            store.add({ ...entry, projectId });
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
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/indexeddb/indexeddb-history.ts
git commit -m "feat(storage): implement IndexedDB ProjectHistoryStore"
```

---

### Task 10: Create `src/storage/indexeddb/indexeddb-stamps.ts`

**Files:**
- Create: `src/storage/indexeddb/indexeddb-stamps.ts`

- [ ] **Step 1: Implement StampStore**

Translate from `src/stamp-store.ts`. Key difference: `add()` calls `BlobStore.put()` to store the blob separately, then stores the `StampEntry` with a `blobRef`. Pruning is NOT in the adapter — it's in `ProjectService`.

```ts
// src/storage/indexeddb/indexeddb-stamps.ts
import type { BlobStore, StampEntry, StampStore } from '../types.js';
import { createBlobRef } from '../types.js';
import { mapDOMException } from './error-utils.js';
import { generateUUID } from './migration.js';

const STAMPS_STORE = 'project-stamps';

export class IndexedDBStampStore implements StampStore {
  constructor(
    private _db: IDBDatabase,
    private _blobs: BlobStore,
  ) {}

  async list(projectId: string): Promise<StampEntry[]> {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readonly');
      const index = tx.objectStore(STAMPS_STORE).index('projectId');
      const entries: StampEntry[] = [];
      const req = index.openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          entries.push(cursor.value as StampEntry);
          cursor.continue();
        } else {
          entries.sort((a, b) => b.createdAt - a.createdAt);
          resolve(entries);
        }
      };
      req.onerror = () => reject(mapDOMException(req.error));
    });
  }

  async add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
    const blobRef = await this._blobs.put(data);
    const entry: StampEntry = {
      id: generateUUID(),
      projectId,
      blobRef,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      tx.objectStore(STAMPS_STORE).add(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
    return entry;
  }

  async delete(id: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      tx.objectStore(STAMPS_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapDOMException(tx.error));
    });
  }

  async deleteForProject(projectId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = this._db.transaction(STAMPS_STORE, 'readwrite');
      const index = tx.objectStore(STAMPS_STORE).index('projectId');
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
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/indexeddb/indexeddb-stamps.ts
git commit -m "feat(storage): implement IndexedDB StampStore"
```

---

### Task 11: Create IndexedDB backend wiring and barrel exports

**Files:**
- Create: `src/storage/indexeddb/indexeddb-backend.ts`
- Create: `src/storage/indexeddb/index.ts`

- [ ] **Step 1: Create the backend wiring class**

```ts
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
```

- [ ] **Step 2: Create the barrel export**

```ts
// src/storage/indexeddb/index.ts
export { IndexedDBBackend } from './indexeddb-backend.js';
export type { IndexedDBBackendOptions } from './indexeddb-backend.js';
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/indexeddb/
git commit -m "feat(storage): implement IndexedDBBackend wiring class"
```

---

## Chunk 4: Service Layer, Context, and Barrel Export

### Task 12: Create `src/storage/project-service.ts`

**Files:**
- Create: `src/storage/project-service.ts`

- [ ] **Step 1: Implement ProjectService**

Contains: `deleteProject` (project-first cascade), `collectGarbage` (sequential mark-and-sweep), `addStamp` (with configurable pruning), and `collectBlobRefsFromEntry`.

```ts
// src/storage/project-service.ts
import type {
  BlobRef,
  StorageBackend,
  StampEntry,
  SerializedHistoryEntry,
  ProjectServiceOptions,
} from './types.js';

const DEFAULT_MAX_STAMPS = 20;

export class ProjectService {
  private _maxStamps: number;

  constructor(
    private _storage: StorageBackend,
    opts?: ProjectServiceOptions,
  ) {
    this._maxStamps = opts?.maxStampsPerProject ?? DEFAULT_MAX_STAMPS;
  }

  get storage(): StorageBackend {
    return this._storage;
  }

  async deleteProject(projectId: string): Promise<void> {
    // Delete root record first — prevents "zombie" projects on partial failure.
    await this._storage.projects.delete(projectId);

    // Best-effort domain record cleanup. Orphans cleaned by GC.
    await Promise.all([
      this._storage.state.delete(projectId),
      this._storage.history.deleteForProject(projectId),
      this._storage.stamps.deleteForProject(projectId),
    ]).catch((e) => console.error('Cascade delete partial failure:', e));

    this.collectGarbage().catch((e) => console.error('GC failed:', e));
  }

  async addStamp(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
    const entry = await this._storage.stamps.add(projectId, data);
    const all = await this._storage.stamps.list(projectId);
    if (all.length > this._maxStamps) {
      const toDelete = all
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, all.length - this._maxStamps);
      for (const old of toDelete) {
        await this._storage.stamps.delete(old.id);
      }
    }
    return entry;
  }

  /**
   * Mark-and-sweep blob GC. Processes projects sequentially to avoid OOM.
   */
  async collectGarbage(): Promise<number> {
    if (!this._storage.blobs.gc) return 0;

    const projects = await this._storage.projects.list();
    const activeRefs = new Set<BlobRef>();

    for (const p of projects) {
      const [state, history, stamps] = await Promise.all([
        this._storage.state.get(p.id),
        this._storage.history.getEntries(p.id),
        this._storage.stamps.list(p.id),
      ]);
      if (p.thumbnailRef) activeRefs.add(p.thumbnailRef);
      state?.layers.forEach((l) => activeRefs.add(l.imageBlobRef));
      history.forEach((h) => collectBlobRefsFromEntry(h.entry, activeRefs));
      stamps.forEach((s) => activeRefs.add(s.blobRef));

      // Yield to main thread between projects
      await new Promise((r) => setTimeout(r, 0));
    }

    return this._storage.blobs.gc(activeRefs);
  }
}

export function collectBlobRefsFromEntry(
  entry: SerializedHistoryEntry,
  refs: Set<BlobRef>,
): void {
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

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/project-service.ts
git commit -m "feat(storage): implement ProjectService with cascade delete and GC"
```

---

### Task 13: Create `src/storage/storage-context.ts`

**Files:**
- Create: `src/storage/storage-context.ts`

- [ ] **Step 1: Create context definitions**

```ts
// src/storage/storage-context.ts
import { createContext } from '@lit/context';
import type { StorageBackend } from './types.js';
import type { ProjectService } from './project-service.js';

export const storageBackendContext = createContext<StorageBackend>('storage-backend');
export const projectServiceContext = createContext<ProjectService>('project-service');
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/storage-context.ts
git commit -m "feat(storage): add Lit context definitions for storage"
```

---

### Task 14: Create `src/storage/index.ts` barrel export

**Files:**
- Create: `src/storage/index.ts`

- [ ] **Step 1: Create barrel export**

```ts
// src/storage/index.ts

// Types (zero runtime)
export type {
  BlobRef,
  ToolSettings,
  SerializedImageData,
  SerializedLayerSnapshot,
  SerializedHistoryEntry,
  SerializedLayer,
  ProjectMeta,
  ProjectStateRecord,
  ProjectHistoryRecord,
  StampEntry,
  BlobStore,
  ProjectStore,
  ProjectStateStore,
  ProjectHistoryStore,
  StampStore,
  StorageBackend,
  ProjectServiceOptions,
} from './types.js';

export { createBlobRef } from './types.js';

// Errors (runtime)
export {
  StorageError,
  StorageNotFoundError,
  StorageQuotaError,
  StorageNetworkError,
  StorageConflictError,
  StorageNotSupportedError,
} from './errors.js';

// Service
export { ProjectService, collectBlobRefsFromEntry } from './project-service.js';

// Context
export { storageBackendContext, projectServiceContext } from './storage-context.js';

// Default adapter
export { IndexedDBBackend } from './indexeddb/index.js';
export type { IndexedDBBackendOptions } from './indexeddb/index.js';
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/index.ts
git commit -m "feat(storage): add barrel export for storage module"
```

---

## Chunk 5: Wire `drawing-app.ts` to New Storage

This is the largest and most critical chunk. `drawing-app.ts` is the root component that currently imports directly from `project-store.ts`. We need to:
1. Add storage backend property + readiness gate
2. Provide storage contexts
3. Replace all direct store imports with context-based storage
4. Update save/load logic to use new interfaces (BlobRef, split stores)

### Task 15: Add storage imports and readiness gate to `drawing-app.ts`

**Files:**
- Modify: `src/components/drawing-app.ts`

- [ ] **Step 1: Add imports from new storage module**

At the top of `drawing-app.ts`, add imports:

```ts
import { IndexedDBBackend, ProjectService, storageBackendContext, projectServiceContext } from '../storage/index.js';
import type { StorageBackend, ProjectMeta as StorageProjectMeta } from '../storage/index.js';
```

Keep existing `project-store.ts` imports for now — they'll be removed incrementally.

- [ ] **Step 2: Add storage properties and readiness gate**

Add these reactive properties to the `DrawingApp` class:

```ts
@property({ attribute: false })
storageBackend?: StorageBackend;

@state() private _storageState: 'loading' | 'ready' | 'error' = 'loading';
@state() private _storageError?: string;
@state() private _backend?: StorageBackend;
@state() private _projectService?: ProjectService;
```

- [ ] **Step 3: Update `connectedCallback` to init storage before anything else**

Wrap the existing `connectedCallback` body in a storage init block:

```ts
async connectedCallback() {
  super.connectedCallback();
  // Init storage
  try {
    const backend = this.storageBackend ?? new IndexedDBBackend();
    await backend.init();
    this._backend = backend;
    this._projectService = new ProjectService(backend);
    this._storageState = 'ready';
  } catch (e) {
    this._storageState = 'error';
    this._storageError = e instanceof Error ? e.message : 'Unknown storage error';
    return; // Don't wire event listeners if storage failed
  }
  // Existing event listener setup...
  window.addEventListener('keydown', this._onKeyDown);
  window.addEventListener('beforeunload', this._onBeforeUnload);
  document.addEventListener('visibilitychange', this._onVisibilityChange);
}
```

- [ ] **Step 4: Update `disconnectedCallback` to call `dispose()`**

After existing cleanup:

```ts
disconnectedCallback() {
  super.disconnectedCallback();
  window.removeEventListener('keydown', this._onKeyDown);
  window.removeEventListener('beforeunload', this._onBeforeUnload);
  document.removeEventListener('visibilitychange', this._onVisibilityChange);
  this._flushPendingSave();
  this._backend?.dispose();
}
```

- [ ] **Step 5: Gate render on storage readiness**

Wrap the `render()` method:

```ts
render() {
  if (this._storageState === 'loading') {
    return html`<div class="storage-loading">Loading...</div>`;
  }
  if (this._storageState === 'error') {
    return html`<div class="storage-error">
      <p>Failed to initialize storage</p>
      <p>${this._storageError}</p>
    </div>`;
  }
  // ... existing render template ...
}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: PASS (new code added alongside existing, no conflicts yet)

- [ ] **Step 7: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat(storage): add storage backend init and readiness gate to drawing-app"
```

---

### Task 16: Add storage context providers to `drawing-app.ts`

**Files:**
- Modify: `src/components/drawing-app.ts`

- [ ] **Step 1: Add context providers**

Import `ContextProvider` if not already:

```ts
import { ContextProvider } from '@lit/context';
```

Add provider fields to the class:

```ts
private _storageProvider?: ContextProvider<typeof storageBackendContext>;
private _serviceProvider?: ContextProvider<typeof projectServiceContext>;
```

In `connectedCallback`, after storage init succeeds (after `this._storageState = 'ready'`):

```ts
this._storageProvider = new ContextProvider(this, {
  context: storageBackendContext,
  initialValue: this._backend!,
});
this._serviceProvider = new ContextProvider(this, {
  context: projectServiceContext,
  initialValue: this._projectService!,
});
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/components/drawing-app.ts
git commit -m "feat(storage): provide storage contexts from drawing-app"
```

---

### Task 17: Migrate save/load logic in `drawing-app.ts`

**Files:**
- Modify: `src/components/drawing-app.ts`

This is the most complex task. The `_save()` method (lines 184-326) and `_loadProject()` / `firstUpdated()` need to use the new storage interfaces.

Import the serialization helpers from Task 4:

```ts
import {
  serializeLayer, serializeLayerFromImageData, deserializeLayer,
  serializeHistoryEntry, deserializeHistoryEntry,
} from '../utils/storage-serialization.js';
```

These all take a `BlobStore` parameter — pass `this._backend!.blobs`.

- [ ] **Step 1: Update `firstUpdated()` to use new storage**

The existing `firstUpdated()` calls `listProjects()` and `loadProjectState()` directly. Since the readiness gate prevents `render()` (and thus `firstUpdated`) from running until storage is initialized, `this._backend!` is guaranteed available:

```ts
// Replace: const projects = await listProjects();
const projects = await this._backend!.projects.list();

// Replace: const meta = await createProject('Untitled');
const meta = await this._backend!.projects.create({ name: 'Untitled' });
```

- [ ] **Step 2: Update `_save()` to use split store calls**

Replace the single `saveProjectState(...)` call. The new flow serializes entries using the helpers from Task 4, then makes three separate store calls:

```ts
const blobs = this._backend!.blobs;

// Check project still exists (avoid orphaned writes for deleted projects)
const exists = await this._backend!.projects.get(projectId);
if (!exists) return;

// Serialize layers to BlobRef-based format
const serializedLayers = await Promise.all(
  layerSnapshots.map((snap) => serializeLayerFromImageData(snap.meta, snap.imageData, blobs)),
);

// Serialize new history entries
const serializedEntries: ProjectHistoryRecord[] = await Promise.all(
  newHistoryEntries.map(async (entry, i) => ({
    projectId,
    index: startIndex + i,
    entry: await serializeHistoryEntry(entry, blobs),
  })),
);

// Save state
await this._backend!.state.save({ ...stateRecord, layers: serializedLayers });

// Save history (incremental or full rewrite, per existing version-tracking logic)
if (clearExistingHistory) {
  await this._backend!.history.replaceAll(projectId, serializedEntries);
} else if (serializedEntries.length > 0) {
  await this._backend!.history.putEntries(projectId, serializedEntries);
}

// Update project metadata (thumbnail + updatedAt)
if (thumbnail) {
  const thumbRef = await blobs.put(thumbnail);
  await this._backend!.projects.update(projectId, { thumbnailRef: thumbRef });
} else {
  await this._backend!.projects.update(projectId, {});
}
```

- [ ] **Step 3: Update `_loadProject()` to use split store reads**

Replace `loadProjectState(projectId)` with:

```ts
const blobs = this._backend!.blobs;
const stateRecord = await this._backend!.state.get(projectId);
if (!stateRecord) return null;

// Deserialize layers from BlobRef back to HTMLCanvasElement
const layers = await Promise.all(
  stateRecord.layers.map((sl) => deserializeLayer(sl, stateRecord.canvasWidth, stateRecord.canvasHeight, blobs)),
);

// Deserialize history entries
const historyRecords = await this._backend!.history.getEntries(projectId);
const history = await Promise.all(
  historyRecords.map((r) => deserializeHistoryEntry(r.entry, blobs)),
);

return { state: stateRecord, layers, history, historyIndex: stateRecord.historyIndex ?? (history.length - 1) };
```

- [ ] **Step 4: Update project CRUD to use `ProjectService`**

Replace direct calls:
- `createProject(name)` → `this._projectService!.storage.projects.create({ name })`
- `deleteProject(id)` → `this._projectService!.deleteProject(id)` (cascade)
- `renameProject(id, name)` → `this._backend!.projects.update(id, { name })`
- `listProjects()` → `this._backend!.projects.list()`

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat(storage): migrate drawing-app save/load/CRUD to new storage interfaces"
```

---

### Task 18: Remove old storage imports from `drawing-app.ts`

**Files:**
- Modify: `src/components/drawing-app.ts`

- [ ] **Step 1: Remove project-store.ts imports**

Delete the import block:
```ts
import { listProjects, createProject, deleteProject, renameProject, saveProjectState, loadProjectState, canvasToBlob, serializeLayerFromImageData, deserializeLayer } from '../project-store.js';
```

Replace with direct import of canvas helpers:
```ts
import { canvasToBlob, blobToCanvas, imageDataToBlob, blobToImageData } from '../utils/canvas-helpers.js';
```

Import the new storage types needed:
```ts
import type { SerializedLayer, SerializedHistoryEntry, ProjectMeta, ProjectStateRecord, ProjectHistoryRecord } from '../storage/types.js';
```

- [ ] **Step 2: Verify no remaining references to old store**

Run: `npx tsc --noEmit`
Expected: PASS. If errors, fix remaining references.

- [ ] **Step 3: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "refactor: remove project-store imports from drawing-app"
```

---

## Chunk 6: Wire `tool-settings.ts` and Cleanup

### Task 19: Migrate `tool-settings.ts` to context-based storage

**Files:**
- Modify: `src/components/tool-settings.ts`

- [ ] **Step 1: Replace stamp-store imports with context consumer**

Remove:
```ts
import { getRecentStamps, addStamp, deleteStamp, type StampEntry } from '../stamp-store.js';
```

Add:
```ts
import { ContextConsumer } from '@lit/context';
import { storageBackendContext, projectServiceContext } from '../storage/storage-context.js';
import type { StorageBackend, StampEntry } from '../storage/types.js';
import type { ProjectService } from '../storage/project-service.js';
```

Add context consumers:
```ts
private _storageCtx = new ContextConsumer(this, { context: storageBackendContext, subscribe: true });
private _serviceCtx = new ContextConsumer(this, { context: projectServiceContext, subscribe: true });
```

- [ ] **Step 2: Update `_loadStamps()` to use context**

Replace `getRecentStamps(projectId)` with:

```ts
const backend = this._storageCtx.value;
if (!backend) return;
const stamps = await backend.stamps.list(projectId);
```

Update thumbnail URL creation — stamps now have `blobRef` not `blob`. Fetch blobs in parallel for performance:

```ts
// Fetch blobs in parallel — avoid sequential await per stamp
await Promise.all(stamps.map(async (s) => {
  if (!this._thumbUrls.has(s.id)) {
    const blob = await backend.blobs.get(s.blobRef);
    this._thumbUrls.set(s.id, URL.createObjectURL(blob));
  }
}));
```

- [ ] **Step 3: Update `_uploadStamp()` to use ProjectService**

Replace `addStamp(currentProjectId, file)` with:

```ts
const service = this._serviceCtx.value;
if (!service) return;
await service.addStamp(currentProjectId, file);
```

- [ ] **Step 4: Update `_deleteStamp()` to use context**

Replace `deleteStamp(entry.id)` with:

```ts
const backend = this._storageCtx.value;
if (!backend) return;
await backend.stamps.delete(entry.id);
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/components/tool-settings.ts
git commit -m "feat(storage): migrate tool-settings stamps to context-based storage"
```

---

### Task 20: Update `src/types.ts` — remove migrated types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/contexts/drawing-context.ts`

- [ ] **Step 1: Remove serialized/storage types from `src/types.ts`**

Remove these from `src/types.ts` (they now live in `src/storage/types.ts`):
- `ProjectMeta` interface (lines 79-85)
- `SerializedImageData` interface (lines 87-91)
- `SerializedHistoryEntry` type (lines 93-109)
- `SerializedLayerSnapshot` interface (lines 111-117)
- `SerializedLayer` interface (lines 119-125)
- `ProjectStateRecord` interface (lines 127-142)
- `ProjectHistoryRecord` interface (lines 144-149)

Keep these runtime types that use DOM APIs:
- `ToolType`, `Point`, `FloatingSelection`, `Layer`, `LayerSnapshot`, `DrawingState`, `HistoryEntry`

- [ ] **Step 2: Update `src/contexts/drawing-context.ts`**

Change the `ProjectMeta` import to come from storage types:

```ts
import type { ProjectMeta } from '../storage/types.js';
```

- [ ] **Step 3: Fix any other files that imported removed types from `src/types.ts`**

Search for imports of the removed type names from `'../types.js'` or `'./types.js'` and redirect to `'../storage/types.js'` or `'../storage/index.js'`.

The main files are:
- `src/project-store.ts` — will be deleted next task, skip
- `src/components/drawing-app.ts` — already updated in Task 17

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/types.ts src/contexts/drawing-context.ts
git commit -m "refactor: move serialized types to storage/types.ts, keep runtime types in src/types.ts"
```

---

### Task 21: Delete old storage files

**Files:**
- Delete: `src/project-store.ts`
- Delete: `src/stamp-store.ts`

- [ ] **Step 1: Verify no remaining imports**

Search for any file still importing from `project-store.js` or `stamp-store.js`:

Run: `grep -r "project-store\|stamp-store" src/ --include="*.ts" -l`

If any files still import from these, fix them first.

- [ ] **Step 2: Delete the old files**

```bash
git rm src/project-store.ts src/stamp-store.ts
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git commit -m "refactor: delete old project-store.ts and stamp-store.ts"
```

---

## Chunk 7: Mock Backend and Final Verification

### Task 22: Create `src/storage/testing/mock-backend.ts`

**Files:**
- Create: `src/storage/testing/mock-backend.ts`

- [ ] **Step 1: Implement in-memory MockBackend**

```ts
// src/storage/testing/mock-backend.ts
import type {
  StorageBackend,
  ProjectStore,
  ProjectStateStore,
  ProjectHistoryStore,
  StampStore,
  BlobStore,
  BlobRef,
  ProjectMeta,
  ProjectStateRecord,
  ProjectHistoryRecord,
  StampEntry,
} from '../types.js';
import { createBlobRef } from '../types.js';
import { StorageNotFoundError } from '../errors.js';

let counter = 0;
function mockUUID(): string {
  return `mock-${++counter}`;
}

class MockBlobStore implements BlobStore {
  private _blobs = new Map<string, Blob>();

  async put(data: Blob | ArrayBuffer): Promise<BlobRef> {
    const ref = createBlobRef(mockUUID());
    this._blobs.set(ref, data instanceof Blob ? data : new Blob([data]));
    return ref;
  }

  async get(ref: BlobRef): Promise<Blob> {
    const blob = this._blobs.get(ref);
    if (!blob) throw new StorageNotFoundError(`Blob ${ref} not found`);
    return blob;
  }

  async delete(ref: BlobRef): Promise<void> {
    this._blobs.delete(ref);
  }

  async deleteMany(refs: BlobRef[]): Promise<void> {
    for (const ref of refs) this._blobs.delete(ref);
  }

  async gc(activeRefs: Set<BlobRef>): Promise<number> {
    let deleted = 0;
    for (const key of this._blobs.keys()) {
      if (!activeRefs.has(key as BlobRef)) {
        this._blobs.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

class MockProjectStore implements ProjectStore {
  private _projects = new Map<string, ProjectMeta>();

  async list(opts?: { orderBy?: 'updatedAt' | 'createdAt'; direction?: 'asc' | 'desc' }): Promise<ProjectMeta[]> {
    const all = Array.from(this._projects.values());
    const field = opts?.orderBy ?? 'updatedAt';
    const dir = opts?.direction === 'asc' ? 1 : -1;
    all.sort((a, b) => dir * (a[field] - b[field]));
    return all;
  }

  async get(id: string): Promise<ProjectMeta | null> {
    return this._projects.get(id) ?? null;
  }

  async create(meta: any): Promise<ProjectMeta> {
    const now = Date.now();
    const record: ProjectMeta = {
      id: mockUUID(),
      name: meta.name,
      createdAt: now,
      updatedAt: now,
      thumbnailRef: meta.thumbnailRef ?? null,
    };
    this._projects.set(record.id, record);
    return record;
  }

  async update(id: string, changes: any): Promise<ProjectMeta> {
    const meta = this._projects.get(id);
    if (!meta) throw new StorageNotFoundError(`Project ${id}`);
    if (changes.name !== undefined) meta.name = changes.name;
    if (changes.thumbnailRef !== undefined) meta.thumbnailRef = changes.thumbnailRef;
    meta.updatedAt = Date.now();
    return meta;
  }

  async delete(id: string): Promise<void> {
    this._projects.delete(id);
  }
}

class MockStateStore implements ProjectStateStore {
  private _states = new Map<string, ProjectStateRecord>();

  async get(projectId: string): Promise<ProjectStateRecord | null> {
    return this._states.get(projectId) ?? null;
  }
  async save(record: ProjectStateRecord): Promise<void> {
    this._states.set(record.projectId, record);
  }
  async delete(projectId: string): Promise<void> {
    this._states.delete(projectId);
  }
}

class MockHistoryStore implements ProjectHistoryStore {
  private _entries = new Map<string, ProjectHistoryRecord[]>();

  async getEntries(projectId: string): Promise<ProjectHistoryRecord[]> {
    return [...(this._entries.get(projectId) ?? [])].sort((a, b) => a.index - b.index);
  }
  async putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    const existing = this._entries.get(projectId) ?? [];
    this._entries.set(projectId, [...existing, ...entries]);
  }
  async replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    this._entries.set(projectId, [...entries]);
  }
  async deleteForProject(projectId: string): Promise<void> {
    this._entries.delete(projectId);
  }
}

class MockStampStore implements StampStore {
  private _stamps = new Map<string, StampEntry>();
  constructor(private _blobs: BlobStore) {}

  async list(projectId: string): Promise<StampEntry[]> {
    return Array.from(this._stamps.values())
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
    const blobRef = await this._blobs.put(data);
    const entry: StampEntry = { id: mockUUID(), projectId, blobRef, createdAt: Date.now() };
    this._stamps.set(entry.id, entry);
    return entry;
  }
  async delete(id: string): Promise<void> {
    this._stamps.delete(id);
  }
  async deleteForProject(projectId: string): Promise<void> {
    for (const [id, s] of this._stamps) {
      if (s.projectId === projectId) this._stamps.delete(id);
    }
  }
}

export class MockBackend implements StorageBackend {
  readonly blobs: BlobStore;
  readonly projects: ProjectStore;
  readonly state: ProjectStateStore;
  readonly history: ProjectHistoryStore;
  readonly stamps: StampStore;

  constructor() {
    this.blobs = new MockBlobStore();
    this.projects = new MockProjectStore();
    this.state = new MockStateStore();
    this.history = new MockHistoryStore();
    this.stamps = new MockStampStore(this.blobs);
  }

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}
}
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/storage/testing/mock-backend.ts
git commit -m "feat(storage): add in-memory MockBackend for testing"
```

---

### Task 23: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Type-check the entire project**

Run: `npx tsc --noEmit`
Expected: PASS — zero errors

- [ ] **Step 2: Build the project**

Run: `npm run build`
Expected: PASS — Vite builds successfully

- [ ] **Step 3: Manual smoke test**

Open the dev server (`npm run dev`) and verify:
1. App loads without errors (readiness gate works)
2. Create a new project — name appears in project list
3. Draw something — auto-save works (check console for errors)
4. Switch between projects — state loads correctly
5. Upload a stamp image — stamp appears in toolbar
6. Delete a project — project disappears, no crashes
7. Undo/redo works across save/load cycles
8. Refresh page — all data persists

- [ ] **Step 4: Check IndexedDB migration**

Open DevTools → Application → IndexedDB → `ketchup-projects`:
- Version should be 4
- `blobs` object store should exist
- If upgrading from existing data, verify blobs are populated and inline blob fields are removed from other stores

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address final verification issues"
```

---

## Dependency Graph

```
Task 1 (types) ──┬── Task 5 (migration) ── Task 6 (blobs) ──┐
Task 2 (errors) ─┤                                           │
                 ├── Task 7 (projects)                       │
                 ├── Task 8 (state)                          ├── Task 11 (backend)
                 ├── Task 9 (history)                        │
                 └── Task 10 (stamps) ───────────────────────┘
                                                             │
Task 3 (canvas-helpers) ── Task 4 (serialization) ──────────┤
                                                             │
Task 11 (backend) ── Task 12 (service) ── Task 13 (context) ┤
                                                             │
Task 14 (barrel) ───────────────────────────────────────────┤
                                                             │
Task 15 (app init) ── Task 16 (app context) ────────────────┤
                                                             │
Task 17 (app save/load) ── Task 18 (app cleanup) ──────────┤
                                                             │
Task 19 (tool-settings) ───────────────────────────────────┤
                                                             │
Task 20 (types split) ── Task 21 (delete old files) ───────┤
                                                             │
Task 22 (mock) ── Task 23 (verify) ────────────────────────┘
```

**Parallelizable groups:**
- Tasks 6-10 can run in parallel after Tasks 1, 2, and 5 (independent IndexedDB sub-store files)
- Tasks 3-4 are independent of 5-10 (different utility files)
- Tasks 15-18 must be sequential (each builds on the previous)
- Task 19 can run in parallel with Tasks 15-18 (different file)

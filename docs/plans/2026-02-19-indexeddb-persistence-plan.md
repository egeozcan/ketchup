# IndexedDB Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist the full drawing app state (layers, tool settings, undo history) to IndexedDB with multiple project support, so nothing is lost on reload.

**Architecture:** Hybrid chunked storage — current state (layers + settings) as one record per project, history entries stored individually. Debounced auto-save after every action. Project management via dropdown in the top settings bar.

**Tech Stack:** Lit 3, TypeScript 5, IndexedDB, `@lit/context`

---

### Task 1: Add persistence types to `types.ts`

**Files:**
- Modify: `src/types.ts`

**Step 1: Add the new types**

Add these types after the existing `HistoryEntry` type:

```typescript
export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnail: Blob | null;
}

export interface SerializedImageData {
  width: number;
  height: number;
  blob: Blob;
}

export type SerializedHistoryEntry =
  | { type: 'draw'; layerId: string; before: SerializedImageData; after: SerializedImageData }
  | { type: 'add-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'delete-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string };

export interface SerializedLayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageData: SerializedImageData;
}

export interface SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageBlob: Blob;
}

export interface ProjectStateRecord {
  projectId: string;
  toolSettings: {
    activeTool: ToolType;
    strokeColor: string;
    fillColor: string;
    useFill: boolean;
    brushSize: number;
  };
  canvasWidth: number;
  canvasHeight: number;
  layers: SerializedLayer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
}

export interface ProjectHistoryRecord {
  id?: number;
  projectId: string;
  index: number;
  entry: SerializedHistoryEntry;
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add persistence types for IndexedDB project storage"
```

---

### Task 2: Create `project-store.ts` — serialization helpers

**Files:**
- Create: `src/project-store.ts`

**Step 1: Write serialization helpers and DB setup**

Create `src/project-store.ts` with:

```typescript
import type {
  ProjectMeta,
  ProjectStateRecord,
  ProjectHistoryRecord,
  SerializedLayer,
  SerializedImageData,
  SerializedHistoryEntry,
  SerializedLayerSnapshot,
  HistoryEntry,
  Layer,
  LayerSnapshot,
} from './types.js';

const DB_NAME = 'ketchup-projects';
const DB_VERSION = 1;
const PROJECTS_STORE = 'projects';
const STATE_STORE = 'project-state';
const HISTORY_STORE = 'project-history';

let cachedDB: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (cachedDB) return cachedDB;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        const store = db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const hStore = db.createObjectStore(HISTORY_STORE, { keyPath: 'id', autoIncrement: true });
        hStore.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => {
      cachedDB = req.result;
      resolve(cachedDB);
    };
    req.onerror = () => reject(req.error);
  });
}

// --- Serialization helpers ---

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

export async function blobToCanvas(blob: Blob, width: number, height: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export function imageDataToBlob(imageData: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')!.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas);
}

export async function blobToImageData(blob: Blob, width: number, height: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.getContext('2d')!.getImageData(0, 0, width, height);
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/project-store.ts
git commit -m "feat: add project-store with serialization helpers and DB setup"
```

---

### Task 3: Add CRUD operations to `project-store.ts`

**Files:**
- Modify: `src/project-store.ts`

**Step 1: Add layer and history serialization functions**

Append to `src/project-store.ts`:

```typescript
export async function serializeLayer(layer: Layer): Promise<SerializedLayer> {
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    imageBlob: await canvasToBlob(layer.canvas),
  };
}

export async function deserializeLayer(sl: SerializedLayer, width: number, height: number): Promise<Layer> {
  return {
    id: sl.id,
    name: sl.name,
    visible: sl.visible,
    opacity: sl.opacity,
    canvas: await blobToCanvas(sl.imageBlob, width, height),
  };
}

async function serializeLayerSnapshot(snapshot: LayerSnapshot): Promise<SerializedLayerSnapshot> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    visible: snapshot.visible,
    opacity: snapshot.opacity,
    imageData: {
      width: snapshot.imageData.width,
      height: snapshot.imageData.height,
      blob: await imageDataToBlob(snapshot.imageData),
    },
  };
}

async function deserializeLayerSnapshot(s: SerializedLayerSnapshot): Promise<LayerSnapshot> {
  return {
    id: s.id,
    name: s.name,
    visible: s.visible,
    opacity: s.opacity,
    imageData: await blobToImageData(s.imageData.blob, s.imageData.width, s.imageData.height),
  };
}

async function serializeImageData(id: ImageData): Promise<SerializedImageData> {
  return { width: id.width, height: id.height, blob: await imageDataToBlob(id) };
}

async function deserializeImageDataField(s: SerializedImageData): Promise<ImageData> {
  return blobToImageData(s.blob, s.width, s.height);
}

export async function serializeHistoryEntry(entry: HistoryEntry): Promise<SerializedHistoryEntry> {
  switch (entry.type) {
    case 'draw':
      return {
        type: 'draw',
        layerId: entry.layerId,
        before: await serializeImageData(entry.before),
        after: await serializeImageData(entry.after),
      };
    case 'add-layer':
      return {
        type: 'add-layer',
        layer: await serializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    case 'delete-layer':
      return {
        type: 'delete-layer',
        layer: await serializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    default:
      // reorder, visibility, opacity, rename — no ImageData, pass through
      return entry as SerializedHistoryEntry;
  }
}

export async function deserializeHistoryEntry(entry: SerializedHistoryEntry): Promise<HistoryEntry> {
  switch (entry.type) {
    case 'draw':
      return {
        type: 'draw',
        layerId: entry.layerId,
        before: await deserializeImageDataField(entry.before),
        after: await deserializeImageDataField(entry.after),
      };
    case 'add-layer':
      return {
        type: 'add-layer',
        layer: await deserializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    case 'delete-layer':
      return {
        type: 'delete-layer',
        layer: await deserializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    default:
      return entry as HistoryEntry;
  }
}
```

**Step 2: Add the CRUD operations**

Append to `src/project-store.ts`:

```typescript
// --- CRUD operations ---

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readonly');
    const index = tx.objectStore(PROJECTS_STORE).index('updatedAt');
    const results: ProjectMeta[] = [];
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(cursor.value as ProjectMeta);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const meta: ProjectMeta = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    thumbnail: null,
  };
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    tx.objectStore(PROJECTS_STORE).add(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return meta;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  // Delete from all three stores
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PROJECTS_STORE, STATE_STORE, HISTORY_STORE], 'readwrite');
    tx.objectStore(PROJECTS_STORE).delete(id);
    tx.objectStore(STATE_STORE).delete(id);
    // Delete all history entries for this project via cursor
    const hStore = tx.objectStore(HISTORY_STORE);
    const index = hStore.index('projectId');
    const req = index.openCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    const store = tx.objectStore(PROJECTS_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const meta = req.result as ProjectMeta;
      if (meta) {
        meta.name = name;
        meta.updatedAt = Date.now();
        store.put(meta);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveProjectState(
  projectId: string,
  state: ProjectStateRecord,
  newHistoryEntries: HistoryEntry[],
  historyIndex: number,
  thumbnail: Blob | null,
): Promise<void> {
  // Serialize layers
  const serializedLayers: SerializedLayer[] = await Promise.all(
    state.layers.map(sl => Promise.resolve(sl)),
  );

  const record: ProjectStateRecord = {
    ...state,
    projectId,
    layers: serializedLayers,
  };

  const db = await openDB();

  // Write state
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, 'readwrite');
    tx.objectStore(STATE_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // Write new history entries
  if (newHistoryEntries.length > 0) {
    const serializedEntries = await Promise.all(
      newHistoryEntries.map((e, i) =>
        serializeHistoryEntry(e).then(se => ({
          projectId,
          index: historyIndex - newHistoryEntries.length + 1 + i,
          entry: se,
        })),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      for (const rec of serializedEntries) {
        store.add(rec);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Update project metadata
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    const store = tx.objectStore(PROJECTS_STORE);
    const req = store.get(projectId);
    req.onsuccess = () => {
      const meta = req.result as ProjectMeta;
      if (meta) {
        meta.updatedAt = Date.now();
        meta.thumbnail = thumbnail;
        store.put(meta);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProjectState(
  projectId: string,
): Promise<{ state: ProjectStateRecord; history: HistoryEntry[]; historyIndex: number } | null> {
  const db = await openDB();

  // Load state record
  const stateRecord = await new Promise<ProjectStateRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STATE_STORE, 'readonly');
    const req = tx.objectStore(STATE_STORE).get(projectId);
    req.onsuccess = () => resolve(req.result as ProjectStateRecord | undefined);
    req.onerror = () => reject(req.error);
  });

  if (!stateRecord) return null;

  // Load history records
  const historyRecords = await new Promise<ProjectHistoryRecord[]>((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readonly');
    const index = tx.objectStore(HISTORY_STORE).index('projectId');
    const results: ProjectHistoryRecord[] = [];
    const req = index.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        results.push(cursor.value as ProjectHistoryRecord);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });

  // Sort by index and deserialize
  historyRecords.sort((a, b) => a.index - b.index);
  const history = await Promise.all(historyRecords.map(r => deserializeHistoryEntry(r.entry)));

  return {
    state: stateRecord,
    history,
    historyIndex: history.length - 1,
  };
}

export async function clearProjectHistory(projectId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    const index = tx.objectStore(HISTORY_STORE).index('projectId');
    const req = index.openCursor(IDBKeyRange.only(projectId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/project-store.ts
git commit -m "feat: add CRUD operations and serialization to project-store"
```

---

### Task 4: Expose history from `drawing-canvas.ts`

The history array and index are private in `drawing-canvas.ts`. We need public accessors so `drawing-app.ts` can serialize and restore them.

**Files:**
- Modify: `src/components/drawing-canvas.ts`

**Step 1: Add public history accessors**

Add these public methods to the `DrawingCanvas` class, after the existing `_maxHistory` property (around line 188):

```typescript
// --- Public history access for persistence ---
public getHistory(): HistoryEntry[] { return this._history; }
public getHistoryIndex(): number { return this._historyIndex; }
public setHistory(entries: HistoryEntry[], index: number) {
  this._history = entries;
  this._historyIndex = index;
  this._notifyHistory();
}
```

**Step 2: Add method to skip first-layer white fill when loading a project**

In `firstUpdated()`, we currently always paint the first layer white. When loading a saved project, this would overwrite the loaded content. Add a flag:

Add a private property:
```typescript
private _skipInitialFill = false;
```

Add a public method:
```typescript
public setSkipInitialFill() { this._skipInitialFill = true; }
```

Modify `firstUpdated()` to check the flag:
```typescript
override firstUpdated() {
  this._resizeToFit();
  this._resizeObserver = new ResizeObserver(() => this._resizeToFit());
  this._resizeObserver.observe(this);
  if (!this._skipInitialFill) {
    const layerCtx = this._getActiveLayerCtx();
    if (layerCtx) {
      layerCtx.fillStyle = '#ffffff';
      layerCtx.fillRect(0, 0, this._width, this._height);
    }
  }
  this.composite();
}
```

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: expose history accessors and skip-initial-fill on drawing-canvas"
```

---

### Task 5: Extend context with project operations

**Files:**
- Modify: `src/contexts/drawing-context.ts`

**Step 1: Add project fields and operations to the context interface**

```typescript
import type { DrawingState, ToolType, ProjectMeta } from '../types.js';

export interface DrawingContextValue {
  state: DrawingState;
  // ... existing fields stay the same ...
  // Project operations
  currentProject: ProjectMeta | null;
  projectList: ProjectMeta[];
  saving: boolean;
  switchProject: (id: string) => void;
  createProject: (name: string) => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: Errors in `drawing-app.ts` because `_buildContextValue` doesn't return the new fields yet — this is expected and will be fixed in the next task.

**Step 3: Commit**

```bash
git add src/contexts/drawing-context.ts
git commit -m "feat: extend drawing context with project operations and saving state"
```

---

### Task 6: Wire persistence into `drawing-app.ts`

This is the largest task. It integrates project-store with the root component.

**Files:**
- Modify: `src/components/drawing-app.ts`

**Step 1: Add imports and state fields**

At the top, add imports:
```typescript
import type { DrawingState, Layer, LayerSnapshot, ToolType, ProjectMeta, HistoryEntry } from '../types.js';
import {
  listProjects,
  createProject as createProjectInDB,
  deleteProject as deleteProjectInDB,
  renameProject as renameProjectInDB,
  saveProjectState,
  loadProjectState,
  clearProjectHistory,
  canvasToBlob,
  serializeLayer,
  deserializeLayer,
} from '../project-store.js';
```

Add new state fields to the class:
```typescript
@state() private _saving = false;
@state() private _currentProject: ProjectMeta | null = null;
@state() private _projectList: ProjectMeta[] = [];
private _dirty = false;
private _saveTimer: ReturnType<typeof setTimeout> | null = null;
private _lastSavedHistoryLength = 0;
```

**Step 2: Add `beforeunload` handler**

In `connectedCallback()`, add:
```typescript
window.addEventListener('beforeunload', this._onBeforeUnload);
```

In `disconnectedCallback()`, add:
```typescript
window.removeEventListener('beforeunload', this._onBeforeUnload);
```

Add the handler:
```typescript
private _onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (this._dirty) {
    e.preventDefault();
  }
};
```

**Step 3: Add dirty-marking and debounced save**

Add a `_markDirty()` method that's called from every state mutation:
```typescript
private _markDirty() {
  this._dirty = true;
  if (this._saveTimer) clearTimeout(this._saveTimer);
  this._saveTimer = setTimeout(() => this._save(), 500);
}
```

Add the `_save()` method:
```typescript
private async _save() {
  if (!this._currentProject) return;
  this._saving = true;

  try {
    const layers = await Promise.all(
      this._state.layers.map(l => serializeLayer(l)),
    );

    const stateRecord = {
      projectId: this._currentProject.id,
      toolSettings: {
        activeTool: this._state.activeTool,
        strokeColor: this._state.strokeColor,
        fillColor: this._state.fillColor,
        useFill: this._state.useFill,
        brushSize: this._state.brushSize,
      },
      canvasWidth: this.canvas?.getWidth() ?? 800,
      canvasHeight: this.canvas?.getHeight() ?? 600,
      layers,
      activeLayerId: this._state.activeLayerId,
      layersPanelOpen: this._state.layersPanelOpen,
    };

    // Get new history entries since last save
    const allHistory = this.canvas?.getHistory() ?? [];
    const historyIndex = this.canvas?.getHistoryIndex() ?? -1;
    const newEntries = allHistory.slice(this._lastSavedHistoryLength);

    // Generate thumbnail from composited canvas
    let thumbnail: Blob | null = null;
    if (this.canvas?.mainCanvas) {
      try {
        thumbnail = await canvasToBlob(this.canvas.mainCanvas);
      } catch {
        // Non-critical, continue without thumbnail
      }
    }

    await saveProjectState(
      this._currentProject.id,
      stateRecord,
      newEntries,
      historyIndex,
      thumbnail,
    );
    this._lastSavedHistoryLength = allHistory.length;
    this._dirty = false;
    this._projectList = await listProjects();
  } catch (err) {
    console.error('Save failed:', err);
  } finally {
    this._saving = false;
  }
}
```

**Step 4: Add project load method**

```typescript
private async _loadProject(projectId: string) {
  const result = await loadProjectState(projectId);
  if (!result) return;

  const { state: record, history, historyIndex } = result;

  // Tell canvas to skip white fill
  this.canvas?.setSkipInitialFill();

  // Deserialize layers
  const layers: Layer[] = await Promise.all(
    record.layers.map(sl => deserializeLayer(sl, record.canvasWidth, record.canvasHeight)),
  );

  // Restore layer counter to max existing layer number
  const maxNum = layers.reduce((max, l) => {
    const match = l.name.match(/^Layer (\d+)$/);
    return match ? Math.max(max, parseInt(match[1])) : max;
  }, 0);
  _layerCounter = maxNum;

  this._state = {
    activeTool: record.toolSettings.activeTool,
    strokeColor: record.toolSettings.strokeColor,
    fillColor: record.toolSettings.fillColor,
    useFill: record.toolSettings.useFill,
    brushSize: record.toolSettings.brushSize,
    stampImage: null,
    layers,
    activeLayerId: record.activeLayerId,
    layersPanelOpen: record.layersPanelOpen,
  };

  // Restore history after a microtask so the canvas has rendered
  await this.updateComplete;
  this.canvas?.setHistory(history, historyIndex);
  this._lastSavedHistoryLength = history.length;
  this._dirty = false;
  this.canvas?.composite();
}
```

**Step 5: Add startup initialization**

Override `firstUpdated()` to load the most recent project or create a default:

```typescript
override async firstUpdated() {
  this._projectList = await listProjects();
  if (this._projectList.length > 0) {
    this._currentProject = this._projectList[0];
    await this._loadProject(this._currentProject.id);
  } else {
    const meta = await createProjectInDB('Untitled');
    this._currentProject = meta;
    this._projectList = [meta];
    // Trigger initial save so the default state is persisted
    this._markDirty();
  }
}
```

**Step 6: Add project CRUD context methods**

In `_buildContextValue()`, add:
```typescript
currentProject: this._currentProject,
projectList: this._projectList,
saving: this._saving,
switchProject: async (id: string) => {
  if (id === this._currentProject?.id) return;
  // Save current project first
  if (this._dirty) await this._save();
  const meta = this._projectList.find(p => p.id === id);
  if (!meta) return;
  this._currentProject = meta;
  await this._loadProject(id);
},
createProject: async (name: string) => {
  if (this._dirty) await this._save();
  const meta = await createProjectInDB(name);
  this._currentProject = meta;
  this._projectList = await listProjects();
  // Reset to default state
  _layerCounter = 0;
  const layer = createLayer(this.canvas?.getWidth() ?? 800, this.canvas?.getHeight() ?? 600);
  this._state = {
    activeTool: 'pencil',
    strokeColor: '#000000',
    fillColor: '#ff0000',
    useFill: false,
    brushSize: 4,
    stampImage: null,
    layers: [layer],
    activeLayerId: layer.id,
    layersPanelOpen: true,
  };
  await this.updateComplete;
  this.canvas?.setHistory([], -1);
  this._lastSavedHistoryLength = 0;
  // Paint white background on first layer
  const ctx = layer.canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
  this.canvas?.composite();
  this._markDirty();
},
deleteProject: async (id: string) => {
  await deleteProjectInDB(id);
  this._projectList = await listProjects();
  if (id === this._currentProject?.id) {
    if (this._projectList.length > 0) {
      this._currentProject = this._projectList[0];
      await this._loadProject(this._currentProject.id);
    } else {
      // Create a new default project
      const meta = await createProjectInDB('Untitled');
      this._currentProject = meta;
      this._projectList = [meta];
      _layerCounter = 0;
      const layer = createLayer(this.canvas?.getWidth() ?? 800, this.canvas?.getHeight() ?? 600);
      this._state = {
        ...this._state,
        layers: [layer],
        activeLayerId: layer.id,
      };
      await this.updateComplete;
      this.canvas?.setHistory([], -1);
      this._lastSavedHistoryLength = 0;
      const ctx = layer.canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
      this.canvas?.composite();
      this._markDirty();
    }
  }
},
renameProject: async (id: string, name: string) => {
  await renameProjectInDB(id, name);
  if (this._currentProject?.id === id) {
    this._currentProject = { ...this._currentProject, name };
  }
  this._projectList = await listProjects();
},
```

**Step 7: Call `_markDirty()` from every state mutation**

In every setter/action inside `_buildContextValue()` that modifies `_state`, add `this._markDirty()` at the end. This includes: `setTool`, `setStrokeColor`, `setFillColor`, `setUseFill`, `setBrushSize`, `setStampImage`, `addLayer`, `deleteLayer`, `setActiveLayer`, `setLayerVisibility`, `setLayerOpacity`, `reorderLayer`, `renameLayer`, `toggleLayersPanel`.

Also call `_markDirty()` in `_onHistoryChange` and `_onLayerUndo` handlers.

**Step 8: Type-check and verify**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Expected: App loads. Open DevTools > Application > IndexedDB. See `ketchup-projects` database with 3 stores. Draw something, wait 500ms, see data in `project-state` store. Refresh — drawing is restored.

**Step 9: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat: wire IndexedDB persistence into drawing-app with auto-save and project CRUD"
```

---

### Task 7: Add project dropdown and saving indicator to `tool-settings.ts`

The project dropdown goes in the top settings bar since `app-toolbar` is the narrow left sidebar.

**Files:**
- Modify: `src/components/tool-settings.ts`

**Step 1: Add project dropdown markup**

Add a project section at the start of the `render()` method, before the color section:

```typescript
<div class="section project-section">
  <div class="project-dropdown-wrap">
    <button class="project-name-btn" @click=${this._toggleProjectDropdown}>
      ${this.ctx.currentProject?.name ?? 'Untitled'}
      <span class="dropdown-arrow">&#9662;</span>
    </button>
    ${this._projectDropdownOpen ? html`
      <div class="project-dropdown">
        ${this.ctx.projectList.map(p => html`
          <div class="project-item ${p.id === this.ctx.currentProject?.id ? 'active' : ''}">
            ${this._renamingProjectId === p.id ? html`
              <input
                class="project-rename-input"
                .value=${p.name}
                @keydown=${(e: KeyboardEvent) => this._onRenameKeydown(e, p.id)}
                @blur=${(e: FocusEvent) => this._commitRename(e, p.id)}
              />
            ` : html`
              <span class="project-item-name" @click=${() => this._onSelectProject(p.id)}>
                ${p.name}
              </span>
              <button class="project-item-action" title="Rename" @click=${(e: Event) => this._startRename(e, p.id)}>&#9998;</button>
              <button class="project-item-action delete" title="Delete" @click=${(e: Event) => this._onDeleteProject(e, p.id)}>&#10005;</button>
            `}
          </div>
        `)}
        <div class="project-dropdown-divider"></div>
        <button class="project-new-btn" @click=${this._onNewProject}>+ New Project</button>
      </div>
    ` : ''}
  </div>
  ${this.ctx.saving ? html`<span class="saving-indicator">Saving...</span>` : ''}
</div>
<div class="separator"></div>
```

**Step 2: Add state and methods for the dropdown**

```typescript
@state() private _projectDropdownOpen = false;
@state() private _renamingProjectId: string | null = null;

private _toggleProjectDropdown() {
  this._projectDropdownOpen = !this._projectDropdownOpen;
}

private _onSelectProject(id: string) {
  this._projectDropdownOpen = false;
  this.ctx.switchProject(id);
}

private _onNewProject() {
  this._projectDropdownOpen = false;
  this.ctx.createProject('Untitled');
}

private _onDeleteProject(e: Event, id: string) {
  e.stopPropagation();
  if (confirm('Delete this project? This cannot be undone.')) {
    this._projectDropdownOpen = false;
    this.ctx.deleteProject(id);
  }
}

private _startRename(e: Event, id: string) {
  e.stopPropagation();
  this._renamingProjectId = id;
}

private _onRenameKeydown(e: KeyboardEvent, id: string) {
  if (e.key === 'Enter') {
    this._commitRename(e, id);
  } else if (e.key === 'Escape') {
    this._renamingProjectId = null;
  }
}

private _commitRename(e: Event, id: string) {
  const input = e.target as HTMLInputElement;
  const name = input.value.trim();
  if (name) {
    this.ctx.renameProject(id, name);
  }
  this._renamingProjectId = null;
}
```

**Step 3: Close dropdown on outside click**

```typescript
override connectedCallback() {
  super.connectedCallback();
  this._loadStamps();
  document.addEventListener('click', this._onDocumentClick);
}

override disconnectedCallback() {
  super.disconnectedCallback();
  // ... existing cleanup ...
  document.removeEventListener('click', this._onDocumentClick);
}

private _onDocumentClick = (e: MouseEvent) => {
  if (this._projectDropdownOpen) {
    const path = e.composedPath();
    const dropdown = this.shadowRoot?.querySelector('.project-dropdown-wrap');
    if (dropdown && !path.includes(dropdown)) {
      this._projectDropdownOpen = false;
    }
  }
};
```

**Step 4: Add CSS**

Add styles for the project dropdown and saving indicator:

```css
.project-section {
  position: relative;
}

.project-dropdown-wrap {
  position: relative;
}

.project-name-btn {
  background: #444;
  color: #ddd;
  border: 1px solid #555;
  border-radius: 0.25rem;
  padding: 0.25rem 0.5rem;
  cursor: pointer;
  font-size: 0.8125rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-name-btn:hover {
  background: #555;
}

.dropdown-arrow {
  font-size: 0.625rem;
  opacity: 0.7;
}

.project-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 0.25rem;
  background: #3a3a3a;
  border: 1px solid #555;
  border-radius: 0.375rem;
  min-width: 14rem;
  max-height: 20rem;
  overflow-y: auto;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  padding: 0.25rem 0;
}

.project-item {
  display: flex;
  align-items: center;
  padding: 0.375rem 0.5rem;
  gap: 0.25rem;
}

.project-item.active {
  background: #4a4a4a;
}

.project-item-name {
  flex: 1;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0.125rem 0;
}

.project-item-name:hover {
  color: #fff;
}

.project-item-action {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  padding: 0.125rem 0.25rem;
  font-size: 0.75rem;
  border-radius: 0.125rem;
  line-height: 1;
  width: auto;
  height: auto;
}

.project-item-action:hover {
  color: #ddd;
  background: #555;
}

.project-item-action.delete:hover {
  color: #ff6666;
}

.project-rename-input {
  flex: 1;
  background: #2a2a2a;
  border: 1px solid #5b8cf7;
  border-radius: 0.1875rem;
  color: #ddd;
  padding: 0.125rem 0.25rem;
  font-size: 0.8125rem;
  outline: none;
}

.project-dropdown-divider {
  height: 1px;
  background: #555;
  margin: 0.25rem 0;
}

.project-new-btn {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: #5b8cf7;
  cursor: pointer;
  padding: 0.375rem 0.5rem;
  font-size: 0.8125rem;
  height: auto;
  border-radius: 0;
}

.project-new-btn:hover {
  background: #4a4a4a;
  color: #7aa8ff;
}

.saving-indicator {
  color: #888;
  font-size: 0.75rem;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
```

**Step 5: Type-check and verify**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Expected: See project name in top bar with dropdown arrow. Click to open dropdown. Create a new project — switches to blank canvas. Switch back — previous drawing restored. "Saving..." appears briefly after each action. Closing tab shows browser warning if unsaved.

**Step 6: Commit**

```bash
git add src/components/tool-settings.ts
git commit -m "feat: add project dropdown and saving indicator to tool-settings bar"
```

---

### Task 8: Final integration test and build

**Files:** None (verification only)

**Step 1: Full build**

Run: `npm run build`
Expected: Builds successfully, no type errors

**Step 2: Manual verification checklist**

Run `npm run dev` and verify:
- [ ] App loads with "Untitled" project (first time) or last project (subsequent)
- [ ] Draw something, wait 500ms, see "Saving..." indicator briefly
- [ ] Refresh page — drawing is restored with all layers
- [ ] Undo/redo works after reload
- [ ] Create new project via dropdown — blank canvas
- [ ] Switch between projects — each has its own state
- [ ] Rename project via dropdown
- [ ] Delete project — switches to next or creates new default
- [ ] Close tab while dirty — browser shows "unsaved changes" warning
- [ ] Layer visibility, opacity, and order persist across reload

**Step 3: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "feat: complete IndexedDB persistence with multi-project support"
```

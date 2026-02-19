# IndexedDB Persistence Design

## Goal

Save the full app state to IndexedDB so nothing is lost on reload. Support multiple named projects with undo/redo history persistence.

## Approach: Hybrid (Chunked State with Lazy History)

Current state (layers + settings) is stored as one record per project. History entries are stored individually and loaded lazily on project open. This balances save performance (only layer data on the critical path) with full history persistence.

## IndexedDB Schema

**Database:** `ketchup-projects` (version 1)

### Object Stores

**`projects`** (keyPath: `id`)
- `id: string` — UUID
- `name: string`
- `createdAt: number`
- `updatedAt: number`
- `thumbnail: Blob | null`
- Index on `updatedAt`

**`project-state`** (keyPath: `projectId`)
- `projectId: string`
- `toolSettings: { activeTool, strokeColor, fillColor, useFill, brushSize }`
- `canvasWidth: number`
- `canvasHeight: number`
- `layers: Array<{ id, name, visible, opacity, imageBlob: Blob }>`
- `activeLayerId: string`
- `layersPanelOpen: boolean`

**`project-history`** (autoIncrement, index on `projectId`)
- `projectId: string`
- `index: number`
- `entry: SerializedHistoryEntry` — ImageData fields stored as `{ width, height, blob: Blob }`

## Save/Load Flow

### Save (debounced 500ms after every action)

1. Action occurs — mark `_dirty = true`, reset debounce timer
2. After 500ms idle — set `_saving = true` (triggers indicator)
3. Write `project-state` record (serialize layer canvases to PNG Blobs)
4. Append new history entries to `project-history` (only entries added since last save)
5. Update `projects` metadata (`updatedAt`, thumbnail from composited canvas)
6. Clear `_saving` and `_dirty` flags

### Load (on project open)

1. Read `projects` metadata
2. Read `project-state` — deserialize Blobs back to offscreen canvases via `createImageBitmap()` + `drawImage()`
3. Read `project-history` entries (cursor on `projectId` index) — deserialize Blobs back to ImageData
4. Hydrate `DrawingState` and history stack, trigger recomposite

### App Startup

Load the most recently updated project (sort `projects` by `updatedAt` desc). If no projects exist, create a default one.

## Project Management UI

Toolbar dropdown in `app-toolbar.ts`:
- Current project name displayed as clickable element
- Dropdown shows: project list (name + last modified, sorted by recent), "New Project" action
- Each row: inline rename, delete action
- Switch: save current project first, then load selected
- Delete: confirm dialog, remove all 3 store records, switch to next most recent or create default

## Saving Indicator

Small status element in the toolbar near project name. Shows "Saving..." with subtle animation during writes. Disappears on completion. Non-blocking.

## Navigation Warning

- `_dirty` flag in `drawing-app.ts` — set `true` on every action, cleared after successful save
- `beforeunload` listener on `window` triggers native browser dialog when `_dirty` is true
- Covers: tab close, refresh, navigate away

## Module Structure

### New File: `src/project-store.ts`

All IndexedDB operations, following `stamp-store.ts` pattern:
- `openDB()` — lazy-open, create stores on upgrade
- `listProjects()` — metadata sorted by `updatedAt`
- `createProject(name)` — insert metadata + empty state
- `deleteProject(id)` — remove from all 3 stores
- `saveProjectState(projectId, state, newHistoryEntries)` — serialize & write
- `loadProjectState(projectId)` — read & deserialize
- `renameProject(id, name)` — update metadata
- Serialization helpers: `canvasToBlob()`, `blobToCanvas()`, `imageDataToBlob()`, `blobToImageData()`

### Modified Files

| File | Changes |
|------|---------|
| `drawing-app.ts` | `_dirty`/`_saving` flags, debounced save, `beforeunload`, project CRUD, load on startup, expose `currentProject`/`saving` via context |
| `drawing-context.ts` | Add `currentProject`, `saving`, `switchProject()`, `createProject()`, `deleteProject()`, `renameProject()` to context |
| `app-toolbar.ts` | Project dropdown (name display, list, new/rename/delete) |
| `types.ts` | `ProjectMeta`, `SerializedHistoryEntry` types, `currentProjectId` on `DrawingState` |

### Unchanged Files

`drawing-canvas.ts`, `layers-panel.ts`, tool files, `stamp-store.ts`

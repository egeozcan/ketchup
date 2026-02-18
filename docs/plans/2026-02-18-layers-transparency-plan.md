# Layers & Transparency Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a multi-canvas layer system with per-layer opacity, visibility, and a collapsible layers panel to the ketchup drawing app.

**Architecture:** Each layer owns an offscreen `HTMLCanvasElement`. A display canvas composites all visible layers bottom-to-top with per-layer `globalAlpha`. Tools draw to the active layer's canvas unchanged. A new `layers-panel` web component provides the UI.

**Tech Stack:** Lit 3, @lit/context, TypeScript 5 (strict mode, experimental decorators), Vite 6

**Verification:** No test runner configured. Use `npx tsc --noEmit` for type-checking and `npm run dev` for visual verification after each task.

---

### Task 1: Add Layer types and update DrawingState

**Files:**
- Modify: `src/types.ts`

**Step 1: Add Layer and LayerSnapshot interfaces, update HistoryEntry and DrawingState**

In `src/types.ts`, add these types and modify existing ones:

```typescript
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  canvas: HTMLCanvasElement;
}

export interface LayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageData: ImageData;
}

export type HistoryEntry =
  | { type: 'draw'; layerId: string; before: ImageData; after: ImageData }
  | { type: 'add-layer'; layer: LayerSnapshot }
  | { type: 'delete-layer'; layer: LayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string };
```

Remove the old `HistoryEntry` interface (`{ imageData: ImageData }`).

Add layer-related fields to `DrawingState`:

```typescript
export interface DrawingState {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brushSize: number;
  stampImage: HTMLImageElement | null;
  layers: Layer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: Type errors in `drawing-context.ts`, `drawing-canvas.ts`, and `drawing-app.ts` because they reference the old `HistoryEntry` shape and `DrawingState` is missing the new fields. This is expected — we fix these in subsequent tasks.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add Layer types and update DrawingState for layer system"
```

---

### Task 2: Update DrawingContextValue with layer operations

**Files:**
- Modify: `src/contexts/drawing-context.ts`

**Step 1: Add layer operation methods to the context interface**

Add these to `DrawingContextValue` in `src/contexts/drawing-context.ts`:

```typescript
// Layer operations
addLayer: () => void;
deleteLayer: (id: string) => void;
setActiveLayer: (id: string) => void;
setLayerVisibility: (id: string, visible: boolean) => void;
setLayerOpacity: (id: string, opacity: number) => void;
reorderLayer: (id: string, newIndex: number) => void;
renameLayer: (id: string, name: string) => void;
toggleLayersPanel: () => void;
```

Import `Layer` from `../types.js` (for use in downstream consumers).

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: More errors in `drawing-app.ts` because `_buildContextValue()` doesn't implement the new methods yet. Expected.

**Step 3: Commit**

```bash
git add src/contexts/drawing-context.ts
git commit -m "feat: add layer operations to DrawingContextValue"
```

---

### Task 3: Implement layer state management in drawing-app

**Files:**
- Modify: `src/components/drawing-app.ts`

**Step 1: Add layer helper function and initialize layer state**

Add a helper function (top of file, outside the class) to create a new layer:

```typescript
let _layerCounter = 0;

function createLayer(width: number, height: number): Layer {
  _layerCounter++;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    id: crypto.randomUUID(),
    name: `Layer ${_layerCounter}`,
    visible: true,
    opacity: 1.0,
    canvas,
  };
}
```

Update `_state` initialization to include a default layer:

```typescript
private _initialLayer = createLayer(800, 600);

@state()
private _state: DrawingState = {
  activeTool: 'pencil',
  strokeColor: '#000000',
  fillColor: '#ff0000',
  useFill: false,
  brushSize: 4,
  stampImage: null,
  layers: [this._initialLayer],
  activeLayerId: this._initialLayer.id,
  layersPanelOpen: true,
};
```

**Step 2: Implement all layer context methods in `_buildContextValue()`**

Add these method implementations inside the returned object:

```typescript
addLayer: () => {
  const layer = createLayer(this.canvas?.getWidth() ?? 800, this.canvas?.getHeight() ?? 600);
  const activeIdx = this._state.layers.findIndex(l => l.id === this._state.activeLayerId);
  const newLayers = [...this._state.layers];
  newLayers.splice(activeIdx + 1, 0, layer);
  this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
  this.canvas?.pushLayerOperation({ type: 'add-layer', layer: this._snapshotLayer(layer) });
  this.canvas?.composite();
},
deleteLayer: (id: string) => {
  if (this._state.layers.length <= 1) return;
  const idx = this._state.layers.findIndex(l => l.id === id);
  if (idx === -1) return;
  const layer = this._state.layers[idx];
  const snapshot = this._snapshotLayer(layer);
  const newLayers = this._state.layers.filter(l => l.id !== id);
  const newActiveId = this._state.activeLayerId === id
    ? newLayers[Math.min(idx, newLayers.length - 1)].id
    : this._state.activeLayerId;
  this._state = { ...this._state, layers: newLayers, activeLayerId: newActiveId };
  this.canvas?.pushLayerOperation({ type: 'delete-layer', layer: snapshot, index: idx });
  this.canvas?.composite();
},
setActiveLayer: (id: string) => {
  if (this._state.layers.some(l => l.id === id)) {
    this.canvas?.clearSelection();
    this._state = { ...this._state, activeLayerId: id };
  }
},
setLayerVisibility: (id: string, visible: boolean) => {
  const layer = this._state.layers.find(l => l.id === id);
  if (!layer || layer.visible === visible) return;
  const before = layer.visible;
  layer.visible = visible;
  this._state = { ...this._state, layers: [...this._state.layers] };
  this.canvas?.pushLayerOperation({ type: 'visibility', layerId: id, before, after: visible });
  this.canvas?.composite();
},
setLayerOpacity: (id: string, opacity: number) => {
  const layer = this._state.layers.find(l => l.id === id);
  if (!layer) return;
  const before = layer.opacity;
  layer.opacity = opacity;
  this._state = { ...this._state, layers: [...this._state.layers] };
  this.canvas?.pushLayerOperation({ type: 'opacity', layerId: id, before, after: opacity });
  this.canvas?.composite();
},
reorderLayer: (id: string, newIndex: number) => {
  const oldIndex = this._state.layers.findIndex(l => l.id === id);
  if (oldIndex === -1 || oldIndex === newIndex) return;
  const newLayers = [...this._state.layers];
  const [layer] = newLayers.splice(oldIndex, 1);
  newLayers.splice(newIndex, 0, layer);
  this._state = { ...this._state, layers: newLayers };
  this.canvas?.pushLayerOperation({ type: 'reorder', fromIndex: oldIndex, toIndex: newIndex });
  this.canvas?.composite();
},
renameLayer: (id: string, name: string) => {
  const layer = this._state.layers.find(l => l.id === id);
  if (!layer || layer.name === name) return;
  const before = layer.name;
  layer.name = name;
  this._state = { ...this._state, layers: [...this._state.layers] };
  this.canvas?.pushLayerOperation({ type: 'rename', layerId: id, before, after: name });
},
toggleLayersPanel: () => {
  this._state = { ...this._state, layersPanelOpen: !this._state.layersPanelOpen };
},
```

Add a helper method on the class:

```typescript
private _snapshotLayer(layer: Layer): LayerSnapshot {
  const ctx = layer.canvas.getContext('2d')!;
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    imageData: ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
  };
}
```

Import `Layer`, `LayerSnapshot` from `../types.js`.

**Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: Errors about `this.canvas?.pushLayerOperation`, `this.canvas?.composite`, `this.canvas?.getWidth`, `this.canvas?.getHeight` — these methods don't exist on `DrawingCanvas` yet. Fixed in Task 4.

**Step 4: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat: implement layer state management in drawing-app"
```

---

### Task 4: Refactor drawing-canvas for multi-layer compositing

**Files:**
- Modify: `src/components/drawing-canvas.ts`

This is the largest task. It refactors the canvas component to:
1. Draw to the active layer's offscreen canvas instead of the display canvas
2. Composite all layers onto the display canvas
3. Replace the old ImageData-array history with the new HistoryEntry system

**Step 1: Add compositing and layer-aware drawing**

Key changes to `drawing-canvas.ts`:

1. Rename `#main` canvas role — it becomes the **display** canvas (composited output). Remove `background: white` from its CSS since we'll draw a checkerboard pattern programmatically.

2. Add `composite()` public method:

```typescript
public composite() {
  const displayCtx = this.mainCanvas.getContext('2d')!;
  displayCtx.clearRect(0, 0, this._width, this._height);
  // Draw checkerboard
  this._drawCheckerboard(displayCtx);
  // Composite layers
  const layers = this._ctx.value?.state.layers ?? [];
  for (const layer of layers) {
    if (!layer.visible) continue;
    displayCtx.globalAlpha = layer.opacity;
    displayCtx.drawImage(layer.canvas, 0, 0);
    displayCtx.globalAlpha = 1.0;
  }
}

private _drawCheckerboard(ctx: CanvasRenderingContext2D) {
  const size = 10;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, this._width, this._height);
  ctx.fillStyle = '#e0e0e0';
  for (let y = 0; y < this._height; y += size) {
    for (let x = 0; x < this._width; x += size) {
      if ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 1) {
        ctx.fillRect(x, y, size, size);
      }
    }
  }
}
```

3. Add helper to get the active layer's context:

```typescript
private _getActiveLayerCtx(): CanvasRenderingContext2D | null {
  const state = this._ctx.value?.state;
  if (!state) return null;
  const layer = state.layers.find(l => l.id === state.activeLayerId);
  return layer?.canvas.getContext('2d') ?? null;
}
```

4. Replace every `this.mainCanvas.getContext('2d')!` in drawing operations with `this._getActiveLayerCtx()`. Specifically in:
   - `_onPointerDown` (fill, stamp, brush dot)
   - `_drawBrushAt`
   - `_onPointerUp` (shape commit)
   - `_liftSelection`, `_dropSelection`, `copySelection`, `pasteSelection`, `deleteSelection`

5. After every draw operation that modifies a layer, call `this.composite()`.

6. Add `getWidth()` and `getHeight()` public methods:

```typescript
public getWidth() { return this._width; }
public getHeight() { return this._height; }
```

**Step 2: Refactor history system**

Replace the old history system with the new HistoryEntry-based one.

```typescript
import type { HistoryEntry, LayerSnapshot } from '../types.js';

private _history: HistoryEntry[] = [];
private _historyIndex = -1;
private _maxHistory = 50;
```

Replace `_pushHistory()` with a draw-specific version that captures before/after for the active layer:

```typescript
private _beforeDrawData: ImageData | null = null;

/** Call before a drawing operation starts (pointerdown) */
private _captureBeforeDraw() {
  const ctx = this._getActiveLayerCtx();
  if (!ctx) return;
  this._beforeDrawData = ctx.getImageData(0, 0, this._width, this._height);
}

/** Call after a drawing operation completes (pointerup) */
private _pushDrawHistory() {
  const state = this._ctx.value?.state;
  const ctx = this._getActiveLayerCtx();
  if (!ctx || !state || !this._beforeDrawData) return;
  const after = ctx.getImageData(0, 0, this._width, this._height);
  this._pushHistoryEntry({
    type: 'draw',
    layerId: state.activeLayerId,
    before: this._beforeDrawData,
    after,
  });
  this._beforeDrawData = null;
}

/** Called by drawing-app for layer structural operations */
public pushLayerOperation(entry: HistoryEntry) {
  this._pushHistoryEntry(entry);
}

private _pushHistoryEntry(entry: HistoryEntry) {
  this._history = this._history.slice(0, this._historyIndex + 1);
  this._history.push(entry);
  if (this._history.length > this._maxHistory) {
    this._history.shift();
  } else {
    this._historyIndex++;
  }
  this._notifyHistory();
}
```

Refactor `undo()` and `redo()` to handle all entry types:

```typescript
public undo() {
  if (this._historyIndex < 0) return;
  this._clearSelectionState();
  const entry = this._history[this._historyIndex];
  this._historyIndex--;
  this._applyUndo(entry);
  this.composite();
  this._notifyHistory();
}

public redo() {
  if (this._historyIndex >= this._history.length - 1) return;
  this._clearSelectionState();
  this._historyIndex++;
  const entry = this._history[this._historyIndex];
  this._applyRedo(entry);
  this.composite();
  this._notifyHistory();
}
```

`_applyUndo` and `_applyRedo` dispatch on `entry.type`:

```typescript
private _applyUndo(entry: HistoryEntry) {
  const state = this._ctx.value?.state;
  if (!state) return;
  switch (entry.type) {
    case 'draw': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) layer.canvas.getContext('2d')!.putImageData(entry.before, 0, 0);
      break;
    }
    case 'add-layer': {
      // Remove the added layer — dispatch event to drawing-app
      this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'remove-layer', layerId: entry.layer.id } }));
      break;
    }
    case 'delete-layer': {
      // Re-insert the deleted layer — dispatch event to drawing-app
      this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'restore-layer', snapshot: entry.layer, index: entry.index } }));
      break;
    }
    case 'reorder': {
      this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'reorder', fromIndex: entry.toIndex, toIndex: entry.fromIndex } }));
      break;
    }
    case 'visibility': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) {
        layer.visible = entry.before;
        this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'refresh' } }));
      }
      break;
    }
    case 'opacity': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) {
        layer.opacity = entry.before;
        this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'refresh' } }));
      }
      break;
    }
    case 'rename': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) {
        layer.name = entry.before;
        this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'refresh' } }));
      }
      break;
    }
  }
}

private _applyRedo(entry: HistoryEntry) {
  const state = this._ctx.value?.state;
  if (!state) return;
  switch (entry.type) {
    case 'draw': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) layer.canvas.getContext('2d')!.putImageData(entry.after, 0, 0);
      break;
    }
    case 'add-layer': {
      this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'restore-layer', snapshot: entry.layer, index: -1 } }));
      break;
    }
    case 'delete-layer': {
      this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'remove-layer', layerId: entry.layer.id } }));
      break;
    }
    case 'reorder': {
      this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'reorder', fromIndex: entry.fromIndex, toIndex: entry.toIndex } }));
      break;
    }
    case 'visibility': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) {
        layer.visible = entry.after;
        this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'refresh' } }));
      }
      break;
    }
    case 'opacity': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) {
        layer.opacity = entry.after;
        this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'refresh' } }));
      }
      break;
    }
    case 'rename': {
      const layer = state.layers.find(l => l.id === entry.layerId);
      if (layer) {
        layer.name = entry.after;
        this.dispatchEvent(new CustomEvent('layer-undo', { bubbles: true, composed: true, detail: { action: 'refresh' } }));
      }
      break;
    }
  }
}
```

Update `_notifyHistory` to check the new history structure:

```typescript
private _notifyHistory() {
  this.dispatchEvent(
    new CustomEvent('history-change', {
      bubbles: true,
      composed: true,
      detail: {
        canUndo: this._historyIndex >= 0,
        canRedo: this._historyIndex < this._history.length - 1,
      },
    }),
  );
}
```

**Step 3: Update firstUpdated and resize**

In `firstUpdated()`: Remove the white background fill on mainCanvas. Instead, fill the initial layer's canvas with white, push an initial draw history entry, and call `composite()`:

```typescript
override firstUpdated() {
  this._resizeToFit();
  const ro = new ResizeObserver(() => this._resizeToFit());
  ro.observe(this);
  // Initialize first layer with white background
  const layerCtx = this._getActiveLayerCtx();
  if (layerCtx) {
    layerCtx.fillStyle = '#ffffff';
    layerCtx.fillRect(0, 0, this._width, this._height);
  }
  this.composite();
}
```

Remove the initial `_pushHistory()` call from `firstUpdated` — the history starts empty; the first user action creates the first entry.

In `_resizeToFit()`: Resize all layer canvases + display canvas + preview canvas. Save/restore each layer's ImageData:

```typescript
private _resizeToFit() {
  this._commitSelection();
  const rect = this.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const newWidth = Math.floor(rect.width);
  const newHeight = Math.floor(rect.height);
  if (this.mainCanvas.width === newWidth && this.mainCanvas.height === newHeight) return;

  // Save each layer's content
  const layers = this._ctx.value?.state.layers ?? [];
  const savedLayerData: Map<string, ImageData> = new Map();
  for (const layer of layers) {
    if (layer.canvas.width > 0 && layer.canvas.height > 0) {
      const ctx = layer.canvas.getContext('2d')!;
      savedLayerData.set(layer.id, ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height));
    }
  }

  this._width = newWidth;
  this._height = newHeight;
  this.mainCanvas.width = newWidth;
  this.mainCanvas.height = newHeight;
  this.previewCanvas.width = newWidth;
  this.previewCanvas.height = newHeight;

  // Resize and restore each layer
  for (const layer of layers) {
    layer.canvas.width = newWidth;
    layer.canvas.height = newHeight;
    const saved = savedLayerData.get(layer.id);
    if (saved) {
      layer.canvas.getContext('2d')!.putImageData(saved, 0, 0);
    }
  }

  this.composite();
}
```

**Step 4: Update clearCanvas and saveCanvas**

`clearCanvas()` clears only the active layer:

```typescript
public clearCanvas() {
  this._captureBeforeDraw();
  const ctx = this._getActiveLayerCtx();
  if (ctx) {
    ctx.clearRect(0, 0, this._width, this._height);
  }
  this._pushDrawHistory();
  this.composite();
}
```

`saveCanvas()` exports the display canvas (already composited):

```typescript
public saveCanvas() {
  // Composite onto a temp canvas without checkerboard for clean export
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = this._width;
  exportCanvas.height = this._height;
  const exportCtx = exportCanvas.getContext('2d')!;
  const layers = this._ctx.value?.state.layers ?? [];
  for (const layer of layers) {
    if (!layer.visible) continue;
    exportCtx.globalAlpha = layer.opacity;
    exportCtx.drawImage(layer.canvas, 0, 0);
    exportCtx.globalAlpha = 1.0;
  }
  const link = document.createElement('a');
  link.download = 'drawing.png';
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
}
```

**Step 5: Update pointer handlers to use active layer context**

In `_onPointerDown`: call `this._captureBeforeDraw()` at the start of drawing operations (for fill, stamp, and brush tools). Replace `this.mainCanvas.getContext('2d')!` with `this._getActiveLayerCtx()!` for fill and stamp. Add `this.composite()` after fill and stamp.

In `_drawBrushAt`: Replace `this.mainCanvas.getContext('2d')!` with `this._getActiveLayerCtx()!`. Call `this.composite()` at the end.

In `_onPointerUp`: Replace the mainCtx for shape commit with `this._getActiveLayerCtx()!`. Replace `this._pushHistory()` with `this._pushDrawHistory()`. Call `this.composite()`.

In selection methods (`_liftSelection`, `_dropSelection`, `copySelection`, `pasteSelection`, `deleteSelection`): Replace `this.mainCanvas.getContext('2d')!` with `this._getActiveLayerCtx()!`. Add `this.composite()` after modifications. For `deleteSelection`, use `ctx.clearRect()` instead of filling with white (so it becomes transparent on a layer).

**Step 6: Remove `#main` white background from CSS**

In the component's static styles, change:

```css
#main {
  background: white;
}
```

to:

```css
#main {
  background: transparent;
}
```

The checkerboard is now drawn in the host element's CSS background (already present) and also painted onto the display canvas by `_drawCheckerboard()`.

**Step 7: Type-check and verify**

Run: `npx tsc --noEmit`
Expected: Clean (no errors), or only errors related to `layer-undo` event handling in `drawing-app.ts` (wired in Task 5).

Run: `npm run dev`
Expected: App loads with a single layer. Drawing works as before. Checkerboard visible if you erase content.

**Step 8: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: refactor drawing-canvas for multi-layer compositing and new history system"
```

---

### Task 5: Wire layer-undo events in drawing-app

**Files:**
- Modify: `src/components/drawing-app.ts`

**Step 1: Handle `layer-undo` custom events from drawing-canvas**

Add a `@layer-undo` event listener on `<drawing-canvas>` in the render template, and implement the handler:

```typescript
private _onLayerUndo(e: CustomEvent) {
  const detail = e.detail;
  switch (detail.action) {
    case 'remove-layer': {
      const newLayers = this._state.layers.filter(l => l.id !== detail.layerId);
      if (newLayers.length === 0) return;
      const newActiveId = this._state.activeLayerId === detail.layerId
        ? newLayers[Math.min(newLayers.length - 1, 0)].id
        : this._state.activeLayerId;
      this._state = { ...this._state, layers: newLayers, activeLayerId: newActiveId };
      break;
    }
    case 'restore-layer': {
      const snapshot = detail.snapshot as LayerSnapshot;
      const canvas = document.createElement('canvas');
      canvas.width = snapshot.imageData.width;
      canvas.height = snapshot.imageData.height;
      canvas.getContext('2d')!.putImageData(snapshot.imageData, 0, 0);
      const layer: Layer = {
        id: snapshot.id,
        name: snapshot.name,
        visible: snapshot.visible,
        opacity: snapshot.opacity,
        canvas,
      };
      const newLayers = [...this._state.layers];
      const idx = detail.index === -1 ? newLayers.length : detail.index;
      newLayers.splice(idx, 0, layer);
      this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
      break;
    }
    case 'reorder': {
      const newLayers = [...this._state.layers];
      const [moved] = newLayers.splice(detail.fromIndex, 1);
      newLayers.splice(detail.toIndex, 0, moved);
      this._state = { ...this._state, layers: newLayers };
      break;
    }
    case 'refresh': {
      // Force re-render by creating new layers array reference
      this._state = { ...this._state, layers: [...this._state.layers] };
      break;
    }
  }
}
```

In the render template, add the event binding:

```html
<drawing-canvas
  @history-change=${this._onHistoryChange}
  @layer-undo=${this._onLayerUndo}
></drawing-canvas>
```

**Step 2: Update opacity setter to avoid pushing history on every slider tick**

The `setLayerOpacity` method currently pushes a history entry for every change. For a slider, this creates many entries. Instead, debounce: only push history when the user finishes dragging. For now, keep it simple — the layers panel will dispatch a `commit-opacity` event on `pointerup`/`change` and the app will push history then. Modify `setLayerOpacity` to take an optional `commit` param:

Actually, simpler approach: split into two methods. `setLayerOpacity` does the live update without history. Add a separate context method or have the panel handle it. For now, just remove the `pushLayerOperation` call from `setLayerOpacity` and add a `commitLayerOpacity` that pushes history with the before/after. Store the "before" value when the slider starts.

Revise `setLayerOpacity`:

```typescript
setLayerOpacity: (id: string, opacity: number) => {
  const layer = this._state.layers.find(l => l.id === id);
  if (!layer) return;
  layer.opacity = opacity;
  this._state = { ...this._state, layers: [...this._state.layers] };
  this.canvas?.composite();
},
```

The layers panel will be responsible for capturing before/after and calling `pushLayerOperation` on commit. (Implemented in Task 6.)

**Step 3: Type-check and verify**

Run: `npx tsc --noEmit`
Expected: Clean compile.

Run: `npm run dev`
Expected: App works, single layer, drawing behaves the same.

**Step 4: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat: wire layer-undo events and finalize layer state management"
```

---

### Task 6: Create the layers-panel component

**Files:**
- Create: `src/components/layers-panel.ts`
- Modify: `src/components/drawing-app.ts` (import + layout)

**Step 1: Create the layers-panel component**

Create `src/components/layers-panel.ts` — a `ContextConsumer` Lit component.

Core structure:
- Header row with "Layers" title and collapse/expand toggle button
- Layer list rendered in reverse order (top of list = highest z-order)
- Each layer row: eye icon, name (editable on double-click), thumbnail canvas, opacity slider (active layer only), up/down buttons
- Footer with Add and Delete buttons
- Collapsed state shows just a thin strip with expand button

The component needs:
- `@state() _editingLayerId: string | null` for inline rename
- `@state() _opacityBefore: number | null` for tracking opacity history
- Thumbnail generation via small canvas elements that re-render when layers change
- CSS for the sidebar layout, layer rows, active highlighting

Key event handling:
- Click layer row → `setActiveLayer(id)`
- Click eye icon → `setLayerVisibility(id, !visible)`
- Double-click name → enter edit mode, commit on Enter/blur
- Opacity slider `input` → `setLayerOpacity(id, value)` (live preview)
- Opacity slider `pointerdown` → capture `_opacityBefore`
- Opacity slider `change` → push history via `pushLayerOperation` with before/after
- Up/Down buttons → `reorderLayer(id, newIndex)`
- Add button → `addLayer()`
- Delete button → `deleteLayer(activeLayerId)`

Width: 200px when open. Transition on collapse/expand.

**Step 2: Add the layers-panel to drawing-app layout**

In `drawing-app.ts`:
- Import `./layers-panel.js`
- Add `<layers-panel></layers-panel>` after `<drawing-canvas>` in the `.main-area` div
- Update `.main-area` CSS if needed (layers-panel handles its own width)

```html
<div class="main-area">
  <app-toolbar></app-toolbar>
  <drawing-canvas
    @history-change=${this._onHistoryChange}
    @layer-undo=${this._onLayerUndo}
  ></drawing-canvas>
  <layers-panel></layers-panel>
</div>
```

**Step 3: Type-check and verify**

Run: `npx tsc --noEmit`
Expected: Clean compile.

Run: `npm run dev`
Expected: Layers panel visible on the right. Can add layers, switch between them, toggle visibility, adjust opacity. Drawing goes to the active layer. Toggling visibility shows/hides layer content.

**Step 4: Commit**

```bash
git add src/components/layers-panel.ts src/components/drawing-app.ts
git commit -m "feat: add layers panel component with full layer management UI"
```

---

### Task 7: Add drag-and-drop reordering to layers panel

**Files:**
- Modify: `src/components/layers-panel.ts`

**Step 1: Add drag-and-drop to layer rows**

Add `draggable="true"` to each layer row. Implement:
- `@dragstart`: Set `dataTransfer` with layer id, add `.dragging` CSS class
- `@dragover`: Determine drop position (above/below target), show drop indicator line
- `@dragend`: Remove `.dragging` class
- `@drop`: Call `reorderLayer(id, newIndex)` with computed target index

CSS for drag states:
- `.dragging` row gets reduced opacity
- `.drop-above` / `.drop-below` classes show a 2px blue line indicator

Account for the reversed display order (top of list = end of array) when calculating indices.

**Step 2: Verify**

Run: `npm run dev`
Expected: Can drag layer rows to reorder. Drop indicator shows position. Layer stack order updates correctly in the canvas.

**Step 3: Commit**

```bash
git add src/components/layers-panel.ts
git commit -m "feat: add drag-and-drop reordering to layers panel"
```

---

### Task 8: Update selection tool for layer-aware transparency

**Files:**
- Modify: `src/components/drawing-canvas.ts`

**Step 1: Fix selection operations for transparency**

The selection tool currently fills lifted areas with white (`fillStyle = '#ffffff'`). On a layer system, this should be transparent (use `clearRect` instead).

In `_liftSelection()`: Replace `mainCtx.fillStyle = '#ffffff'; mainCtx.fillRect(x, y, w, h);` with:

```typescript
const ctx = this._getActiveLayerCtx()!;
this._selectionImageData = ctx.getImageData(x, y, w, h);
ctx.clearRect(x, y, w, h);
```

In `deleteSelection()`: Replace `mainCtx.fillStyle = '#ffffff'; mainCtx.fillRect(x, y, w, h);` with:

```typescript
const ctx = this._getActiveLayerCtx()!;
ctx.clearRect(x, y, w, h);
```

Add `this.composite()` calls after these operations.

**Step 2: Verify**

Run: `npm run dev`
Expected: Selecting and moving content on a layer leaves transparency (checkerboard visible) instead of white. Deleting a selection creates transparency.

**Step 3: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "fix: selection tool uses clearRect for layer-aware transparency"
```

---

### Task 9: Layer thumbnails in the panel

**Files:**
- Modify: `src/components/layers-panel.ts`

**Step 1: Add thumbnail rendering**

Each layer row shows a ~48x36 thumbnail (4:3 aspect matching 800x600 default).

Use a small `<canvas>` element per layer row. In the `updated()` lifecycle or via a public `updateThumbnails()` method, scale each layer's offscreen canvas content down to the thumbnail size. Draw a mini checkerboard behind transparent areas.

The thumbnail should update whenever `composite()` is called. Have `drawing-canvas` dispatch a `layers-composited` event after compositing. The panel listens and re-renders thumbnails.

Alternatively, since the panel is a `ContextConsumer` and the layers array reference changes on state updates, the panel will re-render. Use `updated()` to redraw thumbnails into `<canvas>` elements queried from the shadow DOM.

**Step 2: Verify**

Run: `npm run dev`
Expected: Each layer row shows a small thumbnail preview of its contents. Thumbnails update when you draw.

**Step 3: Commit**

```bash
git add src/components/layers-panel.ts
git commit -m "feat: add layer thumbnails to panel"
```

---

### Task 10: Final integration, polish, and type-check

**Files:**
- Modify: various files for polish

**Step 1: Full type-check**

Run: `npx tsc --noEmit`
Fix any remaining type errors.

**Step 2: Build check**

Run: `npm run build`
Expected: Clean build.

**Step 3: Visual verification checklist**

Open `npm run dev` and verify:
- [ ] App starts with one layer, drawing works
- [ ] Add a second layer, draw on it, content is separate
- [ ] Toggle layer visibility — content shows/hides
- [ ] Adjust layer opacity — content fades
- [ ] Reorder layers (both drag-and-drop and up/down buttons)
- [ ] Delete a layer (can't delete the last one)
- [ ] Rename a layer by double-clicking
- [ ] Undo/redo works for: drawing, add layer, delete layer, reorder, visibility, opacity, rename
- [ ] Selection tool works on active layer, leaves transparency
- [ ] Eraser creates transparency (shows layers below)
- [ ] Save exports a flattened PNG
- [ ] Clear clears only the active layer
- [ ] Collapse/expand layers panel
- [ ] Thumbnails update when drawing
- [ ] Canvas resize preserves all layer content

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "feat: layers and transparency — final polish and fixes"
```

---

### Task 11: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update architecture section**

Update the CLAUDE.md to reflect the new layer system:
- Add "Layer System" subsection describing the multi-canvas architecture
- Update "Canvas Layers" to describe display canvas + per-layer offscreen canvases
- Update "History" to describe the new HistoryEntry types
- Add `layers-panel.ts` to the component list

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with layer system architecture"
```

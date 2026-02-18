# Layers & Transparency Design

## Overview

Add a layer system to ketchup with per-layer opacity, visibility, and a collapsible layers panel UI. Approach: multi-canvas stack where each layer owns an offscreen `<canvas>` and the visible result is composited onto a single display canvas.

## Requirements

- Up to ~10 layers
- Add, delete, reorder, toggle visibility, per-layer opacity
- Collapsible right sidebar panel with drag-and-drop + up/down reordering
- Global undo stack covering drawing actions and layer operations
- No blend modes for v1 (normal compositing only)

## Data Model

```typescript
interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;       // 0.0 – 1.0
  canvas: HTMLCanvasElement;  // offscreen, not in DOM
}
```

State additions to `DrawingState`:

- `layers: Layer[]` — ordered bottom-to-top (index 0 = bottom)
- `activeLayerId: string` — which layer tools draw on
- `layersPanelOpen: boolean` — sidebar collapsed/expanded

Context additions:

- `addLayer()`, `deleteLayer(id)`, `setActiveLayer(id)`
- `setLayerVisibility(id, visible)`, `setLayerOpacity(id, opacity)`
- `reorderLayer(id, newIndex)`, `renameLayer(id, name)`
- `toggleLayersPanel()`

Default: app starts with one layer ("Layer 1"), opacity 1.0, visible, active. Auto-naming increments globally.

## Canvas Architecture

Replace the single `#main` canvas with:

- Each `Layer` owns an offscreen `HTMLCanvasElement` (created via `document.createElement`, not in DOM)
- One **display canvas** in the DOM (replaces `#main`) — shows composited result
- `#preview` canvas stays as-is, on top of everything

### Compositing Pipeline

Runs after every draw operation and on layer state changes:

```
draw checkerboard transparency pattern on display canvas
for each layer (bottom to top):
  if layer.visible:
    displayCtx.globalAlpha = layer.opacity
    displayCtx.drawImage(layer.canvas, 0, 0)
    displayCtx.globalAlpha = 1.0
```

### When Compositing Triggers

- After `pointerup` (drawing committed)
- During `pointermove` for continuous tools (pencil/marker/eraser)
- On any layer state change (visibility, opacity, reorder, add, delete)

### Canvas Resize

All layer canvases + display canvas + preview canvas resize together. Each layer's content preserved via save ImageData → resize → restore.

### Tool Integration

Tools receive the **active layer's** `canvas.getContext('2d')` instead of the display canvas context. Tool functions themselves are unchanged.

## History System

Each history entry captures what changed with enough data to undo/redo:

```typescript
type HistoryEntry =
  | { type: 'draw'; layerId: string; before: ImageData; after: ImageData }
  | { type: 'add-layer'; layer: LayerSnapshot }
  | { type: 'delete-layer'; layer: LayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string }
```

`LayerSnapshot = { id, name, visible, opacity, imageData }` — enough to reconstruct a deleted layer.

Key properties:

- Only stores `ImageData` for the affected layer on draw ops (not all layers)
- Structural operations store minimal metadata
- Active layer switches to affected layer on undo/redo
- Max 50 entries

## Layers Panel UI

New `layers-panel.ts` component (`ContextConsumer`). Collapsible right sidebar, ~200px wide.

### Panel Structure

```
┌─────────────────────────┐
│ Layers          [◀ hide]│  header with collapse toggle
├─────────────────────────┤
│ 👁 [Layer 3]  [thumb]   │  active (highlighted)
│    opacity: ▓▓▓░░  [▲▼] │  slider + reorder buttons
├─────────────────────────┤
│ 👁 [Layer 2]  [thumb]   │  inactive row
├─────────────────────────┤
│ 👁 [Layer 1]  [thumb]   │  bottom layer
├─────────────────────────┤
│      [+ Add] [🗑 Delete] │  action buttons
└─────────────────────────┘
```

### Layer Row Features

- Eye icon: click to toggle visibility
- Layer name: click row to activate, double-click name to rename inline
- Thumbnail: ~40x30px scaled preview, updated on compositing
- Opacity slider: shown inline on active layer row (0–100%)
- Up/Down arrows: reorder buttons, disabled at boundaries
- Drag-and-drop: drag rows to reorder with drop position indicator
- Top of list = top of stack (highest z-order)

### Actions

- Add: new blank layer above active
- Delete: delete active layer (disabled if only one layer)
- Collapsed state: thin vertical strip with ▶ expand button

## Existing System Integration

- **Selection tool:** operates on active layer only
- **Fill tool:** operates on active layer canvas only
- **Eraser:** `destination-out` creates transparency, revealing layers below
- **Save:** exports composited display canvas (flattened PNG)
- **Clear:** clears active layer only
- **Keyboard shortcuts:** existing Ctrl+Z/Y works with new global history stack
- **Layout:** `.main-area` becomes `toolbar | canvas | layers-panel`

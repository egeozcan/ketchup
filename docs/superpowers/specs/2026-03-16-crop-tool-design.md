# Crop Tool Design

## Overview

A document-level crop tool that lets the user draw a rectangle on the canvas, adjust it with resize handles, and commit to resize the document and trim all layers to the crop region. The operation is fully undoable with a single history entry.

## Interaction Flow

### 1. Activate

User presses `R` or clicks the crop icon in the toolbar (first group: select, move, crop, hand). The tool settings panel shows an aspect ratio dropdown.

### 2. Draw Crop Rectangle

Click-drag on the canvas to define the crop region in document coordinates. While dragging:

- A semi-transparent dark overlay covers the entire document on the preview canvas
- The crop region is clipped out (clear), showing the content underneath
- If an aspect ratio is locked, the rectangle constrains accordingly

### 3. Adjust

On pointer up, the rectangle persists with:

- 8 resize handles (white squares with blue border) at corners and edge midpoints
- A solid border (not dashed, to distinguish from selection marching ants)
- A dimensions label (e.g., "480 x 320") near the bottom-right corner

The user can:

- **Drag a handle** to resize. Corner handles preserve aspect ratio when locked. Edge handles adjust freely in their axis and compute the constrained axis when ratio-locked.
- **Drag inside** the rectangle to reposition it.
- **Click outside** the rectangle to start a new crop rect, replacing the current one.

### 4. Confirm or Cancel

- **Enter**: Commits the crop. All layers are trimmed, document dimensions update, one `crop` history entry is pushed. Handled in `drawing-app.ts`'s `_onKeyDown` (which already owns keyboard dispatch), calling `canvas.commitCrop()`.
- **Escape**: Cancels. Overlay clears, tool stays active. Handled in `drawing-app.ts`'s existing Escape handler, calling `canvas.cancelCrop()`.
- **Switching tools**: Also cancels the pending crop (via `cancelCrop()` in the tool-switch logic).

## Technical Design

### New State in `drawing-canvas.ts`

```typescript
type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

private _cropRect: { x: number; y: number; w: number; h: number } | null = null;
private _cropDragging = false;           // drawing initial rect
private _cropHandle: CropHandle | null = null;
private _cropDragOrigin: Point | null = null;
```

### Preview Canvas Rendering

When `_cropRect` is set, `crop.ts` draws on the preview canvas:

1. Fill entire document area with `rgba(0, 0, 0, 0.5)`
2. `clearRect()` the crop region to reveal content
3. Stroke the crop region border (solid white or blue, 1px)
4. Draw 8 resize handles (8x8 white squares with 1px blue border)
5. Draw dimensions label text near bottom-right of crop rect

Handles are drawn at a fixed screen-space size regardless of zoom. The overlay function receives the current zoom level to compute handle pixel sizes.

This is called from the existing preview render loop in `drawing-canvas.ts`.

### Pointer Event Dispatch

In `_onPointerDown` / `_onPointerMove` / `_onPointerUp`, when `activeTool === 'crop'`:

**Pointer down:**
- If `_cropRect` exists: hit-test handles first (return handle name), then hit-test interior (return `'move'`), then fall through to start a new rect. Handle hit-testing uses screen-space coordinates and a fixed pixel threshold (scaled by `1 / _zoom`) so handles remain easy to grab at any zoom level.
- If no `_cropRect`: begin drawing a new one from the pointer position (converted to document coords via `_getDocPoint()`)

**Pointer move:**
- Initial draw: update `_cropRect` width/height from pointer delta, apply ratio constraint
- Handle resize: adjust the relevant edges, apply ratio constraint, enforce minimum size (e.g., 1x1)
- Move: offset `_cropRect` x/y by pointer delta, clamp to document bounds

**Pointer up:**
- Finalize the drag. `_cropRect` stays for adjustment.

### Aspect Ratio Constraint

Applied during both initial draw and handle resize:

- `'free'`: no constraint
- `'1:1'`, `'4:3'`, `'16:9'`, etc.: compute the shorter dimension from the longer, preserving the drag direction

Edge handles (N/S/E/W) when ratio-locked: the dragged axis is primary, the perpendicular axis is computed. Corner handles: the axis with the larger delta is primary.

### Commit Flow

When Enter is pressed with an active `_cropRect`:

1. Snapshot all layers' `ImageData` and current `documentWidth`/`documentHeight` as before-state
2. For each layer:
   - `getImageData(cropRect.x, cropRect.y, cropRect.w, cropRect.h)` from the layer's offscreen canvas
   - Create a new `HTMLCanvasElement` at crop dimensions
   - `putImageData()` the extracted region at (0, 0)
   - Replace the layer's `.canvas` reference
3. Dispatch `crop-commit` custom event to `drawing-app` with the new dimensions
4. `drawing-app` updates `documentWidth`/`documentHeight` directly (NOT via the existing `setDocumentSize()`, which clears the history stack). A new `_applyDocumentDimensions(w, h)` helper sets the dimensions without side effects.
5. Snapshot all layers again as after-state
6. Push `crop` history entry
7. Clear `_cropRect`, re-composite display canvas

### History Entry

New discriminated union member in `HistoryEntry`:

```typescript
{
  type: 'crop';
  beforeLayers: LayerSnapshot[];
  afterLayers: LayerSnapshot[];
  beforeWidth: number;
  beforeHeight: number;
  afterWidth: number;
  afterHeight: number;
}
```

**Undo:** Restore all layer canvases from `beforeLayers`, reset document dimensions to `beforeWidth`/`beforeHeight`. This is a structural operation — `drawing-canvas` dispatches a `layer-undo` event with a new `action: 'crop-restore'` variant carrying `{ layers: LayerSnapshot[], width: number, height: number }`. `drawing-app` handles this by calling `_applyDocumentDimensions()` and replacing all layer canvases.

**Redo:** Same mechanism — dispatches `layer-undo` with `action: 'crop-restore'` carrying the after-state layers and dimensions.

**Serialization:** The `crop` entry needs both a runtime type (`HistoryEntry`) and a serialized type (`SerializedHistoryEntry`). The serialized variant replaces `LayerSnapshot[]` with `SerializedLayerSnapshot[]` (ImageData → Blob). New `case 'crop'` arms are added to both the serialize and deserialize switch statements in `project-store.ts`.

### Tool Settings

`tool-settings.ts` renders when `activeTool === 'crop'`:

- **Aspect ratio dropdown** with options: Free, 1:1, 4:3, 3:2, 16:9, 3:4, 2:3, 9:16
- Selected value stored as `cropAspectRatio: string` in `DrawingState` (default: `'free'`)
- Changing the ratio while a crop rect is active does not retroactively adjust it — it applies to the next resize/draw action

### Toolbar & Icon

- **Toolbar group**: First group becomes `['select', 'move', 'crop', 'hand']`
- **Icon**: Overlapping L-shaped corners (standard crop icon), 24x24 SVG viewBox
- **Shortcut**: `R`
- **Label**: `"Crop"`

## Files Changed

| File | Change |
|---|---|
| `src/types.ts` | Add `'crop'` to `ToolType` union. Add `crop` variant to both `HistoryEntry` and `SerializedHistoryEntry` unions. Add `cropAspectRatio: string` to `DrawingState`. |
| `src/tools/crop.ts` | **New file.** Stateless functions: `drawCropOverlay(ctx, cropRect, docWidth, docHeight, zoom)` renders the dim overlay, border, handles (fixed screen-space size via zoom), and dimensions label on the preview canvas. `hitTestCropHandle(cropRect, point, zoom)` returns `CropHandle` or null, using zoom-adjusted hit threshold. |
| `src/components/drawing-canvas.ts` | Crop state fields (`CropHandle` type). Pointer event dispatch for `'crop'` tool. Commit/cancel logic. Integration with preview render loop. Push `crop` history entry. Undo/redo dispatch for `crop` entries via `layer-undo` with `action: 'crop-restore'`. |
| `src/components/drawing-app.ts` | Listen for `crop-commit` event. New `_applyDocumentDimensions(w, h)` helper (does NOT clear history, unlike `setDocumentSize()`). Handle `'crop-restore'` action in `layer-undo` event. Handle Enter/Escape keyboard events for crop confirm/cancel (dispatches to canvas via `commitCrop()`/`cancelCrop()` methods). Wire `cropAspectRatio` into context. Initialize `cropAspectRatio` in default state. |
| `src/components/app-toolbar.ts` | Add `'crop'` to first tool group. |
| `src/components/tool-icons.ts` | Add `toolIcons['crop']` SVG, `toolLabels['crop']`, `toolShortcuts['crop']`. |
| `src/components/tool-settings.ts` | Add aspect ratio dropdown section when `activeTool === 'crop'`. |
| `src/project-store.ts` | Serialize/deserialize `crop` history entries (LayerSnapshot[] ↔ Blob[]). |
| `src/contexts/drawing-context.ts` | Add `cropAspectRatio` to `DrawingContextValue` and setter method. |

## Edge Cases

- **Crop rect extends beyond document**: Clamp to document bounds. `getImageData` handles out-of-bounds by returning transparent pixels, but we should clamp for a clean UX.
- **Crop rect is zero-size or too small**: Enforce minimum 1x1 pixel. If the user releases without dragging, discard the rect.
- **Active float when crop is activated**: Commit the float first (existing pattern — `drawing-app` already does this on tool switch).
- **Single layer vs multiple layers**: Same logic — iterate all layers regardless of count.
- **Undo after further drawing**: The crop entry sits in the history stack like any other. Undoing past it restores original dimensions and all layer content.
- **Changing aspect ratio with active rect**: Does not retroactively adjust the current crop rect — the new ratio applies on the next resize or draw action. This is a deliberate choice to avoid surprising repositioning.
- **Memory cost**: The crop history entry stores full `LayerSnapshot[]` for all layers in both before and after state. This is heavier than a single-layer `draw` entry. Accepted trade-off for atomic undo/redo correctness.

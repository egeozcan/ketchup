# Merge Layers Design

Adds Photoshop-style layer merge operations: Merge Down, Merge Visible, and Flatten Image.

## Operations

### Merge Down

Composites the active layer onto the layer directly below it. The active layer is removed, and the layer below becomes the merged result, keeping its name and ID. Disabled when the active layer is the bottom-most layer.

### Merge Visible

Composites all visible layers (respecting opacity and z-order) onto a single layer. The result is placed at the position of the bottom-most visible layer, keeping its name and ID. All other visible layers are removed. Hidden layers remain untouched and their positions shift accordingly. Disabled when fewer than 2 layers are visible.

### Flatten Image

Composites all visible layers onto a single layer at the bottom. Hidden layers are discarded (not drawn). The result keeps the bottom-most visible layer's name and ID, with opacity 1.0. The canvas is left with exactly one layer. Disabled when there is only 1 layer.

### Preconditions

All three operations commit any active floating selection before executing, following the same pattern as crop.

## Compositing Logic

All three operations share a core merge function:

1. Create a temporary offscreen canvas at the document's dimensions.
2. For each source layer (bottom-to-top order):
   - Set `globalAlpha` to the layer's opacity.
   - `drawImage(layer.canvas, 0, 0)` onto the temp canvas.
3. The temp canvas becomes the merged layer's canvas, with opacity set to 1.0.

**Merge Down** composites exactly 2 layers: the layer below first (at its opacity), then the active layer on top (at its opacity).

**Merge Visible** composites all layers where `visible === true`, in their z-order.

**Flatten** composites only visible layers in z-order. Hidden layers are discarded rather than drawn.

The merged layer inherits the target layer's `id`, `name`, and `visible` state. Its `opacity` is always reset to 1.0 since opacity has been baked into the pixels.

## History

A new `merge` variant in the `HistoryEntry` discriminated union, following the same `beforeLayers`/`afterLayers` pattern as `crop`:

```typescript
{
  type: 'merge';
  beforeLayers: LayerSnapshot[];      // full layer stack snapshot before merge
  afterLayers: LayerSnapshot[];       // full layer stack snapshot after merge
  previousActiveLayerId: string;      // active layer ID before merge
  afterActiveLayerId: string;         // active layer ID after merge
}
```

**Undo:** Replace the entire layer stack with `beforeLayers` (recreating canvases from ImageData), set active layer to `previousActiveLayerId`.

**Redo:** Replace the entire layer stack with `afterLayers` (recreating canvases from ImageData), set active layer to `afterActiveLayerId`.

This is the same approach as `crop` — a full stack snapshot avoids surgical index math and handles all three merge operations uniformly. Memory cost is proportional to total layer count, same trade-off as crop.

## Undo/Redo Flow

Merge operations are layer structural operations and follow the existing event-based undo pattern, reusing the same `crop-restore` mechanism:

**Recording:** `drawing-app.ts` calls `this.canvas.pushLayerOperation(mergeEntry)` after performing the merge.

**Undo path:**

1. `drawing-canvas.ts` `_applyUndo()` matches `type: 'merge'`.
2. Dispatches `layer-undo` custom event with action `'crop-restore'` and `beforeLayers`.
3. `drawing-app.ts` `_onLayerUndo()` handles `'crop-restore'` (existing handler): replaces layer stack, restores active layer ID.
4. Calls `_markDirty()` and `composite()`.

**Redo path:**

1. `drawing-canvas.ts` `_applyRedo()` matches `type: 'merge'`.
2. Dispatches `layer-undo` custom event with action `'crop-restore'` and `afterLayers`.
3. `drawing-app.ts` handles it via the existing `'crop-restore'` handler: replaces layer stack, sets active layer.

## UI Integration

### Context menu on layer rows

Right-click a layer row in the layers panel to show a context menu with:

- "Merge Down" — disabled if active layer is the bottom layer
- "Merge Visible" — disabled if fewer than 2 layers are visible
- "Flatten Image" — disabled if there's only 1 layer

### Dropdown menu in the action bar

A menu button (e.g. "..." or merge icon) next to the existing add/delete buttons in the layers panel footer. Same three items with the same enable/disable logic. Clicking outside the menu or pressing Escape closes it.

### Context methods

Three new methods on `DrawingContextValue`:

- `mergeLayerDown(id: string): void`
- `mergeVisibleLayers(): void`
- `flattenImage(): void`

Implementation lives in `drawing-app.ts`, triggered from `layers-panel.ts` via context.

### Keyboard shortcuts

None for now. Can be added later if needed.

## Edge Cases

- **Single layer:** All three operations are disabled when only one layer exists.
- **Floating selection:** Committed before any merge operation.
- **Active layer after merge:**
  - Merge Down: the merged (lower) layer becomes active.
  - Merge Visible: the merged result layer becomes active, regardless of which layer was previously active (even if the active layer was visible and got merged away).
  - Flatten: the single remaining layer becomes active.
- **All layers hidden except one:** "Merge Visible" is disabled (needs 2+ visible). "Flatten" still works.
- **Active layer is hidden during Merge Visible:** Hidden layers are kept and not involved in the merge. If the active layer is hidden, it remains in the layer stack and stays active.
- **Canvas dimensions:** All operations work at existing document dimensions. No canvas resizing.

## Files Modified

- `src/types.ts` — add `merge` variant to `HistoryEntry` union
- `src/contexts/drawing-context.ts` — add three merge methods to `DrawingContextValue`
- `src/components/drawing-app.ts` — implement merge logic, push history, handle undo/redo events
- `src/components/drawing-canvas.ts` — handle `merge` type in `_applyUndo`/`_applyRedo`, dispatch layer-undo events
- `src/components/layers-panel.ts` — add context menu and action bar dropdown menu

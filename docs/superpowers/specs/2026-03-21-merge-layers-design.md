# Merge Layers Design

Adds Photoshop-style layer merge operations: Merge Down, Merge Visible, and Flatten Image.

## Operations

### Merge Down

Composites the active layer onto the layer directly below it. The active layer is removed, and the layer below becomes the merged result, keeping its name and ID. Disabled when the active layer is the bottom-most layer.

### Merge Visible

Composites all visible layers (respecting opacity and z-order) onto a single layer. The result is placed at the position of the bottom-most visible layer, keeping its name and ID. All other visible layers are removed. Hidden layers remain untouched and their positions shift accordingly. Disabled when fewer than 2 layers are visible.

### Flatten Image

Composites all visible layers onto a single layer at the bottom. Hidden layers are discarded (not drawn). The result keeps the bottom-most layer's name with opacity 1.0. The canvas is left with exactly one layer. Disabled when there is only 1 layer.

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

A new `merge` variant in the `HistoryEntry` discriminated union:

```typescript
{
  type: 'merge';
  sourceLayers: LayerSnapshot[];  // all layers involved, with their ImageData
  sourceIndices: number[];        // original positions in the layers array
  mergedLayer: LayerSnapshot;     // the result layer with its ImageData
  mergedIndex: number;            // position of the result in the layers array
  previousActiveLayerId: string;  // to restore active layer on undo
}
```

**Undo:** Remove the merged layer, restore all source layers at their original indices (inserted in order), restore the previous active layer ID.

**Redo:** Remove source layers, insert the merged layer at `mergedIndex`, set it as active.

This follows the same snapshot approach as `crop`. Memory cost is proportional to the layers involved.

## Undo/Redo Flow

Merge operations are layer structural operations and follow the existing event-based undo pattern:

**Recording:** `drawing-app.ts` calls `this.canvas.pushLayerOperation(mergeEntry)` after performing the merge.

**Undo path:**

1. `drawing-canvas.ts` `_applyUndo()` matches `type: 'merge'`.
2. Dispatches `layer-undo` custom event with action `'restore-merge'` and the source layer snapshots/indices.
3. `drawing-app.ts` `_onLayerUndo()` handles `'restore-merge'`: removes merged layer, recreates source layers from snapshots at their original indices, restores active layer ID.
4. Calls `_markDirty()` and `composite()`.

**Redo path:**

1. `drawing-canvas.ts` `_applyRedo()` matches `type: 'merge'`.
2. Dispatches `layer-undo` custom event with action `'apply-merge'` and the merged layer snapshot/index.
3. `drawing-app.ts` handles it: removes source layers, inserts merged layer, sets it active.

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
  - Merge Visible: the merged layer (at bottom-most visible position) becomes active.
  - Flatten: the single remaining layer becomes active.
- **All layers hidden except one:** "Merge Visible" is disabled (needs 2+ visible). "Flatten" still works.
- **Active layer is hidden during Merge Visible:** Hidden layers are kept and not involved. The active layer stays active if it is hidden.
- **Canvas dimensions:** All operations work at existing document dimensions. No canvas resizing.

## Files Modified

- `src/types.ts` — add `merge` variant to `HistoryEntry` union
- `src/contexts/drawing-context.ts` — add three merge methods to `DrawingContextValue`
- `src/components/drawing-app.ts` — implement merge logic, push history, handle undo/redo events
- `src/components/drawing-canvas.ts` — handle `merge` type in `_applyUndo`/`_applyRedo`, dispatch layer-undo events
- `src/components/layers-panel.ts` — add context menu and action bar dropdown menu

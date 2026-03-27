import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import type { HistoryEntry } from '../src/types.ts';
import { makeAppCanvasStub } from './helpers.ts';

/**
 * Bug: _onLayerUndo 'reorder' handler uses splice indices without bounds
 * checking. When a reorder history entry contains indices that are out of
 * bounds for the current layer array, splice(outOfBoundsIndex, 1) returns
 * an empty array, so `moved` is `undefined`. The subsequent
 * splice(toIndex, 0, undefined) inserts `undefined` into the layers array,
 * corrupting it.
 *
 * This can happen in practice when cancelExternalFloat removes a layer but
 * keeps reorder history entries (because reorder entries have no layerId).
 * The stale indices reference positions that existed when the extra layer
 * was present but are out of bounds after the layer is removed.
 *
 * Repro scenario:
 *   1. Start with 2 layers [A, B].
 *   2. Paste an external image → adds layer C at index 2 → [A, B, C].
 *   3. While the float is active, reorder layer C from index 2 to index 0.
 *      History records { type: 'reorder', fromIndex: 2, toIndex: 0 }.
 *   4. Cancel the external float (Escape) → removes C → layers become [A, B].
 *      cancelExternalFloat strips add-layer and layer-specific entries for C
 *      but KEEPS the reorder entry because _getEntryLayerId('reorder') returns null.
 *   5. Undo the reorder → _applyUndo dispatches
 *      { action: 'reorder', fromIndex: 0 (entry.toIndex), toIndex: 2 (entry.fromIndex) }.
 *   6. _onLayerUndo handler does:
 *        splice(0, 1) → removes A → [B]
 *        splice(2, 0, A) → inserts A at index 2 (past the end) → [B, A]
 *      This silently reorders the layers when they should not have been affected.
 *
 * Root cause: The reorder handler in _onLayerUndo does not validate that the
 * stored indices are within bounds for the current layer array, and the
 * cancelExternalFloat pruning logic does not remove reorder entries that
 * involved the cancelled layer.
 */
describe('Reorder undo with stale indices after cancelExternalFloat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('corrupts layer order when undoing a reorder with out-of-range toIndex', () => {
    const app = new DrawingApp();

    // Stub the canvas so pushLayerOperation and clearSelection work.
    const historyEntries: HistoryEntry[] = [];
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub({
        pushLayerOperation: vi.fn((entry: HistoryEntry) => {
          historyEntries.push(entry);
        }),
      }),
    });

    // Add a second layer so we have [Layer 1, Layer 2].
    const ctx = (app as any)._buildContextValue();
    ctx.addLayer();

    const layers = (app as any)._state.layers;
    expect(layers).toHaveLength(2);
    const layerA = layers[0];
    const layerB = layers[1];

    // Simulate the situation after cancelExternalFloat has removed a third
    // layer but left a reorder entry with stale indices in the history.
    //
    // The stale reorder entry was: { fromIndex: 2, toIndex: 0 }
    // (moving the now-removed layer C from index 2 to index 0)
    //
    // When undoing this reorder, _applyUndo reverses the indices:
    // dispatches { action: 'reorder', fromIndex: 0, toIndex: 2 }
    //
    // For a 2-element array, fromIndex=0 is valid but toIndex=2 is
    // out of bounds (max valid index is 1 after removal = 0).
    const event = new CustomEvent('layer-undo', {
      bubbles: true,
      composed: true,
      detail: { action: 'reorder', fromIndex: 0, toIndex: 2 },
    });
    (app as any)._onLayerUndo(event);

    // After the reorder, the layers should still be [A, B] in order.
    // BUG: The handler moves A from index 0 to index 2 (past the end of the
    // 2-element array), resulting in [B, A] instead of leaving the array
    // unchanged. The layers are silently reordered even though the reorder
    // entry was stale and should not have been applied.
    const layersAfter = (app as any)._state.layers;
    expect(layersAfter).toHaveLength(2);

    // The original order was [A, B]. After applying a stale reorder with
    // toIndex=2 (out of bounds for a 2-element array), the splice inserts
    // at the end, producing [B, A]. This is incorrect — the layers should
    // remain in their original order [A, B].
    expect(layersAfter[0].id).toBe(layerA.id);
    expect(layersAfter[1].id).toBe(layerB.id);
  });

  it('records the normalized destination index when reordering past the array end', () => {
    const app = new DrawingApp();

    const historyEntries: HistoryEntry[] = [];
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub({
        pushLayerOperation: vi.fn((entry: HistoryEntry) => {
          historyEntries.push(entry);
        }),
      }),
    });

    const ctx = (app as any)._buildContextValue();
    ctx.addLayer();
    ctx.addLayer();

    const [layerA] = (app as any)._state.layers;
    ctx.reorderLayer(layerA.id, 999);

    const reorderEntry = historyEntries[historyEntries.length - 1] as Extract<HistoryEntry, { type: 'reorder' }>;
    expect(reorderEntry.type).toBe('reorder');
    expect(reorderEntry.toIndex).toBe(2);
  });
});

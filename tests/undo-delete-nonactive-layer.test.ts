import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import type { HistoryEntry, LayerSnapshot } from '../src/types.ts';
import { makeAppCanvasStub } from './helpers.ts';

/**
 * Bug: Undoing deletion of a NON-active layer incorrectly switches the
 * active layer to the restored layer.
 *
 * Repro:
 *   1. Start with layers [A, B, C], active = A.
 *   2. Delete layer C (which is NOT the active layer).
 *      → layers become [A, B], active stays A. Correct.
 *   3. Undo the delete.
 *      → layer C is restored at its original index.
 *      → BUG: active becomes C instead of staying A.
 *
 * Root cause:
 *   The 'restore-layer' case in _onLayerUndo unconditionally sets
 *   `activeLayerId: layer.id` (the restored layer's ID), regardless of
 *   whether the deletion originally changed the active layer or not.
 *
 *   When deleting a non-active layer, the active layer ID is preserved.
 *   Therefore, undoing that deletion should also preserve the current
 *   active layer ID — but it doesn't.
 */
describe('Undo delete of non-active layer preserves active layer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not switch the active layer when restoring a non-active deleted layer', () => {
    const app = new DrawingApp();

    // Capture the first layer created by the constructor.
    const layerA = (app as any)._state.layers[0];

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

    // Add two more layers: [A, B, C].
    const ctx = (app as any)._buildContextValue();
    ctx.addLayer(); // B, inserted after A
    ctx.addLayer(); // C, inserted after B

    const layers = (app as any)._state.layers;
    expect(layers).toHaveLength(3);
    const layerB = layers[1];
    const layerC = layers[2];

    // Active layer is currently C (last one added). Switch to A.
    ctx.setActiveLayer(layerA.id);
    expect((app as any)._state.activeLayerId).toBe(layerA.id);

    // Delete layer C — a NON-active layer.
    ctx.deleteLayer(layerC.id);

    // After deletion: layers = [A, B], active = A (unchanged).
    const layersAfterDelete = (app as any)._state.layers;
    expect(layersAfterDelete).toHaveLength(2);
    expect(layersAfterDelete[0].id).toBe(layerA.id);
    expect(layersAfterDelete[1].id).toBe(layerB.id);
    expect((app as any)._state.activeLayerId).toBe(layerA.id);

    // The last history entry should be the delete-layer for C.
    const deleteEntry = historyEntries[historyEntries.length - 1];
    expect(deleteEntry.type).toBe('delete-layer');

    // Now simulate undo of delete-layer.
    // The drawing-canvas _applyUndo dispatches 'restore-layer' for delete-layer entries.
    const snapshot = (deleteEntry as any).layer as LayerSnapshot;
    const event = new CustomEvent('layer-undo', {
      bubbles: true,
      composed: true,
      detail: {
        action: 'restore-layer',
        snapshot,
        index: (deleteEntry as any).index,
      },
    });
    (app as any)._onLayerUndo(event);

    // After undo: layers should be [A, B, C] again.
    const layersAfterUndo = (app as any)._state.layers;
    expect(layersAfterUndo).toHaveLength(3);
    expect(layersAfterUndo[0].id).toBe(layerA.id);
    expect(layersAfterUndo[1].id).toBe(layerB.id);
    expect(layersAfterUndo[2].id).toBe(layerC.id);

    // BUG: The active layer should remain A (since deleting C didn't
    // change the active layer, undoing that delete shouldn't either).
    // The current code unconditionally sets activeLayerId to the
    // restored layer's ID, so it incorrectly becomes C.
    expect((app as any)._state.activeLayerId).toBe(layerA.id);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import type { HistoryEntry, LayerSnapshot } from '../src/types.ts';

/**
 * Bug: cancelExternalFloat drops reorder (and crop) history entries.
 *
 * When the user pastes an external image (creating a new layer with a float),
 * then performs a global operation like reorder or crop, and finally presses
 * Escape to cancel the paste, the history-cleanup filter in cancelExternalFloat
 * uses `entryLayerId !== null && entryLayerId !== layerId`. Since reorder and
 * crop entries return null from _getEntryLayerId, the condition
 * `null !== null` is false, so those entries are dropped from the history.
 *
 * Expected: reorder/crop entries should be preserved because they are global
 * operations unrelated to the cancelled layer.
 *
 * Root cause: src/components/drawing-canvas.ts, line ~2351
 *   return entryLayerId !== null && entryLayerId !== layerId;
 * Should be:
 *   return entryLayerId === null || entryLayerId !== layerId;
 */
describe('cancelExternalFloat preserves global history entries', () => {
  it('does not drop reorder history entries when cancelling an external float', () => {
    const canvas = new DrawingCanvas();

    // The layer created for the pasted image
    const pastedLayerId = 'pasted-layer';

    // Pre-existing layer
    const existingLayerId = 'existing-layer';

    // Set up context with the pasted layer as active
    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [
            { id: existingLayerId, name: 'Layer 1', visible: true, opacity: 1, canvas: document.createElement('canvas') },
            { id: pastedLayerId, name: 'Pasted Image', visible: true, opacity: 1, canvas: document.createElement('canvas') },
          ],
          activeLayerId: pastedLayerId,
          documentWidth: 800,
          documentHeight: 600,
        },
      },
    };

    // Set up the float as an external image
    (canvas as any)._float = {
      originalImageData: new ImageData(10, 10),
      currentRect: { x: 0, y: 0, w: 10, h: 10 },
      tempCanvas: document.createElement('canvas'),
    };
    (canvas as any)._floatIsExternalImage = true;

    // Build a history that contains:
    //  [0] some pre-existing draw on existing layer
    //  [1] add-layer for the pasted layer
    //  [2] a reorder entry (global operation, layerId = null)
    const drawEntry: HistoryEntry = {
      type: 'draw',
      layerId: existingLayerId,
      before: new ImageData(1, 1),
      after: new ImageData(1, 1),
    };

    const addLayerEntry: HistoryEntry = {
      type: 'add-layer',
      layer: {
        id: pastedLayerId,
        name: 'Pasted Image',
        visible: true,
        opacity: 1,
        imageData: new ImageData(1, 1),
      } as LayerSnapshot,
      index: 1,
    };

    const reorderEntry: HistoryEntry = {
      type: 'reorder',
      fromIndex: 0,
      toIndex: 1,
    };

    (canvas as any)._history = [drawEntry, addLayerEntry, reorderEntry];
    (canvas as any)._historyIndex = 2;

    // Stub _clearFloatState to prevent side effects
    (canvas as any)._clearFloatState = vi.fn();
    // Stub composite and _notifyHistory
    (canvas as any).composite = vi.fn();
    (canvas as any)._notifyHistory = vi.fn();
    // Stub dispatchEvent to capture events
    (canvas as any).dispatchEvent = vi.fn();

    // Act: cancel the external float (simulates pressing Escape)
    (canvas as any).cancelExternalFloat();

    // The history should contain:
    //  [0] the pre-existing draw entry
    //  [1] the reorder entry (should be preserved!)
    //
    // The add-layer entry for the pasted layer should be removed.
    // The reorder entry should NOT be removed — it's a global operation.
    const history: HistoryEntry[] = (canvas as any)._history;

    // The draw entry should still be there
    expect(history.some(e => e.type === 'draw' && e.layerId === existingLayerId)).toBe(true);

    // The add-layer entry for the pasted layer should be removed
    expect(history.some(e => e.type === 'add-layer' && e.layer.id === pastedLayerId)).toBe(false);

    // BUG: The reorder entry should be preserved, but the current code drops it
    // because _getEntryLayerId returns null for reorder entries, and the filter
    // condition `entryLayerId !== null && entryLayerId !== layerId` evaluates
    // to `false` when entryLayerId is null.
    expect(history.some(e => e.type === 'reorder')).toBe(true);
  });

  it('does not drop crop history entries when cancelling an external float', () => {
    const canvas = new DrawingCanvas();

    const pastedLayerId = 'pasted-layer';
    const existingLayerId = 'existing-layer';

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [
            { id: existingLayerId, name: 'Layer 1', visible: true, opacity: 1, canvas: document.createElement('canvas') },
            { id: pastedLayerId, name: 'Pasted Image', visible: true, opacity: 1, canvas: document.createElement('canvas') },
          ],
          activeLayerId: pastedLayerId,
          documentWidth: 400,
          documentHeight: 300,
        },
      },
    };

    (canvas as any)._float = {
      originalImageData: new ImageData(10, 10),
      currentRect: { x: 0, y: 0, w: 10, h: 10 },
      tempCanvas: document.createElement('canvas'),
    };
    (canvas as any)._floatIsExternalImage = true;

    const addLayerEntry: HistoryEntry = {
      type: 'add-layer',
      layer: {
        id: pastedLayerId,
        name: 'Pasted Image',
        visible: true,
        opacity: 1,
        imageData: new ImageData(1, 1),
      } as LayerSnapshot,
      index: 1,
    };

    const cropEntry: HistoryEntry = {
      type: 'crop',
      beforeLayers: [],
      afterLayers: [],
      beforeWidth: 800,
      beforeHeight: 600,
      afterWidth: 400,
      afterHeight: 300,
    };

    (canvas as any)._history = [addLayerEntry, cropEntry];
    (canvas as any)._historyIndex = 1;

    (canvas as any)._clearFloatState = vi.fn();
    (canvas as any).composite = vi.fn();
    (canvas as any)._notifyHistory = vi.fn();
    (canvas as any).dispatchEvent = vi.fn();

    (canvas as any).cancelExternalFloat();

    const history: HistoryEntry[] = (canvas as any)._history;

    // The add-layer entry should be removed
    expect(history.some(e => e.type === 'add-layer')).toBe(false);

    // BUG: The crop entry should be preserved, but it gets dropped
    expect(history.some(e => e.type === 'crop')).toBe(true);
  });
});

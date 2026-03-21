import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import type { HistoryEntry, LayerSnapshot } from '../src/types.ts';

/**
 * Bug: Undoing an "add layer" operation selects the WRONG layer.
 *
 * Repro:
 *   1. Start with layers [A, B, C], active = A (index 0).
 *   2. Add a new layer D → inserted at index 1, active becomes D.
 *   3. Undo the add → D is removed, but active becomes B (index 1)
 *      instead of reverting to A (the layer that was active before the add).
 *
 * Root cause:
 *   The 'remove-layer' handler in _onLayerUndo picks the active layer
 *   using `Math.min(removedIdx, newLayers.length - 1)`. This selects
 *   the layer at the position where the removed layer used to be, which
 *   is the layer ABOVE the one that was originally active — not the
 *   previously-active layer itself.
 *
 *   addLayer always inserts at `activeIdx + 1`, so `removedIdx` equals
 *   `activeIdx + 1`. After removing, `newLayers[removedIdx]` is the
 *   layer that was at `activeIdx + 2` (shifted down by one), not the
 *   layer at `activeIdx` (the original active layer).
 */
describe('Undo add-layer restores previous active layer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('selects the previously-active layer after undoing addLayer', () => {
    const app = new DrawingApp();

    // Capture the first layer that the constructor created.
    const layer1 = (app as any)._state.layers[0];

    // Stub the canvas so pushLayerOperation and clearSelection work.
    const historyEntries: HistoryEntry[] = [];
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        clearSelection: vi.fn(),
        pushLayerOperation: vi.fn((entry: HistoryEntry) => {
          historyEntries.push(entry);
        }),
      },
    });

    // Add two more layers so we have [Layer1, Layer2, Layer3].
    const ctx = (app as any)._buildContextValue();
    ctx.addLayer(); // Layer 2, inserted after Layer 1
    ctx.addLayer(); // Layer 3, inserted after Layer 2

    const layers = (app as any)._state.layers;
    expect(layers).toHaveLength(3);
    const layer2 = layers[1];
    const layer3 = layers[2];

    // The active layer is now Layer 3 (the last one added).
    expect((app as any)._state.activeLayerId).toBe(layer3.id);

    // Switch the active layer to Layer 1 (the bottom one).
    ctx.setActiveLayer(layer1.id);
    expect((app as any)._state.activeLayerId).toBe(layer1.id);

    // Now add a new layer. It should be inserted at index 1 (after Layer 1).
    ctx.addLayer(); // Layer 4
    const layersAfterAdd = (app as any)._state.layers;
    expect(layersAfterAdd).toHaveLength(4);
    const layer4 = layersAfterAdd[1]; // inserted at index 1

    // Active layer should be the newly added Layer 4.
    expect((app as any)._state.activeLayerId).toBe(layer4.id);

    // Verify the layer order is [Layer1, Layer4, Layer2, Layer3].
    expect(layersAfterAdd[0].id).toBe(layer1.id);
    expect(layersAfterAdd[1].id).toBe(layer4.id);
    expect(layersAfterAdd[2].id).toBe(layer2.id);
    expect(layersAfterAdd[3].id).toBe(layer3.id);

    // Now simulate undo: fire the 'remove-layer' event that the
    // drawing-canvas would dispatch when undoing 'add-layer'.
    // The last history entry should be the add-layer for Layer 4.
    const addEntry = historyEntries[historyEntries.length - 1];
    expect(addEntry.type).toBe('add-layer');

    // Fire the layer-undo event as the canvas would during undo.
    const event = new CustomEvent('layer-undo', {
      bubbles: true,
      composed: true,
      detail: { action: 'remove-layer', layerId: layer4.id },
    });
    (app as any)._onLayerUndo(event);

    // After undo, the layers should be back to [Layer1, Layer2, Layer3].
    const layersAfterUndo = (app as any)._state.layers;
    expect(layersAfterUndo).toHaveLength(3);
    expect(layersAfterUndo[0].id).toBe(layer1.id);
    expect(layersAfterUndo[1].id).toBe(layer2.id);
    expect(layersAfterUndo[2].id).toBe(layer3.id);

    // BUG: The active layer should revert to Layer 1 (the layer that
    // was active before the add), but the current code selects Layer 2
    // (the layer at the removed position).
    expect((app as any)._state.activeLayerId).toBe(layer1.id);
  });
});

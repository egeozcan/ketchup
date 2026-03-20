import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: Deleting a pasted (or externally-placed) floating selection does not push
 * a history entry, making the delete irreversible.
 *
 * Root cause: `deleteSelection()` calls `_pushDrawHistory()` without `force`.
 * The no-op detection inside `_pushDrawHistory()` compares `_beforeDrawData`
 * (captured at paste time) with the current layer pixel data. Because a pasted
 * float is an overlay that has NOT modified the underlying layer canvas, the
 * before and after ImageData are byte-identical. The no-op check causes the
 * entry to be silently skipped. The float is then cleared by `_clearFloatState()`,
 * so the pasted content vanishes with no way to undo.
 *
 * In contrast, a float created via the *selection tool* (lifting pixels from the
 * layer) DOES modify the layer (clearing the lifted region), so before != after
 * and a history entry is pushed correctly.
 *
 * Expected: After pasting and then deleting, a history entry should be pushed
 * so that undo restores the pasted content.
 *
 * File: src/components/drawing-canvas.ts
 * Method: deleteSelection() (~line 2284) and _pushDrawHistory() (~line 364)
 */
describe('deleteSelection on a pasted float should push a history entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setupCanvas() {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;
    // Fill with white so we have a known state
    const layerCtx = layerCanvas.getContext('2d')!;
    layerCtx.fillStyle = '#ffffff';
    layerCtx.fillRect(0, 0, 800, 600);

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          activeTool: 'select',
          strokeColor: '#000000',
          fillColor: '#ff0000',
          useFill: false,
          brushSize: 4,
          documentWidth: 800,
          documentHeight: 600,
          stampImage: null,
          cropAspectRatio: 'free',
          fontFamily: 'sans-serif',
          fontSize: 24,
          fontBold: false,
          fontItalic: false,
        },
      },
    };

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 800;
    previewCanvas.height = 600;
    Object.defineProperty(canvas, 'previewCanvas', {
      configurable: true,
      value: previewCanvas,
    });

    const mainCanvas = document.createElement('canvas');
    mainCanvas.width = 800;
    mainCanvas.height = 600;
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: mainCanvas,
    });

    (canvas as any).composite = vi.fn();
    (canvas as any).dispatchEvent = vi.fn();

    return { canvas, layerCanvas };
  }

  it('should push a history entry when deleting a pasted float', () => {
    const { canvas, layerCanvas } = setupCanvas();

    // Simulate having clipboard data (as if user copied a selection earlier).
    // The clipboard contains a 50x50 red square.
    const clipW = 50;
    const clipH = 50;
    const clipData = new ImageData(clipW, clipH);
    // Fill with red pixels
    for (let i = 0; i < clipData.data.length; i += 4) {
      clipData.data[i] = 255;     // R
      clipData.data[i + 1] = 0;   // G
      clipData.data[i + 2] = 0;   // B
      clipData.data[i + 3] = 255; // A
    }
    (canvas as any)._clipboard = clipData;
    (canvas as any)._clipboardOrigin = { x: 100, y: 100 };

    // Start with a clean history
    (canvas as any)._history = [];
    (canvas as any)._historyIndex = -1;

    // Paste the selection — this creates a float WITHOUT modifying the layer
    canvas.pasteSelection();

    // Verify the float was created
    expect((canvas as any)._float).not.toBeNull();
    expect((canvas as any)._float.currentRect).toEqual({ x: 100, y: 100, w: 50, h: 50 });

    // Verify _beforeDrawData was captured
    expect((canvas as any)._beforeDrawData).not.toBeNull();

    // Record history state before delete
    const historyLengthBeforeDelete = (canvas as any)._history.length;
    const historyIndexBeforeDelete = (canvas as any)._historyIndex;

    // Delete the selection — this should push a history entry so the user
    // can undo and get the pasted content back
    canvas.deleteSelection();

    // The float should be gone
    expect((canvas as any)._float).toBeNull();

    // BUG: No history entry is pushed because _pushDrawHistory's no-op
    // detection sees that before == after (the layer wasn't modified by
    // the paste — only the float overlay was). This means the delete
    // cannot be undone.
    //
    // Expected: historyIndex should have incremented (new entry pushed)
    // Actual (buggy): historyIndex is unchanged because entry was skipped
    expect((canvas as any)._history.length).toBeGreaterThan(historyLengthBeforeDelete);
  });

  it('should allow undo after deleting a pasted float', () => {
    const { canvas, layerCanvas } = setupCanvas();

    // Set up clipboard data
    const clipW = 50;
    const clipH = 50;
    const clipData = new ImageData(clipW, clipH);
    for (let i = 0; i < clipData.data.length; i += 4) {
      clipData.data[i] = 255;
      clipData.data[i + 3] = 255;
    }
    (canvas as any)._clipboard = clipData;
    (canvas as any)._clipboardOrigin = { x: 10, y: 10 };

    // Put one real history entry in the stack (simulating a previous draw)
    const layerCtx = layerCanvas.getContext('2d')!;
    const beforeData = layerCtx.getImageData(0, 0, 800, 600);
    const afterData = layerCtx.getImageData(0, 0, 800, 600);
    afterData.data[0] = 42; // make them different
    (canvas as any)._history = [
      { type: 'draw', layerId: 'l1', before: beforeData, after: afterData },
    ];
    (canvas as any)._historyIndex = 0;

    // Paste and delete
    canvas.pasteSelection();
    canvas.deleteSelection();

    // BUG: After deleting the pasted float, the historyIndex should point
    // to a NEW entry (index 1), not still at 0. Because no entry was pushed,
    // calling undo() would undo the PREVIOUS unrelated draw operation instead
    // of restoring the deleted pasted content.
    expect((canvas as any)._historyIndex).toBe(1);
  });
});

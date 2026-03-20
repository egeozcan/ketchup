import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: Pressing undo (Ctrl+Z) while dragging a shape (rectangle, circle, line,
 * triangle) cancels the in-progress shape AND also undoes the previous history
 * entry. The user expects only the shape to be cancelled -- one undo press
 * should equal one logical action.
 *
 * Root cause: Shape tools delay _captureBeforeDraw() until pointerUp (since
 * they only commit on release). This means _beforeDrawData is null during the
 * drag. When undo() is called mid-drag, it enters the `if (this._drawing)`
 * block and calls _pushDrawHistory(), which returns early because
 * _beforeDrawData is null -- so no history entry is pushed for the in-progress
 * shape. Because there is no early return after handling the _drawing block,
 * the code falls through to the main undo logic which decrements
 * _historyIndex and applies undo on the PREVIOUS entry.
 *
 * For comparison, brush tools (pencil/marker/eraser) capture _beforeDrawData
 * on pointerDown, so _pushDrawHistory() succeeds and pushes a partial-stroke
 * entry. The main undo logic then undoes THAT entry -- effectively cancelling
 * only the current stroke with no net history change.
 *
 * File: src/components/drawing-canvas.ts
 * Lines: ~445-480 (undo method) and ~1027-1036 (_onPointerDown for shapes)
 */
describe('undo during shape drag should not undo previous entry', () => {
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

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          activeTool: 'rectangle',
          strokeColor: '#000000',
          fillColor: '#ff0000',
          useFill: false,
          brushSize: 4,
          documentWidth: 800,
          documentHeight: 600,
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

    (canvas as any).composite = vi.fn();
    (canvas as any).dispatchEvent = vi.fn();

    return { canvas, layerCanvas };
  }

  it('does not decrement historyIndex when undo is called during an in-progress rectangle', () => {
    const { canvas, layerCanvas } = setupCanvas();
    const layerCtx = layerCanvas.getContext('2d')!;

    // Set up one existing history entry (simulating a previous completed operation)
    const beforeData = layerCtx.getImageData(0, 0, 800, 600);
    const afterData = layerCtx.getImageData(0, 0, 800, 600);
    // Manually tweak a pixel so before != after (mock canvas may not track real draws)
    afterData.data[0] = 255;

    (canvas as any)._history = [
      { type: 'draw', layerId: 'l1', before: beforeData, after: afterData },
    ];
    (canvas as any)._historyIndex = 0;

    // Simulate the state during a shape drag:
    // - _drawing = true (set by _onPointerDown for shapes)
    // - _startPoint/_lastPoint set (set by _onPointerDown)
    // - _beforeDrawData = null (NOT captured for shapes during pointerDown)
    (canvas as any)._drawing = true;
    (canvas as any)._startPoint = { x: 10, y: 10 };
    (canvas as any)._lastPoint = { x: 100, y: 100 };
    (canvas as any)._beforeDrawData = null;

    // Call undo -- simulates pressing Ctrl+Z while dragging a rectangle
    (canvas as any).undo();

    // The shape should be cancelled
    expect((canvas as any)._drawing).toBe(false);
    expect((canvas as any)._startPoint).toBeNull();
    expect((canvas as any)._lastPoint).toBeNull();

    // BUG: historyIndex should remain at 0 because only the in-progress
    // shape was cancelled. No completed history entry should have been undone.
    // Due to the bug, historyIndex is decremented to -1.
    expect((canvas as any)._historyIndex).toBe(0);
  });

  it('does not decrement historyIndex for any shape tool type (circle, line, triangle)', () => {
    for (const tool of ['circle', 'line', 'triangle'] as const) {
      const { canvas, layerCanvas } = setupCanvas();
      const layerCtx = layerCanvas.getContext('2d')!;

      (canvas as any)._ctx.value.state.activeTool = tool;

      const beforeData = layerCtx.getImageData(0, 0, 800, 600);
      const afterData = layerCtx.getImageData(0, 0, 800, 600);
      afterData.data[0] = 255;

      (canvas as any)._history = [
        { type: 'draw', layerId: 'l1', before: beforeData, after: afterData },
      ];
      (canvas as any)._historyIndex = 0;

      (canvas as any)._drawing = true;
      (canvas as any)._startPoint = { x: 10, y: 10 };
      (canvas as any)._lastPoint = { x: 100, y: 100 };
      (canvas as any)._beforeDrawData = null;

      (canvas as any).undo();

      // Same bug: historyIndex should be 0, but the bug makes it -1
      expect((canvas as any)._historyIndex).toBe(0);
    }
  });

  it('does not call _applyUndo when shape drag has no _beforeDrawData', () => {
    const { canvas, layerCanvas } = setupCanvas();
    const layerCtx = layerCanvas.getContext('2d')!;

    const beforeData = layerCtx.getImageData(0, 0, 800, 600);
    const afterData = layerCtx.getImageData(0, 0, 800, 600);

    (canvas as any)._history = [
      { type: 'draw', layerId: 'l1', before: beforeData, after: afterData },
    ];
    (canvas as any)._historyIndex = 0;

    // Spy on _applyUndo to verify it's not called
    const applyUndoSpy = vi.spyOn(canvas as any, '_applyUndo');

    // Simulate shape drag state
    (canvas as any)._drawing = true;
    (canvas as any)._startPoint = { x: 0, y: 0 };
    (canvas as any)._lastPoint = { x: 50, y: 50 };
    (canvas as any)._beforeDrawData = null;

    (canvas as any).undo();

    // _applyUndo should NOT have been called — only the shape drag was cancelled
    expect(applyUndoSpy).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: Pressing redo (Ctrl+Shift+Z) while dragging a shape (rectangle, circle,
 * line, triangle) cancels the in-progress shape AND also applies the next redo
 * entry. The user expects only the shape to be cancelled — one redo press
 * should equal one logical action.
 *
 * Root cause: The redo() method has the same structural issue that was already
 * fixed in undo() (bug #4). Shape tools delay _captureBeforeDraw() until
 * pointerUp, so _beforeDrawData is null during the drag. When redo() is
 * called mid-drag, it enters the `if (this._drawing)` block and calls
 * _pushDrawHistory(), which returns early because _beforeDrawData is null —
 * no history entry is pushed. Unlike undo(), redo() does NOT check whether
 * _beforeDrawData existed and return early. The code falls through to the
 * main redo logic which increments _historyIndex and applies the next redo
 * entry.
 *
 * The fix in undo() was to capture `hadBeforeData` before calling
 * _pushDrawHistory() and `if (!hadBeforeData) return;` afterward.
 * The same guard is missing from redo().
 *
 * File: src/components/drawing-canvas.ts
 * Lines: ~484-511 (redo method)
 */
describe('redo during shape drag should not apply the next redo entry', () => {
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

  it('does not increment historyIndex when redo is called during an in-progress rectangle', () => {
    const { canvas, layerCanvas } = setupCanvas();
    const layerCtx = layerCanvas.getContext('2d')!;

    // Set up two history entries: one already applied, one undone (available for redo)
    const imgData1 = layerCtx.getImageData(0, 0, 800, 600);
    const imgData2 = layerCtx.getImageData(0, 0, 800, 600);
    imgData2.data[0] = 255;
    const imgData3 = layerCtx.getImageData(0, 0, 800, 600);
    imgData3.data[0] = 128;

    (canvas as any)._history = [
      { type: 'draw', layerId: 'l1', before: imgData1, after: imgData2 },
      { type: 'draw', layerId: 'l1', before: imgData2, after: imgData3 },
    ];
    // historyIndex at 0 means entry[0] is applied, entry[1] is available for redo
    (canvas as any)._historyIndex = 0;

    // Simulate the state during a shape drag:
    // - _drawing = true (set by _onPointerDown for shapes)
    // - _startPoint/_lastPoint set (set by _onPointerDown)
    // - _beforeDrawData = null (NOT captured for shapes during pointerDown)
    (canvas as any)._drawing = true;
    (canvas as any)._startPoint = { x: 10, y: 10 };
    (canvas as any)._lastPoint = { x: 100, y: 100 };
    (canvas as any)._beforeDrawData = null;

    // Call redo -- simulates pressing Ctrl+Shift+Z while dragging a rectangle
    (canvas as any).redo();

    // The shape should be cancelled
    expect((canvas as any)._drawing).toBe(false);
    expect((canvas as any)._startPoint).toBeNull();
    expect((canvas as any)._lastPoint).toBeNull();

    // BUG: historyIndex should remain at 0 because only the in-progress
    // shape was cancelled. No redo entry should have been applied.
    // Due to the bug, historyIndex is incremented to 1.
    expect((canvas as any)._historyIndex).toBe(0);
  });

  it('does not increment historyIndex for any shape tool type (circle, line, triangle)', () => {
    for (const tool of ['circle', 'line', 'triangle'] as const) {
      const { canvas, layerCanvas } = setupCanvas();
      const layerCtx = layerCanvas.getContext('2d')!;

      (canvas as any)._ctx.value.state.activeTool = tool;

      const imgData1 = layerCtx.getImageData(0, 0, 800, 600);
      const imgData2 = layerCtx.getImageData(0, 0, 800, 600);
      imgData2.data[0] = 255;
      const imgData3 = layerCtx.getImageData(0, 0, 800, 600);
      imgData3.data[0] = 128;

      (canvas as any)._history = [
        { type: 'draw', layerId: 'l1', before: imgData1, after: imgData2 },
        { type: 'draw', layerId: 'l1', before: imgData2, after: imgData3 },
      ];
      (canvas as any)._historyIndex = 0;

      (canvas as any)._drawing = true;
      (canvas as any)._startPoint = { x: 10, y: 10 };
      (canvas as any)._lastPoint = { x: 100, y: 100 };
      (canvas as any)._beforeDrawData = null;

      (canvas as any).redo();

      // Same bug: historyIndex should be 0, but the bug makes it 1
      expect((canvas as any)._historyIndex).toBe(0);
    }
  });

  it('does not call _applyRedo when shape drag has no _beforeDrawData', () => {
    const { canvas, layerCanvas } = setupCanvas();
    const layerCtx = layerCanvas.getContext('2d')!;

    const imgData1 = layerCtx.getImageData(0, 0, 800, 600);
    const imgData2 = layerCtx.getImageData(0, 0, 800, 600);
    imgData2.data[0] = 255;

    (canvas as any)._history = [
      { type: 'draw', layerId: 'l1', before: imgData1, after: imgData2 },
    ];
    // historyIndex at -1 means entry[0] is available for redo
    (canvas as any)._historyIndex = -1;

    // Spy on _applyRedo to verify it's not called
    const applyRedoSpy = vi.spyOn(canvas as any, '_applyRedo');

    // Simulate shape drag state
    (canvas as any)._drawing = true;
    (canvas as any)._startPoint = { x: 0, y: 0 };
    (canvas as any)._lastPoint = { x: 50, y: 50 };
    (canvas as any)._beforeDrawData = null;

    (canvas as any).redo();

    // _applyRedo should NOT have been called — only the shape drag was cancelled
    expect(applyRedoSpy).not.toHaveBeenCalled();
  });
});

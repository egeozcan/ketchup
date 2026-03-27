import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: clearSelection() does not reset the _selectionDrawing flag.
 *
 * Repro:
 *   1. Switch to the select tool and begin dragging a selection rectangle
 *      (_selectionDrawing = true, _startPoint set to drag origin).
 *   2. While still dragging (before pointerup), press a keyboard shortcut to
 *      switch to a different tool (e.g. 'p' for pencil).
 *      → drawing-app calls canvas.clearSelection() then changes the tool.
 *   3. clearSelection() commits any float and finalises any brush/move
 *      stroke, but it does NOT reset _selectionDrawing or _startPoint.
 *   4. Later the user switches back to the select tool.
 *   5. On pointer-move (without clicking), _handleSelectPointerMove checks
 *      `if (this._selectionDrawing && this._startPoint)` — both are still
 *      truthy from step 1, so a spurious selection rectangle is drawn on the
 *      preview canvas using the stale _startPoint.
 *
 * Root cause:
 *   clearSelection() handles _drawing, _moveTempCanvas, _textEditing, _cropRect,
 *   and _float — but never checks or resets _selectionDrawing.  When no float
 *   exists, _commitFloat() returns early without calling _clearFloatState()
 *   (which would have reset _selectionDrawing).
 *
 * Expected:
 *   After clearSelection(), _selectionDrawing must be false so that a stale
 *   in-progress selection rectangle cannot leak into subsequent tool usage.
 */
describe('clearSelection resets _selectionDrawing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('resets _selectionDrawing when called mid-selection-drag', () => {
    const canvas = new DrawingCanvas();

    // Simulate a selection drag in progress (pointerdown fired, pointerup not yet).
    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: 50, y: 50 };

    // No transform exists before the tool switch.
    expect((canvas as any)._transformManager).toBeNull();

    // Call clearSelection() — this is what happens when the user switches tools.
    canvas.clearSelection();

    // BUG: _selectionDrawing is still true after clearSelection().
    // After the fix it should be false.
    expect((canvas as any)._selectionDrawing).toBe(false);
  });

  it('resets _startPoint so pointer-move does not draw a stale rectangle', () => {
    const canvas = new DrawingCanvas();

    // Simulate mid-selection state.
    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: 100, y: 200 };

    canvas.clearSelection();

    // After clearSelection, _startPoint should be cleared so that
    // _handleSelectPointerMove cannot use the stale value.
    // (Either _selectionDrawing being false OR _startPoint being null
    // would prevent the spurious draw; testing both for robustness.)
    const drawingFlag = (canvas as any)._selectionDrawing;
    const startPoint = (canvas as any)._startPoint;

    // At least one of these must be falsy to prevent the stale preview.
    expect(drawingFlag && startPoint).toBeFalsy();
  });
});

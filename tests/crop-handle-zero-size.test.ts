import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import type { HistoryEntry } from '../src/types.ts';

/**
 * Bug: Resizing a crop rect via drag handles can produce a zero-width or
 * zero-height crop rect, because _handleCropPointerUp only enforces a
 * minimum size (w >= 1, h >= 1) when a NEW crop rect was drawn
 * (_cropDragging === true), but NOT when an existing rect was resized
 * via handles (_cropDragging === false, _cropHandle !== null).
 *
 * A zero-size crop rect, when committed via commitCrop(), calls
 * ctx.getImageData(x, y, 0, h) which throws an IndexSizeError per the
 * Canvas spec (width and height must be > 0).
 *
 * Steps to reproduce:
 * 1. Draw a crop rect on the canvas
 * 2. Drag the east (right) handle all the way to the left edge of the rect
 *    so the width becomes 0
 * 3. Release the pointer — the crop rect is normalized but NOT nulled out
 * 4. Press Enter to commit the crop
 * 5. Expected: the crop should be cancelled (rect too small)
 *    Actual: getImageData throws IndexSizeError / produces empty crop
 *
 * Root cause: src/components/drawing-canvas.ts, _handleCropPointerUp()
 * The size check `if (this._cropRect.w < 1 || this._cropRect.h < 1)`
 * only runs inside the `if (this._cropDragging)` block. When a handle
 * resize ends, _cropDragging is false, so the check is skipped. The
 * second normalization block at the bottom of the method does NOT check
 * for minimum size.
 *
 * Fix: Add the same minimum-size check after the second normalization,
 * or consolidate both paths into a single post-normalization check.
 */
describe('crop handle resize allows zero-size rect (missing minimum check)', () => {
  function setupCanvas() {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;
    // Fill with white so getImageData returns non-zero data
    const lctx = layerCanvas.getContext('2d')!;
    lctx.fillStyle = '#ffffff';
    lctx.fillRect(0, 0, 800, 600);

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [
            { id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas },
          ],
          activeLayerId: 'l1',
          activeTool: 'crop',
          documentWidth: 800,
          documentHeight: 600,
          cropAspectRatio: 'free',
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
    (canvas as any)._notifyHistory = vi.fn();

    return { canvas, layerCanvas };
  }

  it('_handleCropPointerUp should null out crop rect when handle resize produces w < 1', () => {
    const { canvas } = setupCanvas();

    // Simulate: user has drawn a crop rect at (100, 100) with size 200x200
    (canvas as any)._cropRect = { x: 100, y: 100, w: 200, h: 200 };

    // Simulate: user drags the east handle to make width = 0
    // This sets up the state as if a handle drag just ended
    (canvas as any)._cropDragging = false;  // handle resize, not new draw
    (canvas as any)._cropHandle = 'e';       // was dragging the east handle
    (canvas as any)._cropDragOrigin = { x: 300, y: 200 };
    (canvas as any)._cropRectOrigin = { x: 100, y: 100, w: 200, h: 200 };

    // Apply the resize result: east handle dragged 200px left -> w = 0
    (canvas as any)._cropRect = { x: 100, y: 100, w: 0, h: 200 };

    // Call _handleCropPointerUp to simulate pointer release
    (canvas as any)._handleCropPointerUp();

    // BUG: After handle resize, _cropRect should be null because w < 1
    // after normalization. But the minimum-size check only runs for
    // _cropDragging === true, not for handle resizes.
    //
    // Expected: _cropRect === null (too small to be valid)
    // Actual: _cropRect === { x: 100, y: 100, w: 0, h: 200 }
    expect((canvas as any)._cropRect).toBeNull();
  });

  it('_handleCropPointerUp should null out crop rect when handle resize produces h < 1', () => {
    const { canvas } = setupCanvas();

    // Simulate: crop rect exists, user drags south handle up to make h = 0
    (canvas as any)._cropRect = { x: 100, y: 100, w: 200, h: 0 };
    (canvas as any)._cropDragging = false;
    (canvas as any)._cropHandle = 's';
    (canvas as any)._cropDragOrigin = { x: 200, y: 300 };
    (canvas as any)._cropRectOrigin = { x: 100, y: 100, w: 200, h: 200 };

    (canvas as any)._handleCropPointerUp();

    // BUG: _cropRect should be null because h < 1
    expect((canvas as any)._cropRect).toBeNull();
  });

  it('commitCrop refuses a zero-width rect instead of corrupting the layer', () => {
    const { canvas, layerCanvas } = setupCanvas();

    // A zero-width rect must never reach getImageData(100, 100, 0, 200),
    // which throws IndexSizeError per the Canvas spec. _handleCropPointerUp
    // nulls such rects out, and commitCrop guards against them as well so a
    // stale rect (e.g. left behind by a cancelled gesture) cannot corrupt the
    // document.
    (canvas as any)._cropRect = { x: 100, y: 100, w: 0, h: 200 };

    expect(() => (canvas as any).commitCrop()).not.toThrow();

    const layer = (canvas as any)._ctx.value.state.layers[0];
    expect(layer.canvas).toBe(layerCanvas);
    expect(layer.canvas.width).toBe(800);
    expect(layer.canvas.height).toBe(600);
  });

  it('new crop rect draw correctly enforces minimum size (control test)', () => {
    const { canvas } = setupCanvas();

    // Simulate: user draws a new crop rect that ends up with w < 1
    (canvas as any)._cropRect = { x: 100, y: 100, w: 0.3, h: 200 };
    (canvas as any)._cropDragging = true;  // new crop draw
    (canvas as any)._cropHandle = null;

    (canvas as any)._handleCropPointerUp();

    // For new crop draws, the minimum-size check DOES run.
    // After normalization, w = round(0.3) = 0, which is < 1, so _cropRect is nulled.
    expect((canvas as any)._cropRect).toBeNull();
  });
});

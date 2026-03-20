import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: _normalizeCropRect does not reduce w/h when clamping negative x/y to 0.
 *
 * When the user draws or resizes a crop rect such that the top-left corner
 * extends beyond the document boundary (negative x or y), _normalizeCropRect
 * clamps x/y to 0 but does NOT reduce w/h by the same amount. This causes the
 * crop rectangle to be WIDER (or TALLER) than what the user actually selected,
 * because the right/bottom edge is silently extended.
 *
 * Example:
 *   User drags a crop rect from x=-20 to x=80 (w=100), y=50 to y=250 (h=200).
 *   Expected normalized rect: { x: 0, y: 50, w: 80, h: 200 }
 *     (The portion from x=-20 to x=0 is outside the document and should be
 *      discarded; the visible crop should cover x=[0, 80].)
 *   Actual normalized rect:   { x: 0, y: 50, w: 100, h: 200 }
 *     (w was NOT reduced, so the crop now covers x=[0, 100], which is 20px
 *      wider than intended.)
 *
 * Root cause: src/components/drawing-canvas.ts, _normalizeCropRect()
 *   Line `x = Math.max(0, x)` moves x from -20 to 0, but the next line
 *   `w = Math.min(w, this._docWidth - x)` only prevents w from exceeding
 *   the right edge of the document, NOT from exceeding the user's original
 *   right edge.
 *
 * The fix should reduce w by the amount x was clamped (and h by the amount
 * y was clamped):
 *   if (x < 0) { w += x; x = 0; }
 *   if (y < 0) { h += y; y = 0; }
 */
describe('_normalizeCropRect does not adjust w/h when clamping negative x/y', () => {
  function setupCanvas(docWidth = 800, docHeight = 600) {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = docWidth;
    layerCanvas.height = docHeight;
    const lctx = layerCanvas.getContext('2d')!;
    lctx.fillStyle = '#ffffff';
    lctx.fillRect(0, 0, docWidth, docHeight);

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [
            { id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas },
          ],
          activeLayerId: 'l1',
          activeTool: 'crop',
          documentWidth: docWidth,
          documentHeight: docHeight,
          cropAspectRatio: 'free',
        },
      },
    };

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = docWidth;
    previewCanvas.height = docHeight;
    Object.defineProperty(canvas, 'previewCanvas', {
      configurable: true,
      value: previewCanvas,
    });

    const mainCanvas = document.createElement('canvas');
    mainCanvas.width = docWidth;
    mainCanvas.height = docHeight;
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: mainCanvas,
    });

    (canvas as any).composite = vi.fn();
    (canvas as any).dispatchEvent = vi.fn();
    (canvas as any)._notifyHistory = vi.fn();

    return { canvas, layerCanvas };
  }

  it('should reduce w when x is negative (left overflow)', () => {
    const { canvas } = setupCanvas();
    // Rect extends 20px past the left edge: covers x=[-20, 80], y=[50, 250]
    const rect = { x: -20, y: 50, w: 100, h: 200 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // After clamping x to 0, w should be reduced by 20 to preserve
    // the original right edge at x=80.
    // Expected: { x: 0, y: 50, w: 80, h: 200 }
    // Bug: w stays at 100, giving { x: 0, y: 50, w: 100, h: 200 }
    expect(result.x).toBe(0);
    expect(result.y).toBe(50);
    expect(result.w).toBe(80);
    expect(result.h).toBe(200);
  });

  it('should reduce h when y is negative (top overflow)', () => {
    const { canvas } = setupCanvas();
    // Rect extends 30px past the top edge: covers x=[100, 300], y=[-30, 170]
    const rect = { x: 100, y: -30, w: 200, h: 200 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // After clamping y to 0, h should be reduced by 30 to preserve
    // the original bottom edge at y=170.
    // Expected: { x: 100, y: 0, w: 200, h: 170 }
    // Bug: h stays at 200, giving { x: 100, y: 0, w: 200, h: 200 }
    expect(result.x).toBe(100);
    expect(result.y).toBe(0);
    expect(result.w).toBe(200);
    expect(result.h).toBe(170);
  });

  it('should reduce both w and h when both x and y are negative (corner overflow)', () => {
    const { canvas } = setupCanvas();
    // Rect starts at (-10, -15), extends 100x100
    // Covers x=[-10, 90], y=[-15, 85]
    const rect = { x: -10, y: -15, w: 100, h: 100 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // Expected: { x: 0, y: 0, w: 90, h: 85 }
    // Bug: { x: 0, y: 0, w: 100, h: 100 }
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.w).toBe(90);
    expect(result.h).toBe(85);
  });

  it('should handle right-to-left drag that produces negative x after flip', () => {
    const { canvas } = setupCanvas();
    // User drags from x=80 to x=-20 → raw rect has negative w
    // { x: 80, y: 50, w: -100, h: 200 }
    // After flip: { x: -20, y: 50, w: 100, h: 200 }
    const rect = { x: 80, y: 50, w: -100, h: 200 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // The original selection covers x=[-20, 80]. Clamped to document: x=[0, 80].
    // Expected: { x: 0, y: 50, w: 80, h: 200 }
    // Bug: { x: 0, y: 50, w: 100, h: 200 }
    expect(result.x).toBe(0);
    expect(result.y).toBe(50);
    expect(result.w).toBe(80);
    expect(result.h).toBe(200);
  });

  it('should correctly normalize when rect is fully inside document (no overflow)', () => {
    const { canvas } = setupCanvas();
    // Rect fully inside: no clamping needed
    const rect = { x: 50, y: 50, w: 200, h: 200 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // No change expected (except rounding, which is a no-op for integers)
    expect(result.x).toBe(50);
    expect(result.y).toBe(50);
    expect(result.w).toBe(200);
    expect(result.h).toBe(200);
  });
});

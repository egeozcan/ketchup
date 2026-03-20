import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: _normalizeCropRect rounding can push x+w past docWidth (or y+h past
 * docHeight), producing a crop region that includes out-of-bounds canvas pixels.
 *
 * _normalizeCropRect clamps floating-point x, y, w, h so that
 *   x + w <= docWidth   and   y + h <= docHeight
 * in exact arithmetic. But the final step rounds all four values independently:
 *   return { x: Math.round(x), y: Math.round(y),
 *            w: Math.round(w), h: Math.round(h) };
 *
 * When both x and w have fractional parts >= 0.5, both round UP, and the sum
 * Math.round(x) + Math.round(w) can exceed docWidth.
 *
 * Example (docWidth = 100):
 *   Pre-round:  x = 0.5, w = 99.5   →  x + w = 100.0 ≤ 100 ✓
 *   Post-round: x = 1,   w = 100     →  x + w = 101   > 100 ✗
 *
 * When commitCrop() later calls ctx.getImageData(1, …, 100, …) on a 100-wide
 * canvas, the rightmost column (index 100) is outside the canvas. The Canvas
 * API returns transparent-black (rgba 0,0,0,0) for those pixels, so the
 * cropped layer silently gains a spurious transparent column at the right
 * edge, corrupting the image.
 *
 * Root cause: src/components/drawing-canvas.ts, _normalizeCropRect()
 *   The rounding is applied without a subsequent re-clamp.
 *
 * Fix: After rounding, ensure the invariant still holds:
 *   w = Math.min(w, docWidth - x);
 *   h = Math.min(h, docHeight - y);
 */
describe('_normalizeCropRect rounding can overflow document bounds', () => {
  function setupCanvas(docWidth = 100, docHeight = 100) {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = docWidth;
    layerCanvas.height = docHeight;
    const lctx = layerCanvas.getContext('2d')!;
    lctx.fillStyle = '#ff0000'; // fill red so we can detect transparent intrusion
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

  it('Math.round(x) + Math.round(w) should not exceed docWidth', () => {
    const { canvas } = setupCanvas(100, 100);

    // Pre-round values satisfy x + w = 100.0 exactly, but both x and w
    // have fractional part = 0.5, so both round UP.
    const rect = { x: 0.5, y: 0, w: 99.5, h: 100 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // After rounding, the invariant x + w <= docWidth must still hold.
    expect(result.x + result.w).toBeLessThanOrEqual(100);
  });

  it('Math.round(y) + Math.round(h) should not exceed docHeight', () => {
    const { canvas } = setupCanvas(100, 100);

    const rect = { x: 0, y: 0.5, w: 100, h: 99.5 };
    const result = (canvas as any)._normalizeCropRect(rect);

    expect(result.y + result.h).toBeLessThanOrEqual(100);
  });

  it('both axes overflow simultaneously', () => {
    const { canvas } = setupCanvas(100, 100);

    const rect = { x: 0.5, y: 0.5, w: 99.5, h: 99.5 };
    const result = (canvas as any)._normalizeCropRect(rect);

    expect(result.x + result.w).toBeLessThanOrEqual(100);
    expect(result.y + result.h).toBeLessThanOrEqual(100);
  });

  it('normalized rect values stay within document bounds for asymmetric rounding', () => {
    const { canvas } = setupCanvas(100, 100);

    // A different rounding scenario: x rounds up, w rounds up
    const rect = { x: 1.5, y: 2.5, w: 98.5, h: 97.5 };
    const result = (canvas as any)._normalizeCropRect(rect);

    // x=2, w=99 → 2+99=101 would overflow without post-rounding clamp
    expect(result.x + result.w).toBeLessThanOrEqual(100);
    expect(result.y + result.h).toBeLessThanOrEqual(100);
  });
});

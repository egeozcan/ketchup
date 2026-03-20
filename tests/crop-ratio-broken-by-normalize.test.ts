import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { constrainCropToRatio } from '../src/tools/crop.ts';

/**
 * Bug: constrainCropToRatio + _normalizeCropRect silently breaks the aspect ratio.
 *
 * When an edge handle ('n', 's', 'e', 'w') is dragged with an aspect-ratio
 * constraint active, constrainCropToRatio derives the perpendicular dimension
 * from the dragged dimension.  For wide ratios (e.g. 16:9) or when the rect
 * is near a document edge, the derived width can exceed the document bounds.
 *
 * _normalizeCropRect then clamps the width to fit inside the document, but
 * it does NOT re-derive the height to maintain the aspect ratio.  The result
 * is a crop rect whose actual ratio differs from the user-selected ratio.
 *
 * Example (docWidth = 800, ratio 16:9):
 *   1. User has a crop rect at {x: 500, y: 100, w: 160, h: 90}.
 *      Ratio = 160/90 ≈ 1.778 (16:9).  ✓
 *   2. User drags the 's' handle down 270 px → raw height becomes 360.
 *      constrainCropToRatio derives newW = 360 * (16/9) = 640.
 *      Rect becomes {x: 500, y: 100, w: 640, h: 360}.
 *      Right edge = 500 + 640 = 1140 — outside the 800-wide document.
 *   3. _normalizeCropRect clamps w to 800 − 500 = 300.
 *      Final rect: {x: 500, y: 100, w: 300, h: 360}.
 *      Actual ratio = 300/360 ≈ 0.833 — completely wrong.
 *
 * The fix should either:
 *   (a) reduce h proportionally when w is clamped (h = clampedW / ratio), or
 *   (b) prevent the drag from producing an out-of-bounds rect in the first place.
 */
describe('Aspect-ratio crop rect broken by _normalizeCropRect clamping', () => {
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
          cropAspectRatio: '16:9',
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

    return { canvas };
  }

  it('should maintain 16:9 ratio after normalization clamps width to document bounds', () => {
    const { canvas } = setupCanvas(800, 600);
    const ratio = 16 / 9;

    // Step 1: constrainCropToRatio for 's' handle produces an out-of-bounds width.
    //   Starting rect near the right edge, user drags 's' handle down significantly.
    //   The derived width (360 * 16/9 = 640) pushes the right edge past docWidth.
    const constrained = constrainCropToRatio(
      { x: 500, y: 100, w: 160, h: 360 },
      ratio,
      's',
    );

    // constrainCropToRatio should give w = 640 (= 360 * 16/9).
    expect(constrained.w).toBeCloseTo(640, 0);
    expect(constrained.h).toBeCloseTo(360, 0);

    // Step 2: _normalizeCropRect clamps the rect to document bounds.
    //   It reduces w from 640 to 300 (= 800 − 500), but does NOT
    //   re-derive h to maintain the aspect ratio.
    const normalized = (canvas as any)._normalizeCropRect(constrained);

    // Width was clamped because 500 + 640 > 800.
    expect(normalized.w).toBeLessThanOrEqual(800 - normalized.x);

    // BUG: the height was NOT adjusted to match the clamped width.
    //   Expected: h = normalizedW / ratio  (maintaining 16:9)
    //   Actual:   h = 360 (unchanged from the constrained rect)
    const actualRatio = normalized.w / normalized.h;
    expect(actualRatio).toBeCloseTo(ratio, 1);
    //                  ^^^^^^^^^^^^^^^^^^^^^^^^^^
    //   This assertion FAILS because normalizedW ≈ 300 and h = 360,
    //   giving actualRatio ≈ 0.83 instead of ≈ 1.78.
  });

  it('should maintain 1:1 ratio after normalization clamps height to document bounds', () => {
    const { canvas } = setupCanvas(800, 600);
    const ratio = 1;

    // 'e' handle drag with 1:1 ratio: derive height from width.
    // Starting rect near the bottom, user drags 'e' handle right.
    // Derived height = width / 1 = width.  If width is large, bottom
    // edge = y + height may exceed docHeight.
    const constrained = constrainCropToRatio(
      { x: 100, y: 400, w: 500, h: 100 },
      ratio,
      'e',
    );

    expect(constrained.w).toBeCloseTo(500, 0);
    // height derived: 500 / 1 = 500
    expect(constrained.h).toBeCloseTo(500, 0);
    // bottom edge = 400 + 500 = 900 > 600 → out of bounds

    const normalized = (canvas as any)._normalizeCropRect(constrained);

    expect(normalized.h).toBeLessThanOrEqual(600 - normalized.y);

    // BUG: width was NOT adjusted to match the clamped height.
    const actualRatio = normalized.w / normalized.h;
    expect(actualRatio).toBeCloseTo(ratio, 1);
  });
});

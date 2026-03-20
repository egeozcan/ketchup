import { describe, expect, it } from 'vitest';
import { constrainCropToRatio, type CropRect } from '../src/tools/crop.ts';

/**
 * Bug: constrainCropToRatio does not adjust x/y to keep the opposite edge
 * anchored when the aspect ratio constraint changes the width or height.
 *
 * When dragging a handle that moves the left edge (NW, W, SW), the right edge
 * should stay fixed. constrainCropToRatio correctly adjusts `w` for the ratio
 * but leaves `x` unchanged, causing the RIGHT edge to shift unexpectedly.
 *
 * Root cause: constrainCropToRatio (src/tools/crop.ts, line 177) returns the
 * original x and y values without compensating for the new w/h. For handles
 * that move the left/top edge, x/y must be recalculated from the fixed
 * opposite edge: x = rightEdge - newW, y = bottomEdge - newH.
 *
 * File: /Users/egecan/Code/ketchup/src/tools/crop.ts
 * Line: 177 — return { x, y, w: newW * signW, h: newH * signH };
 */

/**
 * Replicates _resizeCropRect (private method in drawing-canvas.ts) which
 * computes the unconstrained rect before constrainCropToRatio is applied.
 */
function resizeCropRect(
  orig: CropRect,
  handle: string,
  dx: number,
  dy: number,
): CropRect {
  let { x, y, w, h } = orig;
  switch (handle) {
    case 'nw': x += dx; y += dy; w -= dx; h -= dy; break;
    case 'n':  y += dy; h -= dy; break;
    case 'ne': w += dx; y += dy; h -= dy; break;
    case 'e':  w += dx; break;
    case 'se': w += dx; h += dy; break;
    case 's':  h += dy; break;
    case 'sw': x += dx; w -= dx; h += dy; break;
    case 'w':  x += dx; w -= dx; break;
  }
  return { x, y, w, h };
}

describe('constrainCropToRatio — opposite edge anchoring bug', () => {
  // Original crop rect: 200x200 square at (100, 100)
  // Edges: left=100, top=100, right=300, bottom=300
  const orig: CropRect = { x: 100, y: 100, w: 200, h: 200 };
  const ratio = 16 / 9;

  it('NW handle: SE corner (300,300) must stay fixed after ratio constraint', () => {
    // Drag NW handle diagonally outward: dx=-50, dy=-30
    const unconstrained = resizeCropRect(orig, 'nw', -50, -30);
    // unconstrained: x=50, y=70, w=250, h=230
    // right edge = 50+250 = 300, bottom = 70+230 = 300 (SE corner preserved so far)

    const constrained = constrainCropToRatio(unconstrained, ratio, 'nw');
    // Ratio constraint makes w ≈ 408.9 (from h=230, w = 230 * 16/9)

    // SE corner must remain at (300, 300)
    const seCorner = {
      x: constrained.x + constrained.w,
      y: constrained.y + constrained.h,
    };

    // BUG: x was not adjusted, so right edge = 50 + 408.9 = 458.9 instead of 300
    expect(seCorner.x).toBeCloseTo(300, 1);
    // y happens to be correct: 70 + 230 = 300
    expect(seCorner.y).toBeCloseTo(300, 1);
  });

  it('SW handle: NE corner (300,100) must stay fixed after ratio constraint', () => {
    // Drag SW handle: dx=-50, dy=30
    const unconstrained = resizeCropRect(orig, 'sw', -50, 30);
    // unconstrained: x=50, y=100, w=250, h=230
    // right edge = 50+250 = 300 (NE x preserved), top = 100 (NE y preserved)

    const constrained = constrainCropToRatio(unconstrained, ratio, 'sw');
    // Ratio constraint makes w ≈ 408.9

    // NE corner must remain at (300, 100)
    const neCorner = {
      x: constrained.x + constrained.w,
      y: constrained.y,
    };

    // BUG: right edge = 50 + 408.9 = 458.9 instead of 300
    expect(neCorner.x).toBeCloseTo(300, 1);
    expect(neCorner.y).toBeCloseTo(100, 1);
  });

  it('SE handle: NW corner (100,100) must stay fixed (should pass — no bug for SE)', () => {
    // Drag SE handle: dx=50, dy=30
    const unconstrained = resizeCropRect(orig, 'se', 50, 30);
    // unconstrained: x=100, y=100, w=250, h=230

    const constrained = constrainCropToRatio(unconstrained, ratio, 'se');

    // NW corner is at (x, y) — this should stay at (100, 100) since
    // constrainCropToRatio passes x and y through unchanged, which is
    // correct for SE (the NW corner is already the anchor).
    expect(constrained.x).toBeCloseTo(100, 1);
    expect(constrained.y).toBeCloseTo(100, 1);
  });

  it('NE handle: SW corner (100,300) must stay fixed after ratio constraint', () => {
    // Drag NE handle: dx=50, dy=-30
    const unconstrained = resizeCropRect(orig, 'ne', 50, -30);
    // unconstrained: x=100, y=70, w=250, h=230
    // SW corner = (100, 70+230=300). x=100 stays, bottom=300 stays — correct before constraint

    const constrained = constrainCropToRatio(unconstrained, ratio, 'ne');
    // Ratio makes w ≈ 408.9

    // SW corner must remain at (100, 300)
    const swCorner = {
      x: constrained.x,
      y: constrained.y + constrained.h,
    };

    // x is correct (100 — passed through), bottom is correct (70+230=300)
    expect(swCorner.x).toBeCloseTo(100, 1);
    expect(swCorner.y).toBeCloseTo(300, 1);
  });
});

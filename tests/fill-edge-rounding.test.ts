import { describe, it, expect } from 'vitest';
import { floodFill } from '../src/tools/fill.js';

/**
 * Bug: floodFill uses Math.round() to snap the floating-point start
 * coordinates to a pixel index.  For a canvas of width W, pixel columns
 * are indexed 0 … W-1.  A document-space coordinate like (W − 0.3)
 * lies inside pixel column W-1, so the fill should target that pixel.
 *
 * Math.round(W − 0.3) === W, which then fails the bounds check
 * (sx >= width) and the function returns false — the fill silently
 * does nothing even though the user clicked inside the canvas.
 *
 * The correct function is Math.floor(), which maps any coordinate in
 * the half-open interval [px, px+1) to pixel index px.
 */
describe('floodFill edge-pixel rounding', () => {
  function makeCtx(w: number, h: number) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas.getContext('2d')!;
  }

  it('should fill the last column when startX rounds up to width', () => {
    const W = 10;
    const H = 5;
    const ctx = makeCtx(W, H);

    // Use tolerance > 0 to avoid the same-color early exit (jsdom's canvas
    // mock doesn't produce real pixel data from fillRect/getImageData).
    const filled = floodFill(ctx, 9.7, 2, '#ff0000', 1);

    // With the bug (Math.round), Math.round(9.7) = 10 >= width → false.
    // With the fix (Math.floor), Math.floor(9.7) = 9 < width → proceeds.
    expect(filled).toBe(true);
  });

  it('should fill the last row when startY rounds up to height', () => {
    const W = 5;
    const H = 10;
    const ctx = makeCtx(W, H);

    const filled = floodFill(ctx, 2, 9.6, '#ff0000', 1);
    expect(filled).toBe(true);
  });

  it('should fill at fractional coords near the bottom-right corner', () => {
    const W = 100;
    const H = 100;
    const ctx = makeCtx(W, H);

    // Both x and y near the edge
    const filled = floodFill(ctx, 99.7, 99.6, '#0000ff', 1);
    expect(filled).toBe(true);
  });

  it('should NOT fill when coordinates are truly out of bounds', () => {
    const W = 10;
    const H = 10;
    const ctx = makeCtx(W, H);

    // x = 10.0 is out of bounds (pixel 10 doesn't exist)
    expect(floodFill(ctx, 10.0, 5, '#ff0000', 1)).toBe(false);
    // Negative
    expect(floodFill(ctx, -0.5, 5, '#ff0000', 1)).toBe(false);
  });
});

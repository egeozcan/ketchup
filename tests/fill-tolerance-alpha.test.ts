import { describe, expect, it } from 'vitest';
import { floodFill } from '../src/tools/fill.ts';

/**
 * Bug: floodFill's same-color early-exit check (line 29 of fill.ts)
 * prevents the fill from reaching neighboring pixels that are within
 * tolerance of the target but have different actual color values.
 *
 * Root cause: src/tools/fill.ts, line 29:
 *
 *   if (tr === fc.r && tg === fc.g && tb === fc.b && ta === fc.a) return false;
 *
 * This exact-equality check fires when the clicked pixel already has the
 * fill color, causing an immediate return without scanning neighbors.
 * But with tolerance > 0, neighbors may have colors that differ from the
 * fill color yet still fall within tolerance of the target. Those pixels
 * should be filled but are silently skipped.
 *
 * Scenario (in a real browser):
 *   3x1 canvas:
 *     Pixel 0: (100, 0, 0, 255) — |100-128|=28 ≤ 32 → within tolerance
 *     Pixel 1: (128, 0, 0, 255) — user clicks here; fill color = (128,0,0,255)
 *     Pixel 2: (100, 0, 0, 255) — within tolerance
 *
 *   floodFill(ctx, 1, 0, '#800000', 32) returns false immediately.
 *   Pixels 0 and 2 remain at (100,0,0) instead of becoming (128,0,0).
 *
 * Impact: When painting a gradient or soft-edged area, clicking on a pixel
 * that already has the exact fill color does nothing — the user must click
 * on a nearby pixel with a *different* color for the fill to work.
 *
 * Fix: Remove the early exit on line 29, or change it to only return false
 * when every connected pixel within tolerance already has the fill color.
 */
describe('floodFill same-color early-exit skips connected in-tolerance pixels', () => {
  it('should fill neighbors when the click point has the fill color but neighbors differ within tolerance', () => {
    // Create a 3x1 canvas and set known pixel data
    const canvas = document.createElement('canvas');
    canvas.width = 3;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;

    // Write pixel data directly
    const imgData = ctx.createImageData(3, 1);
    // Pixel 0: R=100, G=0, B=0, A=255  (within tolerance of fill)
    imgData.data[0] = 100; imgData.data[1] = 0; imgData.data[2] = 0; imgData.data[3] = 255;
    // Pixel 1: R=128, G=0, B=0, A=255  (click point — same as fill color)
    imgData.data[4] = 128; imgData.data[5] = 0; imgData.data[6] = 0; imgData.data[7] = 255;
    // Pixel 2: R=100, G=0, B=0, A=255  (within tolerance of fill)
    imgData.data[8] = 100; imgData.data[9] = 0; imgData.data[10] = 0; imgData.data[11] = 255;
    ctx.putImageData(imgData, 0, 0);

    // Call floodFill clicking on pixel 1 with fill color #800000 (=128,0,0)
    // and tolerance 32.
    //
    // In a real browser, parseColor('#800000') returns {r:128,g:0,b:0,a:255}.
    // Target pixel 1 is (128,0,0,255). Same-color check: 128===128 etc → true.
    // floodFill returns false immediately without scanning pixels 0 and 2.
    //
    // In vitest-canvas-mock, parseColor returns {r:0,g:0,b:0,a:0} because
    // the mock's fillRect→getImageData doesn't produce real pixels.
    // Target pixel 1 is read as (0,0,0,0) by the mock's getImageData.
    // So the check becomes: 0===0 && 0===0 && 0===0 && 0===0 → true.
    // floodFill returns false for the same reason.
    //
    // Either way, the function returns false when it should return true.
    const result = floodFill(ctx, 1, 0, '#800000', 32);

    // EXPECTED (correct behavior): true — pixels 0 and 2 should be filled
    // ACTUAL (bug): false — early exit prevents any modification
    expect(result).toBe(true);
  });
});

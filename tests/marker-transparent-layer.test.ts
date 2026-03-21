import { describe, expect, it } from 'vitest';
import { drawMarkerSegment } from '../src/tools/marker.ts';

/**
 * Bug: drawMarkerSegment uses globalCompositeOperation = 'multiply', which
 * produces black (RGB 0,0,0) output on transparent layers regardless of the
 * selected stroke color.
 *
 * Root cause: src/tools/marker.ts, line 11:
 *
 *   ctx.globalCompositeOperation = 'multiply';
 *
 * The 'multiply' composite operation computes output RGB as:
 *
 *   result_r = (source_r * destination_r) / 255
 *   result_g = (source_g * destination_g) / 255
 *   result_b = (source_b * destination_b) / 255
 *
 * On a transparent canvas (destination RGBA = 0,0,0,0), the destination RGB
 * values are all 0, so the multiplication always yields 0 for every channel.
 * The output alpha follows the standard Porter-Duff formula
 * (alpha_s + alpha_d - alpha_s * alpha_d), which IS non-zero when the source
 * has alpha, so the pixel IS written -- but with RGB = (0,0,0).
 *
 * This means drawing with the marker on a newly added (transparent) layer
 * always produces BLACK, no matter what color is selected. The user sees a
 * faint dark smudge instead of the expected semi-transparent colored stroke.
 *
 * The pencil tool uses 'source-over' which works correctly on all layers.
 * The marker should use a composite operation that doesn't zero out the color
 * on transparent backgrounds (e.g., 'source-over' with reduced alpha, or
 * draw to a temp canvas first and then multiply-composite onto the layer).
 *
 * Scenario to reproduce:
 *   1. Create a new layer (it's transparent by default)
 *   2. Select the marker tool
 *   3. Pick any non-black color (e.g., bright red #ff0000)
 *   4. Draw a stroke on the transparent layer
 *   5. Expected: a semi-transparent red stroke appears
 *   6. Actual: a semi-transparent BLACK stroke appears
 */
describe('marker tool on transparent layer', () => {
  it('should not use multiply composite mode which zeroes out colors on transparent backgrounds', () => {
    // Create a transparent canvas (all pixels are RGBA 0,0,0,0)
    const canvas = document.createElement('canvas');
    canvas.width = 10;
    canvas.height = 10;
    const ctx = canvas.getContext('2d')!;

    // Track what globalCompositeOperation is set to during drawing
    let compositeOpDuringDraw: string | null = null;

    // Use a spy to capture the composite operation set by drawMarkerSegment
    let currentOp = 'source-over';
    Object.defineProperty(ctx, 'globalCompositeOperation', {
      get() { return currentOp; },
      set(val: string) {
        currentOp = val;
        // Capture the value during the draw (after save, before restore)
        if (val !== 'source-over') {
          compositeOpDuringDraw = val;
        }
      },
      configurable: true,
    });

    // Draw a marker segment with a bright red color on a transparent canvas
    const from = { x: 2, y: 5 };
    const to = { x: 8, y: 5 };
    drawMarkerSegment(ctx, from, to, '#ff0000', 2);

    // The marker currently uses 'multiply' which breaks on transparent layers.
    //
    // With globalCompositeOperation = 'multiply':
    //   result_rgb = source_rgb * destination_rgb / 255
    //   On transparent canvas: destination_rgb = 0 => result_rgb = 0 (BLACK)
    //
    // The marker should use a mode that preserves the stroke color on any
    // background. 'multiply' only works correctly on opaque (e.g. white)
    // backgrounds.
    //
    // This test FAILS because drawMarkerSegment sets 'multiply'.
    expect(compositeOpDuringDraw).not.toBe('multiply');
  });
});

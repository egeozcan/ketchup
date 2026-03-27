import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { makeAppCanvasStub } from './helpers.ts';

/**
 * Bug: setFontSize does not guard against NaN input.
 *
 * Root cause: src/components/drawing-app.ts, inside _buildContextValue():
 *
 *   setFontSize: (size: number) => {
 *     this._state = { ...this._state, fontSize: Math.max(8, Math.min(200, size)) };
 *     ...
 *   },
 *
 * The clamping expression `Math.max(8, Math.min(200, size))` is intended to
 * constrain fontSize to the range [8, 200]. However, when `size` is NaN:
 *
 *   Math.min(200, NaN)  → NaN   (any comparison with NaN returns NaN)
 *   Math.max(8, NaN)    → NaN   (same)
 *
 * So fontSize is set to NaN, which then:
 *   1. Produces an invalid font string "NaNpx sans-serif" via buildFontString()
 *   2. Causes measureTextBlock() to return NaN for height (fontSize * LINE_HEIGHT)
 *   3. Makes the text tool unable to measure or position text correctly
 *
 * The fix is to add a NaN check before clamping, e.g.:
 *   const clamped = Number.isFinite(size) ? size : 8;
 *   this._state = { ...this._state, fontSize: Math.max(8, Math.min(200, clamped)) };
 *
 * Impact: While the current UI's <input type="number"> converts invalid input
 * to 0 (which clamps to 8), the setFontSize function is part of the public
 * DrawingContextValue API consumed by multiple components. Any caller that
 * passes NaN (e.g., from a valueAsNumber read on an unfocused input, or from
 * arithmetic involving undefined values) would corrupt the fontSize state,
 * making the text tool unusable until fontSize is manually reset.
 */
describe('setFontSize NaN passthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('should clamp NaN to the minimum font size instead of storing NaN', () => {
    const app = new DrawingApp();

    // Stub canvas to prevent errors from missing DOM element
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub(),
    });

    const ctx = (app as any)._buildContextValue();

    // Verify the initial font size is valid
    expect((app as any)._state.fontSize).toBe(24);

    // Call setFontSize with NaN
    ctx.setFontSize(NaN);

    // The font size should be clamped to the minimum (8), not NaN.
    // BUG: Math.max(8, Math.min(200, NaN)) evaluates to NaN.
    const fontSize = (app as any)._state.fontSize;
    expect(fontSize).not.toBeNaN();
    expect(fontSize).toBeGreaterThanOrEqual(8);
    expect(fontSize).toBeLessThanOrEqual(200);
  });

  it('should still clamp valid edge values correctly', () => {
    const app = new DrawingApp();

    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub(),
    });

    const ctx = (app as any)._buildContextValue();

    // Zero should clamp to 8
    ctx.setFontSize(0);
    expect((app as any)._state.fontSize).toBe(8);

    // Negative should clamp to 8
    ctx.setFontSize(-10);
    expect((app as any)._state.fontSize).toBe(8);

    // Over max should clamp to 200
    ctx.setFontSize(999);
    expect((app as any)._state.fontSize).toBe(200);

    // Normal value should pass through
    ctx.setFontSize(48);
    expect((app as any)._state.fontSize).toBe(48);
  });
});

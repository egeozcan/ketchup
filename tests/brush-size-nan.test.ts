import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';

/**
 * Bug: setBrushSize does not guard against NaN / non-finite / out-of-range input.
 *
 * Root cause: src/components/drawing-app.ts, inside _buildContextValue():
 *
 *   setBrushSize: (size: number) => {
 *     this._state = { ...this._state, brushSize: size };
 *     this._markDirty();
 *   },
 *
 * Unlike setFontSize (which was fixed to check Number.isFinite and clamp to
 * [8, 200]), setBrushSize stores the value with zero validation. When `size`
 * is NaN:
 *
 *   - Pencil tool passes NaN to ctx.lineWidth, producing an invisible stroke
 *   - Eraser tool passes NaN * 2 = NaN to ctx.lineWidth, erasing nothing
 *   - Marker tool passes NaN * 3 = NaN to ctx.lineWidth, drawing nothing
 *   - Stamp tool computes brushSize * 10 = NaN, causing Math.round(NaN) = NaN,
 *     then Math.max(1, NaN) = 1 — stamps silently collapse to 1×1 pixels
 *   - The slider UI displays "NaN" instead of a number
 *
 * When `size` is 0 or negative:
 *   - ctx.lineWidth = 0 or negative produces invisible strokes (per Canvas spec)
 *   - The brush tools silently stop working with no visible feedback
 *
 * The fix should mirror setFontSize: add a Number.isFinite guard and clamp
 * to the valid slider range [1, 150]:
 *
 *   setBrushSize: (size: number) => {
 *     const safe = Number.isFinite(size) ? size : 4;
 *     this._state = { ...this._state, brushSize: Math.max(1, Math.min(150, safe)) };
 *     this._markDirty();
 *   },
 *
 * Impact: While the current UI range slider always produces valid numbers,
 * setBrushSize is part of the public DrawingContextValue API. Any corrupted
 * persisted state (e.g., brushSize saved as NaN due to a storage glitch) or
 * a programmatic caller passing an invalid value would silently break all
 * brush-based tools without any error or fallback.
 */
describe('setBrushSize NaN passthrough', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('should clamp NaN to a valid default instead of storing NaN', () => {
    const app = new DrawingApp();

    // Stub canvas to prevent errors from missing DOM element
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        clearSelection: vi.fn(),
        pushLayerOperation: vi.fn(),
        cancelCrop: vi.fn(),
      },
    });

    const ctx = (app as any)._buildContextValue();

    // Verify the initial brush size is valid
    expect((app as any)._state.brushSize).toBe(4);

    // Call setBrushSize with NaN
    ctx.setBrushSize(NaN);

    // The brush size should be clamped to a valid value, not NaN.
    // BUG: setBrushSize stores NaN directly without validation.
    const brushSize = (app as any)._state.brushSize;
    expect(brushSize).not.toBeNaN();
    expect(brushSize).toBeGreaterThanOrEqual(1);
    expect(brushSize).toBeLessThanOrEqual(150);
  });

  it('should clamp zero and negative values to the minimum', () => {
    const app = new DrawingApp();

    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        clearSelection: vi.fn(),
        pushLayerOperation: vi.fn(),
        cancelCrop: vi.fn(),
      },
    });

    const ctx = (app as any)._buildContextValue();

    // Zero should clamp to 1 (minimum valid brush size)
    ctx.setBrushSize(0);
    expect((app as any)._state.brushSize).toBeGreaterThanOrEqual(1);

    // Negative should clamp to 1
    ctx.setBrushSize(-5);
    expect((app as any)._state.brushSize).toBeGreaterThanOrEqual(1);
  });

  it('should clamp Infinity to the maximum brush size', () => {
    const app = new DrawingApp();

    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        clearSelection: vi.fn(),
        pushLayerOperation: vi.fn(),
        cancelCrop: vi.fn(),
      },
    });

    const ctx = (app as any)._buildContextValue();

    ctx.setBrushSize(Infinity);
    const brushSize = (app as any)._state.brushSize;
    expect(brushSize).not.toBe(Infinity);
    expect(brushSize).toBeLessThanOrEqual(150);
  });

  it('should still accept valid values within range', () => {
    const app = new DrawingApp();

    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        clearSelection: vi.fn(),
        pushLayerOperation: vi.fn(),
        cancelCrop: vi.fn(),
      },
    });

    const ctx = (app as any)._buildContextValue();

    // Normal value should pass through
    ctx.setBrushSize(10);
    expect((app as any)._state.brushSize).toBe(10);

    // Boundary values
    ctx.setBrushSize(1);
    expect((app as any)._state.brushSize).toBe(1);

    ctx.setBrushSize(150);
    expect((app as any)._state.brushSize).toBe(150);
  });
});

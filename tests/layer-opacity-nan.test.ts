import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';

/**
 * Bug: setLayerOpacity does not validate its input — NaN, Infinity, and
 * out-of-range values are stored directly in the layer's opacity field.
 *
 * Root cause: src/components/drawing-app.ts, inside _buildContextValue():
 *
 *   setLayerOpacity: (id: string, opacity: number) => {
 *     const layer = this._state.layers.find(l => l.id === id);
 *     if (!layer) return;
 *     const newLayers = this._state.layers.map(l => l.id === id ? { ...l, opacity } : l);
 *     this._state = { ...this._state, layers: newLayers };
 *     this._markDirty();
 *   },
 *
 * Unlike setBrushSize and setFontSize (bugs #15 and #14, now fixed), which both
 * guard against NaN/Infinity with `Number.isFinite()` and clamp to a valid range,
 * setLayerOpacity passes the raw value straight through.
 *
 * Effects of invalid opacity:
 *   1. composite() sets `displayCtx.globalAlpha = layer.opacity`. Per the Canvas
 *      spec, assigning NaN or a value outside [0,1] to globalAlpha is silently
 *      ignored, leaving the previous value in place. So a NaN-opacity layer
 *      renders at whatever alpha was left over from the previous layer (typically
 *      1.0 after the reset), making the layer appear fully opaque regardless of
 *      intent.
 *   2. The layers-panel slider displays `Math.round(layer.opacity * 100)`, which
 *      shows "NaN%" for NaN and "Infinity%" for Infinity.
 *   3. The invalid value is persisted to IndexedDB, corrupting the saved project
 *      state across sessions.
 *   4. History entries capture the invalid value as `before`/`after`, propagating
 *      corruption through undo/redo.
 *
 * The fix should mirror setBrushSize / setFontSize:
 *   const safe = Number.isFinite(opacity) ? opacity : 1;
 *   const clamped = Math.max(0, Math.min(1, safe));
 *   // then use `clamped` in the layer spread
 */
describe('setLayerOpacity missing validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('should clamp NaN to a valid opacity instead of storing NaN', () => {
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
    const layerId = (app as any)._state.activeLayerId;

    // Baseline: opacity should be 1.0
    const initialOpacity = (app as any)._state.layers[0].opacity;
    expect(initialOpacity).toBe(1.0);

    // Call setLayerOpacity with NaN
    ctx.setLayerOpacity(layerId, NaN);

    // BUG: NaN is stored directly without validation.
    // Expected: opacity should be clamped to a valid value (e.g. 1.0 as default)
    const opacity = (app as any)._state.layers[0].opacity;
    expect(opacity).not.toBeNaN();
    expect(opacity).toBeGreaterThanOrEqual(0);
    expect(opacity).toBeLessThanOrEqual(1);
  });

  it('should clamp Infinity to 1', () => {
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
    const layerId = (app as any)._state.activeLayerId;

    ctx.setLayerOpacity(layerId, Infinity);

    const opacity = (app as any)._state.layers[0].opacity;
    expect(Number.isFinite(opacity)).toBe(true);
    expect(opacity).toBeLessThanOrEqual(1);
  });

  it('should clamp negative values to 0', () => {
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
    const layerId = (app as any)._state.activeLayerId;

    ctx.setLayerOpacity(layerId, -0.5);

    const opacity = (app as any)._state.layers[0].opacity;
    expect(opacity).toBeGreaterThanOrEqual(0);
  });

  it('should clamp values greater than 1 to 1', () => {
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
    const layerId = (app as any)._state.activeLayerId;

    ctx.setLayerOpacity(layerId, 1.5);

    const opacity = (app as any)._state.layers[0].opacity;
    expect(opacity).toBeLessThanOrEqual(1);
  });

  it('should allow valid values within [0, 1]', () => {
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
    const layerId = (app as any)._state.activeLayerId;

    ctx.setLayerOpacity(layerId, 0.5);
    expect((app as any)._state.layers[0].opacity).toBe(0.5);

    ctx.setLayerOpacity(layerId, 0);
    expect((app as any)._state.layers[0].opacity).toBe(0);

    ctx.setLayerOpacity(layerId, 1);
    expect((app as any)._state.layers[0].opacity).toBe(1);
  });
});

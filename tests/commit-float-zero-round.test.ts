import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: _commitFloat used bare Math.round(currentRect.w/h) for drawImage
 * destination dimensions. At high zoom (>= 9), _applyResize allows
 * currentRect.w/h < 0.5 (minSize = 4/zoom), so Math.round produces 0.
 * drawImage with 0-pixel destination is a silent no-op — float content
 * is lost. _rebuildTempCanvas correctly uses Math.max(1, Math.round(...))
 * but _commitFloat didn't, causing a mismatch.
 *
 * Fix: _commitFloat now uses Math.max(1, Math.round(...)) matching
 * _rebuildTempCanvas.
 */
describe('_commitFloat with near-zero currentRect dimensions', () => {
  it('should draw with at least 1px destination dimensions even when currentRect rounds to 0', () => {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 200;
    layerCanvas.height = 200;

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 200,
          documentHeight: 200,
        },
      },
    };

    // Create a float with dimensions that round to 0
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 1; // _rebuildTempCanvas uses Math.max(1, Math.round(0.4)) = 1
    tempCanvas.height = 1;

    (canvas as any)._float = {
      originalImageData: new ImageData(10, 10),
      currentRect: { x: 50, y: 50, w: 0.4, h: 0.4 }, // Math.round(0.4) = 0
      tempCanvas,
    };

    (canvas as any)._beforeDrawData = new ImageData(200, 200);
    (canvas as any).composite = vi.fn();
    (canvas as any)._clearFloatState = vi.fn();
    (canvas as any)._notifyHistory = vi.fn();
    (canvas as any).dispatchEvent = vi.fn();

    // Spy on drawImage to capture the destination dimensions
    const layerCtx = layerCanvas.getContext('2d')!;
    const drawImageSpy = vi.spyOn(layerCtx, 'drawImage');

    (canvas as any)._commitFloat();

    expect(drawImageSpy).toHaveBeenCalledOnce();
    const args = drawImageSpy.mock.calls[0];

    // Destination width and height (args[3] and args[4]) must be >= 1
    // Before fix: Math.round(0.4) = 0 → silent drawImage no-op
    // After fix: Math.max(1, Math.round(0.4)) = 1 → content is drawn
    expect(args[3]).toBeGreaterThanOrEqual(1);
    expect(args[4]).toBeGreaterThanOrEqual(1);
  });
});

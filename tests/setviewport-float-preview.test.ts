import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

/**
 * Bug: setViewport() does not call _redrawFloatPreview() when a floating
 * selection is active.  Every other viewport-changing method in DrawingCanvas
 * (centerDocument, zoomToFit, _zoomToCenter, _resizeToFit, _updatePan,
 * _onWheel) calls `if (this._float) this._redrawFloatPreview()` after
 * updating _panX / _panY / _zoom and calling composite().  setViewport()
 * only calls composite() + _dispatchViewportChange(), so the float overlay
 * on the preview canvas stays at its old position while the document shifts.
 *
 * This is triggered when the user pans or zooms via the navigator mini-map
 * while a floating selection is active: the float appears "stuck" because
 * the preview canvas is not redrawn.
 */
describe('setViewport float preview desync', () => {
  it('should call _redrawFloatPreview when a float is active', () => {
    const canvas = new DrawingCanvas();

    // Set up minimal context and canvases
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 800,
          documentHeight: 600,
        },
      },
    };

    // Use Object.defineProperty to override @query-decorated getter
    const mainCanvas = document.createElement('canvas');
    mainCanvas.width = 800;
    mainCanvas.height = 600;
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: mainCanvas,
    });

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 800;
    previewCanvas.height = 600;
    Object.defineProperty(canvas, 'previewCanvas', {
      configurable: true,
      value: previewCanvas,
    });

    // Create a float
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 50;
    tempCanvas.height = 50;
    (canvas as any)._float = {
      originalImageData: new ImageData(50, 50),
      currentRect: { x: 100, y: 100, w: 50, h: 50 },
      tempCanvas,
    };

    // Spy on _redrawFloatPreview
    const redrawSpy = vi.fn();
    (canvas as any)._redrawFloatPreview = redrawSpy;
    (canvas as any)._dispatchViewportChange = vi.fn();

    // Call setViewport (simulating navigator panel pan/zoom)
    canvas.setViewport(2.0, 100, 50);

    // BUG: _redrawFloatPreview is NOT called, so the float overlay on the
    // preview canvas remains at the old viewport position.
    expect(redrawSpy).toHaveBeenCalled();
  });

  it('other viewport methods DO call _redrawFloatPreview when float is active', () => {
    // Verify that centerDocument (as a representative example) DOES call
    // _redrawFloatPreview, showing the inconsistency with setViewport.
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 800,
          documentHeight: 600,
        },
      },
    };

    const mainCanvas = document.createElement('canvas');
    mainCanvas.width = 800;
    mainCanvas.height = 600;
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: mainCanvas,
    });

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 800;
    previewCanvas.height = 600;
    Object.defineProperty(canvas, 'previewCanvas', {
      configurable: true,
      value: previewCanvas,
    });

    // Create a float
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 50;
    tempCanvas.height = 50;
    (canvas as any)._float = {
      originalImageData: new ImageData(50, 50),
      currentRect: { x: 100, y: 100, w: 50, h: 50 },
      tempCanvas,
    };

    const redrawSpy = vi.fn();
    (canvas as any)._redrawFloatPreview = redrawSpy;
    (canvas as any)._dispatchViewportChange = vi.fn();

    // centerDocument DOES call _redrawFloatPreview when a float is active
    canvas.centerDocument();

    expect(redrawSpy).toHaveBeenCalled();
  });
});

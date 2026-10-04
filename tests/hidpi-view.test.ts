import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { MAX_VIEW_BACKING_PIXELS, sizeViewCanvas, viewBackingSize, viewCanvasSize } from '../src/utils/view-canvas.ts';
import { attachCanvasElements, makeLayer, makeState } from './helpers.ts';

function setDevicePixelRatio(dpr: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
}

afterEach(() => setDevicePixelRatio(1));

describe('view canvas sizing', () => {
  it('gives the bitmap one pixel per device pixel', () => {
    expect(viewBackingSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
    expect(viewBackingSize(801, 601, 1.5)).toEqual({ width: 1202, height: 902 });
    expect(viewBackingSize(800, 600, 0.5)).toEqual({ width: 400, height: 300 });
  });

  it('caps the bitmap of a huge view, but never below one pixel per CSS pixel', () => {
    const b = viewBackingSize(3000, 2000, 3);
    expect(b.width * b.height).toBeLessThanOrEqual(MAX_VIEW_BACKING_PIXELS * 1.001);
    expect(b.width).toBeGreaterThan(3000);
    expect(viewBackingSize(6000, 4000, 2)).toEqual({ width: 6000, height: 4000 });
  });

  it('treats a bad scale as 1', () => {
    expect(viewBackingSize(100, 50, NaN)).toEqual({ width: 100, height: 50 });
    expect(viewBackingSize(100, 50, 0)).toEqual({ width: 100, height: 50 });
  });

  it('lays the canvas out in CSS pixels and draws in them', () => {
    const canvas = document.createElement('canvas');
    sizeViewCanvas(canvas, 300, 200, 2);
    expect([canvas.width, canvas.height]).toEqual([600, 400]);
    expect([canvas.style.width, canvas.style.height]).toEqual(['300px', '200px']);
    expect(viewCanvasSize(canvas)).toEqual({ width: 300, height: 200 });
    const m = canvas.getContext('2d')!.getTransform();
    expect([m.a, m.d]).toEqual([2, 2]);
  });

  it('takes a canvas resized some other way as one bitmap pixel per CSS pixel', () => {
    const canvas = document.createElement('canvas');
    sizeViewCanvas(canvas, 300, 200, 2);
    canvas.width = 50;
    expect(viewCanvasSize(canvas)).toEqual({ width: 50, height: 400 });
  });
});

describe('DrawingCanvas on a high-DPI screen', () => {
  function setup(viewWidth: number, viewHeight: number) {
    const canvas = new DrawingCanvas();
    const layer = makeLayer(800, 600);
    const state = makeState({ layers: [layer], activeLayerId: layer.id, documentWidth: 800, documentHeight: 600 });
    (canvas as any)._ctx = { value: { state } };
    const { mainCanvas, previewCanvas } = attachCanvasElements(canvas, viewWidth, viewHeight);
    (canvas as any).composite = vi.fn();
    (canvas as any)._composite = vi.fn();
    (canvas as any).requestUpdate = vi.fn();
    const resize = (width: number, height: number) => {
      (canvas as any).getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
      Object.defineProperty(mainCanvas, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 10, top: 20, width, height }),
      });
      (canvas as any)._invalidateCanvasRect();
      (canvas as any)._resizeToFit();
    };
    return { canvas, mainCanvas, previewCanvas, resize };
  }

  it('sizes the display and preview bitmaps at device resolution, the view in CSS pixels', () => {
    setDevicePixelRatio(2);
    const { canvas, mainCanvas, previewCanvas, resize } = setup(100, 100);
    resize(1200, 800);
    expect([mainCanvas.width, mainCanvas.height]).toEqual([2400, 1600]);
    expect([previewCanvas.width, previewCanvas.height]).toEqual([2400, 1600]);
    expect(canvas.getViewportSize()).toEqual({ width: 1200, height: 800 });
    canvas.resetView();
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 200, panY: 100 });
  });

  it('maps a pointer to the document point under it', () => {
    setDevicePixelRatio(2);
    const { canvas, resize } = setup(100, 100);
    resize(1200, 800);
    canvas.setViewport(2, 100, 50);
    const p = (canvas as any)._clientToDoc(10 + 300, 20 + 250);
    expect(p).toEqual({ x: 100, y: 100 });
    expect((canvas as any)._clientToView(10 + 300, 20 + 250)).toEqual({ x: 300, y: 250 });
  });

  it('keeps the view when only the device pixel ratio changes', () => {
    setDevicePixelRatio(1);
    const { canvas, mainCanvas, resize } = setup(100, 100);
    resize(1200, 800);
    canvas.setViewport(1.5, 37, 41);
    const dispatch = vi.spyOn(canvas as any, '_dispatchViewportChange');
    setDevicePixelRatio(3);
    resize(1200, 800);
    expect([mainCanvas.width, mainCanvas.height]).toEqual([3600, 2400]);
    expect(canvas.getViewport()).toEqual({ zoom: 1.5, panX: 37, panY: 41 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('leaves the canvases alone when nothing changed', () => {
    setDevicePixelRatio(2);
    const { mainCanvas, resize } = setup(100, 100);
    resize(1200, 800);
    const setWidth = vi.spyOn(mainCanvas, 'width', 'set');
    resize(1200, 800);
    expect(setWidth).not.toHaveBeenCalled();
  });

  it('measures the view in its own CSS pixels under a host CSS zoom', () => {
    setDevicePixelRatio(2);
    const { canvas, mainCanvas, resize } = setup(100, 100);
    // Zoomed 1.5×: the client rect is 1.5× the element's own (computed) size.
    Object.defineProperty(canvas, 'isConnected', { configurable: true, get: () => true });
    const cs = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ width: '800px', height: '600px' } as CSSStyleDeclaration);
    try {
      resize(1200, 900);
    } finally {
      cs.mockRestore();
    }
    expect(canvas.getViewportSize()).toEqual({ width: 800, height: 600 });
    expect([mainCanvas.width, mainCanvas.height]).toEqual([2400, 1800]);
    canvas.setViewport(1, 0, 0);
    // A client pixel is 2/3 of a view pixel.
    expect((canvas as any)._clientToDoc(10 + 300, 20 + 150)).toEqual({ x: 200, y: 100 });
  });
});

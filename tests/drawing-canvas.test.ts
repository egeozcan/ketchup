import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

describe('DrawingCanvas selection bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clamps selection rectangle to document bounds before lifting', () => {
    const canvas = new DrawingCanvas();
    const liftSpy = vi.fn();
    (canvas as any)._liftToFloat = liftSpy;
    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: -10, y: -20 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 900, y: 700 }));

    (canvas as any)._handleSelectPointerUp({} as PointerEvent);

    expect(liftSpy).toHaveBeenCalledWith(0, 0, 800, 600);
  });

  it('defensively clamps _liftToFloat() reads/writes to document bounds', () => {
    const canvas = new DrawingCanvas();
    const fakeImageData = {
      data: new Uint8ClampedArray(800 * 600 * 4),
      width: 800,
      height: 600,
    } as unknown as ImageData;
    const getImageData = vi.fn(() => fakeImageData);
    const clearRect = vi.fn();
    const putImageData = vi.fn();
    const drawImage = vi.fn();

    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ putImageData, drawImage }),
        } as unknown as HTMLCanvasElement;
      }
      return realCreateElement(tagName as any);
    }) as typeof document.createElement);

    (canvas as any)._captureBeforeDraw = vi.fn();
    (canvas as any)._getActiveLayerCtx = vi.fn(() => ({ getImageData, clearRect }));
    (canvas as any).composite = vi.fn();
    (canvas as any)._startSelectionAnimation = vi.fn();

    (canvas as any)._liftToFloat(-10, -20, 900, 700);

    expect(getImageData).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect((canvas as any)._float.currentRect).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe('DrawingCanvas saveCanvas', () => {
  it('includes active floating selection in exported image', () => {
    const canvas = new DrawingCanvas();

    // Set up a float with a known tempCanvas
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 50;
    floatTemp.height = 50;
    (canvas as any)._float = {
      originalImageData: new ImageData(50, 50),
      currentRect: { x: 10, y: 20, w: 50, h: 50 },
      tempCanvas: floatTemp,
    };

    // Set up a single visible layer
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 100;
    layerCanvas.height = 100;
    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 100,
          documentHeight: 100,
        },
      },
    };

    // Intercept the export canvas created inside saveCanvas
    let exportCtx: CanvasRenderingContext2D | null = null;
    const realCreate = document.createElement.bind(document);
    let canvasCount = 0;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'canvas') {
        canvasCount++;
        // The first canvas created by saveCanvas is the export canvas
        if (canvasCount === 1) {
          exportCtx = el.getContext('2d');
        }
      }
      // Prevent actual navigation for the anchor
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { value: vi.fn() });
      }
      return el;
    }) as typeof document.createElement);

    canvas.saveCanvas();

    expect(exportCtx).not.toBeNull();
    // The float's tempCanvas should have been drawn onto the export canvas
    expect(exportCtx!.drawImage).toHaveBeenCalledWith(floatTemp, 10, 20);
  });
});

describe('DrawingCanvas _commitFloat after clearCanvas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pushes a history entry when committing a float after clearCanvas consumed _beforeDrawData', () => {
    const canvas = new DrawingCanvas();

    // Set up a layer with a mock context
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 100;
    layerCanvas.height = 100;
    const layerCtx = layerCanvas.getContext('2d')!;

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 100,
          documentHeight: 100,
        },
      },
    };

    // Simulate an active float (as if the user lifted a selection)
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 20;
    floatTemp.height = 20;
    (canvas as any)._float = {
      originalImageData: new ImageData(20, 20),
      currentRect: { x: 5, y: 5, w: 20, h: 20 },
      tempCanvas: floatTemp,
    };

    // _liftToFloat normally sets _beforeDrawData; simulate that
    (canvas as any)._beforeDrawData = layerCtx.getImageData(0, 0, 100, 100);

    // Stub methods that touch the DOM/rendering
    (canvas as any).composite = vi.fn();
    (canvas as any)._clearFloatState = vi.fn();
    (canvas as any)._startSelectionAnimation = vi.fn();

    // clearCanvas consumes _beforeDrawData
    canvas.clearCanvas();
    expect((canvas as any)._beforeDrawData).toBeNull();

    // Record history length after the clear
    const historyAfterClear = (canvas as any)._history.length;

    // Now commit the float — this should still push a history entry
    (canvas as any)._commitFloat();

    expect((canvas as any)._history.length).toBe(historyAfterClear + 1);
  });
});

describe('DrawingCanvas _applyResize', () => {
  it('preserves aspect ratio when minSize clamp kicks in on a corner handle', () => {
    const canvas = new DrawingCanvas();

    // Original float: 200×100 (2:1 aspect ratio)
    const orig = { x: 50, y: 50, w: 200, h: 100 };
    (canvas as any)._float = {
      originalImageData: new ImageData(200, 100),
      currentRect: { ...orig },
      tempCanvas: document.createElement('canvas'),
    };
    (canvas as any)._floatSrcCanvas = document.createElement('canvas');
    (canvas as any)._floatResizeHandle = 'se';
    (canvas as any)._floatResizeOrigin = {
      rect: { ...orig },
      point: { x: 250, y: 150 }, // SE corner of orig rect
    };

    // Low zoom makes minSize large (4 / 0.2 = 20)
    (canvas as any)._zoom = 0.2;

    // Drag SE handle inward to shrink below minSize while preserving aspect
    // dx = -190 → newW = 200 + (-190) = 10
    // dy = -95  → newH = 100 + (-95) = 5
    // Aspect enforcement: 10/5 = 2:1 ✓
    // But minSize=20, so independent clamp → 20×20 = 1:1 ✗
    (canvas as any)._applyResize({ x: 250 - 190, y: 150 - 95 });

    const result = (canvas as any)._float.currentRect;
    const resultAspect = result.w / result.h;
    const origAspect = orig.w / orig.h;

    // Aspect ratio must be preserved (2:1), not become 1:1
    expect(resultAspect).toBeCloseTo(origAspect, 5);
    // Both dimensions must still meet the minimum
    expect(result.w).toBeGreaterThanOrEqual(20);
    expect(result.h).toBeGreaterThanOrEqual(20);
  });
});

describe('DrawingCanvas pasteSelection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clamps paste origin into document bounds after a document resize', () => {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 200;
    layerCanvas.height = 200;

    // Document is now 200×200 (simulating a resize-down from 800×600)
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

    // Clipboard was copied from the old 800×600 document at position (500, 400)
    (canvas as any)._clipboard = new ImageData(50, 50);
    (canvas as any)._clipboardOrigin = { x: 500, y: 400 };

    // Stub methods
    (canvas as any)._commitFloat = vi.fn();
    (canvas as any)._captureBeforeDraw = vi.fn();
    (canvas as any)._startSelectionAnimation = vi.fn();

    canvas.pasteSelection();

    const rect = (canvas as any)._float.currentRect;
    // The paste origin must be clamped so at least part of the float
    // is inside the 200×200 document — not placed at (500, 400)
    expect(rect.x).toBeLessThan(200);
    expect(rect.y).toBeLessThan(200);
  });
});

describe('DrawingCanvas stamp tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('commits the float when clicking outside it even if stampImage is null', () => {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;

    (canvas as any)._ctx = {
      value: {
        state: {
          activeTool: 'stamp',
          stampImage: null,
          brushSize: 10,
          strokeColor: '#000000',
          fillColor: '#ff0000',
          useFill: false,
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 800,
          documentHeight: 600,
          layersPanelOpen: true,
        },
      },
    };

    // Active float at (100, 100, 50, 50) — e.g. a previously placed stamp
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 50;
    floatTemp.height = 50;
    (canvas as any)._float = {
      originalImageData: new ImageData(50, 50),
      currentRect: { x: 100, y: 100, w: 50, h: 50 },
      tempCanvas: floatTemp,
    };

    const commitSpy = vi.spyOn(canvas as any, '_commitFloat').mockImplementation(() => {
      (canvas as any)._float = null;
    });

    // Mock mainCanvas for setPointerCapture and _getDocPoint
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: {
        setPointerCapture: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      },
    });

    // Click at (300, 300) — well outside the float
    const event = { button: 0, clientX: 300, clientY: 300, pointerId: 1 } as unknown as PointerEvent;
    (canvas as any)._onPointerDown(event);

    expect(commitSpy).toHaveBeenCalled();
  });
});

describe('DrawingCanvas selection rounding', () => {
  it('rounds endpoints before computing width/height for _liftToFloat', () => {
    const canvas = new DrawingCanvas();
    const liftSpy = vi.fn();
    (canvas as any)._liftToFloat = liftSpy;
    (canvas as any)._selectionDrawing = true;

    // Drag from (10.4, 20.4) to (12.6, 22.6)
    // Fractional endpoints that straddle pixel boundaries:
    //   x=10.4 rounds to 10, right=12.6 rounds to 13 → width should be 3
    //   y=20.4 rounds to 20, bottom=22.6 rounds to 23 → height should be 3
    // Bug: Math.round(w) where w=2.2 gives 2, losing 1 pixel
    (canvas as any)._startPoint = { x: 10.4, y: 20.4 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 12.6, y: 22.6 }));

    (canvas as any)._handleSelectPointerUp({} as PointerEvent);

    expect(liftSpy).toHaveBeenCalledTimes(1);
    const [rx, ry, rw, rh] = liftSpy.mock.calls[0];
    // Rounded endpoints: (10, 20) to (13, 23)
    expect(rx).toBe(10);
    expect(ry).toBe(20);
    expect(rw).toBe(3);
    expect(rh).toBe(3);
  });
});

describe('DrawingCanvas _endPan cursor', () => {
  it('restores the move cursor after a middle-button pan with the move tool', () => {
    const canvas = new DrawingCanvas();

    (canvas as any)._ctx = {
      value: {
        state: {
          activeTool: 'move',
          layers: [],
          activeLayerId: '',
          documentWidth: 800,
          documentHeight: 600,
        },
      },
    };

    const mockMainCanvas = {
      style: { cursor: '' },
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    };
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: mockMainCanvas,
    });

    // Simulate a middle-button pan
    (canvas as any)._panning = true;
    (canvas as any)._panPointerId = 1;

    (canvas as any)._endPan();

    // After pan ends with the move tool active, cursor must be 'move', not 'crosshair'
    expect(mockMainCanvas.style.cursor).toBe('move');
  });
});

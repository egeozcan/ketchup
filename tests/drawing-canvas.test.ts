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
          exportCtx = (el as HTMLCanvasElement).getContext('2d');
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

  it('preserves the east-edge anchor when W handle minSize clamp activates', () => {
    const canvas = new DrawingCanvas();

    const orig = { x: 50, y: 50, w: 200, h: 100 };
    (canvas as any)._float = {
      originalImageData: new ImageData(200, 100),
      currentRect: { ...orig },
      tempCanvas: document.createElement('canvas'),
    };
    (canvas as any)._floatSrcCanvas = document.createElement('canvas');
    (canvas as any)._floatResizeHandle = 'w';
    (canvas as any)._floatResizeOrigin = {
      rect: { ...orig },
      point: { x: 50, y: 100 }, // W edge midpoint
    };

    // minSize = 4 / 0.2 = 20
    (canvas as any)._zoom = 0.2;

    // Drag W handle 190px to the right → newW = 200 - 190 = 10, clamped to 20
    (canvas as any)._applyResize({ x: 50 + 190, y: 100 });

    const result = (canvas as any)._float.currentRect;
    const eastEdge = result.x + result.w;

    // The east edge must stay anchored at orig.x + orig.w = 250
    // BUG: without fix, eastEdge = 240 + 20 = 260
    expect(eastEdge).toBe(orig.x + orig.w);
    expect(result.w).toBeGreaterThanOrEqual(20);
  });

  it('preserves the south-edge anchor when N handle minSize clamp activates', () => {
    const canvas = new DrawingCanvas();

    const orig = { x: 50, y: 50, w: 200, h: 100 };
    (canvas as any)._float = {
      originalImageData: new ImageData(200, 100),
      currentRect: { ...orig },
      tempCanvas: document.createElement('canvas'),
    };
    (canvas as any)._floatSrcCanvas = document.createElement('canvas');
    (canvas as any)._floatResizeHandle = 'n';
    (canvas as any)._floatResizeOrigin = {
      rect: { ...orig },
      point: { x: 150, y: 50 }, // N edge midpoint
    };

    (canvas as any)._zoom = 0.2;

    // Drag N handle 90px down → newH = 100 - 90 = 10, clamped to 20
    (canvas as any)._applyResize({ x: 150, y: 50 + 90 });

    const result = (canvas as any)._float.currentRect;
    const southEdge = result.y + result.h;

    // The south edge must stay anchored at orig.y + orig.h = 150
    expect(southEdge).toBe(orig.y + orig.h);
    expect(result.h).toBeGreaterThanOrEqual(20);
  });

  it('preserves the SE-corner anchor when NW handle minSize clamp activates', () => {
    const canvas = new DrawingCanvas();

    const orig = { x: 0, y: 0, w: 200, h: 100 };
    (canvas as any)._float = {
      originalImageData: new ImageData(200, 100),
      currentRect: { ...orig },
      tempCanvas: document.createElement('canvas'),
    };
    (canvas as any)._floatSrcCanvas = document.createElement('canvas');
    (canvas as any)._floatResizeHandle = 'nw';
    (canvas as any)._floatResizeOrigin = {
      rect: { ...orig },
      point: { x: 0, y: 0 }, // NW corner
    };

    // minSize = 4 / 0.2 = 20
    (canvas as any)._zoom = 0.2;

    // Drag NW handle far toward SE → both dimensions shrink below minSize
    // dx=190 → newW = 200-190 = 10, dy=95 → newH = 100-95 = 5
    // After aspect + re-anchor + clamp: newW=40, newH=20
    (canvas as any)._applyResize({ x: 190, y: 95 });

    const result = (canvas as any)._float.currentRect;

    // The SE corner must stay anchored at (orig.x + orig.w, orig.y + orig.h) = (200, 100)
    expect(result.x + result.w).toBe(orig.x + orig.w);
    expect(result.y + result.h).toBe(orig.y + orig.h);
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

describe('DrawingCanvas _createFloatFromImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not crash on a narrow image that rounds to zero width', () => {
    const canvas = new DrawingCanvas();

    (canvas as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: document.createElement('canvas') }],
          activeLayerId: 'l1',
          documentWidth: 800,
          documentHeight: 600,
        },
      },
    };

    (canvas as any).composite = vi.fn();
    (canvas as any)._stopSelectionAnimation = vi.fn();

    // A 1×100 image with size=40: scale = 40/100 = 0.4
    // w = Math.round(1 * 0.4) = 0 → zero-width canvas → crash
    const img = new Image();
    Object.defineProperty(img, 'naturalWidth', { value: 1 });
    Object.defineProperty(img, 'naturalHeight', { value: 100 });

    expect(() => {
      (canvas as any)._createFloatFromImage(img, 400, 300, 40);
    }).not.toThrow();

    // Float should be created with w >= 1
    expect((canvas as any)._float).not.toBeNull();
    expect((canvas as any)._float.currentRect.w).toBeGreaterThanOrEqual(1);
    expect((canvas as any)._float.currentRect.h).toBeGreaterThanOrEqual(1);
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

describe('DrawingCanvas canUndo with active float', () => {
  it('reports canUndo=true when a float exists even with empty history', () => {
    const canvas = new DrawingCanvas();

    // Empty history
    (canvas as any)._history = [];
    (canvas as any)._historyIndex = -1;

    // Active float
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 20;
    floatTemp.height = 20;
    (canvas as any)._float = {
      originalImageData: new ImageData(20, 20),
      currentRect: { x: 0, y: 0, w: 20, h: 20 },
      tempCanvas: floatTemp,
    };

    let detail: { canUndo: boolean; canRedo: boolean } | null = null;
    canvas.addEventListener('history-change', (e: Event) => {
      detail = (e as CustomEvent).detail;
    });

    (canvas as any)._notifyHistory();

    // With a float active, undo can discard it — button must be enabled
    expect(detail).not.toBeNull();
    expect(detail!.canUndo).toBe(true);
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

describe('DrawingCanvas undo with float on empty history', () => {
  it('discards the float even when there is no history to undo', () => {
    const canvas = new DrawingCanvas();

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

    (canvas as any).composite = vi.fn();
    (canvas as any)._stopSelectionAnimation = vi.fn();

    // Empty history — nothing to undo
    (canvas as any)._history = [];
    (canvas as any)._historyIndex = -1;

    // Active float (user just selected a region)
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 20;
    floatTemp.height = 20;
    (canvas as any)._float = {
      originalImageData: new ImageData(20, 20),
      currentRect: { x: 10, y: 10, w: 20, h: 20 },
      tempCanvas: floatTemp,
    };
    (canvas as any)._beforeDrawData = new ImageData(100, 100);

    canvas.undo();

    // The float must be discarded — Ctrl+Z should cancel the selection
    expect((canvas as any)._float).toBeNull();
    // History should remain empty (no entry was pushed)
    expect((canvas as any)._history).toHaveLength(0);
  });
});

describe('DrawingCanvas redo with active float', () => {
  it('does not crash when redo entries exist and a float is active', () => {
    const canvas = new DrawingCanvas();

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

    (canvas as any).composite = vi.fn();
    (canvas as any)._stopSelectionAnimation = vi.fn();

    // History with a redo entry: [E0, E1, E2], index=1 → E2 is redoable
    const img = () => new ImageData(100, 100);
    (canvas as any)._history = [
      { type: 'draw', layerId: 'l1', before: img(), after: img() },
      { type: 'draw', layerId: 'l1', before: img(), after: img() },
      { type: 'draw', layerId: 'l1', before: img(), after: img() },
    ];
    (canvas as any)._historyIndex = 1;

    // Active float (e.g. user just made a selection)
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 20;
    floatTemp.height = 20;
    (canvas as any)._float = {
      originalImageData: new ImageData(20, 20),
      currentRect: { x: 10, y: 10, w: 20, h: 20 },
      tempCanvas: floatTemp,
    };
    (canvas as any)._beforeDrawData = img();

    // BUG: _commitFloat inside redo() pushes a new history entry,
    // truncating E2. Then redo increments past the array → crash.
    expect(() => canvas.redo()).not.toThrow();

    // After redo, the float should be gone and E2 should have been applied
    expect((canvas as any)._float).toBeNull();
    expect((canvas as any)._historyIndex).toBe(2);
  });
});

describe('DrawingCanvas clearCanvas with active float', () => {
  it('preserves original pre-lift layer state in undo history', () => {
    const canvas = new DrawingCanvas();

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

    // Simulate a float with _beforeDrawData set (as _liftToFloat does)
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 20;
    floatTemp.height = 20;
    (canvas as any)._float = {
      originalImageData: new ImageData(20, 20),
      currentRect: { x: 10, y: 10, w: 20, h: 20 },
      tempCanvas: floatTemp,
    };

    // A distinct ImageData object representing the pre-lift layer state.
    // We check identity (===) to confirm it ends up in history[0].before.
    const preLiftState = new ImageData(100, 100);
    (canvas as any)._beforeDrawData = preLiftState;

    // Stub methods that touch DOM/rendering not available in test env
    (canvas as any).composite = vi.fn();
    (canvas as any)._stopSelectionAnimation = vi.fn();

    canvas.clearCanvas();

    // With the fix, _commitFloat runs first and pushes a history entry
    // whose "before" is the pre-lift state (preLiftState).
    // Without the fix, clearCanvas overwrites _beforeDrawData via
    // _captureBeforeDraw, so the pre-lift state is lost.
    const history: any[] = (canvas as any)._history;
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].before).toBe(preLiftState);
  });
});

describe('DrawingCanvas cancelExternalFloat history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not leave orphan history entries after canceling an external image paste', () => {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;

    const pastedLayerCanvas = document.createElement('canvas');
    pastedLayerCanvas.width = 800;
    pastedLayerCanvas.height = 600;

    let layers = [
      { id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas },
      { id: 'l2', name: 'Pasted Image', visible: true, opacity: 1, canvas: pastedLayerCanvas },
    ];

    const deleteLayerSpy = vi.fn((id: string) => {
      layers = layers.filter(l => l.id !== id);
    });

    (canvas as any)._ctx = {
      value: {
        state: {
          layers,
          activeLayerId: 'l2',
          documentWidth: 800,
          documentHeight: 600,
        },
        deleteLayer: deleteLayerSpy,
      },
    };

    (canvas as any).composite = vi.fn();
    (canvas as any)._stopSelectionAnimation = vi.fn();

    // Simulate the state after _handleExternalImage completed:
    // - There's an active float marked as external image
    // - _beforeDrawData is set
    // - An add-layer history entry was pushed
    const floatTemp = document.createElement('canvas');
    floatTemp.width = 100;
    floatTemp.height = 100;
    (canvas as any)._float = {
      originalImageData: new ImageData(100, 100),
      currentRect: { x: 350, y: 250, w: 100, h: 100 },
      tempCanvas: floatTemp,
    };
    (canvas as any)._floatIsExternalImage = true;
    (canvas as any)._beforeDrawData = new ImageData(800, 600);

    // Push an add-layer history entry (as addLayer would have done)
    (canvas as any)._pushHistoryEntry({
      type: 'add-layer',
      layer: { id: 'l2', name: 'Pasted Image', visible: true, opacity: 1, imageData: new ImageData(800, 600) },
      index: 1,
    });
    const historyLenAfterAdd = (canvas as any)._history.length;
    expect(historyLenAfterAdd).toBe(1);

    // Cancel the external float
    canvas.cancelExternalFloat();

    // The add-layer entry should have been removed from history, and
    // deleteLayer should NOT push another entry — the net result on
    // history should be zero new entries.
    expect((canvas as any)._history.length).toBeLessThanOrEqual(historyLenAfterAdd - 1);
  });
});

describe('DrawingCanvas fill tool bounds check', () => {
  it('does not push a phantom history entry when rounded coords are out of bounds', () => {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 800;
    layerCanvas.height = 600;

    (canvas as any)._ctx = {
      value: {
        state: {
          activeTool: 'fill',
          strokeColor: '#ff0000',
          fillColor: '#000000',
          useFill: false,
          brushSize: 4,
          stampImage: null,
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 800,
          documentHeight: 600,
          layersPanelOpen: true,
        },
      },
    };

    (canvas as any).composite = vi.fn();

    // Mock mainCanvas for setPointerCapture and _getDocPoint
    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: {
        setPointerCapture: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      },
    });

    // Simulate a click at viewport coords that map to doc coords (799.6, 300)
    // at zoom=1, pan=0: docX = clientX - 0 - 0 = clientX
    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    const event = {
      button: 0,
      clientX: 799.6,
      clientY: 300,
      pointerId: 1,
    } as unknown as PointerEvent;

    (canvas as any)._onPointerDown(event);

    // Math.round(799.6) = 800, which is >= canvas width (800).
    // floodFill returns early without modifying anything.
    // BUG: the outer bounds check passes (799.6 < 800), so _captureBeforeDraw
    // and _pushDrawHistory still run, creating a no-op history entry.
    expect((canvas as any)._history).toHaveLength(0);
  });

  it('does not push a no-op history entry when floodFill changes nothing', () => {
    const canvas = new DrawingCanvas();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 100;
    layerCanvas.height = 100;

    (canvas as any)._ctx = {
      value: {
        state: {
          activeTool: 'fill',
          strokeColor: '#ff0000',
          fillColor: '#000000',
          useFill: false,
          brushSize: 4,
          stampImage: null,
          layers: [{ id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas }],
          activeLayerId: 'l1',
          documentWidth: 100,
          documentHeight: 100,
          layersPanelOpen: true,
        },
      },
    };

    (canvas as any).composite = vi.fn();

    Object.defineProperty(canvas, 'mainCanvas', {
      configurable: true,
      value: {
        setPointerCapture: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      },
    });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    // In the jsdom/canvas-mock environment, getImageData returns all zeros
    // and parseColor also returns {r:0,g:0,b:0,a:0} (mock doesn't render).
    // So floodFill hits the "same color" early return — no pixels change.
    const event = {
      button: 0,
      clientX: 50,
      clientY: 50,
      pointerId: 1,
    } as unknown as PointerEvent;

    (canvas as any)._onPointerDown(event);

    // floodFill returned without modifying the layer.
    // No history entry should be pushed for a no-op fill.
    expect((canvas as any)._history).toHaveLength(0);
  });
});

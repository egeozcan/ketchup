import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import {
  attachCanvasElements,
  makeLayer,
  makeState,
  makeTransformManagerStub,
} from './helpers.ts';

function setupCanvas({
  width = 100,
  height = 100,
  stateOverrides = {},
}:
  {
    width?: number;
    height?: number;
    stateOverrides?: Record<string, unknown>;
  } = {}) {
  const canvas = new DrawingCanvas();
  const layers = ((stateOverrides.layers as ReturnType<typeof makeLayer>[]) ?? [makeLayer(width, height)]);
  const state = makeState({
    layers,
    activeLayerId: (stateOverrides.activeLayerId as string | undefined) ?? layers[0].id,
    documentWidth: width,
    documentHeight: height,
    ...(stateOverrides as object),
  });
  (canvas as any)._ctx = { value: { state } };
  attachCanvasElements(canvas, width, height);
  (canvas as any).composite = vi.fn();
  (canvas as any).requestUpdate = vi.fn();
  return { canvas, state, layers, activeLayer: layers.find(layer => layer.id === state.activeLayerId)! };
}

describe('DrawingCanvas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clamps selection bounds to the document before lifting into transform mode', () => {
    const { canvas, activeLayer } = setupCanvas({ width: 800, height: 600 });
    const layerCtx = activeLayer.canvas.getContext('2d')!;
    const getImageDataSpy = vi.spyOn(layerCtx, 'getImageData');
    const clearRectSpy = vi.spyOn(layerCtx, 'clearRect');

    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: -10, y: -20 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 900, y: 700 }));

    (canvas as any)._handleSelectPointerUp({} as PointerEvent);

    expect(getImageDataSpy).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(clearRectSpy).toHaveBeenCalledWith(0, 0, 800, 600);
    expect((canvas as any).getTransformValues()).toMatchObject({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('rounds selection endpoints before deriving width and height', () => {
    const { canvas, activeLayer } = setupCanvas();
    const layerCtx = activeLayer.canvas.getContext('2d')!;
    const getImageDataSpy = vi.spyOn(layerCtx, 'getImageData');

    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: 10.4, y: 20.4 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 12.6, y: 22.6 }));

    (canvas as any)._handleSelectPointerUp({} as PointerEvent);

    expect(getImageDataSpy).toHaveBeenCalledWith(10, 20, 3, 3);
    expect((canvas as any).getTransformValues()).toMatchObject({ x: 10, y: 20, width: 3, height: 3 });
  });

  it('dispatches transform-change after lifting a selection', () => {
    const { canvas } = setupCanvas();
    const handler = vi.fn();
    canvas.addEventListener('transform-change', handler);

    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: 10, y: 10 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 40, y: 50 }));

    (canvas as any)._handleSelectPointerUp({} as PointerEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail.active).toBe(true);
  });

  it('exports the active transform at the owning layer z-position', () => {
    const canvas = new DrawingCanvas();
    const l1 = makeLayer(100, 100, { id: 'l1' });
    const l2 = makeLayer(100, 100, { id: 'l2', name: 'Layer 2' });
    (canvas as any)._ctx = {
      value: {
        state: makeState({
          layers: [l1, l2],
          activeLayerId: 'l1',
          documentWidth: 100,
          documentHeight: 100,
        }),
      },
    };
    attachCanvasElements(canvas, 100, 100);

    const floatCanvas = document.createElement('canvas');
    floatCanvas.width = 50;
    floatCanvas.height = 50;
    (canvas as any)._transformManager = makeTransformManagerStub({
      renderTransformed: vi.fn((ctx: CanvasRenderingContext2D) => {
        ctx.drawImage(floatCanvas, 10, 10);
      }),
    });

    const drawOrder: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'canvas') {
        const ctx = (el as HTMLCanvasElement).getContext('2d')!;
        const original = ctx.drawImage.bind(ctx);
        ctx.drawImage = vi.fn((...args: any[]) => {
          const source = args[0] as HTMLCanvasElement;
          if (source === l1.canvas) drawOrder.push('l1');
          if (source === l2.canvas) drawOrder.push('l2');
          if (source === floatCanvas) drawOrder.push('float');
          original(...(args as Parameters<typeof ctx.drawImage>));
        }) as typeof ctx.drawImage;
      }
      if (tag === 'a') {
        Object.defineProperty(el, 'click', { configurable: true, value: vi.fn() });
      }
      return el;
    }) as typeof document.createElement);

    canvas.saveCanvas();

    expect(drawOrder).toEqual(['l1', 'float', 'l2']);
  });

  it('clamps paste origins into the resized document bounds', () => {
    const { canvas } = setupCanvas({ width: 200, height: 200 });

    (canvas as any)._clipboard = new ImageData(50, 50);
    (canvas as any)._clipboardOrigin = { x: 500, y: 400 };

    canvas.pasteSelection();

    expect((canvas as any).getTransformValues()).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: 50,
      height: 50,
    });
    expect((canvas as any).getTransformValues().x).toBeLessThan(200);
    expect((canvas as any).getTransformValues().y).toBeLessThan(200);
  });

  it('does not crash when creating a stamp transform from a narrow image', () => {
    const { canvas } = setupCanvas({ width: 800, height: 600 });
    const img = new Image();
    Object.defineProperty(img, 'naturalWidth', { value: 1 });
    Object.defineProperty(img, 'naturalHeight', { value: 100 });

    expect(() => {
      (canvas as any)._createStampAsTransform(img, 400, 300, 40);
    }).not.toThrow();

    const values = (canvas as any).getTransformValues();
    expect(values).not.toBeNull();
    expect(values.width).toBeGreaterThanOrEqual(1);
    expect(values.height).toBeGreaterThanOrEqual(1);
  });

  it('reports canUndo when a transform is active with empty history', () => {
    const { canvas } = setupCanvas();
    (canvas as any)._history = [];
    (canvas as any)._historyIndex = -1;
    (canvas as any)._transformManager = makeTransformManagerStub();

    let detail: { canUndo: boolean; canRedo: boolean } | null = null;
    canvas.addEventListener('history-change', (event: Event) => {
      detail = (event as CustomEvent).detail;
    });

    (canvas as any)._notifyHistory();

    expect(detail).not.toBeNull();
    expect(detail!.canUndo).toBe(true);
  });

  it('undo discards the active transform even with empty history', () => {
    const { canvas } = setupCanvas();
    (canvas as any)._history = [];
    (canvas as any)._historyIndex = -1;
    (canvas as any)._beforeDrawData = new ImageData(100, 100);
    (canvas as any)._transformManager = makeTransformManagerStub({
      getSourceRect: vi.fn(() => ({ x: 10, y: 10, w: 20, h: 20 })),
    });

    canvas.undo();

    expect((canvas as any)._transformManager).toBeNull();
    expect((canvas as any)._history).toHaveLength(0);
  });

  it('redo discards the active transform before replaying the next entry', () => {
    const { canvas, activeLayer } = setupCanvas();
    const image = () => new ImageData(100, 100);
    (canvas as any)._history = [
      { type: 'draw', layerId: activeLayer.id, before: image(), after: image() },
      { type: 'draw', layerId: activeLayer.id, before: image(), after: image() },
      { type: 'draw', layerId: activeLayer.id, before: image(), after: image() },
    ];
    (canvas as any)._historyIndex = 1;
    (canvas as any)._beforeDrawData = new ImageData(100, 100);
    (canvas as any)._transformManager = makeTransformManagerStub({
      getSourceRect: vi.fn(() => ({ x: 10, y: 10, w: 20, h: 20 })),
    });

    expect(() => canvas.redo()).not.toThrow();
    expect((canvas as any)._transformManager).toBeNull();
    expect((canvas as any)._historyIndex).toBe(2);
  });

  it('preserves the pre-lift image data when clearCanvas commits an active transform', () => {
    const { canvas } = setupCanvas();
    const preLiftState = new ImageData(100, 100);
    (canvas as any)._beforeDrawData = preLiftState;
    (canvas as any)._transformManager = makeTransformManagerStub({
      hasChanged: vi.fn(() => true),
    });

    canvas.clearCanvas();

    const history = (canvas as any)._history;
    expect(history[0].type).toBe('transform');
    expect(history[0].before).toBe(preLiftState);
  });

  it('cancelExternalFloat removes the pasted layer history without orphaning entries', () => {
    const canvas = new DrawingCanvas();
    const baseLayer = makeLayer(800, 600, { id: 'l1' });
    const pastedLayer = makeLayer(800, 600, { id: 'l2', name: 'Pasted Image' });
    (canvas as any)._ctx = {
      value: {
        state: makeState({
          layers: [baseLayer, pastedLayer],
          activeLayerId: pastedLayer.id,
          documentWidth: 800,
          documentHeight: 600,
        }),
      },
    };
    attachCanvasElements(canvas, 800, 600);
    (canvas as any)._transformManager = makeTransformManagerStub();
    (canvas as any)._floatIsExternalImage = true;
    (canvas as any).composite = vi.fn();

    (canvas as any)._pushHistoryEntry({
      type: 'add-layer',
      layer: {
        id: pastedLayer.id,
        name: pastedLayer.name,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        imageData: new ImageData(800, 600),
      },
      index: 1,
    });
    const historyLenAfterAdd = (canvas as any)._history.length;

    canvas.cancelExternalFloat();

    expect((canvas as any)._history.length).toBeLessThan(historyLenAfterAdd);
    expect((canvas as any)._history.some((entry: any) => entry.type === 'add-layer')).toBe(false);
  });

  it('does not push a no-op history entry when clicking move without dragging', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'move' } });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 50, clientY: 50, pointerId: 1 } as PointerEvent);
    (canvas as any)._onPointerUp({ clientX: 50, clientY: 50, pointerId: 1 } as PointerEvent);

    expect((canvas as any)._history).toHaveLength(0);
  });

  it('cleans up move state when the tool changes mid-drag', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'move' } });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 50, clientY: 50, pointerId: 1 } as PointerEvent);
    (canvas as any)._ctx.value.state.activeTool = 'pencil';
    (canvas as any)._onPointerUp({ clientX: 60, clientY: 60, pointerId: 1 } as PointerEvent);

    expect((canvas as any)._moveTempCanvas).toBeNull();
    expect((canvas as any)._moveStartPoint).toBeNull();
    expect((canvas as any)._history.length).toBeGreaterThan(0);
  });

  it('cleans up brush state when the tool changes mid-stroke', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'pencil' } });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 } as PointerEvent);
    (canvas as any)._ctx.value.state.activeTool = 'select';
    (canvas as any)._onPointerUp({ clientX: 50, clientY: 50, pointerId: 1 } as PointerEvent);

    expect((canvas as any)._drawing).toBe(false);
    expect((canvas as any)._beforeDrawData).toBeNull();
  });

  it('clearSelection clears _drawing so stale strokes do not leak across tools', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'pencil' } });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 } as PointerEvent);
    canvas.clearSelection();

    expect((canvas as any)._drawing).toBe(false);
  });

  it('clearCanvas finalizes an in-progress brush stroke before clearing', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'pencil' } });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 } as PointerEvent);
    const preBrushData = (canvas as any)._beforeDrawData;

    canvas.clearCanvas();

    expect((canvas as any)._drawing).toBe(false);
    expect((canvas as any)._history.length).toBe(2);
    expect((canvas as any)._history[0].before).toBe(preBrushData);
  });

  it('undo finalizes an in-progress brush stroke before undoing history', () => {
    const { canvas, activeLayer } = setupCanvas({ stateOverrides: { activeTool: 'pencil' } });
    const before = new ImageData(100, 100);
    const after = new ImageData(100, 100);
    (canvas as any)._history = [{ type: 'draw', layerId: activeLayer.id, before, after }];
    (canvas as any)._historyIndex = 0;

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 } as PointerEvent);
    canvas.undo();

    expect((canvas as any)._drawing).toBe(false);
    expect((canvas as any)._history.length).toBeGreaterThanOrEqual(1);
    expect((canvas as any)._historyIndex).toBe(-1);
  });

  it('pasteSelection does not overwrite the stroke-owned beforeDrawData', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'pencil' } });

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 } as PointerEvent);
    const preBrushData = (canvas as any)._beforeDrawData;
    (canvas as any)._clipboard = new ImageData(20, 20);
    (canvas as any)._clipboardOrigin = { x: 50, y: 50 };

    canvas.pasteSelection();

    expect((canvas as any)._beforeDrawData).toBe(preBrushData);
  });

  it('does not zoom when Ctrl+wheel has deltaY === 0', () => {
    const { canvas } = setupCanvas({ width: 800, height: 600 });
    const zoomBefore = (canvas as any)._zoom;

    (canvas as any)._onWheel({
      ctrlKey: true,
      metaKey: false,
      deltaX: 50,
      deltaY: 0,
      clientX: 400,
      clientY: 300,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent);

    expect((canvas as any)._zoom).toBe(zoomBefore);
  });

  it('clamps history indices passed to setHistory', () => {
    const { canvas, activeLayer } = setupCanvas();
    const image = () => new ImageData(100, 100);

    canvas.setHistory([
      { type: 'draw', layerId: activeLayer.id, before: image(), after: image() },
      { type: 'draw', layerId: activeLayer.id, before: image(), after: image() },
    ], 5);

    expect(canvas.getHistoryIndex()).toBe(1);
    expect(() => canvas.undo()).not.toThrow();
  });

  it('clears the preview canvas when abandoning a shape draw via clearSelection', () => {
    const { canvas } = setupCanvas({ stateOverrides: { activeTool: 'rectangle' } });
    const previewCtx = canvas.previewCanvas.getContext('2d')!;
    const clearRectSpy = vi.spyOn(previewCtx, 'clearRect');

    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 10, pointerId: 1 } as PointerEvent);
    previewCtx.fillRect(10, 10, 50, 50);

    canvas.clearSelection();

    expect((canvas as any)._drawing).toBe(false);
    expect(clearRectSpy).toHaveBeenCalled();
  });
});

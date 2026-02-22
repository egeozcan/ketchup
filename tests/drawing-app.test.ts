import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';

function makeKeyEvent(
  key: string,
  path: EventTarget[],
  options: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    preventDefault: vi.fn(),
    composedPath: () => path,
  } as unknown as KeyboardEvent;
}

function createAppWithCanvasSpies() {
  const app = new DrawingApp();
  const canvasMock = {
    undo: vi.fn(),
    redo: vi.fn(),
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    pasteSelection: vi.fn(),
    deleteSelection: vi.fn(),
    clearSelection: vi.fn(),
    zoomToFit: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    setHistory: vi.fn(),
    centerDocument: vi.fn(),
    composite: vi.fn(),
  };
  Object.defineProperty(app, 'canvas', {
    configurable: true,
    value: canvasMock,
  });
  return app;
}

describe('DrawingApp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not run shortcuts while typing in text inputs', () => {
    const app = createAppWithCanvasSpies();
    const input = document.createElement('input');
    input.type = 'text';
    const event = makeKeyEvent('z', [input], { ctrlKey: true });

    (app as any)._onKeyDown(event);

    expect((app as any).canvas.undo).not.toHaveBeenCalled();
    expect((event.preventDefault as any)).not.toHaveBeenCalled();
  });

  it('still runs shortcuts for non-text inputs like range sliders', () => {
    const app = createAppWithCanvasSpies();
    const input = document.createElement('input');
    input.type = 'range';
    const event = makeKeyEvent('z', [input], { ctrlKey: true });

    (app as any)._onKeyDown(event);

    expect((app as any).canvas.undo).toHaveBeenCalledTimes(1);
    expect((event.preventDefault as any)).toHaveBeenCalledTimes(1);
  });

  it('marks state dirty when toggling the layers panel', () => {
    const app = createAppWithCanvasSpies();
    const ctx = (app as any)._buildContextValue();
    const beforeOpen = (app as any)._state.layersPanelOpen;
    (app as any)._dirty = false;

    ctx.toggleLayersPanel();

    expect((app as any)._state.layersPanelOpen).toBe(!beforeOpen);
    expect((app as any)._dirty).toBe(true);
  });

  it('forces a full history rewrite after document resize', () => {
    const app = createAppWithCanvasSpies();
    const baseLayer = (app as any)._state.layers[0];
    const fakeImageData = {
      data: new Uint8ClampedArray(16),
      width: 2,
      height: 2,
    } as unknown as ImageData;
    const layerCtx = {
      getImageData: vi.fn(() => fakeImageData),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const layerCanvas = {
      width: 10,
      height: 10,
      getContext: vi.fn(() => layerCtx),
    } as unknown as HTMLCanvasElement;
    const setHistory = vi.fn();

    (app as any)._state = {
      ...(app as any)._state,
      documentWidth: 10,
      documentHeight: 10,
      layers: [{ ...baseLayer, canvas: layerCanvas }],
    };
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        clearSelection: vi.fn(),
        setHistory,
        centerDocument: vi.fn(),
        composite: vi.fn(),
      },
    });
    (app as any)._lastSavedHistoryLength = 5;
    (app as any)._lastSavedHistoryVersion = 0;

    (app as any)._buildContextValue().setDocumentSize(20, 30);

    expect(setHistory).toHaveBeenCalledWith([], -1);
    expect((app as any)._lastSavedHistoryLength).toBe(0);
    expect((app as any)._lastSavedHistoryVersion).toBe(-1);
    expect((layerCanvas as any).width).toBe(20);
    expect((layerCanvas as any).height).toBe(30);
  });
});

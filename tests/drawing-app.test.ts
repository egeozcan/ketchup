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
    pushLayerOperation: vi.fn(),
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

  it('triggers redo on Ctrl+Shift+Z with uppercase key (browser default)', () => {
    const app = createAppWithCanvasSpies();
    // Browsers produce e.key='Z' (uppercase) when Shift is held
    const event = makeKeyEvent('Z', [], { ctrlKey: true, shiftKey: true });

    (app as any)._onKeyDown(event);

    expect((app as any).canvas.redo).toHaveBeenCalledTimes(1);
    expect((event.preventDefault as any)).toHaveBeenCalledTimes(1);
  });

  it('marks state dirty when switching the active layer', () => {
    const app = createAppWithCanvasSpies();

    // Add a second layer so we have something to switch to
    const layer2 = (app as any)._createLayer(800, 600);
    (app as any)._state = {
      ...(app as any)._state,
      layers: [...(app as any)._state.layers, layer2],
    };

    (app as any)._dirty = false;
    const ctx = (app as any)._buildContextValue();

    ctx.setActiveLayer(layer2.id);

    expect((app as any)._state.activeLayerId).toBe(layer2.id);
    expect((app as any)._dirty).toBe(true);
  });

  it('commits the floating selection before adding a new layer', () => {
    const app = createAppWithCanvasSpies();

    const ctx = (app as any)._buildContextValue();

    // clearSelection was not called yet
    expect((app as any).canvas.clearSelection).not.toHaveBeenCalled();

    ctx.addLayer();

    // addLayer changes the active layer, so any float from the old layer
    // must be committed first — just like setActiveLayer does.
    expect((app as any).canvas.clearSelection).toHaveBeenCalled();
  });

  it('commits the float before flushing the save when switching projects', async () => {
    const app = createAppWithCanvasSpies();

    // Set up a "current project" so switchProject doesn't bail on the guard
    (app as any)._currentProject = { id: 'old', name: 'Old', createdAt: 0, updatedAt: 0, thumbnail: null };
    (app as any)._projectList = [
      { id: 'old', name: 'Old', createdAt: 0, updatedAt: 0, thumbnail: null },
      { id: 'new', name: 'New', createdAt: 0, updatedAt: 0, thumbnail: null },
    ];

    // Track call ordering
    const callOrder: string[] = [];
    (app as any).canvas.clearSelection = vi.fn(() => callOrder.push('clearSelection'));

    // Stub _flushPendingSaveAndWait to record the call and resolve immediately
    (app as any)._flushPendingSaveAndWait = vi.fn(async () => callOrder.push('flush'));
    // Make the dirty flag true so the flush path is entered
    (app as any)._dirty = true;

    // Stub _loadProject to not do real work
    (app as any)._loadProject = vi.fn(async () => {});

    const ctx = (app as any)._buildContextValue();
    ctx.switchProject('new');

    // switchProject is fire-and-forget async — wait for its internal promise
    await vi.advanceTimersByTimeAsync(0);

    // The float must be committed BEFORE the save flush, so the save
    // captures the layer with the float content (no hole).
    expect(callOrder).toContain('clearSelection');
    expect(callOrder).toContain('flush');
    expect(callOrder.indexOf('clearSelection')).toBeLessThan(callOrder.indexOf('flush'));
  });

  it('clears the floating selection when resetting to a fresh project', async () => {
    const app = createAppWithCanvasSpies();

    // _resetToFreshProject awaits this.updateComplete, so stub it
    Object.defineProperty(app, 'updateComplete', {
      configurable: true,
      get: () => Promise.resolve(true),
    });

    await (app as any)._resetToFreshProject();

    // clearSelection must be called to discard any float from the old project
    expect((app as any).canvas.clearSelection).toHaveBeenCalled();
  });
});

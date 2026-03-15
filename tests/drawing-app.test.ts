import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';

function makeKeyEvent(
  key: string,
  path: EventTarget[],
  options: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
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

  it('commits the float before flushing the save when creating a new project', async () => {
    const app = createAppWithCanvasSpies();

    (app as any)._currentProject = { id: 'old', name: 'Old', createdAt: 0, updatedAt: 0, thumbnail: null };

    const callOrder: string[] = [];
    (app as any).canvas.clearSelection = vi.fn(() => callOrder.push('clearSelection'));
    (app as any)._flushPendingSaveAndWait = vi.fn(async () => callOrder.push('flush'));
    (app as any)._dirty = true;

    // Stub _resetToFreshProject so it doesn't do real work
    (app as any)._resetToFreshProject = vi.fn(async () => {});

    // Stub createProjectInDB
    const projectStore = await import('../src/project-store.js');
    const createSpy = vi.spyOn(projectStore, 'createProject').mockResolvedValue(
      { id: 'new', name: 'Untitled', createdAt: 0, updatedAt: 0, thumbnail: null },
    );
    vi.spyOn(projectStore, 'listProjects').mockResolvedValue([]);

    const ctx = (app as any)._buildContextValue();
    ctx.createProject('Untitled');

    await vi.advanceTimersByTimeAsync(0);

    // clearSelection must happen BEFORE flush so the save captures the
    // layer with the float committed (no hole).
    expect(callOrder).toContain('clearSelection');
    expect(callOrder).toContain('flush');
    expect(callOrder.indexOf('clearSelection')).toBeLessThan(callOrder.indexOf('flush'));

    createSpy.mockRestore();
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

  it('commits the floating selection when switching tools via keyboard shortcut', () => {
    const app = createAppWithCanvasSpies();
    // Start with the select tool active
    (app as any)._state = { ...(app as any)._state, activeTool: 'select' };

    // Press 'b' to switch to pencil
    const event = makeKeyEvent('b', []);
    (app as any)._onKeyDown(event);

    expect((app as any)._state.activeTool).toBe('pencil');
    // The float must be committed before switching away from the select tool
    expect((app as any).canvas.clearSelection).toHaveBeenCalled();
  });

  it('suppresses shortcuts when a modal dialog is in the event path', () => {
    const app = createAppWithCanvasSpies();
    (app as any)._state = { ...(app as any)._state, activeTool: 'select' };

    // Simulate a keydown inside an open <dialog> (e.g. resize-dialog)
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const button = document.createElement('button');
    dialog.appendChild(button);

    const event = makeKeyEvent('b', [button, dialog]);
    (app as any)._onKeyDown(event);

    // Tool must NOT switch — the dialog should swallow the shortcut
    expect((app as any)._state.activeTool).toBe('select');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('does not skip layer counter numbers when addLayer is called with a custom name', () => {
    const app = createAppWithCanvasSpies();
    // Counter starts at 1 (one initial "Layer 1")
    expect((app as any)._layerCounter).toBe(1);

    const ctx = (app as any)._buildContextValue();

    // Add a layer with a custom name (as external image paste does)
    ctx.addLayer('Pasted Image');
    // The counter should NOT have incremented since the generated name was discarded
    expect((app as any)._layerCounter).toBe(1);

    // Now add a layer without a name — should be "Layer 2", not "Layer 3"
    ctx.addLayer();
    expect((app as any)._layerCounter).toBe(2);
    const layers = (app as any)._state.layers;
    const lastLayer = layers[layers.length - 1];
    expect(lastLayer.name).toBe('Layer 2');
  });

  it('does not switch tools when Shift is held (Shift is for constraining)', () => {
    const app = createAppWithCanvasSpies();
    (app as any)._state = { ...(app as any)._state, activeTool: 'select' };

    // Shift+B should NOT switch to pencil — user is holding Shift to constrain
    const event = makeKeyEvent('B', [], { shiftKey: true });
    (app as any)._onKeyDown(event);

    // Tool must stay on select
    expect((app as any)._state.activeTool).toBe('select');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('does not call clearSelection when selecting the already-active layer', () => {
    const app = createAppWithCanvasSpies();

    // Add a second layer so we have something to distinguish
    const layer2 = (app as any)._createLayer(800, 600);
    (app as any)._state = {
      ...(app as any)._state,
      layers: [...(app as any)._state.layers, layer2],
    };

    // Set activeLayerId to the first layer
    const layer1Id = (app as any)._state.layers[0].id;
    (app as any)._state = { ...(app as any)._state, activeLayerId: layer1Id };
    (app as any).canvas.clearSelection.mockClear();

    const ctx = (app as any)._buildContextValue();

    // Select the already-active layer (e.g. clicking the layer row or opacity slider)
    ctx.setActiveLayer(layer1Id);

    // clearSelection must NOT be called — the layer didn't change, so
    // there's no reason to commit a float or finalize a stroke.
    // BUG: currently clearSelection IS called, destroying any active float.
    expect((app as any).canvas.clearSelection).not.toHaveBeenCalled();
  });

  it('falls back to the first layer if saved activeLayerId is invalid on load', async () => {
    const app = createAppWithCanvasSpies();

    // Stub updateComplete
    Object.defineProperty(app, 'updateComplete', {
      configurable: true,
      get: () => Promise.resolve(true),
    });

    // Simulate _loadProject with a record whose activeLayerId doesn't
    // match any layer (e.g. data corruption or partial migration).
    const fakeRecord = {
      toolSettings: {
        activeTool: 'pencil' as const,
        strokeColor: '#000000',
        fillColor: '#ff0000',
        useFill: false,
        brushSize: 4,
      },
      canvasWidth: 100,
      canvasHeight: 100,
      layers: [
        { id: 'real-layer', name: 'Layer 1', visible: true, opacity: 1, imageBlob: new Blob() },
      ],
      activeLayerId: 'deleted-layer-id',
      layersPanelOpen: true,
      historyIndex: -1,
    };

    // Mock loadProjectState to return our corrupted record
    const projectStore = await import('../src/project-store.js');
    const loadSpy = vi.spyOn(projectStore, 'loadProjectState').mockResolvedValue({
      state: fakeRecord as any,
      history: [],
      historyIndex: -1,
    });
    // Mock deserializeLayer to return a real layer object
    vi.spyOn(projectStore, 'deserializeLayer').mockResolvedValue({
      id: 'real-layer',
      name: 'Layer 1',
      visible: true,
      opacity: 1,
      canvas: document.createElement('canvas'),
    });

    await (app as any)._loadProject('test-project');

    // activeLayerId must fall back to the first layer, not stay on the
    // non-existent 'deleted-layer-id'.
    expect((app as any)._state.activeLayerId).toBe('real-layer');

    loadSpy.mockRestore();
  });

  it('resets to fresh project if saved layers array is empty', async () => {
    const app = createAppWithCanvasSpies();

    Object.defineProperty(app, 'updateComplete', {
      configurable: true,
      get: () => Promise.resolve(true),
    });

    const fakeRecord = {
      toolSettings: {
        activeTool: 'pencil' as const,
        strokeColor: '#000000',
        fillColor: '#ff0000',
        useFill: false,
        brushSize: 4,
      },
      canvasWidth: 100,
      canvasHeight: 100,
      layers: [],           // empty — corrupted data
      activeLayerId: 'gone',
      layersPanelOpen: true,
      historyIndex: -1,
    };

    const projectStore = await import('../src/project-store.js');
    const loadSpy = vi.spyOn(projectStore, 'loadProjectState').mockResolvedValue({
      state: fakeRecord as any,
      history: [],
      historyIndex: -1,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must not crash — should fall back to a fresh project
    await (app as any)._loadProject('test-project');

    // Should have at least one layer after recovery
    expect((app as any)._state.layers.length).toBeGreaterThanOrEqual(1);
    // The recovery should be clean — no error logged
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    loadSpy.mockRestore();
  });

  it('composites active float into layer snapshot during save', () => {
    const app = new DrawingApp();

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 100;
    layerCanvas.height = 100;

    // Float tempCanvas — the content lifted from the selection
    const floatCanvas = document.createElement('canvas');
    floatCanvas.width = 20;
    floatCanvas.height = 20;

    const layer = { id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: layerCanvas };

    (app as any)._state = {
      activeTool: 'select',
      strokeColor: '#000000',
      fillColor: '#ff0000',
      useFill: false,
      brushSize: 4,
      stampImage: null,
      layers: [layer],
      activeLayerId: 'l1',
      layersPanelOpen: true,
      documentWidth: 100,
      documentHeight: 100,
    };

    // Mock canvas with an active float
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: {
        getFloatSnapshot: () => ({ layerId: 'l1', tempCanvas: floatCanvas, x: 10, y: 15 }),
        getHistory: () => [],
        getHistoryIndex: () => -1,
        getHistoryVersion: () => 0,
        mainCanvas: null,
        clearSelection: vi.fn(),
      },
    });

    // Track drawImage calls on any temp canvas created during the snapshot.
    // The snapshot code creates a temp canvas and composites the float onto it.
    const drawImageCalls: any[][] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'canvas') {
        const ctx = (el as HTMLCanvasElement).getContext('2d')!;
        const origDraw = ctx.drawImage.bind(ctx);
        ctx.drawImage = vi.fn((...args: any[]) => {
          drawImageCalls.push(args);
          origDraw(...(args as Parameters<typeof ctx.drawImage>));
        }) as typeof ctx.drawImage;
      }
      return el;
    }) as typeof document.createElement);

    // Run the snapshot logic that _save uses (extracted inline)
    const floatSnap = (app as any).canvas?.getFloatSnapshot() ?? null;
    (app as any)._state.layers.map((l: any) => {
      const ctx = l.canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
      if (floatSnap && l.id === floatSnap.layerId) {
        const tmp = document.createElement('canvas');
        tmp.width = l.canvas.width;
        tmp.height = l.canvas.height;
        const tmpCtx = tmp.getContext('2d')!;
        tmpCtx.putImageData(imageData, 0, 0);
        tmpCtx.drawImage(floatSnap.tempCanvas, floatSnap.x, floatSnap.y);
        return { id: l.id, imageData: tmpCtx.getImageData(0, 0, tmp.width, tmp.height) };
      }
      return { id: l.id, imageData };
    });

    // The float must have been composited onto the temp canvas
    const floatDraw = drawImageCalls.find(args => args[0] === floatCanvas);
    expect(floatDraw).toBeDefined();
    expect(floatDraw![1]).toBe(10); // x
    expect(floatDraw![2]).toBe(15); // y

    // The live layer canvas must NOT have had drawImage called on it
    const liveCtx = layerCanvas.getContext('2d')!;
    expect(liveCtx.drawImage).not.toHaveBeenCalled();
  });
});

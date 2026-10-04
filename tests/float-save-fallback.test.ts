import { describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import * as serialization from '../src/utils/storage-serialization.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

const floatDraws: number[][] = [];
function trackFloatDraws(floatCanvas: HTMLCanvasElement) {
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreate(tag);
    if (tag === 'canvas') {
      const ctx = (el as HTMLCanvasElement).getContext('2d')!;
      const orig = ctx.drawImage.bind(ctx);
      ctx.drawImage = ((...args: any[]) => {
        if (args[0] === floatCanvas) floatDraws.push([args[1], args[2]]);
        (orig as any)(...args);
      }) as typeof ctx.drawImage;
    }
    return el;
  }) as typeof document.createElement);
}

describe('float layer fallback', () => {
  it('reads an unmoved float\'s layer back once, and again only once the float moves', async () => {
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const app = new DrawingApp();
    const layer = makeLayer(20, 20, { id: 'l1' });
    (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
    (app as any)._currentProject = project;
    (app as any)._backend = backend;
    const floatCanvas = document.createElement('canvas');
    floatCanvas.width = 5; floatCanvas.height = 5;
    let key = '7:0,0';
    const getFloatSnapshot = vi.fn(() => ({ layerId: 'l1', tempCanvas: floatCanvas, x: 2, y: 2 }));
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub({
        getHistory: vi.fn(() => []),
        getHistoryIndex: vi.fn(() => -1),
        setViewport: vi.fn(),
        getLayerRevision: vi.fn(() => '1:0'),
        getFloatKey: vi.fn(() => ({ layerId: 'l1', key })),
        getFloatSnapshot,
      }),
    });
    // Each save is for an edit (content changed), as an autosave during a float is.
    const save = async () => {
      (app as any)._dirty = true; (app as any)._dirtyVersion++; (app as any)._contentVersion++;
      await (app as any)._save(true);
    };
    const ser = vi.spyOn(serialization, 'serializeLayerFromImageData');
    const liveRead = vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData');
    await save();
    expect(getFloatSnapshot).toHaveBeenCalledTimes(1);
    expect(ser).toHaveBeenCalledTimes(1);
    const ref = (await backend.state.get(project.id))!.layers[0].imageBlobRef;

    // Same layer revision, same float: the stored blob stands, nothing is read.
    await save();
    await save();
    expect(getFloatSnapshot).toHaveBeenCalledTimes(1);
    expect(ser).toHaveBeenCalledTimes(1);
    expect(liveRead).not.toHaveBeenCalled();
    expect((await backend.state.get(project.id))!.layers[0].imageBlobRef).toBe(ref);

    // The float moved: its layer is merged and read again (then stored if
    // its pixels differ, which this canvas mock can't show).
    key = '8:3,0';
    await save();
    expect(getFloatSnapshot).toHaveBeenCalledTimes(2);
  });

  it('re-reads an unmoved float layer whose stored blob is no longer referenced', async () => {
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const app = new DrawingApp();
    const layer = makeLayer(20, 20, { id: 'l1' });
    (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
    (app as any)._currentProject = project;
    (app as any)._backend = backend;
    const floatCanvas = document.createElement('canvas');
    floatCanvas.width = 5; floatCanvas.height = 5;
    floatCanvas.getContext('2d')!.fillStyle = '#ff0000';
    floatCanvas.getContext('2d')!.fillRect(0, 0, 5, 5);
    const getFloatSnapshot = vi.fn(() => ({ layerId: 'l1', tempCanvas: floatCanvas, x: 2, y: 2 }));
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub({
        getHistory: vi.fn(() => []),
        getHistoryIndex: vi.fn(() => -1),
        setViewport: vi.fn(),
        getLayerRevision: vi.fn(() => '1:0'),
        getFloatKey: vi.fn(() => ({ layerId: 'l1', key: '7:0,0' })),
        getFloatSnapshot,
      }),
    });
    const save = async () => {
      (app as any)._dirty = true; (app as any)._dirtyVersion++; (app as any)._contentVersion++;
      await (app as any)._save(true);
    };
    await save();
    expect(getFloatSnapshot).toHaveBeenCalledTimes(1);

    // Another writer replaces the stored layer blob (no-locks second tab / custom backend).
    const state = (await backend.state.get(project.id))!;
    const otherRef = await backend.blobs.put(new Blob(['x']));
    await backend.state.save({ ...state, layers: state.layers.map(l => ({ ...l, imageBlobRef: otherRef })) });

    floatDraws.length = 0;
    trackFloatDraws(floatCanvas);
    const liveRead = vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData');
    const ser = vi.spyOn(serialization, 'serializeLayerFromImageData');
    await save();
    // Correct behaviour: the float is composited again (not the bare, holey layer).
    expect(getFloatSnapshot).toHaveBeenCalledTimes(2);
    expect(ser).toHaveBeenCalledTimes(1);
    expect(floatDraws).toEqual([[2, 2]]);
    // Not read bare: the live layer is only drawn onto a copy.
    expect(liveRead).not.toHaveBeenCalled();
  });

  it('merges the float where it is now when it moved while the save was waiting', async () => {
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const app = new DrawingApp();
    const layer = makeLayer(20, 20, { id: 'l1' });
    (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
    (app as any)._currentProject = project;
    (app as any)._backend = backend;
    const floatCanvas = document.createElement('canvas');
    floatCanvas.width = 5; floatCanvas.height = 5;
    const fctx = floatCanvas.getContext('2d')!;
    fctx.fillStyle = '#ff0000';
    fctx.fillRect(0, 0, 5, 5);
    let at = { x: 2, y: 2 };
    let key = 'a';
    const getFloatSnapshot = vi.fn(() => ({ layerId: 'l1', tempCanvas: floatCanvas, ...at }));
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub({
        getHistory: vi.fn(() => []),
        getHistoryIndex: vi.fn(() => -1),
        setViewport: vi.fn(),
        getLayerRevision: vi.fn(() => '1:0'),
        getFloatKey: vi.fn(() => ({ layerId: 'l1', key })),
        getFloatSnapshot,
      }),
    });
    const save = async () => {
      (app as any)._dirty = true; (app as any)._dirtyVersion++; (app as any)._contentVersion++;
      await (app as any)._save(true);
    };
    await save();
    const state = (await backend.state.get(project.id))!;
    const otherRef = await backend.blobs.put(new Blob(['x']));
    await backend.state.save({ ...state, layers: state.layers.map(l => ({ ...l, imageBlobRef: otherRef })) });
    trackFloatDraws(floatCanvas);

    // The float moves while the save awaits the backend.
    const realGet = backend.state.get.bind(backend.state);
    vi.spyOn(backend.state, 'get').mockImplementation(async (id: string) => {
      const result = await realGet(id);
      at = { x: 10, y: 10 };
      key = 'b';
      return result;
    });
    const ser = vi.spyOn(serialization, 'serializeLayerFromImageData');
    floatDraws.length = 0;
    await save();
    expect(ser).toHaveBeenCalledTimes(1);
    // Merged where the float is now, not where it was or not at all.
    expect(floatDraws).toEqual([[10, 10]]);
  });
});

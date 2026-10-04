import { describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import * as serialization from '../src/utils/storage-serialization.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

/** The float's layer as its commit would leave it, marked with where the float is. */
function merged(x: number) {
  const data = new ImageData(20, 20);
  data.data[x * 4 + 3] = 255;
  return data;
}

async function setup(floatState: { x: number; key: string }) {
  const backend = new MockBackend();
  await backend.init();
  const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
  const app = new DrawingApp();
  const layer = makeLayer(20, 20, { id: 'l1' });
  (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
  (app as any)._currentProject = project;
  (app as any)._backend = backend;
  const previewFloatCommit = vi.fn(() => ({ layerId: 'l1', imageData: merged(floatState.x), entry: null }));
  Object.defineProperty(app, 'canvas', {
    configurable: true,
    value: makeAppCanvasStub({
      getHistory: vi.fn(() => []),
      getHistoryIndex: vi.fn(() => -1),
      getHistoryAsCommitted: vi.fn(() => ({ history: [], index: -1 })),
      setViewport: vi.fn(),
      getLayerRevision: vi.fn(() => '1:0'),
      getFloatKey: vi.fn(() => ({ layerId: 'l1', key: floatState.key })),
      previewFloatCommit,
    }),
  });
  const save = async () => {
    (app as any)._dirty = true; (app as any)._dirtyVersion++; (app as any)._contentVersion++;
    await (app as any)._save(true);
  };
  /** Another writer replaces the stored layer blob (no-locks second tab / custom backend). */
  const replaceStoredBlob = async () => {
    const state = (await backend.state.get(project.id))!;
    const otherRef = await backend.blobs.put(new Blob(['x']));
    await backend.state.save({ ...state, layers: state.layers.map(l => ({ ...l, imageBlobRef: otherRef })) });
  };
  return { app, backend, project, layer, save, previewFloatCommit, replaceStoredBlob };
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
    const { layer, save, previewFloatCommit, replaceStoredBlob } = await setup({ x: 2, key: '7:0,0' });
    await save();
    expect(previewFloatCommit).toHaveBeenCalledTimes(1);

    await replaceStoredBlob();
    const liveRead = vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData');
    const ser = vi.spyOn(serialization, 'serializeLayerFromImageData');
    await save();
    // The float is merged again (not the bare, holey layer).
    expect(previewFloatCommit).toHaveBeenCalledTimes(2);
    expect(ser).toHaveBeenCalledTimes(1);
    expect(ser.mock.calls[0][1].data[2 * 4 + 3]).toBe(255);
    // Not read bare.
    expect(liveRead).not.toHaveBeenCalled();
    ser.mockRestore();
  });

  it('starts over when the float moved while the save was waiting, so the layer matches the history stored with it', async () => {
    const float = { x: 2, key: 'a' };
    const { backend, save, previewFloatCommit, replaceStoredBlob } = await setup(float);
    await save();
    await replaceStoredBlob();

    // The float moves while the save awaits the backend.
    const realGet = backend.state.get.bind(backend.state);
    vi.spyOn(backend.state, 'get').mockImplementation(async (id: string) => {
      const result = await realGet(id);
      float.x = 10;
      float.key = 'b';
      return result;
    });
    const ser = vi.spyOn(serialization, 'serializeLayerFromImageData');
    previewFloatCommit.mockClear();
    await save();
    // Stored once, merged where the float is now, from a fresh snapshot.
    expect(ser).toHaveBeenCalledTimes(1);
    expect(ser.mock.calls[0][1].data[10 * 4 + 3]).toBe(255);
    expect(ser.mock.calls[0][1].data[2 * 4 + 3]).toBe(0);
    ser.mockRestore();
  });
});

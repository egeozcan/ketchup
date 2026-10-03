import { describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import * as serialization from '../src/utils/storage-serialization.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

describe('float layer fallback', () => {
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

    const liveRead = vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData');
    const ser = vi.spyOn(serialization, 'serializeLayerFromImageData');
    await save();
    // Correct behaviour: the float is composited again (not the bare, holey layer).
    expect(getFloatSnapshot).toHaveBeenCalledTimes(2);
  });
});

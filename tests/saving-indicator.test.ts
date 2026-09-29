import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

function setupApp() {
  const app = new DrawingApp();
  const layer = makeLayer(20, 20, { id: 'l1' });
  (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
  (app as any)._currentProject = { id: 'p1', name: 'P', createdAt: 0, updatedAt: 0, thumbnailRef: null };
  Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });

  const savingDuringSave: boolean[] = [];
  (app as any)._backend = {
    blobs: { put: vi.fn(async () => 'ref'), deleteMany: vi.fn(async () => {}) },
    state: {
      get: vi.fn(async () => null),
      save: vi.fn(async () => { savingDuringSave.push((app as any)._saving); }),
    },
    history: { getEntries: vi.fn(async () => []), replaceAll: vi.fn(async () => {}) },
    projects: {
      get: vi.fn(async () => ({ id: 'p1', name: 'P', createdAt: 0, updatedAt: 0, thumbnailRef: null })),
      update: vi.fn(async () => ({ id: 'p1', name: 'P', createdAt: 0, updatedAt: 0, thumbnailRef: null })),
      list: vi.fn(async () => []),
    },
  };
  return { app, savingDuringSave };
}

describe('saving indicator', () => {
  beforeEach(async () => {
    const serMod = await import('../src/utils/storage-serialization.js');
    vi.spyOn(serMod, 'serializeLayerFromImageData').mockResolvedValue(
      { id: 'l1', name: 'Layer 1', visible: true, opacity: 1, imageBlobRef: 'ref' as any },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays hidden when only the tool changes', async () => {
    const { app, savingDuringSave } = setupApp();

    (app as any)._buildContextValue().setTool('eraser');
    await (app as any)._save(true);

    expect(savingDuringSave).toEqual([false]);
  });

  it('stays hidden for pan and zoom', async () => {
    const { app, savingDuringSave } = setupApp();

    (app as any)._onViewportChange();
    await (app as any)._save(true);

    expect(savingDuringSave).toEqual([false]);
  });

  it('shows when the drawing changes', async () => {
    const { app, savingDuringSave } = setupApp();

    (app as any)._onHistoryChange(new CustomEvent('history-change', { detail: { canUndo: true, canRedo: false } }));
    await (app as any)._save(true);

    expect(savingDuringSave).toEqual([true]);
    expect((app as any)._saving).toBe(false);
  });

  it('shows for a drawing change made alongside a tool switch', async () => {
    const { app, savingDuringSave } = setupApp();

    (app as any)._buildContextValue().setTool('eraser');
    (app as any)._onHistoryChange(new CustomEvent('history-change', { detail: { canUndo: true, canRedo: false } }));
    await (app as any)._save(true);

    expect(savingDuringSave).toEqual([true]);
  });
});

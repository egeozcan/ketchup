import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { collectBlobRefsFromEntry } from '../src/storage/project-service.ts';
import type { BlobRef, SerializedHistoryEntry } from '../src/storage/types.ts';
import type { HistoryEntry } from '../src/types.ts';
import * as serialization from '../src/utils/storage-serialization.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

function patch(n: number): HistoryEntry {
  return { type: 'patch', layerId: 'l1', x: n, y: 0, before: new ImageData(1, 1), after: new ImageData(1, 1) };
}

async function setupApp() {
  const backend = new MockBackend();
  await backend.init();
  const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
  const app = new DrawingApp();
  const layer = makeLayer(20, 20, { id: 'l1' });
  (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
  (app as any)._currentProject = project;
  (app as any)._backend = backend;
  let history: HistoryEntry[] = [];
  Object.defineProperty(app, 'canvas', {
    configurable: true,
    value: makeAppCanvasStub({
      getHistory: vi.fn(() => [...history]),
      getHistoryIndex: vi.fn(() => history.length - 1),
      setViewport: vi.fn(),
    }),
  });
  const save = async (entries: HistoryEntry[]) => {
    history = entries;
    (app as any)._dirty = true;
    (app as any)._dirtyVersion++;
    (app as any)._contentVersion++;
    await (app as any)._save(true);
  };
  // Same as `save`, but as a pan/zoom would mark the project: no content change.
  const saveViewportOnly = async () => {
    (app as any)._dirty = true;
    (app as any)._dirtyVersion++;
    await (app as any)._save(true);
  };
  const stored = () => backend.history.getEntries(project.id);
  return { app, backend, project, layer, save, saveViewportOnly, stored };
}

function refsOf(entry: SerializedHistoryEntry): BlobRef[] {
  const refs = new Set<BlobRef>();
  collectBlobRefsFromEntry(entry, refs);
  return [...refs];
}

async function blobExists(backend: MockBackend, ref: BlobRef) {
  return backend.blobs.get(ref).then(() => true, () => false);
}

describe('incremental history persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends only entries that are not stored yet', async () => {
    const { backend, save, stored } = await setupApp();
    const [a, b, c] = [patch(1), patch(2), patch(3)];
    await save([a, b]);
    const replaceAll = vi.spyOn(backend.history, 'replaceAll');
    const serialize = vi.spyOn(serialization, 'serializeHistoryEntry');

    await save([a, b, c]);

    expect(replaceAll).not.toHaveBeenCalled();
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith(c, expect.anything());
    expect((await stored()).map(r => r.index)).toEqual([0, 1, 2]);
  });

  it('deletes only the evicted record and its blobs when the stack is full', async () => {
    const { backend, save, stored } = await setupApp();
    const [a, b, c, d] = [patch(1), patch(2), patch(3), patch(4)];
    await save([a, b, c]);
    const evicted = (await stored())[0];
    const serialize = vi.spyOn(serialization, 'serializeHistoryEntry');

    await save([b, c, d]);

    expect(serialize).toHaveBeenCalledTimes(1);
    const records = await stored();
    expect(records.map(r => r.index)).toEqual([1, 2, 3]);
    expect(records.map(r => (r.entry as { x: number }).x)).toEqual([2, 3, 4]);
    for (const ref of refsOf(evicted.entry)) {
      expect(await blobExists(backend, ref)).toBe(false);
    }
    for (const ref of refsOf(records[0].entry)) {
      expect(await blobExists(backend, ref)).toBe(true);
    }
  });

  it('drops discarded redo entries without rewriting the entries kept', async () => {
    const { backend, save, stored } = await setupApp();
    const [a, b, c, d] = [patch(1), patch(2), patch(3), patch(4)];
    await save([a, b, c]);
    const replaceAll = vi.spyOn(backend.history, 'replaceAll');

    await save([a, d]);

    expect(replaceAll).not.toHaveBeenCalled();
    const records = await stored();
    expect(records.map(r => r.index)).toEqual([0, 3]);
    expect(records.map(r => (r.entry as { x: number }).x)).toEqual([1, 4]);
  });

  it('continues record indices after the ones loaded from storage', async () => {
    const { app, backend, project, save, stored } = await setupApp();
    const [a, b, c] = [patch(1), patch(2), patch(3)];
    const loaded = await Promise.all([a, b].map(async (entry, i) => ({
      projectId: project.id,
      index: 5 + i,
      entry: await serialization.serializeHistoryEntry(entry, backend.blobs),
    })));
    await backend.history.replaceAll(project.id, loaded);
    (app as any)._trackLoadedProject(project.id, [a, b], loaded);

    await save([a, b, c]);

    expect((await stored()).map(r => r.index)).toEqual([5, 6, 7]);
  });

  it('replaces stored history wholesale when its contents are unknown', async () => {
    const { app, backend, project, save, stored } = await setupApp();
    const stale = {
      projectId: project.id,
      index: 0,
      entry: await serialization.serializeHistoryEntry(patch(9), backend.blobs),
    };
    await backend.history.replaceAll(project.id, [stale]);
    (app as any)._historyNeedsRewrite = true;

    await save([patch(1)]);

    const records = await stored();
    expect(records.map(r => (r.entry as { x: number }).x)).toEqual([1]);
    for (const ref of refsOf(stale.entry)) {
      expect(await blobExists(backend, ref)).toBe(false);
    }
  });

  it('reuses the stored blob of a layer that has not changed', async () => {
    const { backend, layer, save } = await setupApp();
    const serializeLayer = vi.spyOn(serialization, 'serializeLayerFromImageData');
    await save([]);
    const firstRef = (await backend.state.get((await backend.projects.list())[0].id))!.layers[0].imageBlobRef;

    await save([]);
    const state = (await backend.state.get((await backend.projects.list())[0].id))!;
    expect(serializeLayer).toHaveBeenCalledTimes(1);
    expect(state.layers[0].imageBlobRef).toBe(firstRef);
    expect(await blobExists(backend, firstRef)).toBe(true);

    const changed = new ImageData(20, 20);
    changed.data[3] = 255;
    vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData').mockReturnValue(changed);
    await save([]);
    const after = (await backend.state.get(state.projectId))!;
    expect(serializeLayer).toHaveBeenCalledTimes(2);
    expect(after.layers[0].imageBlobRef).not.toBe(firstRef);
    expect(await blobExists(backend, firstRef)).toBe(false);
  });

  it('skips reading layers back when only the viewport changed', async () => {
    const { backend, project, layer, save, saveViewportOnly } = await setupApp();
    await save([]);
    const ref = (await backend.state.get(project.id))!.layers[0].imageBlobRef;
    const serializeLayer = vi.spyOn(serialization, 'serializeLayerFromImageData');
    const getImageData = vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData');
    getImageData.mockClear();

    await saveViewportOnly();

    expect(getImageData).not.toHaveBeenCalled();
    expect(serializeLayer).not.toHaveBeenCalled();
    expect((await backend.state.get(project.id))!.layers[0].imageBlobRef).toBe(ref);
    expect(await blobExists(backend, ref)).toBe(true);
  });

  it('keeps the stored layer blobs of a project it just loaded', async () => {
    const { app, backend, project, save } = await setupApp();
    await save([]);
    const ref = (await backend.state.get(project.id))!.layers[0].imageBlobRef;
    // Never attached to a document, the element would wait forever for a render.
    Object.defineProperty(app, 'updateComplete', { get: () => Promise.resolve(true) });
    await (app as any)._loadProject(project.id);
    const serializeLayer = vi.spyOn(serialization, 'serializeLayerFromImageData');

    await save([]);

    expect(serializeLayer).not.toHaveBeenCalled();
    expect((await backend.state.get(project.id))!.layers[0].imageBlobRef).toBe(ref);
  });

  it('does not save while the next project is still loading', async () => {
    const { app, backend, save, stored } = await setupApp();
    const [a, b, c, d] = [patch(1), patch(2), patch(3), patch(4)];
    await save([a, b, c]);
    const storedA = await stored();
    const projectB = await backend.projects.create({ name: 'B', thumbnailRef: null });
    let finishLoad!: () => void;
    const loading = (app as any)._enterProject(projectB, () => new Promise<void>(r => { finishLoad = r; }));

    // An autosave fires before B's content is in, while the canvas still holds A.
    await save([b, c, d]);

    expect(await backend.state.get(projectB.id)).toBeNull();
    expect(await backend.history.getEntries(projectB.id)).toEqual([]);
    expect(await stored()).toEqual(storedA);
    for (const record of storedA) {
      for (const ref of refsOf(record.entry)) expect(await blobExists(backend, ref)).toBe(true);
    }
    finishLoad();
    await loading;
  });

  it("rewrites a project's history rather than applying another project's bookkeeping", async () => {
    const { app, backend, save, stored } = await setupApp();
    const [a, b, c, d] = [patch(1), patch(2), patch(3), patch(4)];
    await save([a, b, c]);
    const storedA = await stored();
    const projectB = await backend.projects.create({ name: 'B', thumbnailRef: null });
    (app as any)._currentProject = projectB;

    await save([b, c, d]);

    const recordsB = await backend.history.getEntries(projectB.id);
    expect(recordsB.map(r => r.index)).toEqual([0, 1, 2]);
    expect(recordsB.map(r => (r.entry as { x: number }).x)).toEqual([2, 3, 4]);
    expect(await stored()).toEqual(storedA);
    for (const record of storedA) {
      for (const ref of refsOf(record.entry)) expect(await blobExists(backend, ref)).toBe(true);
    }
  });

  it('rewrites history when stored entries no longer lead the stack in order', async () => {
    const { backend, save, stored } = await setupApp();
    const [a, b, c] = [patch(1), patch(2), patch(3)];
    await save([a, b]);
    const replaceAll = vi.spyOn(backend.history, 'replaceAll');

    await save([b, a, c]);

    expect(replaceAll).toHaveBeenCalledTimes(1);
    expect((await stored()).map(r => (r.entry as { x: number }).x)).toEqual([2, 1, 3]);
  });

  it('saves through replaceAll when the backend has no updateEntries', async () => {
    const { backend, save, stored } = await setupApp();
    (backend.history as { updateEntries?: unknown }).updateEntries = undefined;
    const [a, b, c] = [patch(1), patch(2), patch(3)];
    await save([a, b]);
    const evicted = (await stored())[0];

    await save([b, c]);

    expect((await stored()).map(r => (r.entry as { x: number }).x)).toEqual([2, 3]);
    for (const ref of refsOf(evicted.entry)) {
      expect(await blobExists(backend, ref)).toBe(false);
    }
  });
});

describe('collectBlobRefsFromEntry', () => {
  it('includes the layer snapshots of merge entries', () => {
    const refs = new Set<BlobRef>();
    const snap = (ref: string) => ({
      id: 'l', name: 'L', visible: true, opacity: 1,
      imageData: { width: 1, height: 1, blobRef: ref as BlobRef },
    });
    collectBlobRefsFromEntry({
      type: 'merge',
      beforeLayers: [snap('b1'), snap('b2')],
      afterLayers: [snap('a1')],
      previousActiveLayerId: 'l',
      afterActiveLayerId: 'l',
    }, refs);
    expect([...refs].sort()).toEqual(['a1', 'b1', 'b2']);
  });
});

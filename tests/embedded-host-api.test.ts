import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MemoryBackend } from '../src/storage/memory/index.ts';
import { IndexedDBBackend } from '../src/storage/indexeddb/index.ts';
import type { HistoryEntry } from '../src/types.ts';
import { makeAppCanvasStub, makeCanvas } from './helpers.ts';

function patch(n: number): HistoryEntry {
  return { type: 'patch', layerId: 'l1', x: n, y: 0, before: new ImageData(1, 1), after: new ImageData(1, 1) };
}

function appWithHistory(embedded: boolean) {
  const app = new DrawingApp();
  app.embedded = embedded;
  let history: HistoryEntry[] = [];
  let index = -1;
  const stub = makeAppCanvasStub({
    getHistory: vi.fn(() => [...history]),
    getHistoryIndex: vi.fn(() => index),
  });
  Object.defineProperty(app, 'canvas', { configurable: true, value: stub });
  const setHistory = (entries: HistoryEntry[], i = entries.length - 1) => {
    history = entries;
    index = i;
    (app as any)._onHistoryChange(new CustomEvent('history-change', { detail: { canUndo: i >= 0, canRedo: i < entries.length - 1 } }));
  };
  return { app, stub, setHistory };
}

function keydown(app: DrawingApp, key: string, ctrlKey = true) {
  const e = { key, ctrlKey, metaKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), composedPath: () => [app] } as unknown as KeyboardEvent;
  (app as any)._onKeyDown(e);
  return e;
}

describe('embedded host API', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('keeps an embedded document in memory, and a standalone one in IndexedDB', async () => {
    const embedded = new DrawingApp();
    embedded.embedded = true;
    await (embedded as any)._doInitStorage();
    expect((embedded as any)._backend).toBeInstanceOf(MemoryBackend);

    const standalone = new DrawingApp();
    const dispose = vi.spyOn(IndexedDBBackend.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(IndexedDBBackend.prototype, 'projects', 'get').mockReturnValue({
      list: async () => [],
      create: async () => ({ id: 'p', name: 'Untitled', createdAt: 0, updatedAt: 0, thumbnailRef: null }),
    } as any);
    await (standalone as any)._doInitStorage();
    expect((standalone as any)._backend).toBeInstanceOf(IndexedDBBackend);
    dispose.mockRestore();
  });

  it('prefers a caller-supplied backend even when embedded', async () => {
    const app = new DrawingApp();
    app.embedded = true;
    const backend = new MemoryBackend();
    app.storageBackend = backend;
    await (app as any)._doInitStorage();
    expect((app as any)._backend).toBe(backend);
  });

  it('whenReady resolves once storage is open', async () => {
    const app = new DrawingApp();
    app.embedded = true;
    let ready = false;
    void app.whenReady().then(() => { ready = true; });
    await (app as any)._doInitStorage();
    await Promise.resolve();
    expect(ready).toBe(true);
  });

  it('asks the host to save when embedded instead of downloading', () => {
    const { app, stub } = appWithHistory(true);
    const requests: Event[] = [];
    app.addEventListener('save-request', (e) => requests.push(e));

    (app as any)._buildContextValue().saveCanvas();

    expect(requests).toHaveLength(1);
    expect(requests[0].bubbles).toBe(true);
    expect(requests[0].composed).toBe(true);
    expect(stub.saveCanvas).not.toHaveBeenCalled();
    // A floating selection is committed so the host exports what is on screen.
    expect(stub.clearSelection).toHaveBeenCalled();
  });

  it('downloads on Save when standalone', () => {
    const { app, stub } = appWithHistory(false);
    const requests: Event[] = [];
    app.addEventListener('save-request', (e) => requests.push(e));

    (app as any)._buildContextValue().saveCanvas();

    expect(requests).toHaveLength(0);
    expect(stub.saveCanvas).toHaveBeenCalledTimes(1);
  });

  it('answers Ctrl+S with a save request only when embedded', () => {
    const embedded = appWithHistory(true);
    const requests: Event[] = [];
    embedded.app.addEventListener('save-request', (e) => requests.push(e));
    const e = keydown(embedded.app, 's');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(requests).toHaveLength(1);

    const standalone = appWithHistory(false);
    const e2 = keydown(standalone.app, 's');
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it('exposes the embedded flag to the toolbar and settings', () => {
    expect((appWithHistory(true).app as any)._buildContextValue().embedded).toBe(true);
    expect((appWithHistory(false).app as any)._buildContextValue().embedded).toBe(false);
  });

  it('reads as modified until saved, and not after undoing back to the saved state', () => {
    vi.useFakeTimers();
    const { app, setHistory } = appWithHistory(true);
    const changes: boolean[] = [];
    app.addEventListener('modified-change', (e) => changes.push((e as CustomEvent).detail.modified));
    const [a, b] = [patch(1), patch(2)];

    expect(app.modified).toBe(false);
    setHistory([a]);
    expect(app.modified).toBe(true);

    app.markSaved();
    expect(app.modified).toBe(false);

    setHistory([a, b]);
    expect(app.modified).toBe(true);
    setHistory([a, b], 0); // undo to the saved state
    expect(app.modified).toBe(false);

    expect(changes).toEqual([true, false, true, false]);
  });

  it('counts an uncommitted transform as a modification', () => {
    const { app, stub } = appWithHistory(true);
    (stub.isTransformActive as any).mockReturnValue(true);
    expect(app.modified).toBe(true);
  });

  it('exports transparent PNGs by default, and JPEGs on white', async () => {
    const { app, stub } = appWithHistory(true);
    (app as any)._resolveReady();
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb, type) {
      cb(new Blob(['x'], { type: type ?? 'image/png' }));
    });

    const png = await app.exportImage();
    expect(stub.renderFlattened).toHaveBeenLastCalledWith(null);
    expect(png.type).toBe('image/png');

    const jpeg = await app.exportImage({ type: 'image/jpeg', quality: 0.9 });
    expect(stub.renderFlattened).toHaveBeenLastCalledWith('#ffffff');
    expect(toBlob).toHaveBeenLastCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    expect(jpeg.type).toBe('image/jpeg');

    await app.exportImage({ background: '#000000' });
    expect(stub.renderFlattened).toHaveBeenLastCalledWith('#000000');
  });

  it('refuses documents larger than the canvas limit', async () => {
    const { app } = appWithHistory(true);
    await expect((app as any)._replaceDocument(20000, 10, null, 'big')).rejects.toBeInstanceOf(RangeError);
    await expect((app as any)._replaceDocument(0, 10, null, 'empty')).rejects.toBeInstanceOf(RangeError);
  });

  it('replaces the embedded document without keeping the previous project', async () => {
    const app = new DrawingApp();
    app.embedded = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });
    document.body.append(app);
    await app.whenReady();
    const backend = (app as any)._backend as MemoryBackend;
    const first = (app as any)._currentProject;

    await app.newDocument(64, 32, { name: 'Sketch', background: null });

    const projects = await backend.projects.list();
    expect(projects.map(p => p.name)).toEqual(['Sketch']);
    expect(projects[0].id).not.toBe(first.id);
    expect((app as any)._state.documentWidth).toBe(64);
    expect((app as any)._state.documentHeight).toBe(32);
    expect(app.modified).toBe(false);
  });
});

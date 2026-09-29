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
  let trimmed = 0;
  const stub = makeAppCanvasStub({
    getHistory: vi.fn(() => [...history]),
    getHistoryIndex: vi.fn(() => index),
    getHistoryTrimmedCount: vi.fn(() => trimmed),
  });
  Object.defineProperty(app, 'canvas', { configurable: true, value: stub });
  const setHistory = (entries: HistoryEntry[], i = entries.length - 1, dropped = trimmed) => {
    history = entries;
    index = i;
    trimmed = dropped;
    (app as any)._onHistoryChange(new CustomEvent('history-change', { detail: { canUndo: i >= 0, canRedo: i < entries.length - 1 } }));
  };
  return { app, stub, setHistory };
}

function keydown(app: DrawingApp, key: string, ctrlKey = true, path: EventTarget[] = [app], repeat = false) {
  const e = { key, ctrlKey, repeat, metaKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), composedPath: () => path } as unknown as KeyboardEvent;
  (app as any)._onKeyDown(e);
  return e;
}

describe('embedded host API', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  /** Startup renders before it resolves, so the element has to be in the document. */
  async function connected(app: DrawingApp): Promise<DrawingApp> {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });
    document.body.append(app);
    await app.whenReady();
    return app;
  }

  it('keeps an embedded document in memory, and a standalone one in IndexedDB', async () => {
    const embedded = new DrawingApp();
    embedded.embedded = true;
    await connected(embedded);
    expect((embedded as any)._backend).toBeInstanceOf(MemoryBackend);

    const init = vi.spyOn(IndexedDBBackend.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(IndexedDBBackend.prototype, 'projects', 'get').mockReturnValue({
      list: async () => [],
      create: async () => ({ id: 'p', name: 'Untitled', createdAt: 0, updatedAt: 0, thumbnailRef: null }),
    } as any);
    const standalone = await connected(new DrawingApp());
    expect((standalone as any)._backend).toBeInstanceOf(IndexedDBBackend);
    init.mockRestore();
  });

  it('prefers a caller-supplied backend even when embedded', async () => {
    const app = new DrawingApp();
    app.embedded = true;
    const backend = new MemoryBackend();
    app.storageBackend = backend;
    await connected(app);
    expect((app as any)._backend).toBe(backend);
  });

  it('whenReady resolves once storage is open and the first document is shown', async () => {
    const app = new DrawingApp();
    app.embedded = true;
    let ready = false;
    void app.whenReady().then(() => { ready = true; });
    expect(ready).toBe(false);
    await connected(app);
    expect(ready).toBe(true);
    expect((app as any)._currentProject).not.toBeNull();
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

  it('reads as modified once the saved state has dropped off the bottom of the undo history', () => {
    const { app, setHistory } = appWithHistory(true);
    const entries = Array.from({ length: 50 }, (_, n) => patch(n));
    // Fifty-one edits: the first fell off the capped stack.
    setHistory(entries, 49, 1);
    // Undoing everything that is left does not undo the edit that was dropped.
    setHistory(entries, -1, 1);
    expect(app.modified).toBe(true);

    app.markSaved();
    expect(app.modified).toBe(false);
  });

  it('marks saved what was exported, not what was drawn while the host stored it', async () => {
    const { app, setHistory } = appWithHistory(true);
    (app as any)._resolveReady();
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb, type) {
      cb(new Blob(['x'], { type: type ?? 'image/png' }));
    });
    const [a, b] = [patch(1), patch(2)];
    setHistory([a]);

    await app.exportImage();
    setHistory([a, b]); // drawn during the upload
    app.markSaved();
    expect(app.modified).toBe(true);

    setHistory([a, b], 0); // back to what the host stored
    expect(app.modified).toBe(false);

    // With no export since, markSaved takes the document as it is.
    setHistory([a, b]);
    app.markSaved();
    expect(app.modified).toBe(false);
  });

  it('commits work in progress before exporting it', async () => {
    const { app, stub } = appWithHistory(true);
    (app as any)._resolveReady();
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb, type) {
      cb(new Blob(['x'], { type: type ?? 'image/png' }));
    });
    await app.exportImage();
    const committed = (stub.clearSelection as any).mock.invocationCallOrder[0];
    const rendered = (stub.renderFlattened as any).mock.invocationCallOrder[0];
    expect(committed).toBeLessThan(rendered);
  });

  it('saves on Ctrl+S from inside a text field when embedded', () => {
    const { app } = appWithHistory(true);
    const requests: Event[] = [];
    app.addEventListener('save-request', (e) => requests.push(e));
    const input = document.createElement('input');
    const e = keydown(app, 's', true, [input, app]);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('reports a transform starting and ending as modified-change', () => {
    const { app, stub } = appWithHistory(true);
    const changes: boolean[] = [];
    app.addEventListener('modified-change', (e) => changes.push((e as CustomEvent).detail.modified));
    (stub.isTransformActive as any).mockReturnValue(true);
    (app as any)._onTransformChange();
    (stub.isTransformActive as any).mockReturnValue(false);
    (app as any)._onTransformChange();
    expect(changes).toEqual([true, false]);
  });

  it('starts on a plain-HTTP page, where crypto.randomUUID is missing', async () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const app = new DrawingApp();
    app.embedded = true;
    await connected(app);
    expect((app as any)._currentProject.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((app as any)._state.layers[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('marks saved the export that landed, even after a later export', async () => {
    const { app, setHistory } = appWithHistory(true);
    (app as any)._resolveReady();
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb, type) {
      cb(new Blob(['x'], { type: type ?? 'image/png' }));
    });
    const [a, b] = [patch(1), patch(2)];
    setHistory([a]);
    const first = await app.exportImage();
    setHistory([a, b]);
    await app.exportImage(); // a second save, still uploading
    app.markSaved(first);   // the first one landed
    expect(app.modified).toBe(true);
    setHistory([a, b], 0);
    expect(app.modified).toBe(false);
  });

  it('leaves the leave-page prompt to the host when embedded', () => {
    const { app } = appWithHistory(true);
    (app as any)._dirty = true;
    const e = { preventDefault: vi.fn() } as unknown as BeforeUnloadEvent;
    (app as any)._onBeforeUnload(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('asks for one save per Ctrl+S press, not per key repeat', () => {
    const { app } = appWithHistory(true);
    const requests: Event[] = [];
    app.addEventListener('save-request', (e) => requests.push(e));
    keydown(app, 's');
    const held = keydown(app, 's', true, [app], true);
    expect(held.preventDefault).toHaveBeenCalled();
    expect(requests).toHaveLength(1);
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
    // Validated after rounding, or 0.4 would pass and make a 0-pixel canvas.
    await expect((app as any)._replaceDocument(0.4, 10, null, 'thin')).rejects.toBeInstanceOf(RangeError);
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

  it('replaces the document one call at a time, in the order the calls were made', async () => {
    const app = new DrawingApp();
    app.embedded = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });
    document.body.append(app);
    await app.whenReady();
    const backend = (app as any)._backend as MemoryBackend;

    const first = app.newDocument(64, 32, { name: 'First' });
    const refused = app.newDocument(0, 0, { name: 'Refused' });
    const second = app.newDocument(16, 8, { name: 'Second' });
    await first;
    await expect(refused).rejects.toBeInstanceOf(RangeError);
    await second;

    expect((await backend.projects.list()).map(p => p.name)).toEqual(['Second']);
    expect((app as any)._state.documentWidth).toBe(16);
    expect((app as any)._state.documentHeight).toBe(8);
  });
});

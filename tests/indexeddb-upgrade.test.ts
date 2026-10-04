import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';
import type { HistoryEntry } from '../src/types.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

function patch(n: number): HistoryEntry {
  return { type: 'patch', layerId: 'l1', x: n, y: 0, before: new ImageData(1, 1), after: new ImageData(1, 1) };
}

/** An app on `backend` (not attached to a document) whose canvas holds `history`. */
function appOn(backend: IndexedDBBackend, history: HistoryEntry[], index: number, layerId = 'l1') {
  const app = new DrawingApp();
  (app as any)._state = makeState({
    layers: [makeLayer(20, 20, { id: layerId })], activeLayerId: layerId, documentWidth: 20, documentHeight: 20,
  });
  (app as any)._backend = backend;
  const canvas = makeAppCanvasStub({
    getHistory: vi.fn(() => [...history]),
    getHistoryIndex: vi.fn(() => index),
    setViewport: vi.fn(),
  });
  Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
  Object.defineProperty(app, 'updateComplete', { configurable: true, get: () => Promise.resolve(true) });
  return { app, canvas };
}

const versionOf = async (name: string) => (await indexedDB.databases()).find(d => d.name === name)?.version;

describe('IndexedDB v4 to v5', () => {
  const backends: IndexedDBBackend[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const b of backends.splice(0)) await b.dispose();
  });

  it('opens a v4 database with projects in it at v5 and loads them as they were', async () => {
    const name = `upgrade-v4-${Math.random()}`;
    // What an older build left: a v4 database holding a saved project.
    const old = new IndexedDBBackend({ dbName: name, version: 4 });
    backends.push(old);
    await old.init();
    const project = await old.projects.create({ name: 'Old', thumbnailRef: null });
    const { app: oldApp } = appOn(old, [patch(1), patch(2), patch(3)], 1);
    (oldApp as any)._currentProject = project;
    (oldApp as any)._dirty = true;
    (oldApp as any)._dirtyVersion++;
    (oldApp as any)._contentVersion++;
    await (oldApp as any)._save(true);
    await old.dispose();
    expect(await versionOf(name)).toBe(4);

    const current = new IndexedDBBackend({ dbName: name });
    backends.push(current);
    await current.init();
    expect(await versionOf(name)).toBe(5);
    expect((await current.projects.list()).map(p => p.name)).toEqual(['Old']);

    const { app, canvas } = appOn(current, [], -1, 'fresh');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await (app as any)._loadProject(project.id);
    expect(errors.mock.calls).toEqual([]);
    expect((app as any)._state.layers.map((l: { id: string }) => l.id)).toEqual(['l1']);
    const [entries, index] = (canvas.setHistory as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect((entries as HistoryEntry[]).map(e => (e as { x: number }).x)).toEqual([1, 2, 3]);
    expect(index).toBe(1);
    expect((app as any)._historyNeedsRewrite).toBe(false);
  });

  it('an older build refuses the upgraded database instead of starting a stray project in it', async () => {
    const name = `upgrade-refuse-${Math.random()}`;
    const current = new IndexedDBBackend({ dbName: name });
    backends.push(current);
    await current.init();
    await current.projects.create({ name: 'New', thumbnailRef: null });
    await current.dispose();

    // What a v4 build does when it opens it.
    const opened = await new Promise<string>(resolve => {
      const req = indexedDB.open(name, 4);
      req.onsuccess = () => { req.result.close(); resolve('opened'); };
      req.onerror = () => resolve(req.error!.name);
    });
    expect(opened).toBe('VersionError');
  });
});

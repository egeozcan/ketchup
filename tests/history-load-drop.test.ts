import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { StorageNotFoundError } from '../src/index.ts';
import type { ProjectHistoryRecord } from '../src/storage/types.ts';
import type { HistoryEntry } from '../src/types.ts';
import { deserializeHistoryEntry, MalformedRecordError } from '../src/utils/storage-serialization.ts';
import { serializedHistoryEntryBytes } from '../src/utils/history-size.ts';
import { makeAppCanvasStub, makeLayer, makeState } from './helpers.ts';

function patch(n: number): HistoryEntry {
  return { type: 'patch', layerId: 'l1', x: n, y: 0, before: new ImageData(1, 1), after: new ImageData(1, 1) };
}

/** An app that saved entries a, b, c (x = 1, 2, 3) to a MockBackend, ready to load them back. */
async function savedApp() {
  const backend = new MockBackend();
  await backend.init();
  const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
  const app = new DrawingApp();
  (app as any)._state = makeState({
    layers: [makeLayer(20, 20, { id: 'l1' })], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20,
  });
  (app as any)._currentProject = project;
  (app as any)._backend = backend;
  const history = [patch(1), patch(2), patch(3)];
  const canvas = makeAppCanvasStub({
    getHistory: vi.fn(() => [...history]),
    getHistoryIndex: vi.fn(() => history.length - 1),
    setViewport: vi.fn(),
  });
  Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
  Object.defineProperty(app, 'updateComplete', { configurable: true, get: () => Promise.resolve(true) });
  (app as any)._dirty = true;
  (app as any)._dirtyVersion++;
  (app as any)._contentVersion++;
  await (app as any)._save(true);
  const records = await backend.history.getEntries(project.id);
  expect(records).toHaveLength(3);
  /** Replaces stored record `i` with `change(record.entry)`. */
  const corrupt = async (i: number, change: (entry: any) => unknown) => {
    const next = records.map((r, j) => (j === i ? { ...r, entry: change(structuredClone(r.entry)) } : r));
    await backend.history.replaceAll(project.id, next as ProjectHistoryRecord[]);
  };
  const loaded = () => {
    const calls = (canvas.setHistory as ReturnType<typeof vi.fn>).mock.calls;
    if (calls.length === 0) return null;
    const [entries, index] = calls[calls.length - 1] as [HistoryEntry[], number];
    return { xs: entries.map(e => (e as { x: number }).x), index };
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { app, backend, project, records, corrupt, loaded };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading history with damaged records', () => {
  it('loads every entry when nothing is damaged', async () => {
    const { app, project, loaded } = await savedApp();
    await (app as any)._loadProject(project.id);
    expect(loaded()).toEqual({ xs: [1, 2, 3], index: 2 });
    expect((app as any)._historyNeedsRewrite).toBe(false);
  });

  it.each([
    ['missing before', (e: any) => { delete e.before; return e; }],
    ['missing blob ref', (e: any) => { delete e.after.blobRef; return e; }],
    ['impossible size', (e: any) => { e.before.width = 0; return e; }],
    ['unknown type', (e: any) => ({ ...e, type: 'mystery' })],
    ['not an object', () => null],
  ])('drops a record with %s and everything older, keeping the project', async (_label, change) => {
    const { app, project, corrupt, loaded } = await savedApp();
    await corrupt(1, change);
    await (app as any)._loadProject(project.id);
    expect(loaded()).toEqual({ xs: [3], index: 0 });
    expect((app as any)._currentProject.id).toBe(project.id);
    // The next save deletes just the dropped records (not a full rewrite).
    expect((app as any)._historyNeedsRewrite).toBe(false);
    expect((app as any)._planHistorySave(project.id, (app as any).canvas.getHistory().slice(2)).rewrite).toBe(false);
  });

  it('deletes only the dropped records and their blobs at the next save, keeping the rest', async () => {
    const { app, backend, project, records, corrupt } = await savedApp();
    await corrupt(1, (e) => { delete e.before; return e; });
    await (app as any)._loadProject(project.id);
    const kept = records[2];
    // The canvas now holds what was loaded: entry 3 alone.
    const [entry] = (app as any).canvas.setHistory.mock.calls.at(-1)[0];
    (app as any).canvas.getHistory = vi.fn(() => [entry]);
    (app as any).canvas.getHistoryIndex = vi.fn(() => 0);
    const replaceAll = vi.spyOn(backend.history, 'replaceAll');
    const updateEntries = vi.spyOn(backend.history, 'updateEntries');
    const deleteMany = vi.spyOn(backend.blobs, 'deleteMany');
    (app as any)._dirty = true;
    (app as any)._dirtyVersion++;
    await (app as any)._save(true);

    expect(replaceAll).not.toHaveBeenCalled();
    expect(updateEntries).toHaveBeenCalledWith(project.id, [records[0].index, records[1].index], []);
    expect(await backend.history.getEntries(project.id)).toEqual([kept]);
    const freed = deleteMany.mock.calls.flatMap(([refs]) => refs);
    expect(freed).toContain((records[0].entry as any).before.blobRef);
    expect(freed).toContain((records[1].entry as any).after.blobRef);
    expect(freed).not.toContain((kept.entry as any).after.blobRef);
  });

  it('rewrites stored history after a drop when stored indices are not distinct', async () => {
    const { app, backend, project, records, loaded } = await savedApp();
    const state = (await backend.state.get(project.id))!;
    // Over the budget: only the newest is kept. Two dropped share an index.
    await backend.history.replaceAll(project.id, [records[0], { ...records[1], index: records[0].index }, records[2]]);
    await backend.state.save({ ...state, historyIndex: 2 });
    vi.spyOn(await import('../src/utils/history-size.ts'), 'historyByteBudget').mockReturnValue(1);
    await (app as any)._loadProject(project.id);
    expect(loaded()!.xs).toEqual([3]);
    expect((app as any)._historyNeedsRewrite).toBe(true);
  });

  it('drops a malformed redo entry and what follows it', async () => {
    const { app, backend, project, corrupt, loaded } = await savedApp();
    const state = (await backend.state.get(project.id))!;
    await backend.state.save({ ...state, historyIndex: 0 });
    await corrupt(1, (e) => { delete e.before; return e; });
    await (app as any)._loadProject(project.id);
    expect(loaded()).toEqual({ xs: [1], index: 0 });
  });

  it.each([
    ['StorageNotFoundError', () => new StorageNotFoundError('gone')],
    ['an error named StorageNotFoundError (custom backend)', () => Object.assign(new Error('gone'), { name: 'StorageNotFoundError' })],
    ['NotFoundError', () => new DOMException('gone', 'NotFoundError')],
  ])('drops an entry whose blob is missing (%s)', async (_label, makeErr) => {
    const { app, backend, project, records, loaded } = await savedApp();
    const ref = (records[1].entry as { before: { blobRef: string } }).before.blobRef;
    const get = backend.blobs.get.bind(backend.blobs);
    vi.spyOn(backend.blobs, 'get').mockImplementation(async (r) => {
      if (r === ref) throw makeErr();
      return get(r);
    });
    await (app as any)._loadProject(project.id);
    expect(loaded()).toEqual({ xs: [3], index: 0 });
    expect((app as any)._currentProject.id).toBe(project.id);
  });

  it.each([
    ['out of memory (RangeError)', () => new RangeError('Array buffer allocation failed')],
    ['a transient read failure', () => Object.assign(new Error('busy'), { name: 'StorageNetworkError' })],
    ['a TypeError (e.g. no 2D context for the pixels)', () => new TypeError("Cannot read properties of null (reading 'putImageData')")],
  ])('fails the load on %s, leaving stored history untouched', async (_label, makeErr) => {
    const { app, backend, project, records, loaded } = await savedApp();
    const ref = (records[1].entry as { before: { blobRef: string } }).before.blobRef;
    const get = backend.blobs.get.bind(backend.blobs);
    vi.spyOn(backend.blobs, 'get').mockImplementation(async (r) => {
      if (r === ref) throw makeErr();
      return get(r);
    });
    await (app as any)._loadProject(project.id);
    // A blank document, not the stored history.
    expect(loaded()?.xs ?? []).toEqual([]);
    // Work carries on in a new project; the failed one is never saved over.
    expect((app as any)._currentProject.id).not.toBe(project.id);
    expect(await backend.history.getEntries(project.id)).toEqual(records);
  });
});

describe('malformed record checks', () => {
  const blobs = { get: vi.fn(async () => { throw new Error('should not be read'); }) } as any;

  it('reports a malformed record before reading any blob', async () => {
    await expect(deserializeHistoryEntry({ type: 'crop', beforeLayers: [], afterLayers: 'x' } as any, blobs))
      .rejects.toBeInstanceOf(MalformedRecordError);
    await expect(deserializeHistoryEntry({ type: 'add-layer', layer: { id: 'a' }, index: 0 } as any, blobs))
      .rejects.toBeInstanceOf(MalformedRecordError);
    expect(blobs.get).not.toHaveBeenCalled();
  });

  it('passes entries without pixels through', async () => {
    const entry = { type: 'rename', layerId: 'l', before: 'a', after: 'b' } as any;
    await expect(deserializeHistoryEntry(entry, blobs)).resolves.toEqual(entry);
  });

  it('counts a malformed record as 0 bytes for the load budget instead of throwing', () => {
    expect(serializedHistoryEntryBytes({ type: 'patch' } as any)).toBe(0);
    expect(serializedHistoryEntryBytes(null as any)).toBe(0);
  });
});

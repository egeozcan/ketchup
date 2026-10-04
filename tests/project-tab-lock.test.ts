import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';
import { StorageQuotaError } from '../src/storage/errors.ts';
import { makeAppCanvasStub, makeCanvas, makeLayer, makeState } from './helpers.ts';

/**
 * Web Locks shared by every app in the test, standing for tabs: exclusive
 * locks granted in a later task (as browsers do), queued, `ifAvailable`,
 * `steal` and `signal`.
 */
function fakeLocks() {
  const held = new Map<string, (err: Error) => void>();
  const queues = new Map<string, (() => void)[]>();
  const grantNext = (name: string) => queues.get(name)?.shift()?.();
  const request = vi.fn((name: string, options: LockOptions, cb: (lock: Lock | null) => unknown) =>
    new Promise((resolve, reject) => {
      const grant = () => {
        let stolen = false;
        held.set(name, err => { stolen = true; reject(err); });
        setTimeout(() => {
          Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then(
            value => { if (!stolen) { held.delete(name); resolve(value); grantNext(name); } },
            err => { if (!stolen) { held.delete(name); reject(err); grantNext(name); } },
          );
        }, 0);
      };
      if (options.steal) {
        held.get(name)?.(new DOMException('Stolen', 'AbortError'));
        grant();
      } else if (!held.has(name)) {
        grant();
      } else if (options.ifAvailable) {
        setTimeout(() => Promise.resolve(cb(null)).then(resolve, reject), 0);
      } else {
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        queue.push(grant);
        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(grant);
          if (i < 0) return;
          queue.splice(i, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }
    }));
  /** Another tab holding a lock until the returned function lets it go. */
  const holdElsewhere = (name: string) => {
    let release!: () => void;
    void request(name, {}, () => new Promise<void>(r => { release = r; })).catch(() => {});
    return () => release();
  };
  // Every lock here is this tab's, as the browser reports them.
  const query = vi.fn(async () => ({ held: [...held.keys()].map(name => ({ name, clientId: 'tab', mode: 'exclusive' })),
    // Requests waiting in a lock's queue, as the browser reports them.
    pending: [...queues].flatMap(([name, queue]) => queue.map(() => ({ name, clientId: 'tab', mode: 'exclusive' }))),
  }));
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request, query } }));
  return { held, request, query, holdElsewhere };
}

/** BroadcastChannel between the apps in the test, delivering in a later task. */
class FakeChannel {
  static open = new Set<FakeChannel>();
  private _listeners = new Set<(e: MessageEvent) => void>();
  constructor(readonly name: string) { FakeChannel.open.add(this); }
  addEventListener(_type: string, fn: (e: MessageEvent) => void) { this._listeners.add(fn); }
  removeEventListener(_type: string, fn: (e: MessageEvent) => void) { this._listeners.delete(fn); }
  postMessage(data: unknown) {
    for (const other of FakeChannel.open) {
      if (other === this || other.name !== this.name) continue;
      setTimeout(() => other._listeners.forEach(fn => fn({ data } as MessageEvent)), 0);
    }
  }
  close() { FakeChannel.open.delete(this); }
}

function makeApp() {
  const app = new DrawingApp();
  const canvas = makeAppCanvasStub();
  Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
  return { app, canvas };
}

const meta = (id: string) => ({ id, name: id, createdAt: 0, updatedAt: 0, thumbnailRef: null });

/** An app editing a stored project, whose saves really write (to a MockBackend). */
async function makeSavingApp(name = 'P') {
  const backend = new MockBackend();
  await backend.init();
  const project = await backend.projects.create({ name, thumbnailRef: null });
  const { app } = makeApp();
  const layer = makeLayer(20, 20, { id: 'l1' });
  (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
  const canvas = makeAppCanvasStub({ mainCanvas: makeCanvas(40, 30) });
  Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
  (app as any)._backend = backend;
  await (app as any)._enterProject(project, async () => { (app as any)._trackLoadedProject(project.id, [], []); });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
    cb(new Blob(['png'], { type: 'image/png' }));
  });
  return { app, canvas, backend, project };
}

/** Another tab taking `id` by "Use here anyway"; resolves a function that lets it go. */
async function stealElsewhere(locks: ReturnType<typeof fakeLocks>, id: string) {
  let release!: () => void;
  void locks.request(`ketchup-project:${id}`, { steal: true }, () => new Promise<void>(r => { release = r; }));
  await settle();
  return () => release();
}
const flush = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await flush(); };

describe('one tab edits a project at a time', () => {
  beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeChannel.open.clear();
    document.body.replaceChildren();
  });

  it('shows a project another tab is editing read-only: no edits by key, no saves', async () => {
    const locks = fakeLocks();
    locks.holdElsewhere('ketchup-project:p');
    const { app, canvas } = makeApp();
    await (app as any)._enterProject(meta('p'), async () => {});
    expect((app as any)._readOnly).toBe(true);

    (app as any)._onKeyDown({ key: 'z', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, preventDefault() {}, composedPath: () => [] });
    expect(canvas.undo).not.toHaveBeenCalled();

    const save = vi.fn();
    (app as any)._backend = { state: { save } };
    (app as any)._dirty = true;
    await (app as any)._save();
    expect(save).not.toHaveBeenCalled();
  });

  it('edits a free project, and lets it go for another', async () => {
    const locks = fakeLocks();
    const { app } = makeApp();
    await (app as any)._enterProject(meta('p'), async () => {});
    expect((app as any)._readOnly).toBe(false);
    expect(locks.held.has('ketchup-project:p')).toBe(true);

    await (app as any)._enterProject(meta('q'), async () => {});
    await flush();
    expect(locks.held.has('ketchup-project:p')).toBe(false);
    expect(locks.held.has('ketchup-project:q')).toBe(true);
  });

  it('opening the same project twice in a row ends holding it, not read-only', async () => {
    const locks = fakeLocks();
    const { app } = makeApp();
    const first = (app as any)._enterProject(meta('q'), async () => {});
    const second = (app as any)._enterProject(meta('q'), async () => {});
    await Promise.all([first, second]);
    await settle();
    expect((app as any)._projectLock?.id).toBe('q');
    expect(locks.held.has('ketchup-project:q')).toBe(true);
    expect((app as any)._readOnly).toBe(false);
  });

  it('takes a project again right after letting it go', async () => {
    fakeLocks();
    const { app } = makeApp();
    expect(await (app as any)._lockProject('p')).toBe(true);
    (app as any)._releaseProjectLock();
    expect(await (app as any)._lockProject('p')).toBe(true);
  });

  it('holds only the project asked for last when requests overlap', async () => {
    const locks = fakeLocks();
    const { app } = makeApp();
    const first = (app as any)._lockProject('p');
    const second = (app as any)._lockProject('q');
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    await settle();
    expect(locks.held.has('ketchup-project:p')).toBe(false);
    expect(locks.held.has('ketchup-project:q')).toBe(true);
  });

  it('"Use here" waits for the editing tab to save, however long that takes, then loads it', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const locks = fakeLocks();
    const order: string[] = [];
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    (editing as any)._dirty = true;
    (editing as any)._flushPendingSaveAndWait = vi.fn(async () => {
      expect((editing as any)._readOnly).toBe(true);
      expect((editing as any)._handingOver).toBe(true);
      await new Promise(r => setTimeout(r, 3000));
      (editing as any)._dirty = false;
      order.push('saved');
    });

    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    expect((shown as any)._readOnly).toBe(true);
    (shown as any)._loadProject = vi.fn(async () => {
      // Still shown read-only until the saved project is in.
      order.push(`loaded, read-only ${(shown as any)._readOnly}`);
    });

    vi.useFakeTimers();
    const done = (shown as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(10);
    expect((shown as any)._waitingForTab).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(order).toEqual(['saved', 'loaded, read-only true']);
    expect((shown as any)._readOnly).toBe(false);
    expect((shown as any)._waitingForTab).toBe(false);
    expect((shown as any)._projectLock?.id).toBe('p');
    expect((editing as any)._readOnly).toBe(true);
    expect((editing as any)._projectLock).toBeNull();
    expect(locks.held.has('ketchup-project:p')).toBe(true);
  });

  it('offers to take over again when the editing tab answers but has not let go after a while', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    (editing as any)._dirty = true;
    (editing as any)._flushPendingSaveAndWait = vi.fn(() => new Promise(() => {}));
    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (shown as any)._loadProject = load;

    vi.useFakeTimers();
    const done = (shown as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((shown as any)._otherTabSilent).toBe(false);
    await vi.advanceTimersByTimeAsync(12000);
    expect((shown as any)._otherTabSilent).toBe(true);
    (shown as any)._forceTakeOver();
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(load).toHaveBeenCalled();
  });

  it('a project renamed while "Use here" waits is still loaded once the other tab lets go', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    (editing as any)._dirty = true;
    let saved!: () => void;
    (editing as any)._flushPendingSaveAndWait = vi.fn(() => new Promise<void>(r => { saved = () => { (editing as any)._dirty = false; r(); }; }));
    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (shown as any)._loadProject = load;

    const done = (shown as any)._editHere(true);
    await vi.waitFor(() => expect(saved).toBeTypeOf('function'));
    (shown as any)._currentProject = { ...meta('p'), name: 'renamed' };
    saved();
    await done;
    expect(load).toHaveBeenCalledWith('p');
    expect((shown as any)._readOnly).toBe(false);
    expect((shown as any)._currentProject.name).toBe('renamed');
  });

  it('saves nothing under a lock the content was not loaded under', async () => {
    fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    // The lock let go and taken again without reloading.
    (app as any)._releaseProjectLock();
    await settle();
    expect(await (app as any)._lockProject(project.id)).toBe(true);
    const write = vi.spyOn(backend.state, 'save');
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    await (app as any)._save(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('when two tabs ask at once, the one that does not get the project stops waiting', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    const asking = [makeApp().app, makeApp().app];
    for (const app of asking) {
      await (app as any)._enterProject(meta('p'), async () => {});
      (app as any)._loadProject = vi.fn(async () => {});
    }

    vi.useFakeTimers();
    const done = asking.map(app => (app as any)._editHere(true));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(done);

    const states = asking.map(app => ({ ro: (app as any)._readOnly, waiting: (app as any)._waitingForTab }));
    expect(states).toContainEqual({ ro: false, waiting: false });
    expect(states).toContainEqual({ ro: true, waiting: false });
  });

  it('asks before taking the project from a tab that does not answer, and takes it if told to', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const locks = fakeLocks();
    locks.holdElsewhere('ketchup-project:p');
    const { app } = makeApp();
    await (app as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (app as any)._loadProject = load;

    vi.useFakeTimers();
    const done = (app as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(1900);
    expect((app as any)._otherTabSilent).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).not.toHaveBeenCalled();
    expect((app as any)._otherTabSilent).toBe(true);
    expect((app as any)._readOnly).toBe(true);

    (app as any)._forceTakeOver();
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(load).toHaveBeenCalled();
    expect((app as any)._readOnly).toBe(false);
    expect((app as any)._otherTabSilent).toBe(false);
  });

  it('keeps work a tab had not stored when its project is taken, to save as a new project', async () => {
    const locks = fakeLocks();
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const { app } = makeApp();
    const layer = makeLayer(20, 20, { id: 'l1' });
    (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub({ mainCanvas: makeCanvas(40, 30) }) });
    (app as any)._backend = backend;
    await (app as any)._enterProject(project, async () => { (app as any)._trackLoadedProject(project.id, [], []); });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });

    // Taken with nothing unstored: only shown.
    void locks.request(`ketchup-project:${project.id}`, { steal: true }, () => new Promise(() => {}));
    await settle();
    expect((app as any)._readOnly).toBe(true);
    expect((app as any)._stranded).toBe(false);

    // Taken with a stroke not yet stored: kept, and leaving asks first.
    const again = await backend.projects.create({ name: 'Q', thumbnailRef: null });
    await (app as any)._enterProject(again, async () => { (app as any)._trackLoadedProject(again.id, [], []); });
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    void locks.request(`ketchup-project:${again.id}`, { steal: true }, () => new Promise(() => {}));
    await settle();
    expect((app as any)._stranded).toBe(true);
    const leave = { preventDefault: vi.fn() };
    (app as any)._onBeforeUnload(leave);
    expect(leave.preventDefault).toHaveBeenCalled();

    await (app as any)._keepAsNewProject();
    const copy = (app as any)._currentProject;
    expect(copy.name).toBe('Q (copy)');
    expect((app as any)._readOnly).toBe(false);
    expect((app as any)._stranded).toBe(false);
    expect(await backend.state.get(copy.id)).toBeTruthy();
    expect(await backend.state.get(again.id)).toBeFalsy();
    await settle();
    expect(locks.held.has(`ketchup-project:${copy.id}`)).toBe(true);
  });

  it('goes back to the kept work, holding no lock, when saving the copy throws', async () => {
    const locks = fakeLocks();
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const { app } = makeApp();
    (app as any)._backend = backend;
    (app as any)._projectService = { deleteProject: (id: string) => backend.projects.delete(id) };
    await (app as any)._enterProject(project, async () => { (app as any)._trackLoadedProject(project.id, [], []); });
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    void locks.request(`ketchup-project:${project.id}`, { steal: true }, () => new Promise(() => {}));
    await settle();
    expect((app as any)._stranded).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(app as any, '_carryStamps').mockRejectedValue(new Error('boom'));

    await (app as any)._keepAsNewProject();
    await settle();
    expect((app as any)._currentProject.id).toBe(project.id);
    expect((app as any)._stranded).toBe(true);
    expect((app as any)._projectLock).toBeNull();
    await vi.waitFor(async () => expect((await backend.projects.list()).map(p => p.id)).toEqual([project.id]));
    // "Use here without them" can still be tried.
    expect((app as any)._claiming).toBe(false);
  });

  it('stays with the kept work, and says why, when the copy cannot even be made', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    (app as any)._projectService = { deleteProject: vi.fn((id: string) => backend.projects.delete(id)) };
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    const release = await stealElsewhere(locks, project.id);
    expect((app as any)._stranded).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.spyOn(backend.projects, 'create').mockRejectedValueOnce(new StorageQuotaError('full'));
    const save = vi.spyOn(backend.state, 'save');

    await (app as any)._keepAsNewProject();
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect((app as any)._keepError).toBe('Storage is full, so the copy could not be saved.');
    expect((app as any)._currentProject.id).toBe(project.id);
    expect((app as any)._stranded).toBe(true);
    expect((app as any)._readOnly).toBe(true);
    expect((app as any)._hasUnsavedWork()).toBe(true);
    expect((app as any)._projectLock).toBeNull();
    expect((app as any)._claiming).toBe(false);
    expect((app as any)._keeping).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect((await backend.projects.list()).map(p => p.id)).toEqual([project.id]);
    expect([...locks.held.keys()]).toEqual([`ketchup-project:${project.id}`]);

    // Trying again once there is room makes the copy.
    await (app as any)._keepAsNewProject();
    expect((app as any)._stranded).toBe(false);
    expect((app as any)._keepError).toBe('');
    expect((app as any)._currentProject.name).toBe('P (copy)');
    release();
  });

  it('keeps work from a take-over through coming back into view, and through a return to the page', async () => {
    const locks = fakeLocks();
    const { app, project } = await makeSavingApp();
    const load = vi.spyOn(app as any, '_loadProject');
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    const letGo = await stealElsewhere(locks, project.id);
    expect((app as any)._stranded).toBe(true);
    letGo();
    await settle();

    await (app as any)._editHere(false);
    expect(load).not.toHaveBeenCalled();
    expect((app as any)._stranded).toBe(true);
  });

  it('commits a float moved since the last save when the project is taken, and keeps it as work', async () => {
    const locks = fakeLocks();
    const { app, canvas, project } = await makeSavingApp();
    // Committing the float lands it in history, which marks work.
    canvas.clearSelection.mockImplementation(() => { (app as any)._markDirty(); });
    await stealElsewhere(locks, project.id);
    expect(canvas.clearSelection).toHaveBeenCalled();
    expect((app as any)._stranded).toBe(true);
  });

  it('never reloads unstored work away when coming back into view', async () => {
    fakeLocks();
    const { app, project } = await makeSavingApp();
    const load = vi.spyOn(app as any, '_loadProject');
    (app as any)._releaseProjectLock();
    Object.assign(app as any, { _readOnly: true, _dirty: true });
    (app as any)._contentVersion++;
    await (app as any)._editHere(false);
    expect(load).not.toHaveBeenCalled();
    expect((app as any)._stranded).toBe(true);
    expect((app as any)._currentProject.id).toBe(project.id);
  });

  it('counts text still being typed as work not stored', async () => {
    const locks = fakeLocks();
    const { app, canvas, project } = await makeSavingApp();
    canvas.hasPendingText.mockReturnValue(true);
    await stealElsewhere(locks, project.id);
    expect((app as any)._stranded).toBe(true);
  });

  it('keeps the work as a new project once its own save under way has finished', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    // Its save stalls at the write; it is taken meanwhile, with work drawn
    // after the save's snapshot.
    let write!: () => void;
    const save = backend.state.save.bind(backend.state);
    vi.spyOn(backend.state, 'save').mockImplementationOnce(async record => {
      await new Promise<void>(r => { write = r; });
      return save(record);
    });
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    void (app as any)._save(true);
    await settle();
    (app as any)._contentVersion++;
    (app as any)._dirtyVersion++;
    await stealElsewhere(locks, project.id);
    expect((app as any)._stranded).toBe(true);

    const keeping = (app as any)._keepAsNewProject();
    await settle();
    expect((app as any)._keeping).toBe(true);
    write();
    await keeping;
    const copy = (app as any)._currentProject;
    expect(copy.name).toBe('P (copy)');
    expect(await backend.state.get(copy.id)).toBeTruthy();
    expect((app as any)._dirty).toBe(false);
  });

  it('makes no copy when its own save under way stores the work after all', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    let write!: () => void;
    const save = backend.state.save.bind(backend.state);
    vi.spyOn(backend.state, 'save').mockImplementationOnce(async record => {
      await new Promise<void>(r => { write = r; });
      return save(record);
    });
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    void (app as any)._save(true);
    await settle();
    await stealElsewhere(locks, project.id);
    expect((app as any)._stranded).toBe(true);

    const keeping = (app as any)._keepAsNewProject();
    await settle();
    write();
    await keeping;
    expect((app as any)._currentProject.id).toBe(project.id);
    expect((app as any)._stranded).toBe(false);
    expect(await backend.projects.list()).toHaveLength(1);
  });

  it('reopens the project a tab had open before a reload', async () => {
    fakeLocks();
    const backend = new MockBackend();
    await backend.init();
    const mine = await backend.projects.create({ name: 'Mine', thumbnailRef: null });
    await new Promise(r => setTimeout(r, 5));
    await backend.projects.create({ name: 'Newer', thumbnailRef: null });
    expect((await backend.projects.list())[0].id).not.toBe(mine.id);
    const { app } = makeApp();
    (app as any)._backend = backend;
    (app as any)._loadProject = vi.fn(async () => {});
    sessionStorage.setItem('ketchup-tab-project', mine.id);
    try {
      await (app as any)._bootstrapProjects();
      expect((app as any)._currentProject.id).toBe(mine.id);
    } finally {
      sessionStorage.clear();
    }
  });

  it('keeps the project, and its work, when its save fails as another tab asks for it', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    (editing as any)._dirty = true;
    (editing as any)._flushPendingSaveAndWait = vi.fn(async () => { (editing as any)._saveFailed = true; });

    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (shown as any)._loadProject = load;

    vi.useFakeTimers();
    const done = (shown as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(load).not.toHaveBeenCalled();
    expect((shown as any)._readOnly).toBe(true);
    expect((shown as any)._waitingForTab).toBe(false);
    expect((shown as any)._keptElsewhere).toBe(true);
    expect((editing as any)._readOnly).toBe(false);
    expect((editing as any)._projectLock?.id).toBe('p');
  });

  it('writes nothing once another tab has taken the project before the writes, and keeps the work here', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    // The save waits on storage before its writes; meanwhile another tab takes the project.
    let resume!: () => void;
    const get = backend.state.get.bind(backend.state);
    vi.spyOn(backend.state, 'get').mockImplementation(async id => {
      await new Promise<void>(r => { resume = r; });
      return get(id);
    });
    const write = vi.spyOn(backend.state, 'save');
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    const saving = (app as any)._save(true);
    await settle();
    await stealElsewhere(locks, project.id);
    expect((app as any)._stranded).toBe(true);
    resume();
    await saving;
    expect(write).not.toHaveBeenCalled();
    expect((app as any)._stranded).toBe(true);
  });

  it('lets writes under way when another tab takes the project land (that tab waits for them), and starts no other save', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    let write!: () => void;
    const save = backend.state.save.bind(backend.state);
    const written = vi.spyOn(backend.state, 'save').mockImplementationOnce(async record => {
      await new Promise<void>(r => { write = r; });
      return save(record);
    });
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    const saving = (app as any)._save(true);
    await vi.waitFor(() => expect(written).toHaveBeenCalled());
    await stealElsewhere(locks, project.id);
    write();
    await saving;
    expect(await backend.state.get(project.id)).toBeTruthy();
    expect((app as any)._stranded).toBe(false);
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    await (app as any)._save(true);
    expect(written).toHaveBeenCalledTimes(1);
  });

  it('holds the save lock only while writing, not through the pause between saves', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    const written = vi.spyOn(backend.state, 'save');
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    void (app as any)._save();
    await vi.waitFor(() => expect(written).toHaveBeenCalled());
    await settle();
    expect((app as any)._savePromise).not.toBeNull();
    expect(locks.held.has(`ketchup-save:${project.id}`)).toBe(false);
  });

  it('writes nothing when the browser says another tab took the project before the save began', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    // Taken while this tab couldn't hear of it yet: it still thinks it holds it.
    locks.query.mockImplementation(async () => ({
      held: [
        { name: `ketchup-project:${project.id}`, clientId: 'other', mode: 'exclusive' },
        ...[...locks.held.keys()].filter(n => n.startsWith('ketchup-save:')).map(name => ({ name, clientId: 'tab', mode: 'exclusive' })),
      ],
      pending: [],
    }));
    const write = vi.spyOn(backend.state, 'save');
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    await (app as any)._save(true);
    expect((app as any)._projectLock?.id).toBe(project.id);
    expect(write).not.toHaveBeenCalled();
    expect((app as any)._dirty).toBe(true);
  });

  it('a save from before the tab lost its project and took it back writes nothing', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    let resume!: () => void;
    const get = backend.state.get.bind(backend.state);
    vi.spyOn(backend.state, 'get').mockImplementationOnce(async id => {
      await new Promise<void>(r => { resume = r; });
      return get(id);
    });
    const write = vi.spyOn(backend.state, 'save');
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    const saving = (app as any)._save(true);
    await settle();
    const letGo = await stealElsewhere(locks, project.id);
    letGo();
    await settle();
    expect(await (app as any)._lockProject(project.id)).toBe(true);
    resume();
    await saving;
    expect(write).not.toHaveBeenCalled();
  });

  it('a project opened while another waited for a save ends that wait, and a save come due then is made', async () => {
    const locks = fakeLocks();
    void locks.request('ketchup-save:p', {}, () => new Promise<void>(() => {}));
    await settle();
    const { app } = makeApp();
    const schedule = vi.spyOn(app as any, '_scheduleSave').mockImplementation(() => {});
    const enteringP = (app as any)._enterProject(meta('p'), async () => {});
    await settle();
    (app as any)._dirty = true;
    await (app as any)._enterProject(meta('q'), async () => {});
    await enteringP;
    expect((app as any)._projectLoads).toBe(0);
    expect((app as any)._currentProject.id).toBe('q');
    expect(schedule).toHaveBeenCalled();
  });

  it('a failed load overtaken by opening another project leaves that project open', async () => {
    fakeLocks();
    const { app } = makeApp();
    Object.defineProperty(app, 'updateComplete', { value: Promise.resolve(true) });
    let created!: (m: unknown) => void;
    const fresh = meta('fresh');
    (app as any)._backend = {
      state: { get: vi.fn(async () => { throw new Error('Blob not found'); }) },
      projects: { create: vi.fn(() => new Promise(r => { created = r; })), list: vi.fn(async () => []), get: vi.fn(async () => null) },
    };
    const deleteProject = vi.fn(async () => {});
    (app as any)._projectService = { deleteProject };
    const reset = vi.spyOn(app as any, '_resetToFreshProject').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entering = (app as any)._enterProject(meta('broken'), () => (app as any)._loadProject('broken'));
    await vi.waitFor(() => expect(created).toBeTypeOf('function'));
    await (app as any)._enterProject(meta('q'), async () => {});
    created(fresh);
    await entering;
    expect((app as any)._currentProject.id).toBe('q');
    expect(reset).not.toHaveBeenCalled();
    expect(deleteProject).toHaveBeenCalledWith('fresh');
    expect((app as any)._projectLock?.id).toBe('q');
  });

  it('opens a project only once storage has reopened', async () => {
    fakeLocks();
    const { app } = makeApp();
    let reopened!: () => void;
    (app as any)._backendReopen = new Promise<void>(r => { reopened = r; });
    const load = vi.fn(async () => {});
    const entering = (app as any)._enterProject(meta('p'), load);
    await settle();
    expect(load).not.toHaveBeenCalled();
    reopened();
    await entering;
    expect(load).toHaveBeenCalled();
  });

  it('a tab taking a project over waits for a save the other tab still has under way', async () => {
    const locks = fakeLocks();
    const order: string[] = [];
    let endSave!: () => void;
    void locks.request('ketchup-save:p', {}, () => new Promise<void>(r => {
      endSave = () => { order.push('saved'); r(); };
    }));
    await settle();
    const { app } = makeApp();
    const entering = (app as any)._enterProject(meta('p'), async () => { order.push('loaded'); });
    await settle();
    expect(order).toEqual([]);
    // Shown, not editable, meanwhile.
    expect((app as any)._readOnly).toBe(true);
    expect((app as any)._opening).toBe(true);
    endSave();
    await entering;
    expect(order).toEqual(['saved', 'loaded']);
    expect((app as any)._readOnly).toBe(false);
    expect((app as any)._opening).toBe(false);
  });

  it('a project opened while another was still waiting to load stays: the earlier load never lands', async () => {
    const locks = fakeLocks();
    let endSave!: () => void;
    void locks.request('ketchup-save:p', {}, () => new Promise<void>(r => { endSave = r; }));
    await settle();
    const { app } = makeApp();
    const loadP = vi.fn(async () => {});
    const entering = (app as any)._enterProject(meta('p'), loadP);
    await settle();
    await (app as any)._enterProject(meta('q'), async () => {});
    endSave();
    await entering;
    expect(loadP).not.toHaveBeenCalled();
    expect((app as any)._currentProject.id).toBe('q');
    expect((app as any)._readOnly).toBe(false);
    expect((app as any)._opening).toBe(false);
    await settle();
    expect(locks.held.has('ketchup-project:q')).toBe(true);
    expect(locks.held.has('ketchup-project:p')).toBe(false);
  });

  it('a load overtaken by opening another project applies nothing', async () => {
    fakeLocks();
    const { app } = makeApp();
    Object.defineProperty(app, 'updateComplete', { value: Promise.resolve(true) });
    let answer!: (record: unknown) => void;
    (app as any)._backend = { state: { get: vi.fn(() => new Promise(r => { answer = r; })) } };
    const fresh = vi.spyOn(app as any, '_resetToFreshProject').mockResolvedValue(undefined);
    const entering = (app as any)._enterProject(meta('p'), () => (app as any)._loadProject('p'));
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await (app as any)._enterProject(meta('q'), async () => {});
    answer(null);
    await entering;
    expect(fresh).not.toHaveBeenCalled();
    expect((app as any)._currentProject.id).toBe('q');
  });

  it('locks the project made on a first visit', async () => {
    const locks = fakeLocks();
    const backend = new MockBackend();
    await backend.init();
    const { app } = makeApp();
    Object.defineProperty(app, 'updateComplete', { value: Promise.resolve(true) });
    (app as any)._backend = backend;
    await (app as any)._bootstrapProjects();
    const id = (app as any)._currentProject.id;
    await settle();
    expect(locks.held.has(`ketchup-project:${id}`)).toBe(true);
    expect((app as any)._readOnly).toBe(false);
  });

  it('keeps its project through a move in the page, and takes it again after time away', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const locks = fakeLocks();
    const backend = new MockBackend();
    const { app } = makeApp();
    app.storageBackend = backend;
    document.body.append(app);
    await app.whenReady();
    await settle();
    const id = (app as any)._currentProject.id;
    expect(locks.held.has(`ketchup-project:${id}`)).toBe(true);

    const box = document.createElement('div');
    document.body.append(box);
    box.append(app);
    await settle();
    expect((app as any)._projectLock?.id).toBe(id);
    expect(locks.held.has(`ketchup-project:${id}`)).toBe(true);

    const load = vi.spyOn(app as any, '_loadProject');
    expect(load).not.toHaveBeenCalled();
    app.remove();
    await vi.waitFor(() => expect(locks.held.has(`ketchup-project:${id}`)).toBe(false));
    // Back: another tab may have changed it meanwhile, so it's loaded again.
    document.body.append(app);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith(id);
      expect((app as any)._projectLock?.id).toBe(id);
      expect((app as any)._readOnly).toBe(false);
    });
  });

  it('keeps the project while out of the page if its work could not be stored', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const locks = fakeLocks();
    const backend = new MockBackend();
    const { app } = makeApp();
    app.storageBackend = backend;
    document.body.append(app);
    await app.whenReady();
    await settle();
    const id = (app as any)._currentProject.id;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(backend.state, 'save').mockRejectedValue(new Error('QuotaExceededError'));
    (app as any)._markDirty();
    app.remove();
    await settle(30);
    expect((app as any)._dirty).toBe(true);
    expect(locks.held.has(`ketchup-project:${id}`)).toBe(true);
    expect((app as any)._readOnly).toBe(false);
  });

  it('keeps the keyboard out of what the read-only overlay covers', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    fakeLocks();
    const { app } = makeApp();
    app.storageBackend = new MockBackend();
    document.body.append(app);
    await app.whenReady();
    (app as any)._readOnly = true;
    await app.updateComplete;
    const root = app.shadowRoot!;
    for (const sel of ['app-toolbar', 'drawing-canvas', '.right-sidebar']) {
      expect(root.querySelector(sel)!.hasAttribute('inert')).toBe(true);
    }
    expect(root.querySelector('.read-only button')!.closest('[inert]')).toBeNull();
    (app as any)._readOnly = false;
    await app.updateComplete;
    expect(root.querySelector('[inert]')).toBeNull();

    // Work kept from a take-over: the top bar can't drop it either, and a
    // "Use here" waiting on a silent tab can still be forced.
    Object.assign(app as any, { _readOnly: true, _stranded: true });
    await app.updateComplete;
    expect(root.querySelector('tool-settings')!.hasAttribute('inert')).toBe(true);
    Object.assign(app as any, { _claiming: true, _waitingForTab: true, _otherTabSilent: true });
    await app.updateComplete;
    expect([...root.querySelectorAll('.read-only button')].map(b => b.textContent!.trim())).toEqual(['Use here anyway', 'Keep them as a new project']);
  });


  it('drops the save banner when going back online finds saving no longer possible', async () => {
    const locks = fakeLocks();
    const { app, project } = await makeSavingApp();
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    (app as any)._saveError = true;
    await stealElsewhere(locks, project.id);
    (app as any)._onOnline();
    await vi.waitFor(() => expect((app as any)._saveError).toBe(false), { timeout: 3000 });
  });

  it('retries a failed final flush of an editor taken out of the document', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    fakeLocks();
    const backend = new MockBackend();
    const { app } = makeApp();
    app.storageBackend = backend;
    document.body.append(app);
    await app.whenReady();
    await settle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.spyOn(backend.state, 'save').mockRejectedValueOnce(new Error('QuotaExceededError'));
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    (app as any)._markDirty();
    app.remove();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect((app as any)._dirty).toBe(false), { timeout: 5000 });
  });

  it('ignores a late "releasing" once taking the project anyway: no stray request to the tab it is taken from', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const locks = fakeLocks();
    locks.holdElsewhere('ketchup-project:p');
    const { app } = makeApp();
    await (app as any)._enterProject(meta('p'), async () => {});
    (app as any)._loadProject = vi.fn(async () => {});
    // The tab holding it, slow to answer.
    const other = new FakeChannel('ketchup-projects');
    const asks: string[] = [];
    other.addEventListener('message', e => { if (e.data.type === 'release') asks.push(e.data.ask); });

    // Taking the lock anyway takes a while (longer than a re-ask's pause),
    // so the late answers below reach the request while it is still taking it.
    const lockProject = (app as any)._lockProject.bind(app);
    (app as any)._lockProject = (id: string, mode?: string) => (mode === 'steal'
      ? new Promise(r => setTimeout(r, 5000)).then(() => lockProject(id, mode))
      : lockProject(id, mode));

    vi.useFakeTimers();
    const done = (app as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(2500);
    expect((app as any)._otherTabSilent).toBe(true);
    // Answers sent before "Use here anyway", arriving after it.
    other.postMessage({ type: 'releasing', id: 'p', ask: asks[0] });
    other.postMessage({ type: 'stayed', id: 'p', asks: [asks[0]] });
    (app as any)._forceTakeOver();
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    // No re-ask after "stayed" (a release the old holder would act on).
    expect(asks).toHaveLength(1);
    expect((app as any)._otherTabSilent).toBe(false);
    expect((app as any)._readOnly).toBe(false);
  });

  it('waits on despite answers to another request', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const locks = fakeLocks();
    const release = locks.holdElsewhere('ketchup-project:p');
    const { app } = makeApp();
    await (app as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (app as any)._loadProject = load;
    const other = new FakeChannel('ketchup-projects');

    vi.useFakeTimers();
    const done = (app as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(10);
    // Answers to an earlier "Use here" of this tab's: not kept from this one.
    other.postMessage({ type: 'kept', id: 'p', asks: ['earlier'] });
    other.postMessage({ type: 'releasing', id: 'p', ask: 'earlier' });
    await vi.advanceTimersByTimeAsync(2500);
    expect((app as any)._keptElsewhere).toBe(false);
    // Not answered (to this request) within 2 s.
    expect((app as any)._otherTabSilent).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(load).toHaveBeenCalled();
  });

  it('a request answered "kept" and asked again keeps the project without trying the failing save again', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing, canvas } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    (editing as any)._dirty = true;
    const flush = vi.fn(async () => {
      // Rendered read-only meanwhile (the app isn't in the page, so Lit won't call it).
      (editing as any).updated(new Map([['_readOnly', false]]));
      (editing as any)._saveFailed = true;
    });
    (editing as any)._flushPendingSaveAndWait = flush;
    const other = new FakeChannel('ketchup-projects');
    const answers: unknown[] = [];
    other.addEventListener('message', e => answers.push(e.data));

    other.postMessage({ type: 'release', id: 'p', ask: 'a' });
    await settle();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(answers).toContainEqual({ type: 'kept', id: 'p', asks: ['a'] });
    expect((editing as any)._readOnly).toBe(false);
    // A dialog over the editor stays: the tab kept the project.
    expect(canvas.dismissResizeDialog).not.toHaveBeenCalled();

    answers.length = 0;
    other.postMessage({ type: 'release', id: 'p', ask: 'a' });
    await settle();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([]);
    expect((editing as any)._readOnly).toBe(false);

    // A new request is a new try.
    other.postMessage({ type: 'release', id: 'p', ask: 'b' });
    await settle();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('keeps a dialog open through a hand-over no one waits for, and dismisses it once the project is handed over', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    const locks = fakeLocks();
    const { app: editing, canvas } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    // Rendered read-only during the hand-over (the app isn't in the page, so
    // Lit won't call `updated`): the dialog must stay until it is over.
    const renderReadOnly = () => {
      expect((editing as any)._readOnly).toBe(true);
      (editing as any).updated(new Map([['_readOnly', false]]));
    };
    (editing as any)._projectWanted = vi.fn(async () => { renderReadOnly(); return false; });
    const other = new FakeChannel('ketchup-projects');
    const answers: unknown[] = [];
    other.addEventListener('message', e => answers.push(e.data));
    other.postMessage({ type: 'release', id: 'p', ask: 'a' });
    await settle();
    expect(answers).toContainEqual({ type: 'stayed', id: 'p', asks: ['a'] });
    expect((editing as any)._readOnly).toBe(false);
    expect(canvas.dismissResizeDialog).not.toHaveBeenCalled();

    // Someone waiting this time.
    (editing as any)._projectWanted = vi.fn(async () => { renderReadOnly(); return true; });
    void locks.request('ketchup-project:p', {}, () => new Promise(() => {}));
    other.postMessage({ type: 'release', id: 'p', ask: 'b' });
    await settle();
    expect((editing as any)._readOnly).toBe(true);
    expect((editing as any)._projectLock).toBeNull();
    expect(canvas.dismissResizeDialog).toHaveBeenCalled();
  });

  it('answers an open yes/no question no as soon as a hand-over starts, and clears nothing after', async () => {
    fakeLocks();
    const { app: editing, canvas } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    let resolveQuestion: ((ok: boolean) => void) | null = null;
    const dialog = {
      show: vi.fn(() => new Promise<boolean>(r => { resolveQuestion = r; })),
      dismiss: vi.fn(() => { resolveQuestion?.(false); resolveQuestion = null; }),
    };
    Object.defineProperty(editing, '_confirmDialog', { configurable: true, value: dialog });
    const ctx = (editing as any)._buildContextValue();
    const answer = ctx.confirm({ message: 'Clear the whole drawing?' });
    let openAtFlush: boolean | null = null;
    (editing as any)._dirty = true;
    (editing as any)._flushPendingSaveAndWait = vi.fn(async () => {
      openAtFlush = resolveQuestion !== null;
      (editing as any)._dirty = false;
    });
    (editing as any)._projectWanted = vi.fn(async () => false);
    let answered: boolean | null = null;
    void answer.then((ok: boolean) => { answered = ok; });
    await (editing as any)._handOver('p', 'a');
    // Answered no before the flush that stores the document for the other tab.
    expect(openAtFlush).toBe(false);
    expect(answered).toBe(false);

    // A clear asked for while the tab can't edit (read-only, handing over,
    // replacing its document) changes nothing.
    for (const flag of ['_readOnly', '_handingOver', '_replacing']) {
      (editing as any)[flag] = true;
      ctx.clearCanvas(true);
      ctx.clearCanvas();
      (editing as any)[flag] = false;
    }
    expect(canvas.clearSelection).toHaveBeenCalledTimes(1);   // the hand-over's own commit
    expect(canvas.clearCanvas).not.toHaveBeenCalled();

    // Rendered read-only or replacing: the question is answered no as well.
    for (const flag of ['_readOnly', '_replacing']) {
      ctx.confirm({ message: '?' });
      dialog.dismiss.mockClear();
      (editing as any)[flag] = true;
      (editing as any).updated(new Map([[flag, false]]));
      (editing as any)[flag] = false;
      expect(dialog.dismiss).toHaveBeenCalled();
    }
  });

  it('taking its project back after a hand-over, answers every tab that asked meanwhile with its own tag', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    // The asking tab gave up between the check and the release.
    (editing as any)._projectWanted = vi.fn(async () => true);
    // Taking it back takes a moment, during which two tabs ask.
    const lockProject = (editing as any)._lockProject.bind(editing);
    let slow = false;
    (editing as any)._lockProject = (id: string, mode?: string) => (slow
      ? new Promise(r => setTimeout(r, 50)).then(() => lockProject(id, mode))
      : lockProject(id, mode));
    const other = new FakeChannel('ketchup-projects');
    const answers: { type: string; ask?: string }[] = [];
    other.addEventListener('message', e => answers.push(e.data));

    slow = true;
    other.postMessage({ type: 'release', id: 'p', ask: 'first' });
    await flush();
    await flush();
    other.postMessage({ type: 'release', id: 'p', ask: 'a' });
    other.postMessage({ type: 'release', id: 'p', ask: 'b' });
    await new Promise(r => setTimeout(r, 100));
    slow = false;
    await settle(20);
    const releasing = answers.filter(a => a.type === 'releasing').map(a => a.ask);
    expect(releasing).toEqual(expect.arrayContaining(['first', 'a', 'b']));
  });

  it('"Use here" gets the project from a holder whose long save ended before it saw the request', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    (editing as any)._dirty = true;
    (editing as any)._flushPendingSaveAndWait = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 3000));
      (editing as any)._dirty = false;
    });
    // The first look for the request misses it.
    const wanted = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    (editing as any)._projectWanted = wanted;

    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (shown as any)._loadProject = load;

    vi.useFakeTimers();
    const done = (shown as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(6000);
    await done;
    expect(wanted).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalled();
    expect((shown as any)._readOnly).toBe(false);
    expect((shown as any)._otherTabSilent).toBe(false);
    expect((editing as any)._projectLock).toBeNull();
  });

  it('re-asks a holder that keeps seeing no request only a few times', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    const wanted = vi.fn(async () => false);
    (editing as any)._projectWanted = wanted;
    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});

    vi.useFakeTimers();
    void (shown as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(wanted).toHaveBeenCalledTimes(4);
    expect((editing as any)._readOnly).toBe(false);
  });

  it('announces a project whose document could not be made, which carries on blank', async () => {
    fakeLocks();
    const { app } = await makeSavingApp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The fallback blank document is made; the one asked for isn't.
    (app as any)._resetToFreshProject = vi.fn()
      .mockRejectedValueOnce(new RangeError('too big'))
      .mockResolvedValue(undefined);
    const announce = vi.spyOn(app as any, '_announceProjects');
    (app as any)._buildContextValue().createProject('Big', 100000, 100000);
    await vi.waitFor(() => expect((app as any)._currentProject.name).toBe('Big'));
    await vi.waitFor(() => expect(announce).toHaveBeenCalled());
  });

  it('embedded, a project gone from storage leaves its unsaved work as a failed save, banner up', async () => {
    fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    app.embedded = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await backend.projects.delete(project.id);
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    await (app as any)._save(true);
    expect((app as any)._dirty).toBe(true);
    expect((app as any)._saveError).toBe(true);
    (app as any)._clearSaveError();
  });

  it('holds a project\'s lock through deleting it, and refuses while another tab edits it', async () => {
    const locks = fakeLocks();
    const { app, backend } = await makeSavingApp();
    const other = await backend.projects.create({ name: 'Q', thumbnailRef: null });
    let heldDuring = false;
    (app as any)._projectService = { deleteProject: vi.fn(async (id: string) => {
      heldDuring = locks.held.has(`ketchup-project:${id}`);
      await backend.projects.delete(id);
    }) };
    const release = locks.holdElsewhere(`ketchup-project:${other.id}`);
    await settle();
    (app as any)._buildContextValue().deleteProject(other.id);
    await vi.waitFor(() => expect((app as any)._notice).toMatch(/open in another tab/));
    expect(await backend.projects.get(other.id)).toBeTruthy();

    release();
    await settle();
    (app as any)._notice = '';
    (app as any)._buildContextValue().deleteProject(other.id);
    await vi.waitFor(async () => expect(await backend.projects.get(other.id)).toBeFalsy());
    expect(heldDuring).toBe(true);
    await settle();
    expect(locks.held.has(`ketchup-project:${other.id}`)).toBe(false);
  });

  it('hands a project over and back between two tabs, each loading what the other last drew', async () => {
    const locks = fakeLocks();
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const patch = (x: number) => ({ type: 'patch', layerId: 'l1', x, y: 0, before: new ImageData(1, 1), after: new ImageData(1, 1) });
    /** A tab on the shared storage, whose canvas keeps the history it is given and drawn into. */
    const tab = () => {
      const app = new DrawingApp();
      (app as any)._state = makeState({ layers: [makeLayer(20, 20, { id: 'l1' })], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
      (app as any)._backend = backend;
      Object.defineProperty(app, 'updateComplete', { configurable: true, get: () => Promise.resolve(true) });
      let history: unknown[] = [];
      let index = -1;
      const canvas = makeAppCanvasStub({
        mainCanvas: makeCanvas(40, 30),
        getHistory: vi.fn(() => [...history]),
        getHistoryIndex: vi.fn(() => index),
        setHistory: vi.fn((h: unknown[], i: number) => { history = [...h]; index = i; }),
        setViewport: vi.fn(),
      });
      Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
      const draw = (x: number) => {
        history = [...history.slice(0, index + 1), patch(x)];
        index = history.length - 1;
        (app as any)._markDirty();
      };
      const drawn = () => history.slice(0, index + 1).map(e => (e as { x: number }).x);
      return { app, draw, drawn };
    };

    const one = tab();
    await (one.app as any)._enterProject(project, () => (one.app as any)._loadProject(project.id));
    expect((one.app as any)._readOnly).toBe(false);
    one.draw(1);
    await (one.app as any)._flushPendingSaveAndWait();
    // Drawn but not stored yet when the other tab asks.
    one.draw(2);

    const two = tab();
    await (two.app as any)._enterProject(project, () => (two.app as any)._loadProject(project.id));
    expect((two.app as any)._readOnly).toBe(true);
    expect(two.drawn()).toEqual([1]);

    await (two.app as any)._editHere(true);
    expect((two.app as any)._readOnly).toBe(false);
    expect(two.drawn()).toEqual([1, 2]);
    expect((one.app as any)._readOnly).toBe(true);
    expect((one.app as any)._projectLock).toBeNull();
    expect((one.app as any)._stranded).toBe(false);
    expect((two.app as any)._otherTabSilent).toBe(false);

    // And back again, with what the second tab drew.
    two.draw(3);
    await (one.app as any)._editHere(true);
    expect((one.app as any)._readOnly).toBe(false);
    expect(one.drawn()).toEqual([1, 2, 3]);
    expect((two.app as any)._readOnly).toBe(true);
    expect((two.app as any)._projectLock).toBeNull();
    await settle();
    expect(locks.held.has(`ketchup-project:${project.id}`)).toBe(true);
    expect((one.app as any)._projectLock?.id).toBe(project.id);
    expect((await backend.history.getEntries(project.id)).map(r => (r.entry as { x: number }).x)).toEqual([1, 2, 3]);
  });

  it('on the phone, "Opening the project…" lists the other projects to open instead', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    fakeLocks();
    const { app } = makeApp();
    const backend = new MockBackend();
    app.storageBackend = backend;
    document.body.append(app);
    await app.whenReady();
    const current = (app as any)._currentProject;
    const other = await backend.projects.create({ name: 'Other', thumbnailRef: null });
    const switchProject = vi.fn();
    const build = (app as any)._buildContextValue.bind(app);
    vi.spyOn(app as any, '_buildContextValue').mockImplementation(() => ({ ...build(), switchProject }));
    const buttons = () => [...app.shadowRoot!.querySelectorAll<HTMLButtonElement>('.read-only button')];
    const texts = () => buttons().map(b => b.textContent!.trim());
    Object.assign(app as any, {
      _projectList: [current, other], _isMobile: true, _readOnly: true, _opening: true, _switching: true,
    });
    await app.updateComplete;
    expect(app.shadowRoot!.querySelector('.read-only')!.textContent).toContain('Opening the project…');
    expect(texts()).toEqual(['Open another project']);

    buttons()[0].click();
    await app.updateComplete;
    // Only the others: the one being opened isn't offered.
    expect(texts()).toEqual(['Open another project', 'Other']);
    buttons()[1].click();
    await app.updateComplete;
    expect(switchProject).toHaveBeenCalledWith(other.id);
    expect(texts()).toEqual(['Open another project']);

    // Not on the desktop layout, which has the project menu at hand.
    Object.assign(app as any, { _isMobile: false });
    await app.updateComplete;
    expect(texts()).toEqual([]);
  });
});

describe('an editor taken out of the page', () => {
  beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeChannel.open.clear();
    document.body.replaceChildren();
  });

  it('during a "Use here" wait loads nothing (its storage may be closed), lets the project go back to the tab that handed it over, and edits it on return', async () => {
    const locks = fakeLocks();
    const { app: editing } = makeApp();
    await (editing as any)._enterProject(meta('p'), async () => {});
    const editingLoad = vi.fn(async () => {});
    (editing as any)._loadProject = editingLoad;
    (editing as any)._dirty = true;
    (editing as any)._flushPendingSaveAndWait = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 3000));
      (editing as any)._dirty = false;
    });
    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    const load = vi.fn(async () => {});
    (shown as any)._loadProject = load;

    vi.useFakeTimers();
    const done = (shown as any)._editHere(true);
    await vi.advanceTimersByTimeAsync(10);
    (shown as any)._detached = true;
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    vi.useRealTimers();

    expect(load).not.toHaveBeenCalled();
    expect((shown as any)._projectLock).toBeNull();
    expect((shown as any)._readOnly).toBe(true);
    await settle();
    // Not left to no one: the tab that handed it over edits it again, as stored.
    expect(editingLoad).toHaveBeenCalledWith('p');
    expect((editing as any)._projectLock?.id).toBe('p');
    expect((editing as any)._readOnly).toBe(false);
    (editing as any)._releaseProjectLock();
    await settle();
    expect(locks.held.has('ketchup-project:p')).toBe(false);

    (shown as any)._detached = false;
    await (shown as any)._editHere(false);
    expect(load).toHaveBeenCalledWith('p');
    expect((shown as any)._projectLock?.id).toBe('p');
  });

  it('lets only a tab in view take up a project an editor out of its page let go of', async () => {
    const locks = fakeLocks();
    const release = locks.holdElsewhere('ketchup-project:p');
    const { app: shown } = makeApp();
    await (shown as any)._enterProject(meta('p'), async () => {});
    expect((shown as any)._readOnly).toBe(true);
    const load = vi.fn(async () => {});
    (shown as any)._loadProject = load;
    const sender = new FakeChannel('ketchup-projects');
    release();
    await settle();

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    sender.postMessage({ type: 'free', id: 'p' });
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect((shown as any)._projectLock).toBeNull();
    expect((shown as any)._readOnly).toBe(true);

    visibility.mockReturnValue('visible');
    sender.postMessage({ type: 'free', id: 'p' });
    await settle();
    expect(load).toHaveBeenCalledWith('p');
    expect((shown as any)._projectLock?.id).toBe('p');
  });

  it('does not take its project back after a hand-over nobody waited for', async () => {
    const locks = fakeLocks();
    const handOver = async (leave: boolean) => {
      const { app } = makeApp();
      await (app as any)._enterProject(meta('p'), async () => {});
      (app as any)._dirty = true;
      (app as any)._flushPendingSaveAndWait = vi.fn(async () => {
        (app as any)._dirty = false;
        if (leave) (app as any)._detached = true;
      });
      // Asked, but the asking tab gave up between the check and the release.
      (app as any)._projectWanted = vi.fn(async () => true);
      await (app as any)._handOver('p');
      await settle();
      return app;
    };

    const stayed = await handOver(false);
    expect((stayed as any)._projectLock?.id).toBe('p');
    expect((stayed as any)._readOnly).toBe(false);
    (stayed as any)._releaseProjectLock();
    await settle();

    const left = await handOver(true);
    expect((left as any)._projectLock).toBeNull();
    expect(locks.held.has('ketchup-project:p')).toBe(false);
  });
});

describe('a newer build', () => {
  let hidden = false;
  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeChannel.open.clear();
    document.body.replaceChildren();
    delete (document as any).hidden;
  });

  it('upgrading storage in another window: stores the work, lets go of the project, saves nothing more, offers a reload', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp();
    const reload = vi.fn();
    (app as any)._reload = reload;
    const save = vi.spyOn(backend.state, 'save');
    (app as any)._markDirty();

    await (app as any)._onStorageVersionChange();
    expect(save).toHaveBeenCalledTimes(1);
    expect((app as any)._dirty).toBe(false);
    expect((app as any)._storageClosed).toBe(true);
    expect((app as any)._readOnly).toBe(true);
    expect((app as any)._projectLock).toBeNull();
    await settle();
    expect(locks.held.has(`ketchup-project:${project.id}`)).toBe(false);
    // Shown, so not reloaded under the user.
    expect(reload).not.toHaveBeenCalled();

    (app as any)._markDirty('viewport');
    await (app as any)._save(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect((app as any)._saveError).toBe(false);
    // Not taken up again by coming back into view.
    await (app as any)._editHere(false);
    expect((app as any)._projectLock).toBeNull();

    hidden = true;
    (app as any)._onVisibilityChange();
    await settle();
    expect(reload).toHaveBeenCalled();
  });

  it('upgrading storage while holding work kept from a take-over: stores it as a new project first', async () => {
    const locks = fakeLocks();
    const { app, backend, project } = await makeSavingApp('Q');
    (app as any)._reload = vi.fn();
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    void locks.request(`ketchup-project:${project.id}`, { steal: true }, () => new Promise(() => {}));
    await settle();
    expect((app as any)._stranded).toBe(true);

    await (app as any)._onStorageVersionChange();
    const copy = (app as any)._currentProject;
    expect(copy.name).toBe('Q (copy)');
    expect(await backend.state.get(copy.id)).toBeTruthy();
    expect((app as any)._stranded).toBe(false);
    expect((app as any)._storageClosed).toBe(true);
    expect((app as any)._readOnly).toBe(true);
    await settle();
    // Let go for the newer build, which a reload reopens on the copy.
    expect(locks.held.has(`ketchup-project:${copy.id}`)).toBe(false);
    expect(sessionStorage.getItem('ketchup-tab-project')).toBe(copy.id);
  });

  it('upgrading storage: a real window of the app steps aside so the upgrade goes ahead', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    fakeLocks();
    const { app } = makeApp();
    (app as any)._reload = vi.fn();
    document.body.append(app);
    await app.whenReady();
    await settle();
    expect((app as any)._backend).toBeInstanceOf(IndexedDBBackend);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ketchup-projects', 6);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    expect((app as any)._storageClosed).toBe(true);
    await app.updateComplete;
    const overlay = app.shadowRoot!.querySelector('.read-only')!;
    expect(overlay.textContent).toContain('Ketchup was updated in another window');
    expect([...overlay.querySelectorAll('button')].map(b => b.textContent!.trim())).toEqual(['Reload']);
    // Back in the page, it stays closed.
    app.remove();
    document.body.append(app);
    await settle();
    expect((app as any)._readOnly).toBe(true);
    await new Promise<void>(resolve => {
      const req = indexedDB.deleteDatabase('ketchup-projects');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });

  it('upgraded while the editor was out of the page: back, it steps aside instead of loading', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const locks = fakeLocks();
    const { app } = makeApp();
    (app as any)._reload = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.append(app);
    await app.whenReady();
    await settle();
    const id = (app as any)._currentProject.id;
    app.remove();
    await vi.waitFor(() => expect((app as any)._backendClosed).toBe(true));
    // Another window, on a newer build, upgrades storage meanwhile.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ketchup-projects', 6);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();

    const load = vi.spyOn(app as any, '_loadProject');
    document.body.append(app);
    await settle(30);
    expect((app as any)._storageClosed).toBe(true);
    expect((app as any)._updateRequired).toBe(true);
    expect((app as any)._readOnly).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect((app as any)._saveError).toBe(false);
    expect((app as any)._projectLock).toBeNull();
    expect(locks.held.has(`ketchup-project:${id}`)).toBe(false);
    await app.updateComplete;
    expect(app.shadowRoot!.querySelector('.read-only')!.textContent).toContain('Ketchup was updated in another window');
    app.remove();
    await new Promise<void>(resolve => {
      const req = indexedDB.deleteDatabase('ketchup-projects');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });

  it('taking over the service worker: reloads once the page is hidden with its work stored, and offers it meanwhile', async () => {
    fakeLocks();
    const { app } = await makeSavingApp();
    const reload = vi.fn();
    (app as any)._reload = reload;
    app.updateReady();
    expect((app as any)._updateReady).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    (app as any)._markDirty();
    hidden = true;
    (app as any)._onVisibilityChange();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect((app as any)._dirty).toBe(false);
  });

  it('taking over the service worker: never reloads away a crop being set up or a dropped image\'s resize question', async () => {
    fakeLocks();
    const { app, canvas } = await makeSavingApp();
    const reload = vi.fn();
    (app as any)._reload = reload;
    const busy = canvas.hasInteractionInProgress as ReturnType<typeof vi.fn>;
    busy.mockReturnValue(true);
    app.updateReady();
    hidden = true;
    (app as any)._onVisibilityChange();
    await settle(20);
    expect(reload).not.toHaveBeenCalled();

    // Done with it: the next time the page is hidden, it reloads.
    busy.mockReturnValue(false);
    hidden = false;
    (app as any)._onVisibilityChange();
    hidden = true;
    (app as any)._onVisibilityChange();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('counts a crop being set up, a selection being dragged and an open resize question as in progress', async () => {
    const { DrawingCanvas } = await import('../src/components/drawing-canvas.ts');
    const { ResizeDialog } = await import('../src/components/resize-dialog.ts');
    const canvas = new DrawingCanvas();
    const dialog = new ResizeDialog();
    Object.defineProperty(canvas, '_resizeDialog', { configurable: true, value: dialog });
    expect(canvas.hasInteractionInProgress()).toBe(false);
    (canvas as any)._cropRectValue = { x: 0, y: 0, w: 5, h: 5 };
    expect(canvas.hasInteractionInProgress()).toBe(true);
    (canvas as any)._cropRectValue = null;
    (canvas as any)._selectionDrawing = true;
    expect(canvas.hasInteractionInProgress()).toBe(true);
    (canvas as any)._selectionDrawing = false;
    const answer = dialog.show(100, 100, 10, 10);
    expect(canvas.hasInteractionInProgress()).toBe(true);
    dialog.dismiss();
    await answer;
    expect(canvas.hasInteractionInProgress()).toBe(false);
  });

  it('taking over the service worker: never reloads away work that could not be stored', async () => {
    fakeLocks();
    const { app, backend } = await makeSavingApp();
    const reload = vi.fn();
    (app as any)._reload = reload;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(backend.state, 'save').mockRejectedValue(new Error('QuotaExceededError'));
    (app as any)._markDirty();
    hidden = true;
    app.updateReady();
    await settle(30);
    expect((app as any)._saveError).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers the reload in a notice, which reloads once the work is stored', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    fakeLocks();
    const backend = new MockBackend();
    const { app } = makeApp();
    app.storageBackend = backend;
    const reload = vi.fn();
    (app as any)._reload = reload;
    document.body.append(app);
    await app.whenReady();
    await settle();
    app.updateReady();
    await app.updateComplete;
    const notice = [...app.shadowRoot!.querySelectorAll('.notice')].find(n => n.textContent!.includes('new version'))!;
    expect(notice).toBeTruthy();
    const save = vi.spyOn(backend.state, 'save');
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    (app as any)._markDirty();
    notice.querySelector<HTMLButtonElement>('.notice-action')!.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(save).toHaveBeenCalled();

    // Dismissed, it still reloads the next time the page is hidden.
    (notice.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click();
    await app.updateComplete;
    expect([...app.shadowRoot!.querySelectorAll('.notice')].some(n => n.textContent!.includes('new version'))).toBe(false);
    reload.mockClear();
    hidden = true;
    (app as any)._onVisibilityChange();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('is not reloaded into by an embedded editor (the host owns the page)', () => {
    const { app } = makeApp();
    app.embedded = true;
    const reload = vi.fn();
    (app as any)._reload = reload;
    hidden = true;
    app.updateReady();
    expect((app as any)._updateReady).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
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
  const query = vi.fn(async () => ({ held: [...held.keys()].map(name => ({ name, clientId: 'tab', mode: 'exclusive' })), pending: [] }));
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

  it('lets a save under way when another tab takes the project land, and starts no other', async () => {
    const locks = fakeLocks();
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const { app } = makeApp();
    const layer = makeLayer(20, 20, { id: 'l1' });
    (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub({ mainCanvas: makeCanvas(40, 30) }) });
    (app as any)._backend = backend;
    await (app as any)._enterProject(project, async () => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });

    // The save waits on storage; meanwhile another tab takes the project.
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
    void locks.request(`ketchup-project:${project.id}`, { steal: true }, () => new Promise(() => {}));
    await settle();
    expect((app as any)._readOnly).toBe(true);
    expect((app as any)._stranded).toBe(true);
    resume();
    await saving;

    // The tab that took it waits for this save before loading.
    expect(write).toHaveBeenCalledTimes(1);
    expect((app as any)._stranded).toBe(false);
    (app as any)._contentVersion++;
    (app as any)._dirty = true;
    await (app as any)._save(true);
    expect(write).toHaveBeenCalledTimes(1);
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
    endSave();
    await entering;
    expect(order).toEqual(['saved', 'loaded']);
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
    expect([...root.querySelectorAll('.read-only button')].map(b => b.textContent!.trim())).toEqual(['Use here anyway']);
  });

});

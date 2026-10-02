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
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request } }));
  return { held, request, holdElsewhere };
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

  it('takes the project from a tab that does not answer', async () => {
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
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(load).toHaveBeenCalled();
    expect((app as any)._readOnly).toBe(false);
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
    expect((editing as any)._readOnly).toBe(false);
    expect((editing as any)._projectLock?.id).toBe('p');
  });

  it('stops a save under way once another tab has taken the project', async () => {
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
    (app as any)._dirty = true;
    const saving = (app as any)._save(true);
    await settle();
    void locks.request(`ketchup-project:${project.id}`, { steal: true }, () => new Promise(() => {}));
    await settle();
    resume();
    await saving;

    expect(write).not.toHaveBeenCalled();
    expect((app as any)._readOnly).toBe(true);
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

    app.remove();
    await settle();
    expect(locks.held.has(`ketchup-project:${id}`)).toBe(false);
    document.body.append(app);
    await settle();
    expect((app as any)._projectLock?.id).toBe(id);
    expect((app as any)._readOnly).toBe(false);
  });

});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { makeAppCanvasStub } from './helpers.ts';

/** Web Locks, as far as the app uses them: names held by this or another tab. */
function fakeLocks() {
  const held = new Set<string>();
  const locks = {
    held,
    request: vi.fn(async (name: string, options: LockOptions, cb: (lock: Lock | null) => unknown) => {
      if (held.has(name) && options.ifAvailable) return cb(null);
      held.add(name);
      try {
        return await cb({ name, mode: 'exclusive' } as Lock);
      } finally {
        held.delete(name);
      }
    }),
  };
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks }));
  return locks;
}

function makeApp() {
  const app = new DrawingApp();
  const canvas = makeAppCanvasStub();
  Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
  return { app, canvas };
}

const meta = (id: string) => ({ id, name: id, createdAt: 0, updatedAt: 0, thumbnailRef: null });
const flush = () => new Promise(r => setTimeout(r, 0));

describe('one tab edits a project at a time', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a project another tab is editing read-only: no edits by key, no saves', async () => {
    const locks = fakeLocks();
    locks.held.add('ketchup-project:p');
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

  it('saves and lets go when another tab asks to use the project, then only shows it', async () => {
    const locks = fakeLocks();
    const { app } = makeApp();
    await (app as any)._enterProject(meta('p'), async () => {});
    const order: string[] = [];
    (app as any)._dirty = true;
    (app as any)._flushPendingSaveAndWait = vi.fn(async () => { order.push('saved'); });

    await (app as any)._handOver('p');
    await flush();
    order.push(locks.held.has('ketchup-project:p') ? 'held' : 'let go');

    expect(order).toEqual(['saved', 'let go']);
    expect((app as any)._readOnly).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { StorageQuotaError } from '../src/storage/errors.ts';
import { makeAppCanvasStub, makeCanvas, makeLayer, makeState } from './helpers.ts';

/** A standalone app editing a stored project, whose saves really write (to a MockBackend). */
async function makeSavingApp() {
  const backend = new MockBackend();
  const app = new DrawingApp();
  app.storageBackend = backend;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub({ mainCanvas: makeCanvas(40, 30) }) });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
    cb(new Blob(['png'], { type: 'image/png' }));
  });
  document.body.append(app);
  await app.whenReady();
  (app as any)._state = makeState({
    layers: [makeLayer(20, 20, { id: 'l1' })], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20,
  });
  return { app, backend };
}

async function failingSave(app: DrawingApp, err: Error) {
  const backend = (app as any)._backend as MockBackend;
  const save = vi.spyOn(backend.state, 'save').mockRejectedValue(err);
  (app as any)._contentVersion++;
  (app as any)._dirty = true;
  await (app as any)._save(true);
  return save;
}

describe('a save that fails for want of space', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('is not retried on a timer, and the banner asks for room with a Try again button', async () => {
    const { app } = await makeSavingApp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await failingSave(app, new StorageQuotaError('full'));
    expect((app as any)._saveError).toBe(true);
    expect((app as any)._saveRetryTimer).toBeNull();
    await app.updateComplete;
    const banner = app.shadowRoot!.querySelector('.save-banner')!;
    expect(banner.textContent).toMatch(/storage is full/);
    expect(banner.textContent).toMatch(/Delete projects/);
    expect(banner.textContent).not.toMatch(/Trying again/);

    const retry = vi.spyOn(app as any, '_scheduleSave');
    banner.querySelector('button')!.click();
    expect(retry).toHaveBeenCalled();
    (app as any)._clearSaveError();
  });

  it('is tried again once another project is deleted', async () => {
    const { app, backend } = await makeSavingApp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const other = await backend.projects.create({ name: 'Q', thumbnailRef: null });
    const save = await failingSave(app, new StorageQuotaError('full'));
    // Full until the project goes (the flush before the delete fails too).
    (app as any)._projectService = { deleteProject: vi.fn(async (id: string) => {
      await backend.projects.delete(id);
      save.mockRestore();
    }) };
    const retry = vi.spyOn(app as any, '_retrySaveNow');
    (app as any)._buildContextValue().deleteProject(other.id);
    await vi.waitFor(() => expect(retry).toHaveBeenCalled());
    await vi.waitFor(() => expect((app as any)._saveError).toBe(false), { timeout: 3000 });
  });

  it('other failures still retry on a timer', async () => {
    const { app } = await makeSavingApp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await failingSave(app, new Error('busy'));
    expect((app as any)._saveError).toBe(true);
    expect((app as any)._saveRetryTimer).not.toBeNull();
    await app.updateComplete;
    expect(app.shadowRoot!.querySelector('.save-banner')!.textContent).toMatch(/Trying again/);
    (app as any)._clearSaveError();
  });
});

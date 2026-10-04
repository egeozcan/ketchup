import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';
import { StorageClosedError } from '../src/storage/errors.ts';

/** Another window opening the database at a newer version; resolves once it is open. */
function upgradeElsewhere(name: string, version: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

describe('IndexedDB backend lifecycle', () => {
  const opened: IDBDatabase[] = [];
  let backend: IndexedDBBackend;

  afterEach(async () => {
    vi.restoreAllMocks();
    await backend?.dispose();
    opened.splice(0).forEach(db => db.close());
  });

  it('calls made while storage reopens wait for it, through stores held from before', async () => {
    backend = new IndexedDBBackend({ dbName: `reopen-${Math.random()}` });
    await backend.init();
    const projects = backend.projects;
    await projects.create({ name: 'A', thumbnailRef: null });
    await backend.dispose();

    const reopen = backend.init();
    const list = projects.list();
    const saved = backend.state.save({ projectId: 'p' } as any);
    await reopen;
    expect((await list).map(p => p.name)).toEqual(['A']);
    await expect(saved).resolves.toBeUndefined();
  });

  it('fails calls on closed storage with a StorageClosedError, not a raw InvalidStateError', async () => {
    backend = new IndexedDBBackend({ dbName: `closed-${Math.random()}` });
    await backend.init();
    const { blobs, history, stamps } = backend;
    await backend.dispose();

    for (const call of [backend.projects.list(), blobs.put(new Blob(['x'])), history.getEntries('p'), stamps.list('p')]) {
      const err = await call.catch(e => e);
      expect(err).toBeInstanceOf(StorageClosedError);
      expect(err.versionChange).toBe(false);
    }
  });

  it('a connection closed under a call is a StorageClosedError too', async () => {
    backend = new IndexedDBBackend({ dbName: `raced-${Math.random()}` });
    await backend.init();
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    });
    await expect(backend.state.get('p')).rejects.toBeInstanceOf(StorageClosedError);
  });

  it('on another window\'s upgrade, lets work under way finish, then closes so the upgrade goes ahead', async () => {
    const name = `upgrade-${Math.random()}`;
    let finishWork!: () => void;
    const onVersionChange = vi.fn(() => new Promise<void>(r => { finishWork = r; }));
    backend = new IndexedDBBackend({ dbName: name, version: 5, onVersionChange });
    await backend.init();

    let upgraded = false;
    const upgrade = upgradeElsewhere(name, 6).then(db => { upgraded = true; opened.push(db); });
    await vi.waitFor(() => expect(onVersionChange).toHaveBeenCalled());
    // Still open for the work being stored.
    await backend.state.save({ projectId: 'p' } as any);
    expect(upgraded).toBe(false);

    finishWork();
    await upgrade;
    expect(upgraded).toBe(true);
    const err = await backend.state.get('p').catch(e => e);
    expect(err).toBeInstanceOf(StorageClosedError);
    expect(err.versionChange).toBe(true);
    // Never reopened by this build: the newer one may write what it can't read.
    await expect(backend.init()).rejects.toBeInstanceOf(StorageClosedError);
  });

  it('without an onVersionChange, closes at once for an upgrade', async () => {
    const name = `upgrade-now-${Math.random()}`;
    backend = new IndexedDBBackend({ dbName: name, version: 5 });
    await backend.init();
    opened.push(await upgradeElsewhere(name, 6));
    await expect(backend.projects.list()).rejects.toMatchObject({ name: 'StorageClosedError', versionChange: true });
  });

  it('never closes for an upgrade between writes that belong together', async () => {
    const name = `together-${Math.random()}`;
    backend = new IndexedDBBackend({ dbName: name, version: 5, onVersionChange: () => Promise.resolve() });
    await backend.init();
    let continueWrites!: () => void;
    const paused = new Promise<void>(r => { continueWrites = r; });
    const writes = backend.writeTogether(async () => {
      await backend.state.save({ projectId: 'p' } as any);
      await paused;
      await backend.history.replaceAll('p', []);
    });

    let upgraded = false;
    const upgrade = upgradeElsewhere(name, 6).then(db => { upgraded = true; opened.push(db); });
    await new Promise(r => setTimeout(r, 50));
    expect(upgraded).toBe(false);
    // Nothing new starts once closing.
    await expect(backend.writeTogether(async () => 1)).rejects.toMatchObject({ name: 'StorageClosedError', versionChange: true });

    continueWrites();
    await expect(writes).resolves.toBeUndefined();
    await upgrade;
    expect(upgraded).toBe(true);
  });

  it('opening storage a newer build has upgraded fails as closed for an upgrade', async () => {
    const name = `newer-${Math.random()}`;
    backend = new IndexedDBBackend({ dbName: name, version: 5 });
    await backend.init();
    await backend.dispose();
    const db = await upgradeElsewhere(name, 6);
    db.close();
    await expect(backend.init()).rejects.toMatchObject({ name: 'StorageClosedError', versionChange: true });
    await expect(backend.projects.list()).rejects.toMatchObject({ versionChange: true });
  });
});

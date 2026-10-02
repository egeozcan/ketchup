import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';

// Out of quota, a write's request succeeds and its transaction then aborts,
// with no error event.
function abortWritesAfterSuccess() {
  const put = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const req = put.apply(this, args);
    req.addEventListener('success', () => this.transaction.abort());
    return req;
  });
}

describe('IndexedDB writes that abort after their request succeeds', () => {
  let backend: IndexedDBBackend;

  afterEach(async () => {
    vi.restoreAllMocks();
    await backend.dispose();
  });

  it('fail rather than report stored data that never was, or never settle', async () => {
    backend = new IndexedDBBackend({ dbName: `abort-${Math.random()}` });
    await backend.init();
    abortWritesAfterSuccess();

    await expect(backend.blobs.put(new Blob(['x']))).rejects.toThrow();
    await expect(backend.state.save({ projectId: 'p' } as any)).rejects.toThrow();
  });
});

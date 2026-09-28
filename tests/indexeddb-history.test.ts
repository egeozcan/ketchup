import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';
import type { ProjectHistoryRecord } from '../src/storage/types.ts';

function record(projectId: string, index: number): ProjectHistoryRecord {
  return { projectId, index, entry: { type: 'rename', layerId: 'l', before: `${index}`, after: `${index}` } };
}

describe('IndexedDBHistoryStore.updateEntries', () => {
  let backend: IndexedDBBackend;

  afterEach(async () => {
    await backend.dispose();
  });

  it("deletes the given indices of one project and appends records, leaving other projects' alone", async () => {
    backend = new IndexedDBBackend({ dbName: `history-update-${Math.random()}` });
    await backend.init();
    await backend.history.replaceAll('p1', [0, 1, 2].map(i => record('p1', i)));
    await backend.history.replaceAll('p2', [0, 1].map(i => record('p2', i)));
    // A record read back from storage carries its auto-increment id; adding it
    // again must not collide with the stored one.
    const [stored] = await backend.history.getEntries('p1');

    await backend.history.updateEntries!('p1', [0, 2], [{ ...stored, index: 3 }]);

    expect((await backend.history.getEntries('p1')).map(r => r.index)).toEqual([1, 3]);
    expect((await backend.history.getEntries('p2')).map(r => r.index)).toEqual([0, 1]);
  });
});

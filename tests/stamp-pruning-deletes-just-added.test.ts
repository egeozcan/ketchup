import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProjectService } from '../src/storage/project-service.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import type { StampEntry } from '../src/storage/types.ts';

/**
 * Bug: ProjectService.addStamp() can delete the stamp it just added
 * when pruning old stamps to stay within the maxStampsPerProject limit.
 *
 * Root cause: src/storage/project-service.ts, addStamp()
 *   After adding a stamp, the method lists ALL stamps for the project
 *   (including the one just added), sorts them oldest-first by createdAt,
 *   and deletes the first N to stay at the limit.
 *
 *   The problem: there is NO guard preventing the just-added entry from
 *   being included in the deletion candidates. If the newly added stamp
 *   has the same (or lower) `createdAt` as existing stamps — which can
 *   happen when Date.now() hasn't advanced (same millisecond) or when
 *   the sort is unstable on equal keys — the new stamp lands in the
 *   deletion slice and is immediately deleted from the store.
 *
 *   addStamp() then returns a StampEntry whose record no longer exists.
 *   The caller (tool-settings _uploadStamp) tries to load its blob URL
 *   and select it, producing a blank stamp preview / error.
 *
 *   Even with a stable sort, this is a latent correctness issue: the
 *   code does not structurally guarantee the new stamp survives pruning.
 *   It relies on Date.now() returning a strictly greater value than all
 *   existing stamps, which is not guaranteed (clock adjustments, same-ms
 *   additions, cross-tab races on shared IndexedDB).
 *
 * Fix: filter out the just-added entry by id before deleting:
 *
 *     const toDelete = all
 *       .sort((a, b) => a.createdAt - b.createdAt)
 *       .filter(s => s.id !== entry.id)              // protect the new entry
 *       .slice(0, all.length - this._maxStamps);
 *
 * Impact: under rapid stamp uploads or clock skew, the newly uploaded
 * stamp silently disappears and its blob is leaked.
 */
describe('ProjectService.addStamp pruning must not delete the just-added stamp', () => {
  let backend: MockBackend;
  let service: ProjectService;
  const PROJECT_ID = 'test-project';

  beforeEach(async () => {
    backend = new MockBackend();
    await backend.init();
    service = new ProjectService(backend, { maxStampsPerProject: 3 });
    await backend.projects.create({ name: 'Test', thumbnailRef: null });
  });

  it('should not delete the just-added stamp when it has an older createdAt than existing stamps', async () => {
    // Add 3 stamps with increasing timestamps so they fill the limit
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(3000)   // stamp 1
      .mockReturnValueOnce(4000)   // stamp 2
      .mockReturnValueOnce(5000);  // stamp 3

    await service.addStamp(PROJECT_ID, new Blob(['a']));
    await service.addStamp(PROJECT_ID, new Blob(['b']));
    await service.addStamp(PROJECT_ID, new Blob(['c']));

    // Now add a 4th stamp that has an OLDER createdAt than all existing stamps.
    // This simulates a clock adjustment or cross-tab race where Date.now()
    // returns a value earlier than existing stamps.
    vi.spyOn(Date, 'now').mockReturnValue(1000); // older than all existing!

    const newEntry = await service.addStamp(PROJECT_ID, new Blob(['d']));

    // The just-added stamp must survive, even though its createdAt (1000)
    // makes it the "oldest" stamp by timestamp.
    const remaining = await backend.stamps.list(PROJECT_ID);
    const survivedIds = remaining.map(s => s.id);

    expect(survivedIds).toContain(newEntry.id);
  });
});

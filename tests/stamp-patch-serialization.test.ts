import { describe, expect, it } from 'vitest';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { deserializeHistoryEntry, serializeHistoryEntry } from '../src/utils/storage-serialization.ts';

describe('stamp patch history persistence', () => {
  it('round-trips bounded patch coordinates and dimensions', async () => {
    const backend = new MockBackend();
    await backend.init();
    const before = new ImageData(4, 3);
    const after = new ImageData(4, 3);
    after.data[3] = 255;

    const serialized = await serializeHistoryEntry({
      type: 'patch', layerId: 'layer-1', x: 12, y: 18, before, after,
    }, backend.blobs);
    const restored = await deserializeHistoryEntry(serialized, backend.blobs);

    expect(restored).toMatchObject({ type: 'patch', layerId: 'layer-1', x: 12, y: 18 });
    if (restored.type !== 'patch') throw new Error('Expected patch history');
    expect(restored.before.width).toBe(4);
    expect(restored.before.height).toBe(3);
    expect(restored.after.width).toBe(4);
    expect(restored.after.height).toBe(3);
  });
});

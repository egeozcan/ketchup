// src/storage/project-service.ts
import type {
  BlobRef,
  StorageBackend,
  StampEntry,
  SerializedHistoryEntry,
  ProjectHistoryRecord,
  ProjectServiceOptions,
} from './types.js';

const DEFAULT_MAX_STAMPS = 20;

export class ProjectService {
  private _maxStamps: number;

  constructor(
    private _storage: StorageBackend,
    opts?: ProjectServiceOptions,
  ) {
    this._maxStamps = opts?.maxStampsPerProject ?? DEFAULT_MAX_STAMPS;
  }

  get storage(): StorageBackend {
    return this._storage;
  }

  async deleteProject(projectId: string): Promise<void> {
    // Deterministic blob cleanup: collect all blob refs BEFORE deleting records
    // so we know exactly which blobs to remove. This eliminates the cross-tab
    // race inherent in mark-and-sweep GC on the delete path.
    const blobRefs = new Set<BlobRef>();

    const [state, history, stamps, project] = await Promise.all([
      this._storage.state.get(projectId).catch(() => null),
      this._storage.history.getEntries(projectId).catch(() => [] as ProjectHistoryRecord[]),
      this._storage.stamps.list(projectId).catch(() => [] as StampEntry[]),
      this._storage.projects.get(projectId).catch(() => null),
    ]);

    if (project?.thumbnailRef) blobRefs.add(project.thumbnailRef);
    state?.layers.forEach((l) => blobRefs.add(l.imageBlobRef));
    for (const h of history) collectBlobRefsFromEntry(h.entry, blobRefs);
    stamps.forEach((s) => blobRefs.add(s.blobRef));

    // Delete root record first — prevents "zombie" projects on partial failure.
    await this._storage.projects.delete(projectId);

    // Best-effort domain record cleanup.
    await Promise.all([
      this._storage.state.delete(projectId),
      this._storage.history.deleteForProject(projectId),
      this._storage.stamps.deleteForProject(projectId),
    ]).catch((e) => console.error('Cascade delete partial failure:', e));

    // Best-effort blob cleanup — deterministic, no GC sweep needed.
    if (blobRefs.size > 0) {
      this._storage.blobs.deleteMany([...blobRefs]).catch(() => {});
    }
  }

  async addStamp(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
    const entry = await this._storage.stamps.add(projectId, data);
    const all = await this._storage.stamps.list(projectId);
    if (all.length > this._maxStamps) {
      const toDelete = all
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, all.length - this._maxStamps);
      for (const old of toDelete) {
        await this._storage.stamps.delete(old.id);
      }
    }
    return entry;
  }

  /**
   * Mark-and-sweep blob GC. Processes projects sequentially to avoid OOM.
   */
  async collectGarbage(): Promise<number> {
    if (!this._storage.blobs.gc) return 0;

    const projects = await this._storage.projects.list();
    const activeRefs = new Set<BlobRef>();

    for (const p of projects) {
      const [state, history, stamps] = await Promise.all([
        this._storage.state.get(p.id),
        this._storage.history.getEntries(p.id),
        this._storage.stamps.list(p.id),
      ]);
      if (p.thumbnailRef) activeRefs.add(p.thumbnailRef);
      state?.layers.forEach((l) => activeRefs.add(l.imageBlobRef));
      history.forEach((h) => collectBlobRefsFromEntry(h.entry, activeRefs));
      stamps.forEach((s) => activeRefs.add(s.blobRef));

      // Yield to main thread between projects
      await new Promise((r) => setTimeout(r, 0));
    }

    return this._storage.blobs.gc(activeRefs);
  }
}

export function collectBlobRefsFromEntry(
  entry: SerializedHistoryEntry,
  refs: Set<BlobRef>,
): void {
  switch (entry.type) {
    case 'draw':
      refs.add(entry.before.blobRef);
      refs.add(entry.after.blobRef);
      break;
    case 'add-layer':
    case 'delete-layer':
      refs.add(entry.layer.imageData.blobRef);
      break;
    case 'crop':
      for (const l of entry.beforeLayers) refs.add(l.imageData.blobRef);
      for (const l of entry.afterLayers) refs.add(l.imageData.blobRef);
      break;
    // reorder, visibility, opacity, rename — no blobs
  }
}

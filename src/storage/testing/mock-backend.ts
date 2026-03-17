// src/storage/testing/mock-backend.ts
import type {
  StorageBackend,
  ProjectStore,
  ProjectStateStore,
  ProjectHistoryStore,
  StampStore,
  BlobStore,
  BlobRef,
  ProjectMeta,
  ProjectStateRecord,
  ProjectHistoryRecord,
  StampEntry,
} from '../types.js';
import { createBlobRef } from '../types.js';
import { StorageNotFoundError } from '../errors.js';

let counter = 0;
function mockUUID(): string {
  return `mock-${++counter}`;
}
function resetCounter(): void {
  counter = 0;
}

class MockBlobStore implements BlobStore {
  private _blobs = new Map<string, Blob>();

  async put(data: Blob | ArrayBuffer): Promise<BlobRef> {
    const ref = createBlobRef(mockUUID());
    this._blobs.set(ref, data instanceof Blob ? data : new Blob([data]));
    return ref;
  }

  async get(ref: BlobRef): Promise<Blob> {
    const blob = this._blobs.get(ref);
    if (!blob) throw new StorageNotFoundError(`Blob ${ref} not found`);
    return blob;
  }

  async delete(ref: BlobRef): Promise<void> {
    this._blobs.delete(ref);
  }

  async deleteMany(refs: BlobRef[]): Promise<void> {
    for (const ref of refs) this._blobs.delete(ref);
  }

  async gc(activeRefs: Set<BlobRef>): Promise<number> {
    let deleted = 0;
    for (const key of [...this._blobs.keys()]) {
      if (!activeRefs.has(key as BlobRef)) {
        this._blobs.delete(key);
        deleted++;
      }
    }
    return deleted;
  }
}

class MockProjectStore implements ProjectStore {
  private _projects = new Map<string, ProjectMeta>();

  async list(opts?: { orderBy?: 'updatedAt' | 'createdAt'; direction?: 'asc' | 'desc' }): Promise<ProjectMeta[]> {
    const all = Array.from(this._projects.values());
    const field = opts?.orderBy ?? 'updatedAt';
    const dir = opts?.direction === 'asc' ? 1 : -1;
    all.sort((a, b) => dir * (a[field] - b[field]));
    return all;
  }

  async get(id: string): Promise<ProjectMeta | null> {
    return this._projects.get(id) ?? null;
  }

  async create(meta: Omit<ProjectMeta, 'id' | 'createdAt' | 'updatedAt'> & { thumbnailRef?: BlobRef | null }): Promise<ProjectMeta> {
    const now = Date.now();
    const record: ProjectMeta = {
      id: mockUUID(),
      name: meta.name,
      createdAt: now,
      updatedAt: now,
      thumbnailRef: meta.thumbnailRef ?? null,
    };
    this._projects.set(record.id, record);
    return record;
  }

  async update(id: string, changes: Partial<Pick<ProjectMeta, 'name' | 'thumbnailRef'>>): Promise<ProjectMeta> {
    const meta = this._projects.get(id);
    if (!meta) throw new StorageNotFoundError(`Project ${id}`);
    if (changes.name !== undefined) meta.name = changes.name;
    if (changes.thumbnailRef !== undefined) meta.thumbnailRef = changes.thumbnailRef;
    meta.updatedAt = Date.now();
    return meta;
  }

  async delete(id: string): Promise<void> {
    this._projects.delete(id);
  }
}

class MockStateStore implements ProjectStateStore {
  private _states = new Map<string, ProjectStateRecord>();

  async get(projectId: string): Promise<ProjectStateRecord | null> {
    return this._states.get(projectId) ?? null;
  }
  async save(record: ProjectStateRecord): Promise<void> {
    this._states.set(record.projectId, record);
  }
  async delete(projectId: string): Promise<void> {
    this._states.delete(projectId);
  }
}

class MockHistoryStore implements ProjectHistoryStore {
  private _entries = new Map<string, ProjectHistoryRecord[]>();

  async getEntries(projectId: string): Promise<ProjectHistoryRecord[]> {
    return [...(this._entries.get(projectId) ?? [])].sort((a, b) => a.index - b.index);
  }
  async putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    const existing = this._entries.get(projectId) ?? [];
    this._entries.set(projectId, [...existing, ...entries]);
  }
  async replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void> {
    this._entries.set(projectId, [...entries]);
  }
  async deleteForProject(projectId: string): Promise<void> {
    this._entries.delete(projectId);
  }
}

class MockStampStore implements StampStore {
  private _stamps = new Map<string, StampEntry>();
  constructor(private _blobs: BlobStore) {}

  async list(projectId: string): Promise<StampEntry[]> {
    return Array.from(this._stamps.values())
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry> {
    const blobRef = await this._blobs.put(data);
    const entry: StampEntry = { id: mockUUID(), projectId, blobRef, createdAt: Date.now() };
    this._stamps.set(entry.id, entry);
    return entry;
  }
  async delete(id: string): Promise<void> {
    this._stamps.delete(id);
  }
  async deleteForProject(projectId: string): Promise<void> {
    const blobRefs: BlobRef[] = [];
    for (const [id, s] of this._stamps) {
      if (s.projectId === projectId) {
        blobRefs.push(s.blobRef);
        this._stamps.delete(id);
      }
    }
    if (blobRefs.length > 0) {
      this._blobs.deleteMany(blobRefs).catch(() => {});
    }
  }
}

export class MockBackend implements StorageBackend {
  readonly blobs: BlobStore;
  readonly projects: ProjectStore;
  readonly state: ProjectStateStore;
  readonly history: ProjectHistoryStore;
  readonly stamps: StampStore;

  constructor() {
    resetCounter();
    this.blobs = new MockBlobStore();
    this.projects = new MockProjectStore();
    this.state = new MockStateStore();
    this.history = new MockHistoryStore();
    this.stamps = new MockStampStore(this.blobs);
  }

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}
}

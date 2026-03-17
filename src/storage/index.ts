// src/storage/index.ts

// Types (zero runtime)
export type {
  BlobRef,
  ToolSettings,
  SerializedImageData,
  SerializedLayerSnapshot,
  SerializedHistoryEntry,
  SerializedLayer,
  ProjectMeta,
  ProjectStateRecord,
  ProjectHistoryRecord,
  StampEntry,
  BlobStore,
  ProjectStore,
  ProjectStateStore,
  ProjectHistoryStore,
  StampStore,
  StorageBackend,
  ProjectServiceOptions,
} from './types.js';

export { createBlobRef } from './types.js';

// Errors (runtime)
export {
  StorageError,
  StorageNotFoundError,
  StorageQuotaError,
  StorageNetworkError,
  StorageConflictError,
  StorageNotSupportedError,
} from './errors.js';

// Service
export { ProjectService, collectBlobRefsFromEntry } from './project-service.js';

// Context
export { storageBackendContext, projectServiceContext } from './storage-context.js';

// Default adapter
export { IndexedDBBackend } from './indexeddb/index.js';
export type { IndexedDBBackendOptions } from './indexeddb/index.js';

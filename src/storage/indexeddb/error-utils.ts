// src/storage/indexeddb/error-utils.ts
import {
  StorageError,
  StorageQuotaError,
  StorageNotFoundError,
  StorageConflictError,
} from '../errors.js';

/** Maps a native DOMException to the appropriate StorageError subclass. */
export function mapDOMException(e: unknown): StorageError {
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'QuotaExceededError':
        return new StorageQuotaError(e.message, e);
      case 'NotFoundError':
        return new StorageNotFoundError(e.message, e);
      case 'ConstraintError':
        return new StorageConflictError(e.message, e);
      default:
        return new StorageError(e.message, e);
    }
  }
  if (e instanceof Error) return new StorageError(e.message, e);
  return new StorageError(String(e));
}

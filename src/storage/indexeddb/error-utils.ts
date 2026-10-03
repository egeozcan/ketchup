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

/** The error an aborted transaction reports (a quota abort fires no error event). */
export function txAbortError(tx: IDBTransaction): StorageError {
  return mapDOMException(tx.error ?? new DOMException('The transaction was aborted', 'AbortError'));
}

/**
 * The error a failed request inside a transaction reports: the request's own
 * (which carries a quota failure), else the transaction's.
 */
export function txRequestError(e: Event, tx: IDBTransaction): StorageError {
  return mapDOMException((e.target as IDBRequest | null)?.error ?? tx.error);
}

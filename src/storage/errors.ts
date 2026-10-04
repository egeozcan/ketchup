// src/storage/errors.ts

export class StorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

export class StorageNotFoundError extends StorageError {
  override name = 'StorageNotFoundError';
}

export class StorageQuotaError extends StorageError {
  override name = 'StorageQuotaError';
}

export class StorageNetworkError extends StorageError {
  override name = 'StorageNetworkError';
}

export class StorageConflictError extends StorageError {
  override name = 'StorageConflictError';
}

export class StorageNotSupportedError extends StorageError {
  override name = 'StorageNotSupportedError';
}

/**
 * Storage isn't open: the editor closed it (it left the page), or another
 * window is upgrading the database to a newer version (`versionChange`), which
 * only a reload of this window can use.
 */
export class StorageClosedError extends StorageError {
  override name = 'StorageClosedError';
  constructor(message: string, public readonly versionChange = false, cause?: unknown) {
    super(message, cause);
  }
}

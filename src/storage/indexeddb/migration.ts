// src/storage/indexeddb/migration.ts

/**
 * Generate a UUID v4 string. Uses crypto.randomUUID() in secure contexts,
 * falls back to crypto.getRandomValues() otherwise.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Runs inside onupgradeneeded when upgrading from v3 to v4.
 * Extracts inline Blobs into the new 'blobs' store, replacing with BlobRef strings.
 *
 * CRITICAL: Uses cursors (not getAll) to avoid OOM. Uses raw IDB callbacks to keep transaction alive.
 */
export function migrateV3toV4(
  db: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
): void {
  const blobStore = db.createObjectStore('blobs');

  // On fresh install (oldVersion === 0), stores are empty — nothing to migrate.
  if (oldVersion < 1) return;

  function migrateImageData(imgData: any): boolean {
    if (imgData?.blob) {
      const ref = generateUUID();
      blobStore.put(imgData.blob, ref);
      imgData.blobRef = ref;
      delete imgData.blob;
      return true;
    }
    return false;
  }

  function migrateSnapshot(snapshot: any): boolean {
    return migrateImageData(snapshot?.imageData);
  }

  // --- 1. Migrate projects (thumbnail → thumbnailRef) ---
  const projStore = transaction.objectStore('projects');
  const projReq = projStore.openCursor();
  projReq.onsuccess = function () {
    const cursor = projReq.result;
    if (!cursor) return;
    const record = cursor.value;
    if (record.thumbnail) {
      const ref = generateUUID();
      blobStore.put(record.thumbnail, ref);
      record.thumbnailRef = ref;
      delete record.thumbnail;
      cursor.update(record);
    }
    cursor.continue();
  };

  // --- 2. Migrate project-state (layer imageBlob → imageBlobRef) ---
  const stateStore = transaction.objectStore('project-state');
  const stateReq = stateStore.openCursor();
  stateReq.onsuccess = function () {
    const cursor = stateReq.result;
    if (!cursor) return;
    const record = cursor.value;
    let updated = false;
    for (const layer of record.layers ?? []) {
      if (layer.imageBlob) {
        const ref = generateUUID();
        blobStore.put(layer.imageBlob, ref);
        layer.imageBlobRef = ref;
        delete layer.imageBlob;
        updated = true;
      }
    }
    if (updated) cursor.update(record);
    cursor.continue();
  };

  // --- 3. Migrate project-history ---
  const histStore = transaction.objectStore('project-history');
  const histReq = histStore.openCursor();
  histReq.onsuccess = function () {
    const cursor = histReq.result;
    if (!cursor) return;
    const record = cursor.value;
    const entry = record.entry;
    let updated = false;

    switch (entry?.type) {
      case 'draw':
        if (migrateImageData(entry.before)) updated = true;
        if (migrateImageData(entry.after)) updated = true;
        break;
      case 'add-layer':
      case 'delete-layer':
        if (migrateSnapshot(entry.layer)) updated = true;
        break;
      case 'crop':
        for (const l of entry.beforeLayers ?? []) if (migrateSnapshot(l)) updated = true;
        for (const l of entry.afterLayers ?? []) if (migrateSnapshot(l)) updated = true;
        break;
    }

    if (updated) cursor.update(record);
    cursor.continue();
  };

  // --- 4. Migrate project-stamps (blob → blobRef) ---
  const stampStore = transaction.objectStore('project-stamps');
  const stampReq = stampStore.openCursor();
  stampReq.onsuccess = function () {
    const cursor = stampReq.result;
    if (!cursor) return;
    const record = cursor.value;
    if (record.blob) {
      const ref = generateUUID();
      blobStore.put(record.blob, ref);
      record.blobRef = ref;
      delete record.blob;
      cursor.update(record);
    }
    cursor.continue();
  };
}

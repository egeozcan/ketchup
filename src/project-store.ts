import type {
  ProjectMeta,
  ProjectStateRecord,
  ProjectHistoryRecord,
  SerializedLayer,
  SerializedImageData,
  SerializedHistoryEntry,
  SerializedLayerSnapshot,
  HistoryEntry,
  Layer,
  LayerSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const DB_NAME = 'ketchup-projects';
const DB_VERSION = 1;
const PROJECTS_STORE = 'projects';
const STATE_STORE = 'project-state';
const HISTORY_STORE = 'project-history';

let cachedDB: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (cachedDB) return cachedDB;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        const store = db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const store = db.createObjectStore(HISTORY_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => {
      cachedDB = req.result;
      resolve(cachedDB);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Low-level serialization helpers
// ---------------------------------------------------------------------------

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

export async function blobToCanvas(
  blob: Blob,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

export async function imageDataToBlob(imageData: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas);
}

export async function blobToImageData(
  blob: Blob,
  width: number,
  height: number,
): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

// ---------------------------------------------------------------------------
// Layer serialization
// ---------------------------------------------------------------------------

export async function serializeLayer(layer: Layer): Promise<SerializedLayer> {
  const imageBlob = await canvasToBlob(layer.canvas);
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    imageBlob,
  };
}

export async function serializeLayerFromImageData(
  meta: { id: string; name: string; visible: boolean; opacity: number },
  imageData: ImageData,
): Promise<SerializedLayer> {
  const blob = await imageDataToBlob(imageData);
  return {
    id: meta.id,
    name: meta.name,
    visible: meta.visible,
    opacity: meta.opacity,
    imageBlob: blob,
  };
}

export async function deserializeLayer(
  sl: SerializedLayer,
  width: number,
  height: number,
): Promise<Layer> {
  const canvas = await blobToCanvas(sl.imageBlob, width, height);
  return {
    id: sl.id,
    name: sl.name,
    visible: sl.visible,
    opacity: sl.opacity,
    canvas,
  };
}

// ---------------------------------------------------------------------------
// Private snapshot / ImageData serialization helpers
// ---------------------------------------------------------------------------

async function serializeImageData(id: ImageData): Promise<SerializedImageData> {
  return {
    width: id.width,
    height: id.height,
    blob: await imageDataToBlob(id),
  };
}

async function deserializeImageDataField(
  s: SerializedImageData,
): Promise<ImageData> {
  return blobToImageData(s.blob, s.width, s.height);
}

async function serializeLayerSnapshot(
  snapshot: LayerSnapshot,
): Promise<SerializedLayerSnapshot> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    visible: snapshot.visible,
    opacity: snapshot.opacity,
    imageData: await serializeImageData(snapshot.imageData),
  };
}

async function deserializeLayerSnapshot(
  s: SerializedLayerSnapshot,
): Promise<LayerSnapshot> {
  return {
    id: s.id,
    name: s.name,
    visible: s.visible,
    opacity: s.opacity,
    imageData: await deserializeImageDataField(s.imageData),
  };
}

// ---------------------------------------------------------------------------
// History entry serialization
// ---------------------------------------------------------------------------

export async function serializeHistoryEntry(
  entry: HistoryEntry,
): Promise<SerializedHistoryEntry> {
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        serializeImageData(entry.before),
        serializeImageData(entry.after),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
    }
    case 'add-layer':
      return {
        type: 'add-layer',
        layer: await serializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    case 'delete-layer':
      return {
        type: 'delete-layer',
        layer: await serializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      // These entries contain no canvas/ImageData — pass through as-is.
      return entry;
  }
}

export async function deserializeHistoryEntry(
  entry: SerializedHistoryEntry,
): Promise<HistoryEntry> {
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        deserializeImageDataField(entry.before),
        deserializeImageDataField(entry.after),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
    }
    case 'add-layer':
      return {
        type: 'add-layer',
        layer: await deserializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    case 'delete-layer':
      return {
        type: 'delete-layer',
        layer: await deserializeLayerSnapshot(entry.layer),
        index: entry.index,
      };
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      return entry;
  }
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readonly');
    const store = tx.objectStore(PROJECTS_STORE);
    const index = store.index('updatedAt');
    const entries: ProjectMeta[] = [];
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        entries.push(cursor.value as ProjectMeta);
        cursor.continue();
      } else {
        resolve(entries);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const now = Date.now();
  const meta: ProjectMeta = {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    thumbnail: null,
  };
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    tx.objectStore(PROJECTS_STORE).add(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return meta;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [PROJECTS_STORE, STATE_STORE, HISTORY_STORE],
      'readwrite',
    );
    tx.objectStore(PROJECTS_STORE).delete(id);
    tx.objectStore(STATE_STORE).delete(id);

    // Delete all history entries for this project via cursor on projectId index.
    const historyStore = tx.objectStore(HISTORY_STORE);
    const index = historyStore.index('projectId');
    const cursorReq = index.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameProject(
  id: string,
  name: string,
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    const store = tx.objectStore(PROJECTS_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const meta = getReq.result as ProjectMeta | undefined;
      if (!meta) {
        reject(new Error(`Project ${id} not found`));
        return;
      }
      meta.name = name;
      meta.updatedAt = Date.now();
      store.put(meta);
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveProjectState(
  projectId: string,
  state: ProjectStateRecord,
  historyEntries: HistoryEntry[],
  startIndex: number,
  clearExistingHistory: boolean,
  thumbnail: Blob | null,
): Promise<void> {
  const db = await openDB();

  // Serialize history entries in parallel before opening the transaction.
  const serializedEntries = await Promise.all(
    historyEntries.map(async (entry, i) => {
      const serialized = await serializeHistoryEntry(entry);
      return {
        projectId,
        index: startIndex + i,
        entry: serialized,
      } as ProjectHistoryRecord;
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [PROJECTS_STORE, STATE_STORE, HISTORY_STORE],
      'readwrite',
    );

    // Write state record.
    tx.objectStore(STATE_STORE).put(state);

    const historyStore = tx.objectStore(HISTORY_STORE);

    if (clearExistingHistory) {
      // Clear existing history entries for this project, then write new ones.
      const historyIdx = historyStore.index('projectId');
      const cursorReq = historyIdx.openCursor(IDBKeyRange.only(projectId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          // All old entries deleted — write new ones.
          for (const record of serializedEntries) {
            historyStore.add(record);
          }
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    } else if (serializedEntries.length > 0) {
      // Append new entries only.
      for (const record of serializedEntries) {
        historyStore.add(record);
      }
    }

    // Update project metadata timestamp & thumbnail.
    const projectsStore = tx.objectStore(PROJECTS_STORE);
    const getReq = projectsStore.get(projectId);
    getReq.onsuccess = () => {
      const meta = getReq.result as ProjectMeta | undefined;
      if (meta) {
        meta.updatedAt = Date.now();
        if (thumbnail !== null) {
          meta.thumbnail = thumbnail;
        }
        projectsStore.put(meta);
      }
    };
    getReq.onerror = () => reject(getReq.error);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProjectState(
  projectId: string,
): Promise<{
  state: ProjectStateRecord;
  history: HistoryEntry[];
  historyIndex: number;
} | null> {
  const db = await openDB();

  // Read state record.
  const state = await new Promise<ProjectStateRecord | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readonly');
      const req = tx.objectStore(STATE_STORE).get(projectId);
      req.onsuccess = () => resolve(req.result as ProjectStateRecord | undefined);
      req.onerror = () => reject(req.error);
    },
  );

  if (!state) return null;

  // Read history entries sorted by their auto-increment id (insertion order).
  const records = await new Promise<ProjectHistoryRecord[]>(
    (resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readonly');
      const store = tx.objectStore(HISTORY_STORE);
      const index = store.index('projectId');
      const entries: ProjectHistoryRecord[] = [];
      const req = index.openCursor(IDBKeyRange.only(projectId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          entries.push(cursor.value as ProjectHistoryRecord);
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
      req.onerror = () => reject(req.error);
    },
  );

  // Sort by the record index field to maintain order.
  records.sort((a, b) => a.index - b.index);

  // Deserialize all history entries in parallel.
  const history = await Promise.all(
    records.map((r) => deserializeHistoryEntry(r.entry)),
  );

  return { state, history, historyIndex: state.historyIndex ?? (history.length - 1) };
}


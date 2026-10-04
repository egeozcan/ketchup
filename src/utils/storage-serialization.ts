// src/utils/storage-serialization.ts
import type { Layer, LayerSnapshot, HistoryEntry } from '../types.js';
import type { BlendMode } from '../engine/types.js';
import type {
  BlobStore,
  SerializedLayer,
  SerializedImageData,
  SerializedLayerSnapshot,
  SerializedHistoryEntry,
} from '../storage/types.js';
import { blobToCanvas, imageDataToBlob, blobToImageData } from './canvas-helpers.js';

const MAX_STORED_DIMENSION = 16384; // the app's largest canvas side

/**
 * A stored history record that doesn't have the shape its type requires
 * (missing pixel data or blob reference, impossible size, unknown type).
 * Like a PixelDecodeError, it is corrupt data rather than a failure to read
 * storage, so loading drops the entry instead of failing.
 */
export class MalformedRecordError extends Error {
  override name = 'MalformedRecordError';
}

function malformed(what: string): never {
  throw new MalformedRecordError(`Stored history record is malformed: ${what}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function checkImageDataRecord(s: unknown): asserts s is SerializedImageData {
  if (!isObject(s)) malformed('missing pixel data');
  if (typeof s.blobRef !== 'string' || !s.blobRef) malformed('missing blob reference');
  const { width, height } = s;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      (width as number) <= 0 || (height as number) <= 0 ||
      (width as number) > MAX_STORED_DIMENSION || (height as number) > MAX_STORED_DIMENSION) {
    malformed(`invalid size ${String(width)}x${String(height)}`);
  }
}

function checkSnapshotRecord(s: unknown): asserts s is SerializedLayerSnapshot {
  if (!isObject(s)) malformed('missing layer');
  checkImageDataRecord(s.imageData);
}

function checkSnapshotList(list: unknown): asserts list is SerializedLayerSnapshot[] {
  if (!Array.isArray(list)) malformed('missing layer list');
  list.forEach(checkSnapshotRecord);
}

/** Throws MalformedRecordError unless every pixel reference the entry needs is present and sized. */
function checkHistoryRecord(entry: unknown): asserts entry is SerializedHistoryEntry {
  if (!isObject(entry)) malformed('not an object');
  switch (entry.type) {
    case 'draw':
    case 'patch':
    case 'transform':
      checkImageDataRecord(entry.before);
      checkImageDataRecord(entry.after);
      return;
    case 'add-layer':
    case 'delete-layer':
      checkSnapshotRecord(entry.layer);
      return;
    case 'crop':
    case 'merge':
      checkSnapshotList(entry.beforeLayers);
      checkSnapshotList(entry.afterLayers);
      return;
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
    case 'blend-mode':
      return;
    default:
      malformed(`unknown type ${String(entry.type)}`);
  }
}

// ---------------------------------------------------------------------------
// ImageData ↔ SerializedImageData
// ---------------------------------------------------------------------------

async function serializeImageData(data: ImageData, blobs: BlobStore): Promise<SerializedImageData> {
  const blob = await imageDataToBlob(data);
  const blobRef = await blobs.put(blob);
  return { width: data.width, height: data.height, blobRef };
}

async function deserializeImageData(s: SerializedImageData, blobs: BlobStore): Promise<ImageData> {
  const blob = await blobs.get(s.blobRef);
  return blobToImageData(blob, s.width, s.height);
}

// ---------------------------------------------------------------------------
// LayerSnapshot ↔ SerializedLayerSnapshot
// ---------------------------------------------------------------------------

async function serializeSnapshot(snapshot: LayerSnapshot, blobs: BlobStore): Promise<SerializedLayerSnapshot> {
  return {
    id: snapshot.id,
    name: snapshot.name,
    visible: snapshot.visible,
    opacity: snapshot.opacity,
    blendMode: snapshot.blendMode,
    imageData: await serializeImageData(snapshot.imageData, blobs),
  };
}

async function deserializeSnapshot(s: SerializedLayerSnapshot, blobs: BlobStore): Promise<LayerSnapshot> {
  return {
    id: s.id,
    name: s.name,
    visible: s.visible,
    opacity: s.opacity,
    blendMode: (s.blendMode as BlendMode) ?? 'normal',
    imageData: await deserializeImageData(s.imageData, blobs),
  };
}

// ---------------------------------------------------------------------------
// Layer ↔ SerializedLayer
// ---------------------------------------------------------------------------

export async function serializeLayerFromImageData(
  meta: { id: string; name: string; visible: boolean; opacity: number; blendMode?: string },
  imageData: ImageData,
  blobs: BlobStore,
): Promise<SerializedLayer> {
  const blob = await imageDataToBlob(imageData);
  const imageBlobRef = await blobs.put(blob);
  return { id: meta.id, name: meta.name, visible: meta.visible, opacity: meta.opacity, blendMode: meta.blendMode ?? 'normal', imageBlobRef };
}

export async function deserializeLayer(
  sl: SerializedLayer,
  width: number,
  height: number,
  blobs: BlobStore,
): Promise<Layer> {
  const blob = await blobs.get(sl.imageBlobRef);
  const canvas = await blobToCanvas(blob, width, height);
  return { id: sl.id, name: sl.name, visible: sl.visible, opacity: sl.opacity, blendMode: (sl.blendMode as BlendMode) ?? 'normal', canvas };
}

// ---------------------------------------------------------------------------
// HistoryEntry ↔ SerializedHistoryEntry
// ---------------------------------------------------------------------------

export async function serializeHistoryEntry(
  entry: HistoryEntry,
  blobs: BlobStore,
): Promise<SerializedHistoryEntry> {
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        serializeImageData(entry.before, blobs),
        serializeImageData(entry.after, blobs),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
    }
    case 'patch': {
      const [before, after] = await Promise.all([
        serializeImageData(entry.before, blobs),
        serializeImageData(entry.after, blobs),
      ]);
      return { type: 'patch', layerId: entry.layerId, x: entry.x, y: entry.y, before, after };
    }
    case 'add-layer':
      return { type: 'add-layer', layer: await serializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'delete-layer':
      return { type: 'delete-layer', layer: await serializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'crop': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => serializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => serializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'crop', beforeLayers, afterLayers,
        beforeWidth: entry.beforeWidth, beforeHeight: entry.beforeHeight,
        afterWidth: entry.afterWidth, afterHeight: entry.afterHeight,
      };
    }
    case 'merge': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => serializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => serializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'merge', beforeLayers, afterLayers,
        previousActiveLayerId: entry.previousActiveLayerId,
        afterActiveLayerId: entry.afterActiveLayerId,
      };
    }
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
    case 'blend-mode':
      return entry;
    case 'transform': {
      const [before, after] = await Promise.all([
        serializeImageData(entry.before, blobs),
        serializeImageData(entry.after, blobs),
      ]);
      return { type: 'transform', layerId: entry.layerId, before, after };
    }
  }
}

export async function deserializeHistoryEntry(
  entry: SerializedHistoryEntry,
  blobs: BlobStore,
): Promise<HistoryEntry> {
  checkHistoryRecord(entry);
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        deserializeImageData(entry.before, blobs),
        deserializeImageData(entry.after, blobs),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
    }
    case 'patch': {
      const [before, after] = await Promise.all([
        deserializeImageData(entry.before, blobs),
        deserializeImageData(entry.after, blobs),
      ]);
      return { type: 'patch', layerId: entry.layerId, x: entry.x, y: entry.y, before, after };
    }
    case 'add-layer':
      return { type: 'add-layer', layer: await deserializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'delete-layer':
      return { type: 'delete-layer', layer: await deserializeSnapshot(entry.layer, blobs), index: entry.index };
    case 'crop': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => deserializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => deserializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'crop', beforeLayers, afterLayers,
        beforeWidth: entry.beforeWidth, beforeHeight: entry.beforeHeight,
        afterWidth: entry.afterWidth, afterHeight: entry.afterHeight,
      };
    }
    case 'merge': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => deserializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => deserializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'merge', beforeLayers, afterLayers,
        previousActiveLayerId: entry.previousActiveLayerId,
        afterActiveLayerId: entry.afterActiveLayerId,
      };
    }
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      return entry;
    case 'blend-mode':
      return { type: 'blend-mode', layerId: entry.layerId, before: entry.before as BlendMode, after: entry.after as BlendMode };
    case 'transform': {
      const [before, after] = await Promise.all([
        deserializeImageData(entry.before, blobs),
        deserializeImageData(entry.after, blobs),
      ]);
      return { type: 'transform', layerId: entry.layerId, before, after };
    }
  }
}

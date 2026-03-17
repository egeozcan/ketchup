// src/utils/storage-serialization.ts
import type { Layer, LayerSnapshot, HistoryEntry } from '../types.js';
import type {
  BlobStore,
  SerializedLayer,
  SerializedImageData,
  SerializedLayerSnapshot,
  SerializedHistoryEntry,
} from '../storage/types.js';
import { canvasToBlob, blobToCanvas, imageDataToBlob, blobToImageData } from './canvas-helpers.js';

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
    imageData: await serializeImageData(snapshot.imageData, blobs),
  };
}

async function deserializeSnapshot(s: SerializedLayerSnapshot, blobs: BlobStore): Promise<LayerSnapshot> {
  return {
    id: s.id,
    name: s.name,
    visible: s.visible,
    opacity: s.opacity,
    imageData: await deserializeImageData(s.imageData, blobs),
  };
}

// ---------------------------------------------------------------------------
// Layer ↔ SerializedLayer
// ---------------------------------------------------------------------------

export async function serializeLayer(layer: Layer, blobs: BlobStore): Promise<SerializedLayer> {
  const blob = await canvasToBlob(layer.canvas);
  const imageBlobRef = await blobs.put(blob);
  return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, imageBlobRef };
}

export async function serializeLayerFromImageData(
  meta: { id: string; name: string; visible: boolean; opacity: number },
  imageData: ImageData,
  blobs: BlobStore,
): Promise<SerializedLayer> {
  const blob = await imageDataToBlob(imageData);
  const imageBlobRef = await blobs.put(blob);
  return { id: meta.id, name: meta.name, visible: meta.visible, opacity: meta.opacity, imageBlobRef };
}

export async function deserializeLayer(
  sl: SerializedLayer,
  width: number,
  height: number,
  blobs: BlobStore,
): Promise<Layer> {
  const blob = await blobs.get(sl.imageBlobRef);
  const canvas = await blobToCanvas(blob, width, height);
  return { id: sl.id, name: sl.name, visible: sl.visible, opacity: sl.opacity, canvas };
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
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      return entry;
  }
}

export async function deserializeHistoryEntry(
  entry: SerializedHistoryEntry,
  blobs: BlobStore,
): Promise<HistoryEntry> {
  switch (entry.type) {
    case 'draw': {
      const [before, after] = await Promise.all([
        deserializeImageData(entry.before, blobs),
        deserializeImageData(entry.after, blobs),
      ]);
      return { type: 'draw', layerId: entry.layerId, before, after };
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
    case 'reorder':
    case 'visibility':
    case 'opacity':
    case 'rename':
      return entry;
  }
}

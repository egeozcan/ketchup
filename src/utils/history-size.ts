import type { HistoryEntry, LayerSnapshot } from '../types.js';
import type { SerializedHistoryEntry, SerializedImageData, SerializedLayerSnapshot } from '../storage/types.js';

const MB = 1024 * 1024;

/**
 * Bytes of decoded pixels the undo stack may hold. Scales with the device's
 * memory where the browser reports it (`navigator.deviceMemory`, in GB, capped
 * at 8 by the browser), otherwise assumes 4 GB.
 */
export function historyByteBudget(): number {
  const gb = (typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    : undefined) ?? 4;
  return Math.max(64 * MB, Math.round(gb * 128) * MB);
}

const snapshotBytes = (s: LayerSnapshot) => s.imageData.data.byteLength;

/** Bytes of decoded pixels a history entry holds in memory. */
export function historyEntryBytes(entry: HistoryEntry): number {
  switch (entry.type) {
    case 'draw':
    case 'patch':
    case 'transform':
      return entry.before.data.byteLength + entry.after.data.byteLength;
    case 'add-layer':
    case 'delete-layer':
      return snapshotBytes(entry.layer);
    case 'crop':
    case 'merge':
      return entry.beforeLayers.reduce((n, l) => n + snapshotBytes(l), 0)
        + entry.afterLayers.reduce((n, l) => n + snapshotBytes(l), 0);
    default:
      return 0;
  }
}

// A malformed record counts as 0 here; decoding it reports it (and drops it).
const imageBytes = (s: SerializedImageData) => {
  const n = s.width * s.height * 4;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const serializedSnapshotBytes = (s: SerializedLayerSnapshot) => imageBytes(s.imageData);

/** Bytes a stored history entry will hold once decoded, without decoding it. */
export function serializedHistoryEntryBytes(entry: SerializedHistoryEntry): number {
  try {
    return serializedBytes(entry);
  } catch {
    return 0;
  }
}

function serializedBytes(entry: SerializedHistoryEntry): number {
  switch (entry.type) {
    case 'draw':
    case 'patch':
    case 'transform':
      return imageBytes(entry.before) + imageBytes(entry.after);
    case 'add-layer':
    case 'delete-layer':
      return serializedSnapshotBytes(entry.layer);
    case 'crop':
    case 'merge':
      return entry.beforeLayers.reduce((n, l) => n + serializedSnapshotBytes(l), 0)
        + entry.afterLayers.reduce((n, l) => n + serializedSnapshotBytes(l), 0);
    default:
      return 0;
  }
}

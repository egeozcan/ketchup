import type { StorageBackend, StampEntry } from '../storage/types.js';
import { canvasToBlob } from './canvas-helpers.js';

const THUMBNAIL_EDGE = 96;
const MAX_CACHE_ENTRIES = 100;

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const versions = new Map<string, number>();

function remember(id: string, url: string): string {
  const previous = urls.get(id);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  urls.delete(id);
  urls.set(id, url);

  while (urls.size > MAX_CACHE_ENTRIES) {
    const oldest = urls.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    urls.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
  }
  return url;
}

async function createThumbnailUrl(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return URL.createObjectURL(await canvasToBlob(canvas));
  } finally {
    bitmap.close();
  }
}

/**
 * Return a small, session-cached thumbnail URL. Original stamp images are decoded
 * one at a time and immediately released, keeping the recent-stamp tray bounded.
 */
export async function getStampThumbnailUrl(
  backend: StorageBackend,
  entry: StampEntry,
): Promise<string> {
  const cached = urls.get(entry.id);
  if (cached) return remember(entry.id, cached);

  const inFlight = pending.get(entry.id);
  if (inFlight) return inFlight;

  const version = versions.get(entry.id) ?? 0;
  const promise = (async () => {
    const blob = await backend.blobs.get(entry.blobRef);
    const url = await createThumbnailUrl(blob);
    // Deletion cannot cancel image decoding, so discard a thumbnail that
    // finished after its stamp was removed instead of leaking/re-caching it.
    if ((versions.get(entry.id) ?? 0) !== version) {
      URL.revokeObjectURL(url);
      throw new Error('Stamp thumbnail was removed while loading.');
    }
    return remember(entry.id, url);
  })();
  pending.set(entry.id, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(entry.id) === promise) {
      pending.delete(entry.id);
      if (!urls.has(entry.id)) versions.delete(entry.id);
    }
  }
}

export function removeStampThumbnail(id: string): void {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
  if (pending.has(id)) {
    versions.set(id, (versions.get(id) ?? 0) + 1);
  } else {
    versions.delete(id);
  }
}

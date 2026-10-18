import { maskFromRGBA, type TipMask } from '../engine/tip-mask.js';

/** Images larger than this on the long side are drawn smaller before their pixels are read (a photo would otherwise be read at full size to make a 1024px tip). */
const MAX_READ_SIZE = 2048;

/** A tip mask from the pixels of a selection, or null when they paint nothing. */
export function maskFromImageData(image: ImageData): TipMask | null {
  return maskFromRGBA(image.data, image.width, image.height);
}

/** A tip mask from an image file (anything the browser decodes), or null when it paints nothing. Rejects when it can't be decoded. */
export async function maskFromImageFile(file: Blob): Promise<TipMask | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_READ_SIZE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return maskFromImageData(ctx.getImageData(0, 0, w, h));
  } finally {
    bitmap.close?.();
  }
}

// src/utils/image-diff.ts

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** View RGBA pixel data as one 32-bit word per pixel so comparisons run 4x fewer iterations. */
function pixelWords(img: ImageData): Uint32Array {
  return new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
}

/**
 * Smallest rectangle containing every pixel that differs between two images
 * of the same size, or null when they are identical.
 */
export function diffBounds(a: ImageData, b: ImageData): PixelRect | null {
  const w = a.width;
  const h = a.height;
  const pa = pixelWords(a);
  const pb = pixelWords(b);
  let minX = w;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w && pa[row + x] === pb[row + x]) x++;
    if (x === w) continue;
    if (minY < 0) minY = y;
    maxY = y;
    if (x < minX) minX = x;
    // Columns up to maxX are already inside the rect, so only scan past it.
    let r = w - 1;
    while (r > maxX && pa[row + r] === pb[row + r]) r--;
    if (r > maxX) maxX = r;
  }
  if (minY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Copy a sub-rectangle of `src` into a new ImageData (returns `src` itself when the rect is the whole image). */
export function cropImageData(src: ImageData, rect: PixelRect): ImageData {
  if (rect.x === 0 && rect.y === 0 && rect.w === src.width && rect.h === src.height) return src;
  const out = new ImageData(rect.w, rect.h);
  const rowBytes = rect.w * 4;
  for (let row = 0; row < rect.h; row++) {
    const start = ((rect.y + row) * src.width + rect.x) * 4;
    out.data.set(src.data.subarray(start, start + rowBytes), row * rowBytes);
  }
  return out;
}

/**
 * 64-bit content fingerprint of an image (two independent 32-bit lanes plus
 * the dimensions). Used to tell whether a layer changed since it was last
 * saved without keeping a copy of its pixels around. Every step is invertible,
 * so changing any single pixel always changes the result; the xor-shifts carry
 * high-bit (alpha) changes down into the low bits.
 */
export function hashImageData(img: ImageData): string {
  const words = pixelWords(img);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h1 ^= h1 >>> 13;
    h2 = Math.imul(h2 ^ v, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return `${img.width}x${img.height}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

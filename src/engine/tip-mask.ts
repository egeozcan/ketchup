// Sampled brush tips as 8-bit coverage masks, and the pure conversions that
// make one from pixels. A mask is what Photoshop's sampled brushes are (a
// grayscale bitmap where black paints) turned the way the engine wants it:
// 0..255 coverage per pixel, 255 painting fully.

/** An 8-bit coverage mask, row by row, `width * height` bytes. */
export interface TipMask {
  width: number;
  height: number;
  alpha: Uint8Array;
}

/** The longest side (px) a stored tip keeps; larger images are scaled down to it. */
export const MAX_TIP_SIZE = 1024;
/** The longest side (px) of the small mask kept beside each tip for lists. */
export const TIP_THUMB_SIZE = 48;
/** Coverage at or below this doesn't count when cropping to the painted area (scanner and JPEG noise on white paper). */
const CROP_THRESHOLD = 3;

/**
 * Coverage from RGBA pixels the way a sampled brush reads them: the inverse
 * of luminance, scaled by alpha, so dark marks on white paper paint and the
 * transparent parts of a PNG don't. Colour is read straight (not
 * premultiplied), as ImageData holds it.
 */
export function coverageFromRGBA(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const lum = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    out[i] = Math.round((255 - lum) * rgba[p + 3] / 255);
  }
  return out;
}

/** The mask cropped to the smallest box holding all coverage above noise; null when there is none. */
export function cropMask(mask: TipMask): TipMask | null {
  const { width, height, alpha } = mask;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] > CROP_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w === width && h === height) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(alpha.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + w), y * w);
  return { width: w, height: h, alpha: out };
}

/** The mask scaled so its longer side is at most `maxSize`, averaging the source pixels each new one covers (so thin lines keep their weight). */
export function downscaleMask(mask: TipMask, maxSize: number): TipMask {
  const long = Math.max(mask.width, mask.height);
  if (long <= maxSize) return mask;
  const scale = maxSize / long;
  const w = Math.max(1, Math.round(mask.width * scale));
  const h = Math.max(1, Math.round(mask.height * scale));
  // Horizontal pass into floats, then vertical, so each pass is a plain average over a span.
  const sx = mask.width / w, sy = mask.height / h;
  const mid = new Float32Array(w * mask.height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < w; x++) {
      mid[y * w + x] = spanAverage(mask.alpha, y * mask.width, 1, x * sx, (x + 1) * sx, mask.width);
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.round(spanAverage(mid, x, w, y * sy, (y + 1) * sy, mask.height));
    }
  }
  return { width: w, height: h, alpha: out };
}

/** The average of `data` along a line (from `base`, `stride` apart) over the fractional span [from, to), weighting edge samples by how much of them it covers. */
function spanAverage(data: ArrayLike<number>, base: number, stride: number, from: number, to: number, count: number): number {
  let sum = 0, weight = 0;
  const first = Math.floor(from);
  const last = Math.min(count - 1, Math.ceil(to) - 1);
  for (let i = first; i <= last; i++) {
    const w = Math.min(i + 1, to) - Math.max(i, from);
    if (w <= 0) continue;
    sum += data[base + i * stride] * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * A tip mask from RGBA pixels: coverage from luminance and alpha, cropped to
 * what is painted, scaled down to `MAX_TIP_SIZE`. Null when the image paints
 * nothing (all white, or all transparent).
 */
export function maskFromRGBA(rgba: ArrayLike<number>, width: number, height: number): TipMask | null {
  if (!(width > 0 && height > 0)) return null;
  const cropped = cropMask({ width, height, alpha: coverageFromRGBA(rgba, width, height) });
  return cropped && downscaleMask(cropped, MAX_TIP_SIZE);
}

/** The small copy of a mask kept for lists. */
export function thumbnailMask(mask: TipMask): TipMask {
  return downscaleMask(mask, TIP_THUMB_SIZE);
}

/** Whether a value is a Uint8Array, also one made in another realm (a stored record read back may be). */
export function isUint8Array(v: unknown): v is Uint8Array {
  return Object.prototype.toString.call(v) === '[object Uint8Array]';
}

/** Whether a stored value is a well-formed mask (sized, with exactly the bytes it needs). */
export function isTipMask(v: unknown): v is TipMask {
  const m = v as Partial<TipMask> | null;
  return !!m && Number.isInteger(m.width) && Number.isInteger(m.height) && m.width! > 0 && m.height! > 0
    && m.width! <= 8192 && m.height! <= 8192 && isUint8Array(m.alpha) && m.alpha.length === m.width! * m.height!;
}

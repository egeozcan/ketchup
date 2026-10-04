/**
 * Sizing for the on-screen canvases (the display and its preview overlay).
 * They are laid out in CSS pixels, the "view" space every caller draws and
 * hit-tests in, while their bitmaps hold one pixel per device pixel, so
 * nothing on them is upscaled by the browser. Each context gets the
 * view-to-bitmap scale as its base transform.
 */

/** Most bitmap pixels each view canvas gets (a 5K screen fits); a larger view gets a coarser bitmap. */
export const MAX_VIEW_BACKING_PIXELS = 4096 * 4096;
const MAX_VIEW_BACKING_SIDE = 16384;

interface ViewSizing { width: number; height: number; backingWidth: number; backingHeight: number }

const sizings = new WeakMap<HTMLCanvasElement, ViewSizing>();

/**
 * Bitmap size for a view of `width`×`height` CSS pixels shown at `scale`
 * device pixels per CSS pixel (devicePixelRatio, times any CSS zoom).
 * Never coarser than one bitmap pixel per CSS pixel unless the scale itself is.
 */
export function viewBackingSize(width: number, height: number, scale: number): { width: number; height: number } {
  let s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const cap = Math.min(
    Math.sqrt(MAX_VIEW_BACKING_PIXELS / Math.max(1, width * height)),
    MAX_VIEW_BACKING_SIDE / Math.max(1, width, height),
  );
  if (s > cap) s = Math.max(Math.min(s, 1), cap);
  return {
    width: Math.max(1, Math.round(width * s)),
    height: Math.max(1, Math.round(height * s)),
  };
}

/**
 * Lays `canvas` out at `width`×`height` CSS pixels with a bitmap `scale`
 * times as fine (see viewBackingSize), and sets its context's base
 * transform so drawing is in CSS pixels. Clears it, as any resize does.
 */
export function sizeViewCanvas(canvas: HTMLCanvasElement, width: number, height: number, scale: number): void {
  const backing = viewBackingSize(width, height, scale);
  canvas.width = backing.width;
  canvas.height = backing.height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  sizings.set(canvas, { width, height, backingWidth: backing.width, backingHeight: backing.height });
  canvas.getContext('2d')?.setTransform(backing.width / width, 0, 0, backing.height / height, 0, 0);
}

/**
 * The CSS size `canvas` was laid out at by sizeViewCanvas. A canvas sized
 * any other way (or resized since) is taken to be one bitmap pixel per CSS pixel.
 */
export function viewCanvasSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const s = sizings.get(canvas);
  if (s && s.backingWidth === canvas.width && s.backingHeight === canvas.height) {
    return { width: s.width, height: s.height };
  }
  return { width: canvas.width, height: canvas.height };
}

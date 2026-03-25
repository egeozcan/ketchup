/**
 * Creates an offscreen canvas, preferring OffscreenCanvas when available.
 * Falls back to document.createElement('canvas') for older browsers.
 */
export function createOffscreenCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Get a 2D context from either canvas type. */
export function get2dContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  return canvas.getContext('2d', options)! as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Type-safe drawImage that accepts both HTMLCanvasElement and OffscreenCanvas. */
export function drawImageSafe(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: AnyCanvas,
  dx: number,
  dy: number,
  dw?: number,
  dh?: number,
) {
  if (dw !== undefined && dh !== undefined) {
    ctx.drawImage(source as HTMLCanvasElement, dx, dy, dw, dh);
  } else {
    ctx.drawImage(source as HTMLCanvasElement, dx, dy);
  }
}

/** Tint an alpha-mask canvas with a solid color using source-in compositing. */
export function tintAlphaMask(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  color: string,
  width: number,
  height: number,
) {
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
}

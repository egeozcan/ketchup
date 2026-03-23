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

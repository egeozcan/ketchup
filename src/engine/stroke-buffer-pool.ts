import { createOffscreenCanvas, get2dContext, type AnyCanvas } from './canvas-pool.js';
import { blendKeepingAlpha } from './blend-math.js';
import type { BrushBlendMode } from './types.js';

type BufferCanvas = AnyCanvas;

/** A rectangle in buffer (document) pixels. */
export interface BufferRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a stroke's coverage is laid onto a layer. */
export interface StrokePaint {
  /** The stroke-level opacity, applied once to the whole stroke. */
  opacity: number;
  /** The eraser tool: always erases, whatever the mode. */
  eraser: boolean;
  mode: BrushBlendMode;
  /** The layer's transparent pixels stay as they are and its alpha is never changed. */
  alphaLocked: boolean;
}

/**
 * The canvas operation that lays a stroke onto a layer, or null when the
 * stroke must change nothing. Canvas blend modes keep the layer's alpha out
 * of the formula the way Photoshop does: over transparent pixels they paint
 * the stroke colour as is (a multiply stroke on an empty layer is just the
 * colour), over opaque ones they blend.
 *
 * Alpha lock (Photoshop's "Lock transparent pixels") keeps every pixel's
 * alpha. Behind and Clear only make sense by changing alpha, so, as in
 * Photoshop, they and the eraser do nothing on a locked layer.
 */
export function strokeCompositeOp(eraser: boolean, mode: BrushBlendMode, alphaLocked: boolean): GlobalCompositeOperation | null {
  if (eraser || mode === 'clear') return alphaLocked ? null : 'destination-out';
  if (mode === 'behind') return alphaLocked ? null : 'destination-over';
  if (mode === 'normal') return alphaLocked ? 'source-atop' : 'source-over';
  return mode;
}

/** Whether a stroke is blended in memory, pixel by pixel (see paintStroke), rather than by a canvas draw. */
export function blendsInMemory(paint: Pick<StrokePaint, 'eraser' | 'mode' | 'alphaLocked'>): boolean {
  const op = strokeCompositeOp(paint.eraser, paint.mode, paint.alphaLocked);
  return paint.alphaLocked && op !== null && op !== 'source-atop';
}

/**
 * Lay `source` (a canvas holding the stroke's coverage, already tinted)
 * onto `target` inside `bounds`, as a commit does. The live preview calls
 * this too, on a copy of the layer, so both show the same pixels.
 *
 * On an alpha-locked layer a plain stroke is source-atop, which is exact. A
 * blend mode cannot be combined with source-atop in one draw, and a canvas
 * blend would weigh the stroke's own colour into semi-transparent pixels
 * (white Multiply over half-transparent black turns it grey), so that case
 * blends the region pixel by pixel (blend-math.ts) and writes back only the
 * colour. It reads the region back, so it costs more than a draw: acceptable
 * for a locked layer with a mode, and only the stroke's bounds are touched.
 */
export function paintStroke(target: CanvasRenderingContext2D, source: AnyCanvas, bounds: BufferRect, paint: StrokePaint) {
  const op = strokeCompositeOp(paint.eraser, paint.mode, paint.alphaLocked);
  if (!op) return;
  const { x, y, w, h } = bounds;
  const src = source as HTMLCanvasElement;
  if (blendsInMemory(paint)) {
    const dst = target.getImageData(x, y, w, h);
    blendKeepingAlpha(dst, get2dContext(source).getImageData(x, y, w, h), paint.opacity, paint.mode);
    target.putImageData(dst, x, y);
    return;
  }
  target.save();
  target.globalAlpha = paint.opacity;
  target.globalCompositeOperation = op;
  target.drawImage(src, x, y, w, h, x, y, w, h);
  target.restore();
}

/**
 * Singleton pool managing one reusable stroke buffer canvas.
 * Never shrinks — only grows when the document exceeds the current size.
 * Zero allocation during painting.
 */
export class StrokeBufferPool {
  private _canvas: BufferCanvas | null = null;
  private _width = 0;
  private _height = 0;

  /**
   * Acquire the buffer for a new stroke. Resizes if needed, then clears
   * `stale` — the region the previous stroke wrote, or null when it wrote
   * nothing — so a short stroke on a large document does not pay for a
   * full-buffer clear.
   */
  acquire(docWidth: number, docHeight: number, stale: BufferRect | null): BufferCanvas {
    if (!this._canvas || docWidth > this._width || docHeight > this._height) {
      this._width = Math.max(this._width, docWidth);
      this._height = Math.max(this._height, docHeight);
      this._canvas = createOffscreenCanvas(this._width, this._height);
      return this._canvas;
    }
    if (stale) get2dContext(this._canvas).clearRect(stale.x, stale.y, stale.w, stale.h);
    return this._canvas;
  }

  /**
   * Tint and composite the buffer onto the target layer. Only `bounds` — the
   * region the stroke wrote — is processed; the buffer is transparent
   * everywhere else, so the result is the same as a full-buffer pass.
   */
  commit(
    target: CanvasRenderingContext2D,
    color: string,
    strokeOpacity: number,
    eraser: boolean,
    bounds: BufferRect | null,
    colorMode = false,
    mode: BrushBlendMode = 'normal',
    alphaLocked = false,
  ) {
    if (!this._canvas || !bounds) return;
    const { x, y, w, h } = bounds;

    if (!eraser && !colorMode) {
      // Alpha-mask mode: tint the stroke's region before compositing. The
      // clip keeps source-in from touching (clearing) the rest of the buffer.
      const ctx = get2dContext(this._canvas);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
    // Eraser removes the stroke's coverage; color mode's buffer already holds
    // tinted RGBA, as does the alpha mask once tinted above.
    paintStroke(target, this._canvas, bounds, { opacity: strokeOpacity, eraser, mode, alphaLocked });
  }

  /** Get the current buffer canvas (for stamping onto during a stroke). */
  get current(): BufferCanvas | null {
    return this._canvas;
  }
}

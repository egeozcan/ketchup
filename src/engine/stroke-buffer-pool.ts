import { createOffscreenCanvas, get2dContext, type AnyCanvas } from './canvas-pool.js';

type BufferCanvas = AnyCanvas;

/** A rectangle in buffer (document) pixels. */
export interface BufferRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
    target.save();
    target.globalAlpha = strokeOpacity;
    target.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
    target.drawImage(this._canvas as HTMLCanvasElement, x, y, w, h, x, y, w, h);
    target.restore();
  }

  /** Get the current buffer canvas (for stamping onto during a stroke). */
  get current(): BufferCanvas | null {
    return this._canvas;
  }
}

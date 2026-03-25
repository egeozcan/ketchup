import { createOffscreenCanvas, get2dContext, drawImageSafe, tintAlphaMask, type AnyCanvas } from './canvas-pool.js';

type BufferCanvas = AnyCanvas;

/**
 * Singleton pool managing one reusable stroke buffer canvas.
 * Never shrinks — only grows when the document exceeds the current size.
 * Zero allocation during painting.
 */
export class StrokeBufferPool {
  private _canvas: BufferCanvas | null = null;
  private _width = 0;
  private _height = 0;

  /** Acquire the buffer for a new stroke. Resizes if needed, then clears. */
  acquire(docWidth: number, docHeight: number): BufferCanvas {
    if (!this._canvas || docWidth > this._width || docHeight > this._height) {
      this._width = Math.max(this._width, docWidth);
      this._height = Math.max(this._height, docHeight);
      this._canvas = createOffscreenCanvas(this._width, this._height);
    }
    const ctx = get2dContext(this._canvas);
    ctx.clearRect(0, 0, this._width, this._height);
    return this._canvas;
  }

  /** Tint and composite the buffer onto the target layer. */
  commit(
    target: CanvasRenderingContext2D,
    color: string,
    strokeOpacity: number,
    eraser: boolean,
    docWidth: number,
    docHeight: number,
    colorMode = false,
  ) {
    if (!this._canvas) return;

    if (eraser) {
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'destination-out';
      drawImageSafe(target, this._canvas, 0, 0);
      target.restore();
    } else if (colorMode) {
      // Color mode: buffer already contains tinted RGBA — composite directly
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'source-over';
      drawImageSafe(target, this._canvas, 0, 0);
      target.restore();
    } else {
      // Alpha-mask mode: tint then composite
      const ctx = get2dContext(this._canvas);
      tintAlphaMask(ctx, color, docWidth, docHeight);
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'source-over';
      drawImageSafe(target, this._canvas, 0, 0);
      target.restore();
    }
  }

  /** Get the current buffer canvas (for stamping onto during a stroke). */
  get current(): BufferCanvas | null {
    return this._canvas;
  }
}

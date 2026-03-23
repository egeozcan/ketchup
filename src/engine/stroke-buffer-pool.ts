import { createOffscreenCanvas, get2dContext } from './canvas-pool.js';

type BufferCanvas = HTMLCanvasElement | OffscreenCanvas;

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

  /** Tint the accumulated alpha mask with the given color, then composite onto the target layer. */
  commit(
    target: CanvasRenderingContext2D,
    color: string,
    strokeOpacity: number,
    eraser: boolean,
    docWidth: number,
    docHeight: number,
  ) {
    if (!this._canvas) return;
    const ctx = get2dContext(this._canvas);

    if (!eraser) {
      // Tint: fill with color using source-in to multiply color × accumulated alpha
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, docWidth, docHeight);
      ctx.globalCompositeOperation = 'source-over';

      // Composite onto layer
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'source-over';
      target.drawImage(this._canvas as any, 0, 0);
      target.restore();
    } else {
      // Eraser: composite the alpha mask with destination-out
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'destination-out';
      target.drawImage(this._canvas as any, 0, 0);
      target.restore();
    }
  }

  /** Get the current buffer canvas (for stamping onto during a stroke). */
  get current(): BufferCanvas | null {
    return this._canvas;
  }
}

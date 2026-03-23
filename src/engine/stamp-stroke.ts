import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { get2dContext } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushParams, type PressureCurveName } from './types.js';

/** Singleton brush engine — create once, reuse across strokes. */
export class StampStrokeEngine {
  private _tipCache = new BrushTipCache();
  private _bufferPool = new StrokeBufferPool();
  private _smoother = new PathSmoother();
  private _params: BrushParams | null = null;
  private _docWidth = 0;
  private _docHeight = 0;

  /** Begin a new stroke. Acquires the buffer and resets the smoother. */
  begin(params: BrushParams, docWidth: number, docHeight: number) {
    this._params = { ...params };
    // Force stroke color to fully opaque for the source-in tint step
    if (!params.eraser && this._params.color.length === 9) {
      // Strip #RRGGBBAA → #RRGGBB
      this._params.color = this._params.color.slice(0, 7);
    }
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    this._bufferPool.acquire(docWidth, docHeight);
    this._smoother.reset();
  }

  /** Feed a pointer event. Stamps onto the buffer. */
  stroke(x: number, y: number, pressure: number) {
    if (!this._params) return;
    const p = this._params;
    const curveFn = PRESSURE_CURVES[p.pressureCurve];
    const mappedPressure = curveFn(pressure);

    const effectiveSpacing = Math.max(1, p.spacing * p.size);
    const stamps = this._smoother.addPoint(x, y, mappedPressure, effectiveSpacing);

    const buf = this._bufferPool.current;
    if (!buf) return;
    const ctx = get2dContext(buf);

    for (const stamp of stamps) {
      const effectiveSize = p.pressureSize
        ? Math.max(1, p.size * stamp.pressure)
        : p.size;
      const effectiveOpacity = p.pressureOpacity
        ? p.flow * stamp.pressure
        : p.flow;

      const diam = quantizeDiameter(effectiveSize);
      const tip = this._tipCache.get(diam, p.hardness);

      ctx.globalAlpha = effectiveOpacity;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(
        tip as any,
        Math.round(stamp.x - diam / 2),
        Math.round(stamp.y - diam / 2),
        diam,
        diam,
      );
    }
    ctx.globalAlpha = 1;
  }

  /** Commit the stroke to the target layer context. */
  commit(target: CanvasRenderingContext2D) {
    if (!this._params) return;

    // Flush any remaining path segment
    const effectiveSpacing = Math.max(1, this._params.spacing * this._params.size);
    const remaining = this._smoother.flush(effectiveSpacing);
    if (remaining.length > 0) {
      // Stamp remaining points — pressure is already curve-mapped from stroke(),
      // so use stamp.pressure directly (do NOT re-apply the curve)
      const buf = this._bufferPool.current;
      if (buf) {
        const ctx = get2dContext(buf);
        const p = this._params;
        for (const stamp of remaining) {
          const effectiveSize = p.pressureSize ? Math.max(1, p.size * stamp.pressure) : p.size;
          const effectiveOpacity = p.pressureOpacity ? p.flow * stamp.pressure : p.flow;
          const diam = quantizeDiameter(effectiveSize);
          const tip = this._tipCache.get(diam, p.hardness);
          ctx.globalAlpha = effectiveOpacity;
          ctx.drawImage(tip as any, Math.round(stamp.x - diam / 2), Math.round(stamp.y - diam / 2), diam, diam);
        }
        ctx.globalAlpha = 1;
      }
    }

    this._bufferPool.commit(
      target,
      this._params.color,
      this._params.opacity,
      this._params.eraser,
      this._docWidth,
      this._docHeight,
    );
    this._params = null;
  }

  /** Abort a stroke without committing. */
  cancel() {
    this._params = null;
    this._smoother.reset();
  }

  /** Get a preview of the in-progress stroke for display compositing. */
  getStrokePreview(): { canvas: HTMLCanvasElement | OffscreenCanvas; eraser: boolean; opacity: number; color: string } | null {
    if (!this._params || !this._bufferPool.current) return null;
    return {
      canvas: this._bufferPool.current,
      eraser: this._params.eraser,
      opacity: this._params.opacity,
      color: this._params.color,
    };
  }
}

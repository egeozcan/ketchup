import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { Stabilizer } from './stabilizer.js';
import { get2dContext, drawImageSafe, tintAlphaMask, createOffscreenCanvas, type AnyCanvas } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushDescriptor, type TipDescriptor, type StampPoint, type InkState } from './types.js';
import { TIP_VARIANT_COUNTS, tipFootprint } from './tip-generators.js';
import { initInkState, applyDepletion, applyBuildup, applyPickup } from './ink-model.js';

const MIN_DIRECTION_DIST_SQ = 0.25;

function computeStampRotation(
  stamp: StampPoint,
  prevStamp: StampPoint | null,
  prevRotation: number,
  tip: TipDescriptor,
): number {
  if (tip.orientation === 'fixed') {
    return tip.angle * Math.PI / 180;
  }
  if (!prevStamp) return tip.angle * Math.PI / 180;
  const dx = stamp.x - prevStamp.x;
  const dy = stamp.y - prevStamp.y;
  const distSq = dx * dx + dy * dy;
  if (distSq < MIN_DIRECTION_DIST_SQ) {
    return prevRotation;
  }
  return Math.atan2(dy, dx) + tip.angle * Math.PI / 180;
}

export class StampStrokeEngine {
  private _tipCache = new BrushTipCache();
  private _bufferPool = new StrokeBufferPool();
  private _smoother = new PathSmoother();
  private _stabilizer = new Stabilizer();
  private _descriptor: BrushDescriptor | null = null;
  private _color = '';
  private _eraser = false;
  private _colorMode = false;
  private _docWidth = 0;
  private _docHeight = 0;
  private _lastMappedPressure = 0.5;
  private _inkState: InkState | null = null;
  private _prevStamp: StampPoint | null = null;
  private _variantCounter = 0;
  private _snapshotCaptured = false;
  // Reusable tinting canvas for color mode — avoids per-stamp allocation
  private _tintCanvas: AnyCanvas | null = null;
  private _tintW = 0;
  private _tintH = 0;
  // What the tint canvas currently holds, so consecutive dabs with the same
  // tip and picked-up colour skip re-tinting it.
  private _tintedTip: AnyCanvas | null = null;
  private _tintedColor = '';
  // Union of every stamp footprint laid down this stroke, in document pixels.
  // Lets the canvas repaint only the touched region of the stroke buffer.
  private _dirtyMinX = Infinity;
  private _dirtyMinY = Infinity;
  private _dirtyMaxX = -Infinity;
  private _dirtyMaxY = -Infinity;

  /**
   * `stabilizerMs` is how far, in time, the stroke trails the pointer (0 =
   * off); it needs stroke() given increasing timestamps.
   */
  begin(descriptor: BrushDescriptor, color: string, eraser: boolean, docWidth: number, docHeight: number, stabilizerMs = 0) {
    this._descriptor = { ...descriptor, tip: { ...descriptor.tip }, ink: { ...descriptor.ink } };
    this._color = eraser ? '' : (color.length === 9 ? color.slice(0, 7) : color);
    this._eraser = eraser;
    this._colorMode = !eraser && descriptor.ink.wetness > 0;
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    this._bufferPool.acquire(docWidth, docHeight, this._rawDirtyRect());
    this._smoother.reset();
    this._stabilizer.reset(stabilizerMs);
    this._prevStamp = null;
    this._variantCounter = 0;
    this._snapshotCaptured = false;
    this._dirtyMinX = Infinity;
    this._dirtyMinY = Infinity;
    this._dirtyMaxX = -Infinity;
    this._dirtyMaxY = -Infinity;
    this._inkState = initInkState(this._color, null);
  }

  stroke(x: number, y: number, pressure: number, layerCtx?: CanvasRenderingContext2D, timestamp = 0) {
    if (!this._descriptor || !this._inkState) return;
    const d = this._descriptor;
    let inputPressure = pressure;
    if (!Number.isFinite(pressure) || pressure <= 0) {
      if (d.pressureSize || d.pressureOpacity) {
        // A lift ends this part of the stroke where the pen was, then the
        // next contact starts afresh.
        this._finishSegment();
        this._smoother.reset();
        this._stabilizer.reset();
        this._prevStamp = null;
        return;
      }
      inputPressure = 1;
    }

    if (this._colorMode && !this._snapshotCaptured && layerCtx) {
      this._inkState.layerSnapshot = layerCtx.getImageData(0, 0, this._docWidth, this._docHeight);
      this._snapshotCaptured = true;
    }

    const curveFn = PRESSURE_CURVES[d.pressureCurve];
    const at = this._stabilizer.add(x, y, curveFn(inputPressure), timestamp);
    this._lastMappedPressure = at.pressure;

    const stamps = this._smoother.addPoint(at.x, at.y, at.pressure, this._spacingAt(at.pressure), timestamp);

    this._stampPoints(stamps);
  }

  private _stampPoints(stamps: StampPoint[]) {
    if (!this._descriptor || !this._inkState) return;
    const d = this._descriptor;
    const ink = d.ink;
    const state = this._inkState;

    const buf = this._bufferPool.current;
    if (!buf) return;
    const ctx = get2dContext(buf);

    const variantCount = TIP_VARIANT_COUNTS[d.tip.shape] ?? 0;

    for (const stamp of stamps) {
      let stampDist = 0;
      if (this._prevStamp) {
        const dx = stamp.x - this._prevStamp.x;
        const dy = stamp.y - this._prevStamp.y;
        stampDist = Math.sqrt(dx * dx + dy * dy);
        state.distanceTraveled += stampDist;
      }
      state.stampCount++;

      const depletionMult = applyDepletion(ink, state);
      if (depletionMult <= 0) {
        this._prevStamp = stamp;
        continue;
      }

      const baseFlow = d.pressureOpacity ? d.flow * stamp.pressure : d.flow;
      const effectiveFlow = applyBuildup(ink, baseFlow, stamp.speedPxPerMs);

      const stampSize = d.pressureSize ? Math.max(1, d.size * stamp.pressure) : d.size;
      applyPickup(ink, state, stamp.x, stamp.y, stampSize / 2);
      const diam = quantizeDiameter(stampSize);

      let tip: AnyCanvas;
      if (variantCount > 0) {
        const vi = this._variantCounter % variantCount;
        tip = this._tipCache.getVariant(diam, d.hardness, d.tip, vi);
        this._variantCounter++;
      } else {
        tip = this._tipCache.get(diam, d.hardness, d.tip);
      }

      const rotation = computeStampRotation(stamp, this._prevStamp, state.prevRotation, d.tip);
      state.prevRotation = rotation;

      const stampAlpha = Math.min(1, effectiveFlow * depletionMult);

      const tipW = tip.width;
      const tipH = tip.height;
      // Tips are cached at an even diameter; draw them stretched to the exact
      // footprint, at the exact (subpixel) position, so thin strokes and
      // pressure tapers don't step in whole pixels.
      const { w: drawW, h: drawH } = tipFootprint(stampSize, d.tip);

      // Half-diagonal covers the tip footprint at any rotation; +1 absorbs
      // resampling spill at the fractional edges.
      const reach = Math.sqrt(drawW * drawW + drawH * drawH) / 2 + 1;
      if (stamp.x - reach < this._dirtyMinX) this._dirtyMinX = stamp.x - reach;
      if (stamp.y - reach < this._dirtyMinY) this._dirtyMinY = stamp.y - reach;
      if (stamp.x + reach > this._dirtyMaxX) this._dirtyMaxX = stamp.x + reach;
      if (stamp.y + reach > this._dirtyMaxY) this._dirtyMaxY = stamp.y + reach;

      if (this._colorMode) {
        // Reuse a single tinting canvas — grow only, never shrink
        if (tipW > this._tintW || tipH > this._tintH) {
          this._tintW = Math.max(this._tintW, tipW);
          this._tintH = Math.max(this._tintH, tipH);
          this._tintCanvas = createOffscreenCanvas(this._tintW, this._tintH);
          this._tintedTip = null;
        }
        if (tip !== this._tintedTip || state.currentColor !== this._tintedColor) {
          const tCtx = get2dContext(this._tintCanvas!);
          tCtx.globalCompositeOperation = 'source-over';
          tCtx.clearRect(0, 0, this._tintW, this._tintH);
          drawImageSafe(tCtx, tip, 0, 0);
          tintAlphaMask(tCtx, state.currentColor, tipW, tipH);
          this._tintedTip = tip;
          this._tintedColor = state.currentColor;
        }

        // The tint canvas only grows, so it can be larger than this tip: crop
        // its top-left tipW×tipH rather than scaling the whole canvas down.
        const tint = this._tintCanvas as HTMLCanvasElement;
        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(stamp.x, stamp.y);
          ctx.rotate(rotation);
          ctx.drawImage(tint, 0, 0, tipW, tipH, -drawW / 2, -drawH / 2, drawW, drawH);
          ctx.restore();
        } else {
          ctx.drawImage(tint, 0, 0, tipW, tipH, stamp.x - drawW / 2, stamp.y - drawH / 2, drawW, drawH);
        }
      } else {
        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(stamp.x, stamp.y);
          ctx.rotate(rotation);
          drawImageSafe(ctx, tip, -drawW / 2, -drawH / 2, drawW, drawH);
          ctx.restore();
        } else {
          drawImageSafe(ctx, tip, stamp.x - drawW / 2, stamp.y - drawH / 2, drawW, drawH);
        }
      }

      this._prevStamp = stamp;
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Composite the stroke onto `target`. Returns false when no stroke was in
   * progress; otherwise getDirtyBounds() covers every pixel it could change.
   */
  commit(target: CanvasRenderingContext2D): boolean {
    if (!this._descriptor) return false;

    this._finishSegment();

    this._bufferPool.commit(
      target,
      this._color,
      this._descriptor.opacity,
      this._eraser,
      this.getDirtyBounds(),
      this._colorMode,
    );
    this._descriptor = null;
    this._inkState = null;
    return true;
  }

  cancel() {
    this._descriptor = null;
    this._inkState = null;
    this._smoother.reset();
    this._stabilizer.reset();
  }

  /**
   * Lay the rest of the stroke so far: up to where the pointer last was (the
   * stabilizer trails it) and the spline's last, still unwalked segment.
   */
  private _finishSegment() {
    if (!this._descriptor) return;
    for (const p of this._stabilizer.catchUp()) {
      this._lastMappedPressure = p.pressure;
      this._stampPoints(this._smoother.addPoint(p.x, p.y, p.pressure, this._spacingAt(p.pressure), p.timestamp));
    }
    const remaining = this._smoother.flush(this._spacingAt(this._lastMappedPressure));
    if (remaining.length > 0) {
      this._stampPoints(remaining);
    }
  }

  /** Distance between dabs at a (curve-mapped) pressure. */
  private _spacingAt(mappedPressure: number): number {
    const d = this._descriptor!;
    const size = d.pressureSize ? Math.max(1, d.size * mappedPressure) : d.size;
    return Math.max(1, d.spacing * size);
  }

  /**
   * Region of the stroke buffer written so far, clamped to the document.
   * Null until the first stamp lands.
   */
  getDirtyBounds(): { x: number; y: number; w: number; h: number } | null {
    if (this._dirtyMaxX < this._dirtyMinX) return null;
    const x = Math.max(0, Math.floor(this._dirtyMinX));
    const y = Math.max(0, Math.floor(this._dirtyMinY));
    const w = Math.min(this._docWidth, Math.ceil(this._dirtyMaxX)) - x;
    const h = Math.min(this._docHeight, Math.ceil(this._dirtyMaxY)) - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  /**
   * Everything stamped since the last begin(), unclamped: stamps near an edge
   * can write past the document into a larger (grow-only) buffer, and that
   * must be cleared before the next stroke too.
   */
  private _rawDirtyRect(): { x: number; y: number; w: number; h: number } | null {
    if (this._dirtyMaxX < this._dirtyMinX) return null;
    const x = Math.floor(this._dirtyMinX);
    const y = Math.floor(this._dirtyMinY);
    return { x, y, w: Math.ceil(this._dirtyMaxX) - x, h: Math.ceil(this._dirtyMaxY) - y };
  }

  getStrokePreview(): {
    canvas: AnyCanvas;
    eraser: boolean;
    opacity: number;
    color: string | null;
    bounds: { x: number; y: number; w: number; h: number } | null;
  } | null {
    if (!this._descriptor || !this._bufferPool.current) return null;
    return {
      canvas: this._bufferPool.current,
      eraser: this._eraser,
      opacity: this._descriptor.opacity,
      color: this._colorMode ? null : this._color,
      bounds: this.getDirtyBounds(),
    };
  }
}

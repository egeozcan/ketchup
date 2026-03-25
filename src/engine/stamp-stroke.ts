import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { get2dContext, drawImageSafe, tintAlphaMask, createOffscreenCanvas, type AnyCanvas } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushDescriptor, type TipDescriptor, type StampPoint, type InkState } from './types.js';
import { TIP_VARIANT_COUNTS } from './tip-generators.js';
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

  begin(descriptor: BrushDescriptor, color: string, eraser: boolean, docWidth: number, docHeight: number) {
    this._descriptor = descriptor;
    this._color = eraser ? '' : (color.length === 9 ? color.slice(0, 7) : color);
    this._eraser = eraser;
    this._colorMode = !eraser && descriptor.ink.wetness > 0;
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    this._bufferPool.acquire(docWidth, docHeight);
    this._smoother.reset();
    this._prevStamp = null;
    this._variantCounter = 0;
    this._snapshotCaptured = false;
    this._inkState = initInkState(this._color, null);
  }

  stroke(x: number, y: number, pressure: number, layerCtx?: CanvasRenderingContext2D) {
    if (!this._descriptor || !this._inkState) return;
    const d = this._descriptor;

    if (this._colorMode && !this._snapshotCaptured && layerCtx) {
      this._inkState.layerSnapshot = layerCtx.getImageData(0, 0, this._docWidth, this._docHeight);
      this._snapshotCaptured = true;
    }

    const curveFn = PRESSURE_CURVES[d.pressureCurve];
    const mappedPressure = curveFn(pressure);
    this._lastMappedPressure = mappedPressure;

    const effectiveSize = d.pressureSize ? Math.max(1, d.size * mappedPressure) : d.size;
    const effectiveSpacing = Math.max(1, d.spacing * effectiveSize);
    const stamps = this._smoother.addPoint(x, y, mappedPressure, effectiveSpacing);

    this._stampPoints(stamps, effectiveSpacing);
  }

  private _stampPoints(stamps: StampPoint[], spacingPx: number) {
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
      const effectiveFlow = applyBuildup(ink, baseFlow, spacingPx, stampDist);

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

      const tipW = (tip as HTMLCanvasElement).width ?? diam;
      const tipH = (tip as HTMLCanvasElement).height ?? diam;

      if (this._colorMode) {
        const tinted = createOffscreenCanvas(tipW, tipH);
        const tCtx = get2dContext(tinted);
        drawImageSafe(tCtx, tip, 0, 0);
        tintAlphaMask(tCtx, state.currentColor, tipW, tipH);

        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(Math.round(stamp.x), Math.round(stamp.y));
          ctx.rotate(rotation);
          drawImageSafe(ctx, tinted, -tipW / 2, -tipH / 2, tipW, tipH);
          ctx.restore();
        } else {
          drawImageSafe(ctx, tinted, Math.round(stamp.x - tipW / 2), Math.round(stamp.y - tipH / 2), tipW, tipH);
        }
      } else {
        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(Math.round(stamp.x), Math.round(stamp.y));
          ctx.rotate(rotation);
          drawImageSafe(ctx, tip, -tipW / 2, -tipH / 2, tipW, tipH);
          ctx.restore();
        } else {
          drawImageSafe(ctx, tip, Math.round(stamp.x - tipW / 2), Math.round(stamp.y - tipH / 2), tipW, tipH);
        }
      }

      this._prevStamp = stamp;
    }
    ctx.globalAlpha = 1;
  }

  commit(target: CanvasRenderingContext2D) {
    if (!this._descriptor) return;

    const lastSize = this._descriptor.pressureSize
      ? Math.max(1, this._descriptor.size * this._lastMappedPressure)
      : this._descriptor.size;
    const flushSpacing = Math.max(1, this._descriptor.spacing * lastSize);
    const remaining = this._smoother.flush(flushSpacing);
    if (remaining.length > 0) {
      this._stampPoints(remaining, flushSpacing);
    }

    this._bufferPool.commit(
      target,
      this._color,
      this._descriptor.opacity,
      this._eraser,
      this._docWidth,
      this._docHeight,
      this._colorMode,
    );
    this._descriptor = null;
    this._inkState = null;
  }

  cancel() {
    this._descriptor = null;
    this._inkState = null;
    this._smoother.reset();
  }

  getStrokePreview(): { canvas: AnyCanvas; eraser: boolean; opacity: number; color: string | null } | null {
    if (!this._descriptor || !this._bufferPool.current) return null;
    return {
      canvas: this._bufferPool.current,
      eraser: this._eraser,
      opacity: this._descriptor.opacity,
      color: this._colorMode ? null : this._color,
    };
  }
}

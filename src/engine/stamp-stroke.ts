import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { Stabilizer, type StabilizedPoint } from './stabilizer.js';
import { get2dContext, drawImageSafe, tintAlphaMask, createOffscreenCanvas, type AnyCanvas } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushDescriptor, type TipDescriptor, type StampPoint, type InkState } from './types.js';
import { TIP_VARIANT_COUNTS, tipFootprint } from './tip-generators.js';
import { copyDescriptor } from './brush-presets.js';
import { initInkState, applyDepletion, applyBuildup, applyPickup } from './ink-model.js';

const MIN_DIRECTION_DIST_SQ = 0.25;
/** How quickly the speed that drives dynamics follows the pointer's, in ms. */
const VELOCITY_SMOOTHING_MS = 40;
/** Screen speed (CSS px per ms) at which speed dynamics reach their full effect. */
const FULL_VELOCITY_PX_PER_MS = 2;
/** How much longer than wide a dab gets from a pen lying flat at full tilt dynamics. */
const MAX_TILT_STRETCH = 2;
/** Tilt short of flat, so its tangent stays finite. */
const MAX_TILT_DEG = 89.9;

export interface StrokeOptions {
  /** How far, in time, the stroke trails the pointer (0 = off); needs increasing stroke() timestamps. */
  stabilizerMs?: number;
  /** Screen pixels per document pixel, so speed dynamics feel the same at any zoom. */
  viewScale?: number;
}

export interface PenTilt {
  /** Degrees (-90..90), as Pointer Events report them; 0, 0 is upright. */
  tiltX: number;
  tiltY: number;
}

const UPRIGHT: PenTilt = { tiltX: 0, tiltY: 0 };

function clampTilt(deg: number): number {
  return Number.isFinite(deg) ? Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, deg)) : 0;
}

interface DabStretch {
  /** The direction the pen leans toward, in radians. */
  azimuth: number;
  /** Length along `azimuth` over width (1 = round as the tip is). */
  stretch: number;
}

const NO_STRETCH: DabStretch = { azimuth: 0, stretch: 1 };

/**
 * A leaning pen's dab is stretched along its lean, as a tilted pencil's
 * contact is: more the further the pen is from upright, scaled by `amount`.
 */
export function tiltStretch(tiltX: number, tiltY: number, amount: number): DabStretch {
  if (!(amount > 0) || (tiltX === 0 && tiltY === 0)) return NO_STRETCH;
  const tx = Math.tan(clampTilt(tiltX) * Math.PI / 180);
  const ty = Math.tan(clampTilt(tiltY) * Math.PI / 180);
  const fromUpright = Math.atan(Math.hypot(tx, ty)) / (Math.PI / 2);
  return { azimuth: Math.atan2(ty, tx), stretch: 1 + amount * MAX_TILT_STRETCH * fromUpright };
}

/**
 * Set up `ctx` so a dab drawn centred on the origin lands at (x, y), turned
 * by `rotation` and then stretched by the pen's lean; false (and nothing
 * set up) when an untransformed draw at (x, y) will do. Restore after.
 */
function transformDab(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, rotation: number, lean: DabStretch): boolean {
  if (rotation === 0 && lean.stretch === 1) return false;
  ctx.save();
  ctx.translate(x, y);
  if (lean.stretch !== 1) {
    ctx.rotate(lean.azimuth);
    ctx.scale(lean.stretch, 1);
    ctx.rotate(rotation - lean.azimuth);
  } else {
    ctx.rotate(rotation);
  }
  return true;
}

/** Tips whose footprint is a long w × w/aspect bar, or (calligraphy) an ellipse that long. */
const BAR_TIPS = new Set(['flat', 'chisel', 'calligraphy']);

/** Headings tried for a dab with none yet, the first of a stroke. */
const ANY_HEADING = Array.from({ length: 8 }, (_, i) => i * Math.PI / 8);

/**
 * How far apart two bar dabs (1 long, 1/aspect thick, turned by `rotation`
 * and stretched by `lean`) can sit along `heading` and still touch; an
 * elliptical bar's ends are round, so it reaches less far off its axes.
 */
function barReach(aspect: number, elliptical: boolean, rotation: number, lean: DabStretch, heading: number): number {
  // The heading back in the dab's own frame: R(az - rot) S⁻¹ R(-az).
  const a = heading - lean.azimuth;
  const ux = Math.cos(a) / lean.stretch, uy = Math.sin(a);
  const b = lean.azimuth - rotation;
  const qx = Math.abs(ux * Math.cos(b) - uy * Math.sin(b));
  const qy = Math.abs(ux * Math.sin(b) + uy * Math.cos(b)) * aspect;
  return 1 / Math.max(elliptical ? Math.hypot(qx, qy) : Math.max(qx, qy), 1e-9);
}

/** A dynamics factor: `control` (-1..1) applied at a speed `v` (0..1). */
function speedFactor(control: number, v: number): number {
  return control >= 0 ? 1 - control + control * v : 1 + control * v;
}

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
  private _viewScale = 1;
  /** Smoothed pointer speed, in screen px per ms. */
  private _velocity = 0;
  /** The last sample's position and the time of the last that moved time on. */
  private _velocityLast: { x: number; y: number; t: number } | null = null;
  /** The way gone since time last moved on. */
  private _velocityDist = 0;
  private _descriptor: BrushDescriptor | null = null;
  private _color = '';
  private _eraser = false;
  private _colorMode = false;
  private _docWidth = 0;
  private _docHeight = 0;
  /** The way the stroke last headed, in radians, and the point it was measured from. */
  /** The last dab spaced, whose direction to the next sets how the next is turned. */
  private _spacedFrom: StampPoint | null = null;
  private _spacedHeading: number | null = null;
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

  begin(descriptor: BrushDescriptor, color: string, eraser: boolean, docWidth: number, docHeight: number, options: StrokeOptions = {}) {
    this._descriptor = copyDescriptor(descriptor);
    this._viewScale = options.viewScale && options.viewScale > 0 ? options.viewScale : 1;
    this._resetMotion();
    this._color = eraser ? '' : (color.length === 9 ? color.slice(0, 7) : color);
    this._eraser = eraser;
    this._colorMode = !eraser && descriptor.ink.wetness > 0;
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    this._bufferPool.acquire(docWidth, docHeight, this._rawDirtyRect());
    this._smoother.reset();
    this._stabilizer.reset(options.stabilizerMs ?? 0);
    this._prevStamp = null;
    this._variantCounter = 0;
    this._snapshotCaptured = false;
    this._dirtyMinX = Infinity;
    this._dirtyMinY = Infinity;
    this._dirtyMaxX = -Infinity;
    this._dirtyMaxY = -Infinity;
    this._inkState = initInkState(this._color, null);
  }

  stroke(x: number, y: number, pressure: number, layerCtx?: CanvasRenderingContext2D, timestamp = 0, tilt: PenTilt = UPRIGHT) {
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
        this._resetMotion();
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
    const at = this._stabilizer.add(x, y, curveFn(inputPressure), timestamp, clampTilt(tilt.tiltX), clampTilt(tilt.tiltY));
    this._stampPoints(this._feed({ ...at, timestamp }));
  }

  /** Feed a (stabilized) sample to the spline, returning the dabs it lays. */
  private _feed(p: StabilizedPoint): StampPoint[] {
    // Speed and heading are measured along the stabilized path, the one the dabs follow.
    const v = this._trackVelocity(p.x, p.y, p.timestamp);
    return this._smoother.addPoint(p.x, p.y, p.pressure, this._dabSpacing, p.timestamp,
      { velocity: v, tiltX: p.tiltX, tiltY: p.tiltY });
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

      const baseFlow = (d.pressureOpacity ? d.flow * stamp.pressure : d.flow) *
        speedFactor(d.dynamics.flowVelocity, stamp.velocity);
      const effectiveFlow = applyBuildup(ink, baseFlow, stamp.speedPxPerMs);

      const stampSize = this._sizeAt(stamp.pressure, stamp.velocity);
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
      const lean = tiltStretch(stamp.tiltX, stamp.tiltY, d.dynamics.tilt);

      // Half-diagonal covers the tip footprint at any rotation, times the
      // lean's stretch; +1 absorbs resampling spill at the fractional edges.
      const reach = Math.sqrt(drawW * drawW + drawH * drawH) / 2 * lean.stretch + 1;
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
        if (transformDab(ctx, stamp.x, stamp.y, rotation, lean)) {
          ctx.drawImage(tint, 0, 0, tipW, tipH, -drawW / 2, -drawH / 2, drawW, drawH);
          ctx.restore();
        } else {
          ctx.drawImage(tint, 0, 0, tipW, tipH, stamp.x - drawW / 2, stamp.y - drawH / 2, drawW, drawH);
        }
      } else {
        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (transformDab(ctx, stamp.x, stamp.y, rotation, lean)) {
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
      this._stampPoints(this._feed(p));
    }
    const remaining = this._smoother.flush(this._dabSpacing);
    if (remaining.length > 0) {
      this._stampPoints(remaining);
    }
  }

  /** A dab's diameter at a (curve-mapped) pressure and a normalized speed. */
  private _sizeAt(mappedPressure: number, velocity: number): number {
    const d = this._descriptor!;
    const min = d.dynamics.minSize;
    const size = d.pressureSize ? d.size * (min + (1 - min) * mappedPressure) : d.size;
    return Math.max(1, size * speedFactor(d.dynamics.sizeVelocity, velocity));
  }

  /**
   * Distance from a dab to the next, from the dab's own size and lean: the
   * spline lays a segment a sample late, so the newest sample's would be
   * another dab's (a pause after a thin, fast run would gap it).
   */
  private _dabSpacing = (stamp: StampPoint): number => {
    const d = this._descriptor!;
    const from = this._spacedFrom;
    if (from) {
      const dx = stamp.x - from.x, dy = stamp.y - from.y;
      if (dx * dx + dy * dy >= MIN_DIRECTION_DIST_SQ) this._spacedHeading = Math.atan2(dy, dx);
    }
    this._spacedFrom = stamp;
    return Math.max(1, d.spacing * this._sizeAt(stamp.pressure, stamp.velocity) * this._leanSpacing(stamp, this._spacedHeading));
  };

  /**
   * Stretching a bar along a lean across it shears it, which can pull
   * neighbouring dabs apart: closes the spacing up by as much as the dabs'
   * reach along the stroke shrank, so ones that touched upright still do.
   * Round dabs only grow when stretched.
   */
  private _leanSpacing(tilt: PenTilt, heading: number | null): number {
    const d = this._descriptor!;
    const lean = tiltStretch(tilt.tiltX, tilt.tiltY, d.dynamics.tilt);
    if (lean.stretch === 1 || !BAR_TIPS.has(d.tip.shape)) return 1;
    const angle = d.tip.angle * Math.PI / 180;
    const aspect = Math.max(1, d.tip.aspect);
    const elliptical = d.tip.shape === 'calligraphy';
    // As _stampPoints turns it: along the way from the dab before, or at
    // the tip's own angle when there is none yet (and then any way on).
    const shrink = (h: number) => {
      const rotation = d.tip.orientation === 'fixed' || heading === null ? angle : h + angle;
      return barReach(aspect, elliptical, rotation, lean, h) / barReach(aspect, elliptical, rotation, NO_STRETCH, h);
    };
    return Math.min(1, ...(heading === null ? ANY_HEADING : [heading]).map(shrink));
  }

  private _resetMotion() {
    this._velocity = 0;
    this._velocityLast = null;
    this._velocityDist = 0;
    this._spacedFrom = null;
    this._spacedHeading = null;
  }

  /**
   * Follow the pointer's speed over time, in screen pixels, and return it
   * normalized. Samples at the same time add the way they went to the next
   * one that moves time on.
   */
  private _trackVelocity(x: number, y: number, t: number): number {
    const last = this._velocityLast;
    this._velocityLast = { x, y, t: last && !(t > last.t) ? last.t : t };
    if (!last) return this._normalizedVelocity();
    this._velocityDist += Math.hypot(x - last.x, y - last.y);
    const dt = t - last.t;
    if (!(dt > 0)) return this._normalizedVelocity();
    const speed = this._velocityDist * this._viewScale / dt;
    this._velocity += (speed - this._velocity) * (1 - Math.exp(-dt / VELOCITY_SMOOTHING_MS));
    this._velocityDist = 0;
    return this._normalizedVelocity();
  }

  /** The smoothed speed as a share (0..1) of the speed dynamics take full effect at. */
  private _normalizedVelocity(): number {
    return Math.min(1, this._velocity / FULL_VELOCITY_PX_PER_MS);
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

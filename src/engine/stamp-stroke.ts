import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { Stabilizer, type StabilizedPoint } from './stabilizer.js';
import { get2dContext, drawImageSafe, tintAlphaMask, createOffscreenCanvas, type AnyCanvas } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushDescriptor, type BrushBlendMode, type TipDescriptor, type StampPoint, type InkState } from './types.js';
import { TIP_VARIANT_COUNTS, tipFootprint } from './tip-generators.js';
import { resolveTipForStroke } from './tip-images.js';
import { copyDescriptor, colorDynamicsActive } from './brush-presets.js';
import { Rng, freshSeed } from './rng.js';
import { resolveGrain, applyGrain, type Grain } from './brush-texture.js';
import { wrapDegrees } from './angle.js';
import { initInkState, applyDepletion, applyBuildup, applyPickup, lerpOklab, varyColor, type ColorRolls } from './ink-model.js';

/** Mixed into the stroke's seed for the flow jitter's own random stream. */
const FLOW_STREAM = 0x9E3779B9;
/** Mixed into the stroke's seed for scatter's own random stream. */
const SCATTER_STREAM = 0x85EBCA6B;

/** Mixed into the stroke's seed for colour dynamics' own random stream. */
const COLOR_STREAM = 0xC2B2AE35;
/** Bytes of tinted tips kept for reuse by a stroke of varying colour; the oldest go first. */
const TINT_CACHE_BYTES = 16 * 1024 * 1024;
/** Tinted-tip slots grow in these steps, so a slowly growing dab doesn't restart the cache at every size. */
const TINT_SLOT_STEP = 32;
/** Pixels of a tinted tip's edge copied outward in its slot. */
const TINT_EDGE = 2;
/** Most tinted tips kept, however small: past a point more colours only mean more canvases to fill and none to reuse. */
const TINT_CACHE_ENTRIES = 128;

const MIN_DIRECTION_DIST_SQ = 0.25;
/** How quickly the speed that drives dynamics follows the pointer's, in ms. */
const VELOCITY_SMOOTHING_MS = 40;
/** Screen speed (CSS px per ms) at which speed dynamics reach their full effect. */
const FULL_VELOCITY_PX_PER_MS = 2;
/** How much longer than wide a dab gets from a pen lying flat at full tilt dynamics. */
const MAX_TILT_STRETCH = 2;
/** Tilt short of flat, so its tangent stays finite. */
const MAX_TILT_DEG = 89.9;
/** Screen (CSS) pixels a hand may tremble without the stabilizer counting it as way gone. */
const STABILIZER_SLACK_PX = 1;
/** The most time an airbrush owes after a stall (a busy frame, a hidden tab), in ms; the rest is forgiven rather than sprayed at once. */
export const AIRBRUSH_MAX_CATCH_UP_MS = 250;
/** Quiet, in ms, after which a pen counts as held still (or a dab's time, if longer). */
const AIRBRUSH_STOPPED_MS = 32;
/** How close (document px) the stabilizer's drawn point must come to a stopped pen before the airbrush holds, well under a dab's spacing so release adds nothing. */
const AIRBRUSH_SETTLED_PX = 0.25;
/** Lag (document px) the stabilizer's own catch-up at a release ignores. */
const STABILIZER_LAG_EPSILON_PX = 0.01;
/** Most steps a settling tick feeds the spline in. */
const AIRBRUSH_MAX_SETTLE_STEPS = 64;

export interface StrokeOptions {
  /** How far, in time, the stroke trails the pointer (0 = off); needs increasing stroke() timestamps. */
  stabilizerMs?: number;
  /** Screen pixels per document pixel, so speed dynamics and the stabilizer feel the same at any zoom. */
  viewScale?: number;
  /** Seeds the stroke's jitter, so a stroke can be replayed exactly; random per stroke without. */
  seed?: number;
  /** The fill colour, which colour dynamics mix toward; without one the mix has nothing to go to. */
  secondaryColor?: string;
  /** The layer being painted on keeps its alpha: the stroke only recolours existing pixels. */
  alphaLocked?: boolean;
}

export interface PenTilt {
  /** Degrees (-90..90), as Pointer Events report them; 0, 0 is upright. */
  tiltX: number;
  tiltY: number;
  /** Pen barrel rotation in degrees (0..360); absent or 0 for a device that reports none. */
  twist?: number;
}

const UPRIGHT: PenTilt = { tiltX: 0, tiltY: 0 };

function clampTilt(deg: number): number {
  return Number.isFinite(deg) ? Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, deg)) : 0;
}

function cleanTwist(deg: number | undefined): number {
  return deg !== undefined && Number.isFinite(deg) ? wrapDegrees(deg) : 0;
}

/** Lean (degrees from upright, both axes together) below which a pen counts as upright and has no direction to lean in. */
const MIN_LEAN_DEG = 0.5;

/**
 * The direction (radians) a pen leans toward, or null when it is upright (or
 * reports no tilt, as a mouse doesn't), where the direction is noise.
 */
export function tiltAzimuth(tiltX: number, tiltY: number): number | null {
  const x = clampTilt(tiltX), y = clampTilt(tiltY);
  if (Math.hypot(x, y) < MIN_LEAN_DEG) return null;
  return Math.atan2(Math.tan(y * Math.PI / 180), Math.tan(x * Math.PI / 180));
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
 * set up) when an untransformed draw at (x, y) will do. `squash` (≤ 1)
 * shortens the dab across its own axis, after the lean. Restore after.
 */
function transformDab(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, rotation: number, lean: DabStretch, squash = 1): boolean {
  if (rotation === 0 && lean.stretch === 1 && squash === 1) return false;
  ctx.save();
  ctx.translate(x, y);
  if (lean.stretch !== 1) {
    ctx.rotate(lean.azimuth);
    ctx.scale(lean.stretch, 1);
    ctx.rotate(rotation - lean.azimuth);
  } else {
    ctx.rotate(rotation);
  }
  if (squash !== 1) ctx.scale(1, squash);
  return true;
}

/**
 * Tips whose footprint is a long 1 × 1/aspect bar: a rectangle, a chisel's
 * parallelogram (its top and bottom edges shifted a third of its thickness
 * apart, as generateChiselTip draws it) or calligraphy's ellipse.
 */
const BAR_TIPS = new Set(['flat', 'chisel', 'calligraphy']);

/** Headings tried for a dab with none yet, the first of a stroke. */
const ANY_HEADING = Array.from({ length: 8 }, (_, i) => i * Math.PI / 8);

/**
 * How many times over two copies of a bar footprint (in its own frame, 1
 * long) must be pushed apart by (qx, qy) to no longer touch: the gauge of
 * the footprint doubled, which for these symmetric shapes is every offset
 * at which two copies still touch.
 */
function barGauge(shape: string, aspect: number, qx: number, qy: number): number {
  const across = Math.abs(qy) * aspect;
  if (shape === 'calligraphy') return Math.hypot(qx, across);
  if (shape === 'chisel') {
    // Rows run 1 - shear long, shifted along the bar by shear = thickness / 3.
    return Math.max(across, Math.abs(qx + qy / 3) / (1 - 1 / (3 * aspect)));
  }
  return Math.max(Math.abs(qx), across);
}

/**
 * How far apart two bar dabs (1 long, turned by `rotation` and stretched by
 * `lean`) can sit along `heading` and still touch.
 */
function barReach(shape: string, aspect: number, rotation: number, lean: DabStretch, heading: number): number {
  // The heading back in the dab's own frame: R(az - rot) S⁻¹ R(-az).
  const a = heading - lean.azimuth;
  const ux = Math.cos(a) / lean.stretch, uy = Math.sin(a);
  const b = lean.azimuth - rotation;
  const qx = ux * Math.cos(b) - uy * Math.sin(b);
  const qy = ux * Math.sin(b) + uy * Math.cos(b);
  return 1 / Math.max(barGauge(shape, aspect, qx, qy), 1e-9);
}

/** A dynamics factor: `control` (-1..1) applied at a speed `v` (0..1). */
function speedFactor(control: number, v: number): number {
  return control >= 0 ? 1 - control + control * v : 1 + control * v;
}

/**
 * The turn a pen gives a dab of a tip following it, plus the tip's offset;
 * null for any other orientation, and for 'tilt' with the pen upright, which
 * has no direction to follow.
 */
function penRotation(stamp: StampPoint, tip: TipDescriptor): number | null {
  const offset = tip.angle * Math.PI / 180;
  if (tip.orientation === 'twist') return stamp.twist * Math.PI / 180 + offset;
  if (tip.orientation === 'tilt') {
    const az = tiltAzimuth(stamp.tiltX, stamp.tiltY);
    return az === null ? null : az + offset;
  }
  return null;
}

/**
 * A mouse reports no tilt and no twist, so 'tilt' and 'twist' turn its dabs
 * by the offset alone, as 'fixed' does. A pen that comes upright mid-stroke
 * keeps the angle it had, as direction following does while still.
 */
function computeStampRotation(
  stamp: StampPoint,
  prevStamp: StampPoint | null,
  prevRotation: number,
  tip: TipDescriptor,
): number {
  if (tip.orientation === 'fixed') {
    return tip.angle * Math.PI / 180;
  }
  if (tip.orientation === 'tilt' || tip.orientation === 'twist') {
    return penRotation(stamp, tip) ?? (prevStamp ? prevRotation : tip.angle * Math.PI / 180);
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
  private _alphaLocked = false;
  private _colorMode = false;
  private _secondary = '';
  /** Colour dynamics change the colour of a dab (never on the eraser). */
  private _dynamicColor = false;
  private _colorRng = new Rng(0);
  /** With dynamics once per stroke, the rolls and then the colour of the stroke's first dab. */
  private _strokeRolls: ColorRolls | null = null;
  private _strokeDabColor: string | null = null;
  private _docWidth = 0;
  private _docHeight = 0;
  private _inkState: InkState | null = null;
  private _prevStamp: StampPoint | null = null;
  /** Path length of the segments of this stroke before the current one (a pressure lift starts a new segment), so size fade runs on over the stroke while the taper restarts. */
  private _distBase = 0;
  private _variantCounter = 0;
  private _rng = new Rng(0);
  private _flowRng = new Rng(0);
  private _scatterRng = new Rng(0);
  /** The stroke's direction between the last two stamps (radians), for scatter across it; null before it has one. */
  private _heading: number | null = null;
  /**
   * The airbrush's clock: the time up to which held dabs are accounted for.
   * Movement resets it to the time of the sample that laid dabs, so a moving
   * stroke has its spacing's density and the timer only fills what movement
   * leaves. Null before the first dab and after a pressure lift.
   */
  private _airClock: number | null = null;
  /**
   * Samples have been fed since the spline last caught up with them: it lays a
   * segment a sample late, so a pen that stops leaves its last one unwalked.
   */
  private _tailPending = false;
  /** The distance the path's last two samples were apart, the pace a recovery steps at. */
  private _lastFeedStep = 0;
  /** The time of the last pen sample, to tell a pen at rest from one that moves slowly. */
  private _lastEvent = 0;
  private _snapshotCaptured = false;
  /** The stroke's texture, null when it has none (or the pattern is gone). */
  private _grain: Grain | null = null;
  /** With a grain not applied per tip: the stroke buffer with the grain applied, rebuilt over what was stamped since it last was. */
  private _grainCanvas: AnyCanvas | null = null;
  private _grainDeltaMinX = Infinity;
  private _grainDeltaMinY = Infinity;
  private _grainDeltaMaxX = -Infinity;
  private _grainDeltaMaxY = -Infinity;
  /** Where a textured dab is drawn before its grain is applied; only grows. */
  private _dabScratch: AnyCanvas | null = null;
  // Reusable tinting canvas for color mode — avoids per-stamp allocation
  private _tintCanvas: AnyCanvas | null = null;
  private _tintW = 0;
  private _tintH = 0;
  // What the tint canvas currently holds, so consecutive dabs with the same
  // tip and picked-up colour skip re-tinting it.
  private _tintedTip: AnyCanvas | null = null;
  private _tintedColor = '';
  // Tinted tips by tip and colour, for strokes whose colour varies per dab
  // (insertion order is age: a hit moves an entry to the back).
  private _tintCache = new Map<string, AnyCanvas>();
  private _slotW = 0;
  private _slotH = 0;
  private _tipIds = new WeakMap<object, number>();
  private _nextTipId = 1;
  // Union of every stamp footprint laid down this stroke, in document pixels.
  // Lets the canvas repaint only the touched region of the stroke buffer.
  private _dirtyMinX = Infinity;
  private _dirtyMinY = Infinity;
  private _dirtyMaxX = -Infinity;
  private _dirtyMaxY = -Infinity;
  // The same, but only since the preview last took it (takePreviewDelta).
  private _deltaMinX = Infinity;
  private _deltaMinY = Infinity;
  private _deltaMaxX = -Infinity;
  private _deltaMaxY = -Infinity;

  begin(descriptor: BrushDescriptor, color: string, eraser: boolean, docWidth: number, docHeight: number, options: StrokeOptions = {}) {
    this._descriptor = copyDescriptor(descriptor);
    // A sampled tip whose image isn't loaded paints round for the whole stroke,
    // so one that arrives meanwhile can't change the shape and spacing partway.
    this._descriptor.tip = resolveTipForStroke(this._descriptor.tip);
    this._viewScale = options.viewScale && options.viewScale > 0 ? options.viewScale : 1;
    this._resetMotion();
    this._color = eraser ? '' : (color.length === 9 ? color.slice(0, 7) : color);
    this._eraser = eraser;
    this._alphaLocked = options.alphaLocked === true;
    this._secondary = options.secondaryColor && options.secondaryColor.length === 9 ? options.secondaryColor.slice(0, 7) : options.secondaryColor ?? '';
    this._dynamicColor = !eraser && colorDynamicsActive(descriptor.color);
    // The per-dab colour path serves both what is picked up and what varies.
    this._colorMode = !eraser && (descriptor.ink.wetness > 0 || this._dynamicColor);
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    const stale = this._rawDirtyRect();
    this._bufferPool.acquire(docWidth, docHeight, stale);
    if (this._grainCanvas && stale) get2dContext(this._grainCanvas).clearRect(stale.x, stale.y, stale.w, stale.h);
    this._grain = resolveGrain(this._descriptor.texture);
    this._resetGrainDelta();
    this._smoother.reset();
    this._stabilizer.reset(options.stabilizerMs ?? 0, STABILIZER_SLACK_PX / this._viewScale);
    this._prevStamp = null;
    this._distBase = 0;
    this._heading = null;
    this._airClock = null;
    this._lastFeedStep = 0;
    this._tailPending = false;
    this._variantCounter = 0;
    const seed = options.seed ?? freshSeed();
    this._rng = new Rng(seed);
    this._flowRng = new Rng(seed ^ FLOW_STREAM);
    this._scatterRng = new Rng(seed ^ SCATTER_STREAM);
    this._colorRng = new Rng(seed ^ COLOR_STREAM);
    this._strokeRolls = null;
    this._strokeDabColor = null;
    this._clearTintCache();
    this._snapshotCaptured = false;
    this._dirtyMinX = Infinity;
    this._dirtyMinY = Infinity;
    this._dirtyMaxX = -Infinity;
    this._dirtyMaxY = -Infinity;
    this._resetPreviewDelta();
    this._inkState = initInkState(this._color, null);
  }

  stroke(x: number, y: number, pressure: number, layerCtx?: CanvasRenderingContext2D, timestamp = 0, tilt: PenTilt = UPRIGHT) {
    if (!this._descriptor || !this._inkState) return;
    const d = this._descriptor;
    let inputPressure = pressure;
    if (!Number.isFinite(pressure) || pressure <= 0) {
      // A pressure that drives the fill mix is a pressure dynamic like the others.
      // A start taper needs the lift too, for the new contact to taper in.
      if (d.pressureSize || d.pressureOpacity || d.fade.taperStart > 0 || (this._dynamicColor && d.color.fgBgPressure && d.color.fgBg > 0) || (this._grain?.perTip && this._grain.depthPressure)) {
        // A lift ends this part of the stroke where the pen was, then the
        // next contact starts afresh.
        this._finishSegment();
        this._distBase += this._smoother.pathLength();
        this._smoother.reset();
        this._stabilizer.reset();
        this._resetMotion();
        this._prevStamp = null;
        this._heading = null;
        // A lifted pen holds nothing: the airbrush pauses until the next contact lays a dab.
        this._airClock = null;
        this._tailPending = false;
        return;
      }
      inputPressure = 1;
    }

    // Only a wet brush reads the layer; varying colour alone never pays for a full-layer read.
    if (d.ink.wetness > 0 && this._colorMode && !this._snapshotCaptured && layerCtx) {
      this._inkState.layerSnapshot = layerCtx.getImageData(0, 0, this._docWidth, this._docHeight);
      this._snapshotCaptured = true;
    }

    const curveFn = PRESSURE_CURVES[d.pressureCurve];
    const at = this._stabilizer.add(x, y, curveFn(inputPressure), timestamp, clampTilt(tilt.tiltX), clampTilt(tilt.tiltY), cleanTwist(tilt.twist));
    const stamps = this._feed({ ...at, timestamp });
    this._stampPoints(stamps);
    if (d.airbrush) {
      this._lastEvent = timestamp;
      this._tailPending = true;
      // Also the first sample after a suspension, whatever it lays: the time between is not owed.
      if (stamps.length > 0 || (this._airClock === null && this._prevStamp)) this._airClock = timestamp;
    }
  }

  /**
   * Stop counting time until the pen reports again (the window lost focus, so no
   * frames ran): what elapsed meanwhile is not owed as dabs at the release.
   */
  suspendAirbrush() {
    this._airClock = null;
  }

  /**
   * Walk the path up to the pen's present position and return the dabs that
   * laid. While the stabilizer lags that is time passing with the pen at rest
   * (its last position fed in again, which closes the lag); otherwise it is the
   * spline's last segment, laid without ending the path.
   */
  private _settlePath(timestamp: number, lagging: boolean): number {
    let stamps: StampPoint[];
    if (lagging) {
      // The drawn point moves to where the average puts it at `timestamp` (or the
      // pen, when that is close), but is fed to the spline in steps no longer than
      // the stroke's own pace (a dab's spacing at least) along the way, timed between the last sample and now: one
      // long jump after a stall, or steps of another size than the stroke's own,
      // would make the spline overshoot and hook back.
      const here = this._stabilizer.position();
      const penAt = this._stabilizer.penTrail();
      const fromT = this._velocityLast ? Math.min(this._velocityLast.t, timestamp) : timestamp;
      let to = this._stabilizer.hold(timestamp);
      // The last fraction of a pixel would take the average ever longer: close it
      // at once, so the held spot is the spot a release commits at.
      if (this._stabilizer.lag() <= AIRBRUSH_SETTLED_PX) to = this._stabilizer.snap(timestamp);
      const dist = Math.hypot(to.x - here.x, to.y - here.y);
      const step = Math.max(1, this._lastFeedStep, this._prevStamp ? this._dabSpacing(this._prevStamp, this._heading) : 1);
      const n = Math.max(1, Math.min(AIRBRUSH_MAX_SETTLE_STEPS, Math.ceil(dist / step)));
      stamps = [];
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        stamps.push(...this._feed({ ...to, ...penAt(f), x: here.x + (to.x - here.x) * f, y: here.y + (to.y - here.y) * f, timestamp: fromT + (timestamp - fromT) * f }));
      }
      if (n > 1) {
        const f = (n - 1) / n;
        this._stabilizer.setPrevious(here.x + (to.x - here.x) * f, here.y + (to.y - here.y) * f, fromT + (timestamp - fromT) * f);
      }
    } else {
      stamps = this._smoother.settle(this._dabSpacing);
      this._tailPending = false;
    }
    this._stampPoints(stamps);
    return stamps.length;
  }

  /** Whether the stroke under way is an airbrush, for a driver deciding to call tick(). */
  get airbrushActive(): boolean {
    return !!this._descriptor?.airbrush;
  }

  /**
   * Airbrush build-up: lay the dabs that time owes since the last dab, at
   * `timestamp` (ms, the clock stroke() timestamps use). Returns how many were
   * laid (0 when the brush isn't an airbrush, the pen is lifted, or nothing is
   * due yet), so the caller knows whether the preview needs redoing.
   *
   * It is the time between calls that counts, never the number of calls, so it
   * lays the same at 60 and 120 Hz and in a throttled tab. After a stall at
   * most AIRBRUSH_MAX_CATCH_UP_MS is owed. A leftover less than one dab's time
   * carries to the next call.
   *
   * Held dabs go where the stroke's last dab went, through the same per-dab
   * path as any other: jitter, scatter, colour dynamics, pickup, dirty bounds.
   * The path trails the pen (the spline by a segment, the stabilizer by its
   * lag), so once the pen has been quiet the path is first walked up to it: the
   * spline's last segment is laid as movement (PathSmoother.settle, which keeps
   * the path going without laying it twice), and while the stabilizer lags,
   * time moves the drawn point instead. The dabs the clock lays after that sit
   * at the end of the path, within a spacing of the pen. They take the pen's
   * present pressure, tilt and twist; speed is 0, so speed dynamics and ink
   * build-up see a pen at rest, and the smoothed velocity fades from what it
   * was (VELOCITY_SMOOTHING_MS).
   *
   * Time and distance do not share a budget: a timed dab sits at the last dab,
   * so it cannot stand in for travel, and movement dabs still land after it.
   * Where a slow stroke's movement dabs come about as often as the timer's,
   * density is up to the sum of the two (twice the rate at most), which only
   * ever builds up; sharing the count would let the timer hold a creeping
   * stroke in place.
   *
   * With a stabilizer the drawn point trails a pen that has stopped. Then time
   * moves the stroke, not the timer: the point closes in on the pen and dabs
   * come from that movement, and the clock stays pinned to now so no backlog
   * builds up to burst out once it arrives. While the pen still reports (slow
   * movement) the timer builds up at the path's last dab as without one.
   */
  tick(timestamp: number): number {
    const d = this._descriptor;
    if (!d || !d.airbrush || !this._inkState || !this._prevStamp || this._airClock === null) return 0;
    if (!Number.isFinite(timestamp) || !(timestamp > this._airClock)) return 0;

    const interval = 1000 / d.airbrushRate;
    // A pen that is moving, however slowly, reports every few ms; one that
    // has been quiet for a dab's time (or this long, for a fast rate) is held.
    const stopped = timestamp - this._lastEvent >= Math.max(AIRBRUSH_STOPPED_MS, interval);

    if (stopped && this._stabilizer.lag() > STABILIZER_LAG_EPSILON_PX) {
      // The pen has stopped but the stabilizer is still closing in on it: that
      // is movement's to lay, and time moves it. The clock stays at now so no
      // backlog is left to burst out when it arrives.
      this._airClock = timestamp;
      return this._settlePath(timestamp, true);
    }

    if (timestamp - this._airClock > AIRBRUSH_MAX_CATCH_UP_MS) this._airClock = timestamp - AIRBRUSH_MAX_CATCH_UP_MS;
    // The epsilon keeps a dab due exactly now from slipping a frame to rounding.
    const due = Math.floor((timestamp - this._airClock) / interval + 1e-9);
    if (due <= 0) return 0;

    // The spline lays a segment a sample late: a pen that has stopped leaves its
    // last one unwalked. Walk it before holding, as movement; if that lays dabs
    // they are this call's.
    if (stopped && this._tailPending) {
      const laid = this._settlePath(timestamp, false);
      if (laid > 0) {
        this._airClock = timestamp;
        return laid;
      }
    }

    const held: StampPoint[] = [];
    // Where the pen is now, not where the path's last dab saw it.
    const pen = this._stabilizer.rawPen();
    for (let i = 1; i <= due; i++) {
      const t = this._airClock + i * interval;
      const last = this._velocityLast;
      // Standing at the last point the velocity tracker saw, so only time passes.
      const velocity = last ? this._trackVelocity(last.x, last.y, t) : 0;
      held.push({ ...this._prevStamp, ...pen, speedPxPerMs: 0, velocity });
    }
    this._airClock += due * interval;
    this._stampPoints(held);

    return due;
  }

  /** Feed a (stabilized) sample to the spline, returning the dabs it lays. */
  private _feed(p: StabilizedPoint): StampPoint[] {
    // Speed and heading are measured along the stabilized path, the one the dabs follow.
    if (this._velocityLast) this._lastFeedStep = Math.hypot(p.x - this._velocityLast.x, p.y - this._velocityLast.y);
    const v = this._trackVelocity(p.x, p.y, p.timestamp);
    return this._smoother.addPoint(p.x, p.y, p.pressure, this._dabSpacing, p.timestamp,
      { velocity: v, tiltX: p.tiltX, tiltY: p.tiltY, twist: p.twist });
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
    const sc = d.scatter;
    const scattering = sc.amount > 0 || sc.count > 1;

    for (const stamp of stamps) {
      let stampDist = 0;
      if (this._prevStamp) {
        const dx = stamp.x - this._prevStamp.x;
        const dy = stamp.y - this._prevStamp.y;
        stampDist = Math.sqrt(dx * dx + dy * dy);
        state.distanceTraveled += stampDist;
        if (dx * dx + dy * dy >= MIN_DIRECTION_DIST_SQ) this._heading = Math.atan2(dy, dx);
      }
      state.stampCount++;

      // The stroke's random stream is read in a fixed order, three values per
      // dab (size, angle, roundness) whether or not each jitter is on and
      // before anything can skip the dab, so turning one jitter on or off
      // doesn't reshuffle the others. Flow jitter takes its one value per dab,
      // at the same point, from a second stream (_flowRng) seeded from the
      // same seed, so adding it left the first stream's values where they were
      // for every dab. Scatter does likewise with _scatterRng, and jitter added
      // later draws from its own stream too.
      const rSize = this._rng.next();
      const rAngle = this._rng.next();
      const rRound = this._rng.next();
      const rFlow = this._flowRng.next();
      // Colour dynamics read four values per dab (hue, saturation, brightness,
      // fill mix) from their own stream, before anything can skip the dab.
      // Once per stroke they are read at the first dab and kept.
      let colorRolls: ColorRolls | null = null;
      if (this._dynamicColor) {
        if (d.color.perTip) colorRolls = this._rollColor();
        else colorRolls = this._strokeRolls ??= this._rollColor();
      }

      const depletionMult = applyDepletion(ink, state);
      if (depletionMult <= 0) {
        this._prevStamp = stamp;
        continue;
      }

      const baseFlow = (d.pressureOpacity ? d.flow * stamp.pressure : d.flow) *
        speedFactor(d.dynamics.flowVelocity, stamp.velocity);
      const effectiveFlow = applyBuildup(ink, baseFlow, stamp.speedPxPerMs);

      const nominal = this._sizeAt(stamp);
      const baseRotation = computeStampRotation(stamp, this._prevStamp, state.prevRotation, d.tip);
      // Direction following reads prevRotation, so neither jitter nor scatter touches it.
      state.prevRotation = baseRotation;
      const lean = tiltStretch(stamp.tiltX, stamp.tiltY, d.dynamics.tilt);

      // Scatter lays `count` dabs around the stamp's spot, each shifted by up to
      // `amount` dab diameters. The extras are drawn on top of the stamp and
      // touch nothing the path keeps (distance, rotation, previous stamp), so
      // spacing, ink depletion and direction following run as without them.
      // Everything random about them comes from _scatterRng, never the main
      // streams, so a stroke without scatter is untouched.
      let dabs = 1;
      if (scattering) {
        const rCount = this._scatterRng.next();
        dabs = Math.max(1, Math.round(sc.count * (1 - sc.countJitter * rCount)));
      }
      const spread = sc.amount * nominal;
      // Before the stroke has a heading, "across it" means nothing: scatter on both axes.
      const bothAxes = sc.bothAxes || this._heading === null;
      const headingCos = this._heading === null ? 1 : Math.cos(this._heading);
      const headingSin = this._heading === null ? 0 : Math.sin(this._heading);

      for (let k = 0; k < dabs; k++) {
        // The first dab takes the stamp's own jitter values, extras fresh ones.
        let jSize = rSize, jAngle = rAngle, jRound = rRound, jFlow = rFlow;
        let px = stamp.x, py = stamp.y;
        if (scattering) {
          const across = (this._scatterRng.next() * 2 - 1) * spread;
          const along = (this._scatterRng.next() * 2 - 1) * spread;
          if (k > 0) {
            jSize = this._scatterRng.next();
            jAngle = this._scatterRng.next();
            jRound = this._scatterRng.next();
            jFlow = this._scatterRng.next();
          }
          const a = bothAxes ? along : 0;
          px += headingCos * a - headingSin * across;
          py += headingSin * a + headingCos * across;
        }

        // Jitter only ever takes size off, never below a pixel; spacing stays on
        // the un-jittered size (_dabSpacing), as Photoshop does, so it stays even.
        const stampSize = Math.max(1, nominal * (1 - d.jitter.size * jSize));
        // Varying colour comes first, then what the brush picks up mixes into
        // it. The pickup is sampled along the path once per stamp, not at each
        // scattered dab; the extras mix in the stamp's sample.
        if (colorRolls) {
          const dabRolls = k > 0 && d.color.perTip ? this._rollColor() : colorRolls;
          const varied = this._dabColor(dabRolls, stamp.pressure);
          state.originalColor = varied;
          state.currentColor = varied;
          if (k === 0) applyPickup(ink, state, stamp.x, stamp.y, stampSize / 2);
          else if (state.pickedWeight > 0) state.currentColor = lerpOklab(varied, state.pickedColor, state.pickedWeight);
        } else if (k === 0) {
          applyPickup(ink, state, stamp.x, stamp.y, stampSize / 2);
        }
        const diam = quantizeDiameter(stampSize);

        let tip: AnyCanvas;
        if (variantCount > 0) {
          const vi = this._variantCounter % variantCount;
          tip = this._tipCache.getVariant(diam, d.hardness, d.tip, vi);
          this._variantCounter++;
        } else {
          tip = this._tipCache.get(diam, d.hardness, d.tip);
        }

        const rotation = baseRotation + (jAngle - 0.5) * d.jitter.angle * 2 * Math.PI;
        const squash = 1 - d.jitter.roundness * jRound;

        // Each dab keeps between 1 - jitter.flow and all of its alpha. This is
        // Photoshop's opacity jitter: the stroke buffer caps the opacity at
        // commit, so the stroke-level opacity itself is never jittered.
        const stampAlpha = Math.min(1, effectiveFlow * depletionMult) * (1 - d.jitter.flow * jFlow);

        const tipW = tip.width;
        const tipH = tip.height;
        // Tips are cached at an even diameter; draw them stretched to the exact
        // footprint, at the exact (subpixel) position, so thin strokes and
        // pressure tapers don't step in whole pixels.
        const { w: drawW, h: drawH } = tipFootprint(stampSize, d.tip);

        // Half-diagonal covers the tip footprint at any rotation, times the
        // lean's stretch (the squash only shortens a dab); +1 absorbs resampling spill at the fractional edges.
        const reach = Math.sqrt(drawW * drawW + drawH * drawH) / 2 * lean.stretch + 1;
        if (px - reach < this._dirtyMinX) this._dirtyMinX = px - reach;
        if (py - reach < this._dirtyMinY) this._dirtyMinY = py - reach;
        if (px + reach > this._dirtyMaxX) this._dirtyMaxX = px + reach;
        if (py + reach > this._dirtyMaxY) this._dirtyMaxY = py + reach;
        if (px - reach < this._deltaMinX) this._deltaMinX = px - reach;
        if (py - reach < this._deltaMinY) this._deltaMinY = py - reach;
        if (px + reach > this._deltaMaxX) this._deltaMaxX = px + reach;
        if (py + reach > this._deltaMaxY) this._deltaMaxY = py + reach;
        if (this._grain && !this._grain.perTip) {
          if (px - reach < this._grainDeltaMinX) this._grainDeltaMinX = px - reach;
          if (py - reach < this._grainDeltaMinY) this._grainDeltaMinY = py - reach;
          if (px + reach > this._grainDeltaMaxX) this._grainDeltaMaxX = px + reach;
          if (py + reach > this._grainDeltaMaxY) this._grainDeltaMaxY = py + reach;
        }

        // Texture on each tip: the dab is drawn on a scratch canvas, masked by
        // the grain where it lies in the document, then laid on the buffer.
        let dctx = ctx;
        let qx = px, qy = py;
        let box: { x: number; y: number; w: number; h: number } | null = null;
        if (this._grain?.perTip) {
          box = this._dabBox(px, py, reach);
          if (!box) continue;
          dctx = this._scratchFor(box);
          qx = px - box.x;
          qy = py - box.y;
        }

        if (this._colorMode) {
          let tint: HTMLCanvasElement;
          if (this._dynamicColor) {
            tint = this._tintedTipFor(tip, state.currentColor) as HTMLCanvasElement;
          } else {
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
            tint = this._tintCanvas as HTMLCanvasElement;
          }
          dctx.globalAlpha = stampAlpha;
          dctx.globalCompositeOperation = 'source-over';
          if (transformDab(dctx, qx, qy, rotation, lean, squash)) {
            dctx.drawImage(tint, 0, 0, tipW, tipH, -drawW / 2, -drawH / 2, drawW, drawH);
            dctx.restore();
          } else {
            dctx.drawImage(tint, 0, 0, tipW, tipH, qx - drawW / 2, qy - drawH / 2, drawW, drawH);
          }
        } else {
          dctx.globalAlpha = stampAlpha;
          dctx.globalCompositeOperation = 'source-over';
          if (transformDab(dctx, qx, qy, rotation, lean, squash)) {
            drawImageSafe(dctx, tip, -drawW / 2, -drawH / 2, drawW, drawH);
            dctx.restore();
          } else {
            drawImageSafe(dctx, tip, qx - drawW / 2, qy - drawH / 2, drawW, drawH);
          }
        }
        if (box) this._layGrainedDab(ctx, dctx, box, stamp.pressure);
      }

      this._prevStamp = stamp;
    }
    ctx.globalAlpha = 1;
  }

  private _resetGrainDelta() {
    this._grainDeltaMinX = Infinity;
    this._grainDeltaMinY = Infinity;
    this._grainDeltaMaxX = -Infinity;
    this._grainDeltaMaxY = -Infinity;
  }

  /** The part of the document a dab reaching `reach` from (px, py) can touch, whole pixels; null when none of it is on the document. */
  private _dabBox(px: number, py: number, reach: number): { x: number; y: number; w: number; h: number } | null {
    const x = Math.max(0, Math.floor(px - reach));
    const y = Math.max(0, Math.floor(py - reach));
    const w = Math.min(this._docWidth, Math.ceil(px + reach)) - x;
    const h = Math.min(this._docHeight, Math.ceil(py + reach)) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  /** The cleared scratch canvas's context a dab over `box` is drawn on. Clipped to the document, so a huge dab costs at most one document's worth. */
  private _scratchFor(box: { w: number; h: number }) {
    if (!this._dabScratch || this._dabScratch.width < box.w || this._dabScratch.height < box.h) {
      this._dabScratch = createOffscreenCanvas(Math.max(box.w, this._dabScratch?.width ?? 0), Math.max(box.h, this._dabScratch?.height ?? 0));
    }
    const sctx = get2dContext(this._dabScratch, { willReadFrequently: true });
    sctx.clearRect(0, 0, box.w, box.h);
    return sctx;
  }

  /** Apply the grain to the dab drawn on the scratch canvas and lay it on the stroke buffer. */
  private _layGrainedDab(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    sctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    box: { x: number; y: number; w: number; h: number },
    pressure: number,
  ) {
    const grain = this._grain!;
    const img = sctx.getImageData(0, 0, box.w, box.h);
    applyGrain(img.data, box.w, box.h, box.x, box.y, grain, grain.depthPressure ? grain.depth * Math.max(0, Math.min(1, pressure)) : grain.depth);
    sctx.putImageData(img, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this._dabScratch as HTMLCanvasElement, 0, 0, box.w, box.h, box.x, box.y, box.w, box.h);
  }

  /**
   * The stroke buffer with the grain applied to everything stamped since this
   * last ran (the buffer stays as the dabs built it, so later dabs go on
   * accumulating); the buffer itself when the stroke has no grain, or grains
   * each dab. Preview and commit both read this, so they show the same pixels.
   */
  private _grainedBuffer(): AnyCanvas | null {
    const buf = this._bufferPool.current;
    if (!buf || !this._grain || this._grain.perTip) return buf;
    if (!this._grainCanvas || this._grainCanvas.width !== this._docWidth || this._grainCanvas.height !== this._docHeight) {
      this._grainCanvas = createOffscreenCanvas(this._docWidth, this._docHeight);
    }
    if (this._grainDeltaMaxX >= this._grainDeltaMinX) {
      const x = Math.max(0, Math.floor(this._grainDeltaMinX));
      const y = Math.max(0, Math.floor(this._grainDeltaMinY));
      const w = Math.min(this._docWidth, Math.ceil(this._grainDeltaMaxX)) - x;
      const h = Math.min(this._docHeight, Math.ceil(this._grainDeltaMaxY)) - y;
      if (w > 0 && h > 0) {
        const img = get2dContext(buf).getImageData(x, y, w, h);
        applyGrain(img.data, w, h, x, y, this._grain);
        get2dContext(this._grainCanvas).putImageData(img, x, y);
      }
      this._resetGrainDelta();
    }
    return this._grainCanvas;
  }

  private _rollColor(): ColorRolls {
    const r = this._colorRng;
    return { hue: r.next(), saturation: r.next(), brightness: r.next(), fgBg: r.next() };
  }

  /**
   * The colour of a dab under colour dynamics. With variation once per stroke
   * it is worked out at the first dab and kept, pressure included.
   */
  private _dabColor(rolls: ColorRolls, pressure: number): string {
    const d = this._descriptor!;
    if (!d.color.perTip && this._strokeDabColor !== null) return this._strokeDabColor;
    const c = varyColor(this._color, this._secondary || this._color, d.color, rolls, pressure);
    if (!d.color.perTip) this._strokeDabColor = c;
    return c;
  }

  /**
   * `tip` tinted `color`, kept for reuse. Retinting a tip is a clear, a draw
   * and a fill the size of the tip, so a stroke of changing colour would pay
   * that at every dab; colours are snapped to steps (varyColor) so the same
   * ones come round again. The tinted tips live in slots all of one size (the
   * largest tip so far, rounded up; the shared tint canvas is cropped the
   * same way), at most TINT_CACHE_BYTES of them: a miss on a full cache
   * redraws the oldest slot rather than allocating, whatever size the tips
   * vary over. A tip too big for the slots starts the cache afresh with
   * bigger ones, which only happens as the stroke's largest dab grows.
   */
  private _tintedTipFor(tip: AnyCanvas, color: string): AnyCanvas {
    const w = Math.ceil((tip.width + TINT_EDGE) / TINT_SLOT_STEP) * TINT_SLOT_STEP;
    const h = Math.ceil((tip.height + TINT_EDGE) / TINT_SLOT_STEP) * TINT_SLOT_STEP;
    if (w > this._slotW || h > this._slotH) {
      this._tintCache.clear();
      this._slotW = Math.max(this._slotW, w);
      this._slotH = Math.max(this._slotH, h);
    }
    let id = this._tipIds.get(tip);
    if (id === undefined) this._tipIds.set(tip, id = this._nextTipId++);
    const key = `${id}|${color}`;
    const hit = this._tintCache.get(key);
    if (hit) {
      this._tintCache.delete(key);
      this._tintCache.set(key, hit);
      return hit;
    }
    const slots = Math.max(1, Math.min(TINT_CACHE_ENTRIES, Math.floor(TINT_CACHE_BYTES / (this._slotW * this._slotH * 4))));
    let canvas: AnyCanvas | undefined;
    if (this._tintCache.size >= slots) {
      const oldest = this._tintCache.keys().next().value!;
      canvas = this._tintCache.get(oldest);
      this._tintCache.delete(oldest);
    }
    canvas ??= createOffscreenCanvas(this._slotW, this._slotH);
    const tCtx = get2dContext(canvas);
    tCtx.globalCompositeOperation = 'source-over';
    tCtx.clearRect(0, 0, tip.width + TINT_EDGE, tip.height + TINT_EDGE);
    drawImageSafe(tCtx, tip, 0, 0);
    tintAlphaMask(tCtx, color, tip.width, tip.height);
    // A dab is drawn from the top-left of its slot at a fractional size, and
    // the resampling reads past the tip's edge: on a tip-sized canvas that is
    // the edge pixel again, in a slot it would be clear padding and soften
    // the dab. So the edge is copied out, one pixel at a time (exact copies).
    const src = canvas as HTMLCanvasElement;
    for (let i = 0; i < TINT_EDGE; i++) {
      tCtx.drawImage(src, tip.width - 1, 0, 1, tip.height, tip.width + i, 0, 1, tip.height);
    }
    for (let i = 0; i < TINT_EDGE; i++) {
      tCtx.drawImage(src, 0, tip.height - 1, tip.width + TINT_EDGE, 1, 0, tip.height + i, tip.width + TINT_EDGE, 1);
    }
    this._tintCache.set(key, canvas);
    return canvas;
  }

  private _clearTintCache() {
    this._tintCache.clear();
    this._slotW = 0;
    this._slotH = 0;
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
      this._descriptor.blendMode,
      this._alphaLocked,
      this._grain && !this._grain.perTip ? this._grainedBuffer() : null,
    );
    this._descriptor = null;
    this._inkState = null;
    this._clearTintCache();
    return true;
  }

  cancel() {
    this._descriptor = null;
    this._inkState = null;
    this._clearTintCache();
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

  /**
   * A dab's diameter at a point of the path: pressure, speed and the fades
   * multiply, then it is held to at least a pixel. Spacing asks this at points
   * the walk is only trying, so it must read nothing but the point.
   */
  private _sizeAt(at: StampPoint): number {
    const d = this._descriptor!;
    const min = d.dynamics.minSize;
    const size = d.pressureSize ? d.size * (min + (1 - min) * at.pressure) : d.size;
    return Math.max(1, size * speedFactor(d.dynamics.sizeVelocity, at.velocity) * this._fadeFactor(at));
  }

  /**
   * How much the fades leave of a dab's size at a point: the size fade runs
   * over the whole stroke's path, falling linearly to `minSize`, and the start
   * taper rises from `minSize` to 1 over the segment's first `taperStart` px,
   * eased by smoothstep so the tip comes to a point instead of a cone with a
   * kink where it ends. There is no end taper: that needs the stroke's end,
   * which isn't known while the dabs are laid.
   */
  private _fadeFactor(at: StampPoint): number {
    const { sizeLength, taperStart } = this._descriptor!.fade;
    let factor = 1;
    if (sizeLength > 0 || taperStart > 0) {
      const min = this._descriptor!.dynamics.minSize;
      if (sizeLength > 0) factor *= 1 - Math.min(1, (this._distBase + at.pathDist) / sizeLength) * (1 - min);
      if (taperStart > 0) {
        const t = Math.min(1, at.pathDist / taperStart);
        factor *= min + (1 - min) * t * t * (3 - 2 * t);
      }
    }
    return factor;
  }

  /**
   * The distance a dab at `at`, laid along `heading`, wants to the next,
   * from its own size and lean (the spline lays a segment a sample late,
   * so the newest sample's would be another dab's: a pause after a thin,
   * fast run would gap it). The smoother lays the next dab where either
   * dab's spacing runs out, so a steep taper stays joined.
   */
  private _dabSpacing = (at: StampPoint, heading: number | null): number => {
    const d = this._descriptor!;
    return Math.max(1, d.spacing * this._sizeAt(at) * this._leanSpacing(at, heading));
  };

  /**
   * Stretching a bar along a lean across it shears it, which can pull
   * neighbouring dabs apart: closes the spacing up by as much as the dabs'
   * reach along the stroke shrank, so ones that touched upright still do.
   * Round dabs only grow when stretched.
   */
  private _leanSpacing(at: StampPoint, heading: number | null): number {
    const d = this._descriptor!;
    const lean = tiltStretch(at.tiltX, at.tiltY, d.dynamics.tilt);
    if (lean.stretch === 1 || !BAR_TIPS.has(d.tip.shape)) return 1;
    const angle = d.tip.angle * Math.PI / 180;
    const aspect = Math.max(1, d.tip.aspect);
    const shape = d.tip.shape;
    // As _stampPoints turns it: by the pen where the tip follows it, along
    // the way from the dab before, or at the tip's own angle when there is
    // none yet (and then any way on). A tilt below the upright threshold has
    // a stretch of about 1, so its unknown turn costs nothing worth closing up.
    const byPen = penRotation(at, d.tip);
    const follows = !['fixed', 'tilt', 'twist'].includes(d.tip.orientation);
    const shrink = (h: number) => {
      const rotation = byPen ?? (!follows || heading === null ? angle : h + angle);
      return barReach(shape, aspect, rotation, lean, h) / barReach(shape, aspect, rotation, NO_STRETCH, h);
    };
    return Math.min(1, ...(heading === null ? ANY_HEADING : [heading]).map(shrink));
  }

  private _resetMotion() {
    this._velocity = 0;
    this._velocityLast = null;
    this._velocityDist = 0;
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

  private _resetPreviewDelta() {
    this._deltaMinX = Infinity;
    this._deltaMinY = Infinity;
    this._deltaMaxX = -Infinity;
    this._deltaMaxY = -Infinity;
  }

  /**
   * The region stamped since this was last called (or since begin()), clamped
   * to the document, or null when nothing was. Outside it the stroke buffer is
   * as the preview last saw it, which lets a preview that is costly per pixel
   * redo only this part of the stroke's bounds.
   */
  takePreviewDelta(): { x: number; y: number; w: number; h: number } | null {
    if (this._deltaMaxX < this._deltaMinX) return null;
    const x = Math.max(0, Math.floor(this._deltaMinX));
    const y = Math.max(0, Math.floor(this._deltaMinY));
    const w = Math.min(this._docWidth, Math.ceil(this._deltaMaxX)) - x;
    const h = Math.min(this._docHeight, Math.ceil(this._deltaMaxY)) - y;
    this._resetPreviewDelta();
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
    /** The brush's mode and the layer's alpha lock, which the preview applies as commit does (see paintStroke). */
    mode: BrushBlendMode;
    alphaLocked: boolean;
    color: string | null;
    bounds: { x: number; y: number; w: number; h: number } | null;
  } | null {
    if (!this._descriptor || !this._bufferPool.current) return null;
    return {
      canvas: this._grainedBuffer()!,
      eraser: this._eraser,
      opacity: this._descriptor.opacity,
      mode: this._descriptor.blendMode,
      alphaLocked: this._alphaLocked,
      color: this._colorMode ? null : this._color,
      bounds: this.getDirtyBounds(),
    };
  }
}

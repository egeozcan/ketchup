/** Lag of the strongest stabilizer setting (100 %), in milliseconds. */
export const MAX_STABILIZER_MS = 120;

/** A stabilizer setting in percent, clamped to 0–100; `fallback` when it isn't a number. */
export function normalizeStabilizer(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value!));
}

/** The time constant for a stabilizer setting in percent (0 = off). */
export function stabilizerTimeConstant(percent: number): number {
  return normalizeStabilizer(percent) / 100 * MAX_STABILIZER_MS;
}

/** The most points a stroke's catch-up is laid in. */
const MAX_CATCH_UP_POINTS = 64;
/** The time a catch-up step takes when no move came before it to go by. */
const DEFAULT_STEP_MS = 1000 / 60;

export interface StabilizedPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  timestamp: number;
}

interface PenSample {
  /** How far the pen had gone along its path, in px. */
  s: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
}

/**
 * Pulls the drawn point after the pointer with an exponential moving average
 * over time, not over samples, so it lags the same whether a pen reports at
 * 60 Hz or (coalesced) at 240 Hz. It needs increasing timestamps: while they
 * stand still, so does the point.
 *
 * Pressure and tilt aren't averaged with it: a change would then start as
 * soon as the pen made it, a whole lag before the drawn point gets there.
 * They are read where the pen was when it had gone as far along its path as
 * the average of that distance, which (the average being linear) is exactly
 * the drawn point on a straight stroke at any pace, from the first sample
 * on: a taper lands where the pen made it, a light touchdown doesn't linger,
 * and a pen easing off as it stops does so at the stop. The distance is
 * taken up like a string pulled behind the pen with `slack` to spare, so a
 * hand trembling where it holds (up to twice the slack from side to side)
 * doesn't add up to a way it never went, reading what the pen did there
 * before the drawn point gets there. The price is at a turn back: the
 * first twice the slack of the way back adds nothing, so what the pen did
 * there is read up to that much late.
 */
export class Stabilizer {
  private _tau = 0;
  private _x = 0;
  private _y = 0;
  private _t = 0;
  // The smoothed point before the last move, which paces the catch-up.
  private _prevX = 0;
  private _prevY = 0;
  private _prevT = 0;
  private _rawX = 0;
  private _rawY = 0;
  /**
   * How far the pen has gone (never less than before), and that distance
   * averaged as the position is. Measured as `_anchorS`, the way a point
   * pulled `_slack` behind the pen went, plus how far the pen is from it.
   */
  private _rawS = 0;
  private _anchorX = 0;
  private _anchorY = 0;
  private _anchorS = 0;
  private _slack = 0;
  private _penS = 0;
  /** The pen's pressure and tilt from the drawn point's distance on, oldest first. */
  private _history: PenSample[] = [];
  private _started = false;

  /** Start over, lagging by `timeConstantMs` and taking up `slack` px of tremor. */
  reset(timeConstantMs = this._tau, slack = this._slack) {
    this._tau = timeConstantMs;
    this._slack = Math.max(0, slack);
    this._started = false;
    this._history = [];
  }

  /** The smoothed sample for a raw one at `timestamp` (ms). */
  add(x: number, y: number, pressure: number, timestamp: number, tiltX = 0, tiltY = 0): Omit<StabilizedPoint, 'timestamp'> {
    if (!this._started || this._tau <= 0) {
      this._rawX = x;
      this._rawY = y;
      this._x = x;
      this._y = y;
      this._t = timestamp;
      this._prevX = x;
      this._prevY = y;
      this._prevT = timestamp;
      this._anchorX = x;
      this._anchorY = y;
      this._anchorS = 0;
      this._rawS = 0;
      this._penS = 0;
      this._history = [{ s: 0, pressure, tiltX, tiltY }];
      this._started = true;
      return { x, y, pressure, tiltX, tiltY };
    }
    let off = Math.hypot(x - this._anchorX, y - this._anchorY);
    if (off > this._slack) {
      const pull = (off - this._slack) / off;
      this._anchorX += (x - this._anchorX) * pull;
      this._anchorY += (y - this._anchorY) * pull;
      this._anchorS += off - this._slack;
      off = this._slack;
    }
    this._rawS = Math.max(this._rawS, this._anchorS + off);
    this._rawX = x;
    this._rawY = y;
    this._remember({ s: this._rawS, pressure, tiltX, tiltY });
    const dt = timestamp - this._t;
    if (dt > 0) {
      this._prevX = this._x;
      this._prevY = this._y;
      this._prevT = this._t;
      const a = 1 - Math.exp(-dt / this._tau);
      this._x += (x - this._x) * a;
      this._y += (y - this._y) * a;
      this._penS += (this._rawS - this._penS) * a;
      this._t = timestamp;
    }
    this._trim();
    const pen = this._penAt(this._penS);
    return { x: this._x, y: this._y, pressure: pen.pressure, tiltX: pen.tiltX, tiltY: pen.tiltY };
  }

  /**
   * The way on to where the pointer last was, when the smoothed point still
   * lags behind it, so a stroke can finish there rather than short of it.
   * Laid in steps no longer than the last move, at its speed, so the spline
   * through them doesn't overshoot and speed dynamics and buildup see the
   * stroke's own pace; pressure and tilt play out what the pen did over the
   * rest of its path, so a taper at the lift lands at the end.
   */
  catchUp(): StabilizedPoint[] {
    if (!this._started || this._tau <= 0) return [];
    const dx = this._rawX - this._x;
    const dy = this._rawY - this._y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return [];
    const lastStep = Math.hypot(this._x - this._prevX, this._y - this._prevY);
    const lastDt = this._t - this._prevT;
    const speed = lastStep > 0 && lastDt > 0 ? lastStep / lastDt : 0;
    const n = Math.min(MAX_CATCH_UP_POINTS, Math.ceil(dist / Math.max(1, lastStep)));
    const dt = speed > 0 ? dist / n / speed : DEFAULT_STEP_MS;
    const penFrom = this._penS;
    const penSpan = this._rawS - penFrom;
    const from = { x: this._x, y: this._y, t: this._t };
    const points: StabilizedPoint[] = [];
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const pen = i === n ? this._history[this._history.length - 1] : this._penAt(penFrom + penSpan * f);
      points.push({
        x: from.x + dx * f,
        y: from.y + dy * f,
        pressure: pen.pressure,
        tiltX: pen.tiltX,
        tiltY: pen.tiltY,
        timestamp: from.t + dt * i,
      });
    }
    const end = points[n - 1];
    this._prevX = n > 1 ? points[n - 2].x : from.x;
    this._prevY = n > 1 ? points[n - 2].y : from.y;
    this._prevT = end.timestamp - dt;
    this._x = end.x;
    this._y = end.y;
    this._t = end.timestamp;
    this._penS = this._rawS;
    this._trim();
    return points;
  }

  /**
   * Add a pen sample. Standing still, only the first and the newest sample
   * there matter (how it got there, how it is now), so a long hold doesn't
   * pile up samples.
   */
  private _remember(sample: PenSample) {
    const h = this._history;
    const n = h.length;
    if (n >= 2 && h[n - 1].s === sample.s && h[n - 2].s === sample.s) h[n - 1] = sample;
    else h.push(sample);
  }

  /** Drop samples the drawn point is past, keeping one at or before it to interpolate from. */
  private _trim() {
    const h = this._history;
    let drop = 0;
    while (drop + 1 < h.length && h[drop + 1].s <= this._penS) drop++;
    if (drop > 0) h.splice(0, drop);
  }

  /**
   * The pen's pressure and tilt when it had gone `s` along its path, between
   * the samples around it. Where it stood still, what it did there changes
   * all at once as the drawn point arrives.
   */
  private _penAt(s: number): PenSample {
    const h = this._history;
    let i = 0;
    while (i + 1 < h.length && h[i + 1].s <= s) i++;
    // At or past the newest distance: what the pen does there now.
    if (i + 1 >= h.length) return h[h.length - 1];
    const a = h[i], b = h[i + 1];
    if (!(s > a.s)) return a;
    const f = (s - a.s) / (b.s - a.s);
    return {
      s,
      pressure: a.pressure + (b.pressure - a.pressure) * f,
      tiltX: a.tiltX + (b.tiltX - a.tiltX) * f,
      tiltY: a.tiltY + (b.tiltY - a.tiltY) * f,
    };
  }
}

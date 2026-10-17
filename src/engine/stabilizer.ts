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
  t: number;
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
 * They are delayed by the time constant instead, which is how far behind
 * the drawn point runs on a steady stroke, so a taper lands where the pen
 * made it.
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
  private _rawT = 0;
  /** The pen's pressure and tilt over the last time constant (and the one sample before), oldest first. */
  private _history: PenSample[] = [];
  private _started = false;

  reset(timeConstantMs = this._tau) {
    this._tau = timeConstantMs;
    this._started = false;
    this._history = [];
  }

  /** The smoothed sample for a raw one at `timestamp` (ms). */
  add(x: number, y: number, pressure: number, timestamp: number, tiltX = 0, tiltY = 0): Omit<StabilizedPoint, 'timestamp'> {
    this._rawX = x;
    this._rawY = y;
    if (!this._started || this._tau <= 0) {
      this._x = x;
      this._y = y;
      this._t = timestamp;
      this._prevX = x;
      this._prevY = y;
      this._prevT = timestamp;
      this._rawT = timestamp;
      this._history = [{ t: timestamp, pressure, tiltX, tiltY }];
      this._started = true;
      return { x, y, pressure, tiltX, tiltY };
    }
    this._record({ t: Math.max(timestamp, this._rawT), pressure, tiltX, tiltY });
    const dt = timestamp - this._t;
    if (dt > 0) {
      this._prevX = this._x;
      this._prevY = this._y;
      this._prevT = this._t;
      const a = 1 - Math.exp(-dt / this._tau);
      this._x += (x - this._x) * a;
      this._y += (y - this._y) * a;
      this._t = timestamp;
    }
    const pen = this._penAt(this._rawT - this._tau);
    return { x: this._x, y: this._y, pressure: pen.pressure, tiltX: pen.tiltX, tiltY: pen.tiltY };
  }

  /**
   * The way on to where the pointer last was, when the smoothed point still
   * lags behind it, so a stroke can finish there rather than short of it.
   * Laid in steps no longer than the last move, at its speed, so the spline
   * through them doesn't overshoot and speed dynamics and buildup see the
   * stroke's own pace; pressure and tilt play out what the pen did over the
   * lag, so a taper at the lift lands at the end.
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
    // The pen's samples the drawn point hasn't reached yet.
    const penFrom = Math.max(this._rawT - this._tau, this._history[0].t);
    const penSpan = this._rawT - penFrom;
    const from = { x: this._x, y: this._y, t: this._t };
    const points: StabilizedPoint[] = [];
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const pen = this._penAt(penFrom + penSpan * f);
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
    this._history = [this._history[this._history.length - 1]];
    return points;
  }

  private _record(sample: PenSample) {
    const h = this._history;
    h.push(sample);
    this._rawT = sample.t;
    // Keep one sample at or before the delayed time, to interpolate from.
    const cutoff = sample.t - this._tau;
    let drop = 0;
    while (drop + 1 < h.length && h[drop + 1].t <= cutoff) drop++;
    if (drop > 0) h.splice(0, drop);
  }

  /** The pen's pressure and tilt at time `t`, between the samples around it. */
  private _penAt(t: number): PenSample {
    const h = this._history;
    if (t <= h[0].t) return h[0];
    let i = h.length - 1;
    while (i > 0 && h[i].t > t) i--;
    if (i === h.length - 1) return h[i];
    const a = h[i], b = h[i + 1];
    const f = (t - a.t) / (b.t - a.t);
    return {
      t,
      pressure: a.pressure + (b.pressure - a.pressure) * f,
      tiltX: a.tiltX + (b.tiltX - a.tiltX) * f,
      tiltY: a.tiltY + (b.tiltY - a.tiltY) * f,
    };
  }
}

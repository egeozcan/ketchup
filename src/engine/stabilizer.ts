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
  timestamp: number;
}

/**
 * Pulls the drawn point after the pointer with an exponential moving average
 * over time, not over samples, so it lags the same whether a pen reports at
 * 60 Hz or (coalesced) at 240 Hz. It needs increasing timestamps: while they
 * stand still, so does the point.
 */
export class Stabilizer {
  private _tau = 0;
  private _x = 0;
  private _y = 0;
  private _pressure = 0;
  private _t = 0;
  // The smoothed point before the last move, which paces the catch-up.
  private _prevX = 0;
  private _prevY = 0;
  private _prevT = 0;
  private _rawX = 0;
  private _rawY = 0;
  private _rawPressure = 0;
  private _rawT = 0;
  private _started = false;

  reset(timeConstantMs = this._tau) {
    this._tau = timeConstantMs;
    this._started = false;
  }

  /**
   * The smoothed sample for a raw one at `timestamp` (ms). Pressure trails
   * with the position, so a taper lands where the pen made it.
   */
  add(x: number, y: number, pressure: number, timestamp: number): { x: number; y: number; pressure: number } {
    this._rawX = x;
    this._rawY = y;
    this._rawPressure = pressure;
    this._rawT = timestamp;
    if (!this._started || this._tau <= 0) {
      this._x = x;
      this._y = y;
      this._pressure = pressure;
      this._t = timestamp;
      this._prevX = x;
      this._prevY = y;
      this._prevT = timestamp;
      this._started = true;
      return { x, y, pressure };
    }
    const dt = timestamp - this._t;
    if (dt > 0) {
      this._prevX = this._x;
      this._prevY = this._y;
      this._prevT = this._t;
      const a = 1 - Math.exp(-dt / this._tau);
      this._x += (x - this._x) * a;
      this._y += (y - this._y) * a;
      this._pressure += (pressure - this._pressure) * a;
      this._t = timestamp;
    }
    return { x: this._x, y: this._y, pressure: this._pressure };
  }

  /**
   * The way on to where the pointer last was, when the smoothed point still
   * lags behind it, so a stroke can finish there rather than short of it.
   * Laid in steps no longer than the last move and as quick, so the spline
   * through them doesn't overshoot and buildup sees the stroke's own speed;
   * pressure goes to the pointer's along the way.
   */
  catchUp(): StabilizedPoint[] {
    if (!this._started || this._tau <= 0) return [];
    const dx = this._rawX - this._x;
    const dy = this._rawY - this._y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return [];
    const lastStep = Math.hypot(this._x - this._prevX, this._y - this._prevY);
    const lastDt = this._t - this._prevT;
    const n = Math.min(MAX_CATCH_UP_POINTS, Math.ceil(dist / Math.max(1, lastStep)));
    const dt = lastStep > 0 && lastDt > 0 ? lastDt : DEFAULT_STEP_MS;
    const from = { x: this._x, y: this._y, pressure: this._pressure, t: this._t };
    const points: StabilizedPoint[] = [];
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      points.push({
        x: from.x + dx * f,
        y: from.y + dy * f,
        pressure: from.pressure + (this._rawPressure - from.pressure) * f,
        timestamp: from.t + dt * i,
      });
    }
    const end = points[n - 1];
    this._prevX = n > 1 ? points[n - 2].x : from.x;
    this._prevY = n > 1 ? points[n - 2].y : from.y;
    this._prevT = end.timestamp - dt;
    this._x = end.x;
    this._y = end.y;
    this._pressure = end.pressure;
    this._t = end.timestamp;
    return points;
  }
}

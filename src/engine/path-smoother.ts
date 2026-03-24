import type { StampPoint } from './types.js';

interface RawPoint {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Catmull-Rom spline interpolator for pointer events.
 * Subdivides curves by arc-length spacing, never by timestamp.
 * Lerps pressure between bracketing raw samples.
 *
 * Uses a rolling window of 4 points to avoid unbounded array growth.
 */
export class PathSmoother {
  /** Rolling window — at most 4 points (oldest evicted as new ones arrive). */
  private _window: RawPoint[] = [];
  /** Total number of points received (not stored). */
  private _count = 0;
  private _remainder = 0; // leftover distance from last subdivision

  reset() {
    this._window = [];
    this._count = 0;
    this._remainder = 0;
  }

  /**
   * Feed a new raw pointer sample. Returns stamp positions along the
   * smoothed path spaced at `spacing` pixel intervals.
   */
  addPoint(x: number, y: number, pressure: number, spacing: number): StampPoint[] {
    const pt: RawPoint = { x, y, pressure };
    this._count++;

    // Maintain rolling window of at most 4 points
    this._window.push(pt);
    if (this._window.length > 4) {
      this._window.shift();
    }

    const n = this._count;

    // Single point (stroke start dot)
    if (n === 1) {
      this._remainder = spacing;
      return [{ x, y, pressure }];
    }

    // Second point: linear interpolation (only linear segment we emit)
    if (n === 2) {
      return this._walkLinear(this._window[0], this._window[1], spacing);
    }

    // Third point: buffer — wait for 4th point to start Catmull-Rom.
    // Walking linearly here would double-emit this segment when the
    // CR walk covers it at n=4.
    if (n === 3) {
      return [];
    }

    // 4+ points: Catmull-Rom between window[1] and window[2]
    // window has exactly 4 entries: [P0, P1, P2, P3]
    // CR curve goes from P1 to P2, using P0 and P3 as control points.
    const [p0, p1, p2, p3] = this._window;
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  /** Flush: emit stamps for any remaining un-emitted segment at stroke end. */
  flush(spacing: number): StampPoint[] {
    const n = this._count;
    const w = this._window;
    if (n < 2) return [];

    if (n === 2) {
      // Only 2 points total — the linear segment was already emitted in addPoint.
      // Nothing more to flush.
      return [];
    }

    if (n === 3) {
      // 3 points: we emitted p[0]→p[1] linearly at n=2, but skipped p[1]→p[2]
      // at n=3 (waiting for CR). Flush it linearly now.
      return this._walkLinear(w[w.length - 2], w[w.length - 1], spacing);
    }

    // 4+ points: the last addPoint emitted CR for window[1]→window[2].
    // The un-emitted tail is window[2]→window[3]. Use a mirrored control point.
    const p0 = w[1];
    const p1 = w[2];
    const p2 = w[3];
    const p3: RawPoint = {
      x: p2.x + (p2.x - p1.x),
      y: p2.y + (p2.y - p1.y),
      pressure: p2.pressure,
    };
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  private _walkLinear(from: RawPoint, to: RawPoint, spacing: number): StampPoint[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return [];

    const stamps: StampPoint[] = [];
    let d = this._remainder;

    while (d <= dist) {
      const t = d / dist;
      stamps.push({
        x: from.x + dx * t,
        y: from.y + dy * t,
        pressure: from.pressure + (to.pressure - from.pressure) * t,
      });
      d += spacing;
    }

    this._remainder = d - dist;
    return stamps;
  }

  private _walkCatmullRom(p0: RawPoint, p1: RawPoint, p2: RawPoint, p3: RawPoint, spacing: number): StampPoint[] {
    // Estimate total arc length with 20 subdivisions
    const SUBDIV = 20;
    let totalLen = 0;
    let prevX = p1.x;
    let prevY = p1.y;
    const lengths: number[] = [0];

    for (let i = 1; i <= SUBDIV; i++) {
      const t = i / SUBDIV;
      const cx = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const cy = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      const segLen = Math.sqrt((cx - prevX) ** 2 + (cy - prevY) ** 2);
      totalLen += segLen;
      lengths.push(totalLen);
      prevX = cx;
      prevY = cy;
    }

    if (totalLen < 0.001) return [];

    const stamps: StampPoint[] = [];
    let d = this._remainder;

    while (d <= totalLen) {
      // Find the subdivision segment containing distance d
      let segIdx = 0;
      for (let i = 1; i < lengths.length; i++) {
        if (lengths[i] >= d) { segIdx = i - 1; break; }
      }

      // Interpolate t within this subdivision segment
      const segStart = lengths[segIdx];
      const segEnd = lengths[segIdx + 1];
      const segFrac = segEnd > segStart ? (d - segStart) / (segEnd - segStart) : 0;
      const t = (segIdx + segFrac) / SUBDIV;

      stamps.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
        pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
      });
      d += spacing;
    }

    this._remainder = d - totalLen;
    return stamps;
  }
}

/** Catmull-Rom spline interpolation for a single axis. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

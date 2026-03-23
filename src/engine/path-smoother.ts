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
 */
export class PathSmoother {
  private _points: RawPoint[] = [];
  private _remainder = 0; // leftover distance from last subdivision

  reset() {
    this._points = [];
    this._remainder = 0;
  }

  /**
   * Feed a new raw pointer sample. Returns stamp positions along the
   * smoothed path spaced at `spacing` pixel intervals.
   */
  addPoint(x: number, y: number, pressure: number, spacing: number): StampPoint[] {
    this._points.push({ x, y, pressure });
    const n = this._points.length;

    // Single point (stroke start dot)
    if (n === 1) {
      // Set remainder to spacing so _walkLinear won't re-emit at this position
      this._remainder = spacing;
      return [{ x, y, pressure }];
    }

    // Fewer than 4 points: linear interpolation between last two
    if (n < 4) {
      const from = this._points[n - 2];
      const to = this._points[n - 1];
      return this._walkLinear(from, to, spacing);
    }

    // 4+ points: Catmull-Rom between P1 and P2 using P0 and P3 as control
    const p0 = this._points[n - 4];
    const p1 = this._points[n - 3];
    const p2 = this._points[n - 2];
    const p3 = this._points[n - 1];
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  /** Flush: emit stamps for any remaining segment at stroke end. */
  flush(spacing: number): StampPoint[] {
    const n = this._points.length;
    if (n < 2) return [];

    // Emit remaining segment from second-to-last to last point
    if (n < 4) {
      const from = this._points[n - 2];
      const to = this._points[n - 1];
      return this._walkLinear(from, to, spacing);
    }

    // For 4+ points, the last Catmull-Rom segment is P[-3]→P[-2] with
    // P[-4] and P[-1] as control points. But we already emitted that in
    // addPoint. We need the segment P[-2]→P[-1]:
    const p0 = this._points[n - 3];
    const p1 = this._points[n - 2];
    const p2 = this._points[n - 1];
    // Mirror p2 past p1 for the final control point
    const p3 = { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y), pressure: p2.pressure };
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

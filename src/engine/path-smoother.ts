import type { PathChannels, StampPoint } from './types.js';
import { lerpDegrees } from './angle.js';

interface RawPoint extends PathChannels {
  x: number;
  y: number;
  pressure: number;
  timestamp: number;
}

function lerpChannels(a: PathChannels, b: PathChannels, t: number): PathChannels {
  return {
    velocity: a.velocity + (b.velocity - a.velocity) * t,
    tiltX: a.tiltX + (b.tiltX - a.tiltX) * t,
    tiltY: a.tiltY + (b.tiltY - a.tiltY) * t,
    // An angle goes the short way round; tilt is a vector, which does so by itself.
    twist: lerpDegrees(a.twist, b.twist, t),
  };
}

const DEFAULT_SPEED_PX_PER_MS = 1;

/** The pressure and channels at a point of the path. */
export type PathTarget = PathChannels & { pressure: number };

/**
 * Distance from a stamp to the next: fixed, or what a stamp at `at`,
 * heading `heading` (radians, null before the path has a direction) from
 * the stamp before, would want. Asked of many points along the way, so it
 * must not change anything.
 */
export type Spacing = number | ((at: StampPoint, heading: number | null) => number);
// A stamp's `pathDist` is the path length from the path's start (the smoother's reset) to it.

/** Shortest spacing honoured, so a careless one can't stall a walk. */
const MIN_SPACING = 1e-3;
/** Squared distance below which a stamp keeps the heading of the one before. */
const MIN_HEADING_DIST_SQ = 0.25;
/**
 * Longest step, in px, taken looking for where the next stamp is due: a
 * spacing that narrows and widens again within less than this may be missed.
 */
const SEARCH_STEP = 1;
/** Halvings that place a stamp within the step it fell due in. */
const SEARCH_REFINE = 16;

function spacingOf(spacing: Spacing, at: StampPoint, heading: number | null): number {
  return Math.max(MIN_SPACING, typeof spacing === 'number' ? spacing : spacing(at, heading));
}

/**
 * Catmull-Rom spline interpolator for pointer events.
 * Subdivides curves by arc-length spacing, never by timestamp.
 * Lerps pressure and the other path channels between bracketing raw samples.
 *
 * Uses a rolling window of 4 points to avoid unbounded array growth.
 */
export class PathSmoother {
  /** Rolling window — at most 4 points (oldest evicted as new ones arrive). */
  private _window: RawPoint[] = [];
  /** Total number of points received (not stored). */
  private _count = 0;
  /** The stamp laid last, the spacing it wanted, and the heading it was laid at. */
  private _last: StampPoint | null = null;
  private _lastSpacing = 0;
  private _heading: number | null = null;
  /** How far the path has gone since the last stamp, up to the end of the segments walked. */
  private _since = 0;
  /** The last stamp's path length from the start of the path, which `_since` adds to. */
  private _lastDist = 0;
  /** The unwalked last segment was laid by settle(); the next point's walk would lay it again. */
  private _tailLaid = false;
  /** Stamps laid since the reset: the next one's `dab`. */
  private _laid = 0;

  reset() {
    this._laid = 0;
    this._window = [];
    this._count = 0;
    this._last = null;
    this._lastSpacing = 0;
    this._heading = null;
    this._since = 0;
    this._lastDist = 0;
    this._tailLaid = false;
  }

  /** How many stamps the path has laid since the reset. */
  laidCount(): number {
    return this._laid;
  }

  /** The path's length so far, up to the end of the segments walked. */
  pathLength(): number {
    return this._lastDist + this._since;
  }

  /**
   * Feed a new raw pointer sample. Returns stamp positions along the
   * smoothed path spaced at `spacing` pixel intervals or, given a function,
   * each at the first point where the way since the stamp before reaches
   * the spacing either of them wants: a stamp narrowing ahead pulls the
   * next one in, wherever the samples fell. `channels` are carried to the
   * stamps like pressure, so a segment drawn a sample late still gets the
   * speed and tilt it was drawn with.
   */
  addPoint(x: number, y: number, pressure: number, spacing: Spacing, timestamp = 0, channels: Partial<PathChannels> = {}): StampPoint[] {
    const pt: RawPoint = {
      x, y, pressure, timestamp,
      velocity: channels.velocity ?? 0,
      tiltX: channels.tiltX ?? 0,
      tiltY: channels.tiltY ?? 0,
      twist: channels.twist ?? 0,
    };
    this._count++;

    // Maintain rolling window of at most 4 points
    this._window.push(pt);
    if (this._window.length > 4) {
      this._window.shift();
    }

    const n = this._count;
    const tailLaid = this._tailLaid;
    this._tailLaid = false;

    // Single point (stroke start dot)
    if (n === 1) {
      const stamp: StampPoint = { x, y, pressure, speedPxPerMs: DEFAULT_SPEED_PX_PER_MS, pathDist: 0, dab: 0, velocity: pt.velocity, tiltX: pt.tiltX, tiltY: pt.tiltY, twist: pt.twist };
      this._lay(stamp, spacing);
      return [stamp];
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
    // That segment is the one settle() laid: not again.
    if (tailLaid) return [];
    const [p0, p1, p2, p3] = this._window;
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  /**
   * Lay the unwalked last segment now, as flush() would, but keep the path
   * going: the next point does not lay it again, and a flush right after
   * lays nothing. For a pen that has stopped mid-stroke (an airbrush holds
   * there) where the path should end at the pen without ending the stroke.
   */
  settle(spacing: Spacing): StampPoint[] {
    if (this._tailLaid) return [];
    const stamps = this.flush(spacing);
    // Two points: addPoint laid the segment already and the third point is
    // buffered either way, so there is nothing to skip.
    if (this._count >= 3) this._tailLaid = true;
    return stamps;
  }

  /** Flush: emit stamps for any remaining un-emitted segment at stroke end. */
  flush(spacing: Spacing): StampPoint[] {
    if (this._tailLaid) return [];
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
      timestamp: p2.timestamp + Math.max(0, p2.timestamp - p1.timestamp),
      velocity: p2.velocity,
      tiltX: p2.tiltX,
      tiltY: p2.tiltY,
      twist: p2.twist,
    };
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  private _walkLinear(from: RawPoint, to: RawPoint, spacing: Spacing): StampPoint[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return [];

    const elapsed = to.timestamp - from.timestamp;
    const speedPxPerMs = elapsed > 0 ? dist / elapsed : DEFAULT_SPEED_PX_PER_MS;
    return this._walk(dist, spacing, (d) => {
      const t = d / dist;
      return {
        x: from.x + dx * t,
        y: from.y + dy * t,
        pressure: from.pressure + (to.pressure - from.pressure) * t,
        speedPxPerMs,
        pathDist: 0, dab: 0,
        ...lerpChannels(from, to, t),
      };
    });
  }

  private _walkCatmullRom(p0: RawPoint, p1: RawPoint, p2: RawPoint, p3: RawPoint, spacing: Spacing): StampPoint[] {
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

    const elapsed = p2.timestamp - p1.timestamp;
    const speedPxPerMs = elapsed > 0 ? totalLen / elapsed : DEFAULT_SPEED_PX_PER_MS;
    return this._walk(totalLen, spacing, (d) => {
      // Find the subdivision segment containing distance d
      let segIdx = SUBDIV - 1;
      for (let i = 1; i < lengths.length; i++) {
        if (lengths[i] >= d) { segIdx = i - 1; break; }
      }

      // Interpolate t within this subdivision segment
      const segStart = lengths[segIdx];
      const segEnd = lengths[segIdx + 1];
      const segFrac = segEnd > segStart ? Math.min(1, (d - segStart) / (segEnd - segStart)) : 0;
      const t = (segIdx + segFrac) / SUBDIV;
      return {
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
        pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
        speedPxPerMs,
        pathDist: 0, dab: 0,
        ...lerpChannels(p1, p2, t),
      };
    });
  }

  /**
   * Lay the stamps due on a segment `length` long, `pointAt` giving the
   * stamp at a distance along it, carrying the way left over to the next.
   */
  private _walk(length: number, spacing: Spacing, pointAt: (d: number) => StampPoint): StampPoint[] {
    const stamps: StampPoint[] = [];
    // Where on the segment the way since the last stamp (`_since`) was measured to.
    let start = 0;
    for (;;) {
      const since = this._since;
      const owed = this._lastSpacing - since;
      // The last stamp's own spacing runs out here; a narrower stamp ahead may be due sooner.
      const latest = start + owed;
      let at = -1;
      if (typeof spacing === 'number') {
        if (latest <= length) at = latest;
      } else {
        const due = (d: number) => {
          const p = pointAt(d);
          p.pathDist = this._lastDist + since + (d - start);
          p.dab = this._laid;
          return since + (d - start) >= Math.min(this._lastSpacing, spacingOf(spacing, p, this._headingTo(p)));
        };
        const end = Math.min(length, latest);
        if (since > 0 && due(start)) {
          at = start;
        } else if (end > start) {
          // Step along to the first point it falls due, so a narrowing
          // shorter than a spacing (if not shorter than a step) isn't
          // stepped over, then close in on it.
          const steps = Math.ceil((end - start) / SEARCH_STEP);
          let lo = start;
          for (let i = 1; i <= steps; i++) {
            const d = i === steps ? end : start + (end - start) * i / steps;
            if (d >= latest || due(d)) {
              let hi = d;
              for (let k = 0; k < SEARCH_REFINE; k++) {
                const mid = (lo + hi) / 2;
                if (due(mid)) hi = mid;
                else lo = mid;
              }
              at = hi;
              break;
            }
            lo = d;
          }
        }
      }
      if (at < 0) {
        this._since = since + (length - start);
        return stamps;
      }
      const stamp = pointAt(at);
      stamp.pathDist = this._lastDist + since + (at - start);
      stamp.dab = this._laid;
      this._lay(stamp, spacing);
      stamps.push(stamp);
      start = at;
    }
  }

  /** The heading from the last stamp to one at `at`. */
  private _headingTo(at: StampPoint): number | null {
    const last = this._last;
    if (!last) return null;
    const dx = at.x - last.x, dy = at.y - last.y;
    return dx * dx + dy * dy >= MIN_HEADING_DIST_SQ ? Math.atan2(dy, dx) : this._heading;
  }

  private _lay(stamp: StampPoint, spacing: Spacing) {
    this._heading = this._headingTo(stamp);
    this._last = stamp;
    this._lastDist = stamp.pathDist;
    this._laid++;
    this._lastSpacing = spacingOf(spacing, stamp, this._heading);
    this._since = 0;
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

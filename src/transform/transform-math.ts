import type { Point } from '../types.js';
import type { TransformState, TransformRect, PerspectiveCorners } from './transform-types.js';

/**
 * Compose a DOMMatrix from individual transform parameters.
 * Order: translate to origin → rotate → scale → skew → translate back → translate to position.
 */
export function composeMatrix(state: TransformState): DOMMatrix {
  const cx = state.width / 2;
  const cy = state.height / 2;
  const radX = (state.skewX * Math.PI) / 180;
  const radY = (state.skewY * Math.PI) / 180;
  const cos = Math.cos(state.rotation);
  const sin = Math.sin(state.rotation);

  type Matrix2D = { a: number; b: number; c: number; d: number; e: number; f: number };

  const multiply = (left: Matrix2D, right: Matrix2D): Matrix2D => ({
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  });

  const translate = (x: number, y: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  const rotate = (): Matrix2D => ({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
  const skewX = (): Matrix2D => ({ a: 1, b: 0, c: Math.tan(radX), d: 1, e: 0, f: 0 });
  const skewY = (): Matrix2D => ({ a: 1, b: Math.tan(radY), c: 0, d: 1, e: 0, f: 0 });
  const scale = (): Matrix2D => ({ a: state.scaleX, b: 0, c: 0, d: state.scaleY, e: 0, f: 0 });

  const matrix = [
    translate(state.x + cx, state.y + cy),
    rotate(),
    skewX(),
    skewY(),
    scale(),
    translate(-cx, -cy),
  ].reduce(multiply, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

  return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]);
}

/**
 * Transform a point from document space to the local (untransformed) coordinate
 * system of the float. Used for hit-testing handles on a rotated/skewed selection.
 */
export function docToLocal(p: Point, state: TransformState): Point {
  const matrix = composeMatrix(state);
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(det) < 1e-10) {
    return { x: p.x, y: p.y };
  }

  return {
    x: (matrix.d * p.x - matrix.c * p.y + matrix.c * matrix.f - matrix.d * matrix.e) / det,
    y: (-matrix.b * p.x + matrix.a * p.y + matrix.b * matrix.e - matrix.a * matrix.f) / det,
  };
}

/**
 * Transform a point from local (untransformed) float space to document space.
 * Used for drawing handles at their screen positions.
 */
export function localToDoc(p: Point, state: TransformState): Point {
  const matrix = composeMatrix(state);
  return {
    x: matrix.a * p.x + matrix.c * p.y + matrix.e,
    y: matrix.b * p.x + matrix.d * p.y + matrix.f,
  };
}

/**
 * Get the 4 corners of the transform bounding box in document space.
 * Returns [topLeft, topRight, bottomRight, bottomLeft].
 */
export function getTransformedCorners(state: TransformState): [Point, Point, Point, Point] {
  const { width, height } = state;
  return [
    localToDoc({ x: 0, y: 0 }, state),
    localToDoc({ x: width, y: 0 }, state),
    localToDoc({ x: width, y: height }, state),
    localToDoc({ x: 0, y: height }, state),
  ];
}

/**
 * Get the center of the transform in document space.
 */
export function getTransformCenter(state: TransformState): Point {
  return localToDoc({ x: state.width / 2, y: state.height / 2 }, state);
}

/**
 * Snap an angle to the nearest increment (in radians).
 */
export function snapAngle(angle: number, increment: number): number {
  return Math.round(angle / increment) * increment;
}

/**
 * Constrain a point to move only along one axis from an origin.
 * Locks to whichever axis has the larger delta.
 */
export function constrainToAxis(point: Point, origin: Point): Point {
  const dx = Math.abs(point.x - origin.x);
  const dy = Math.abs(point.y - origin.y);
  if (dx > dy) {
    return { x: point.x, y: origin.y };
  }
  return { x: origin.x, y: point.y };
}

/**
 * Detect tight bounding box of non-transparent pixels in an ImageData.
 * Returns null if the image is fully transparent.
 */
export function detectContentBounds(imageData: ImageData): TransformRect | null {
  const { data, width, height } = imageData;
  // minY < 0 means no opaque row has been seen yet (i.e. fully transparent).
  let minX = width, minY = -1, maxX = -1, maxY = -1;

  // Per row, only the first and last opaque pixels matter; columns already
  // inside the running [minX, maxX] range are never rescanned.
  for (let y = 0; y < height; y++) {
    const rowAlpha = y * width * 4 + 3;
    let x = 0;
    while (x < width && data[rowAlpha + x * 4] === 0) x++;
    if (x === width) continue;
    if (minY < 0) minY = y;
    maxY = y;
    if (x < minX) minX = x;
    let r = width - 1;
    while (r > maxX && data[rowAlpha + r * 4] === 0) r--;
    if (r > maxX) maxX = r;
  }

  if (minY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// --- Perspective warp ---

/**
 * Compute the 4 destination corners for perspective warp: each corner of the
 * float moved by its offset in the float's own (untransformed) space, then
 * transformed, so the warp turns, flips and scales with the float.
 */
export function getPerspectiveDestCorners(
  state: TransformState,
  offsets: PerspectiveCorners,
): [Point, Point, Point, Point] {
  const m = composeMatrix(state);
  const at = (x: number, y: number): Point => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const { width: w, height: h } = state;
  return [
    at(offsets.nw.x, offsets.nw.y),
    at(w + offsets.ne.x, offsets.ne.y),
    at(w + offsets.se.x, h + offsets.se.y),
    at(offsets.sw.x, h + offsets.sw.y),
  ];
}

/**
 * A destination quad as `warpPerspective` (and its GPU twin in
 * `perspective-gl.ts`) uses it. Everything is relative to the first corner,
 * which keeps the numbers small for the GPU's single precision.
 */
export interface WarpGeometry {
  /** The first corner, in document space. */
  ax: number;
  ay: number;
  /** The corners, relative to the first. */
  quad: [Point, Point, Point, Point];
  /** P(u, v) = e·u + f·v + g·u·v maps the source's unit square onto the quad. */
  ex: number; ey: number; fx: number; fy: number; gx: number; gy: number;
  /** Solving P(u, v) = p for v gives k2·v² + k1·v + k0 = 0, with k1 = ef + p × g. */
  k2: number;
  ef: number;
  /** k2 is negligible: the quad is a parallelogram and v solves a linear equation. */
  linear: boolean;
  /**
   * A convex quad is exactly the image of the source rectangle. Past a concave
   * corner the map folds outside the outline, so there the outline itself
   * decides what is inside (the source rectangle still covers all of it).
   */
  convex: boolean;
  /** Encloses nothing (a convex quad of zero area). */
  empty: boolean;
  /**
   * Convex only: per edge, [nx, ny, c, r], where nx·x + ny·y + c is a point's
   * distance inside the edge's line and r is half a pixel's extent across it,
   * so a pixel is wholly inside the line when its centre is r inside it and
   * wholly outside when r outside. A zero-length edge never excludes anything.
   */
  lines: Float64Array;
  /**
   * Two closed lobes of four edges each, [px, py, qx, qy] per edge; unused
   * edges are zero. The quad itself, or a self-intersecting quad's two
   * triangles, whose winding numbers have opposite signs: what a pixel's
   * square has of each lobe adds up to its nonzero-winding coverage.
   */
  lobes: Float64Array;
  /** The middle of each lobe's corners (the first lobe's again for a missing second). */
  centroids: [Point, Point];
}

/** Large enough to never exclude a pixel, small enough for single precision. */
const NEVER = 1e30;

export function warpGeometry(dst: [Point, Point, Point, Point]): WarpGeometry {
  const [a, b, c, d] = dst;
  const quad = dst.map(p => ({ x: p.x - a.x, y: p.y - a.y })) as [Point, Point, Point, Point];
  const ex = b.x - a.x, ey = b.y - a.y;
  const fx = d.x - a.x, fy = d.y - a.y;
  const gx = a.x - b.x + c.x - d.x, gy = a.y - b.y + c.y - d.y;
  const k2 = gx * fy - gy * fx;
  const ef = ex * fy - ey * fx;
  const convex = isConvex(dst);

  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i], n = quad[(i + 1) % 4];
    area += p.x * n.y - n.x * p.y;
  }
  const lines = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    const p = quad[i], n = quad[(i + 1) % 4];
    const len = Math.hypot(n.x - p.x, n.y - p.y);
    if (len === 0 || area === 0) {
      lines.set([0, 0, NEVER, 0], i * 4);
      continue;
    }
    const sign = area > 0 ? 1 : -1;
    const nx = -sign * (n.y - p.y) / len, ny = sign * (n.x - p.x) / len;
    lines.set([nx, ny, -(nx * p.x + ny * p.y), (Math.abs(nx) + Math.abs(ny)) / 2], i * 4);
  }

  const lobes = new Float64Array(32);
  const edges = (offset: number, pts: Point[]) => {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], n = pts[(i + 1) % pts.length];
      lobes.set([p.x, p.y, n.x, n.y], offset + i * 4);
    }
  };
  const [qa, qb, qc, qd] = quad;
  const x = segmentCrossing(qa, qb, qc, qd), y = x ? null : segmentCrossing(qb, qc, qd, qa);
  if (x) {
    edges(0, [x, qb, qc]);
    edges(16, [x, qd, qa]);
  } else if (y) {
    edges(0, [y, qc, qd]);
    edges(16, [y, qa, qb]);
  } else {
    edges(0, quad);
  }
  const centroids = [0, 16].map(offset => {
    let x = 0, y = 0, n = 0;
    for (let i = offset; i < offset + 16; i += 4) {
      if (lobes[i] === lobes[i + 2] && lobes[i + 1] === lobes[i + 3]) continue;
      x += lobes[i];
      y += lobes[i + 1];
      n++;
    }
    return n > 0 ? { x: x / n, y: y / n } : null;
  });
  const first = centroids[0] ?? { x: 0, y: 0 };

  return {
    ax: a.x, ay: a.y, quad, ex, ey, fx, fy, gx, gy, k2, ef,
    // Also where k2 would be 0 in the GPU's single precision.
    linear: Math.abs(k2) <= 1e-9 * Math.abs(ef) || Math.fround(k2) === 0,
    convex, empty: convex && area === 0, lines, lobes, centroids: [first, centroids[1] ?? first],
  };
}

/** Where segments p1–p2 and p3–p4 cross, strictly inside both; null if they don't. */
function segmentCrossing(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (den === 0) return null;
  const wx = p3.x - p1.x, wy = p3.y - p1.y;
  const t = (wx * d2y - wy * d2x) / den, s = (wx * d1y - wy * d1x) / den;
  if (!(t > 0 && t < 1 && s > 0 && s < 1)) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Warp `src` onto the quad `dst` (top-left, top-right, bottom-right,
 * bottom-left), returning the pixels of `region` in document space.
 *
 * Every pixel is mapped back through the inverse of the bilinear map from the
 * source rectangle onto the quad and sampled bilinearly with premultiplied
 * alpha, so there is no triangle mesh to leave seams at its edges. Pixels the
 * outline crosses are covered by the exact area of their square inside it, so
 * sharp corners taper as they should, and the source is clamped at its
 * border, so an enlarged edge stays crisp. A concave or self-intersecting quad
 * is filled up to its outline (nonzero winding), where the map folds past it.
 * Each pixel depends only on its own position, so a region is exactly that
 * crop of the whole warp.
 */
export function warpPerspective(
  src: ImageData,
  dst: [Point, Point, Point, Point],
  region: TransformRect,
): ImageData {
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const out = new ImageData(rw, rh);
  const g = warpGeometry(dst);
  if (g.empty) return out;
  const o = out.data, s = src.data, W = src.width, H = src.height;
  const { quad, lines, lobes, convex } = g;
  const nearest = { x: 0, y: 0, ex: 0, ey: 0 };
  const uv = { u: 0, v: 0 };

  for (let py = 0; py < rh; py++) {
    const [spanStart, spanEnd] = quadRowSpan(dst, ry + py, rx, rw);
    // Pixel centres, relative to the first corner.
    const cy = ry + py + 0.5 - g.ay;
    for (let px = spanStart; px < spanEnd; px++) {
      const cx = rx + px + 0.5 - g.ax;
      let coverage: number, inside: boolean, dist = Infinity;
      if (convex) {
        // A pixel wholly outside any edge's line is outside the quad; one
        // wholly inside all of them is inside it.
        let full = true;
        inside = true;
        let i = 0;
        for (; i < 16; i += 4) {
          const d = lines[i] * cx + lines[i + 1] * cy + lines[i + 2];
          if (d <= -lines[i + 3]) break;
          if (d < lines[i + 3]) full = false;
          if (d < 0) inside = false;
        }
        if (i < 16) continue;
        coverage = full ? 1 : pixelCoverage(lobes, cx - 0.5, cy - 0.5);
      } else {
        // Only a pixel within √½ of the outline can straddle it.
        const d2 = nearestOnQuad(quad, cx, cy, nearest);
        inside = quadWinding(quad, cx, cy) !== 0;
        coverage = d2 < 0.5 ? pixelCoverage(lobes, cx - 0.5, cy - 0.5) : inside ? 1 : 0;
        dist = Math.sqrt(d2);
      }
      if (coverage <= 0) continue;

      // A pixel whose centre is outside the outline takes its colour from a
      // quarter pixel inside the nearest outline point. So does one just
      // inside a quad that isn't convex: the map there may show parts of the
      // source folded away past the outline.
      let hx = cx, hy = cy;
      if (!inside || dist < 0.25) {
        if (convex) nearestOnQuad(quad, cx, cy, nearest);
        const len = Math.hypot(nearest.ex, nearest.ey);
        if (len > 0) {
          const nx = -0.25 * nearest.ey / len, ny = 0.25 * nearest.ex / len;
          if (quadWinding(quad, nearest.x + nx, nearest.y + ny) !== 0) {
            hx = nearest.x + nx;
            hy = nearest.y + ny;
          } else if (quadWinding(quad, nearest.x - nx, nearest.y - ny) !== 0) {
            hx = nearest.x - nx;
            hy = nearest.y - ny;
          } else if (!inside) {
            // Neither side is inside where a sliver is under a quarter pixel
            // thick; the outline itself still maps onto the source's edge.
            hx = nearest.x;
            hy = nearest.y;
          }
        }
      }
      if (!unmapBilinear(g, hx, hy, uv) && !unmapTowardLobes(g, hx, hy, uv)) continue;
      const u = uv.u, v = uv.v;

      let sx = u * W - 0.5, sy = v * H - 0.5;
      if (sx < 0) sx = 0; else if (sx > W - 1) sx = W - 1;
      if (sy < 0) sy = 0; else if (sy > H - 1) sy = H - 1;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0;
      const tx = sx - x0, ty = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
      const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      // Weight each tap by its alpha: interpolating premultiplied colour keeps
      // transparent texels from darkening the edges of what they surround.
      const a00 = s[i00 + 3] * (1 - tx) * (1 - ty), a10 = s[i10 + 3] * tx * (1 - ty);
      const a01 = s[i01 + 3] * (1 - tx) * ty, a11 = s[i11 + 3] * tx * ty;
      const alpha = a00 + a10 + a01 + a11;
      if (alpha <= 0) continue;
      const inv = 1 / alpha;
      const i = (py * rw + px) * 4;
      // Uint8ClampedArray rounds to nearest on store.
      o[i] = (s[i00] * a00 + s[i10] * a10 + s[i01] * a01 + s[i11] * a11) * inv;
      o[i + 1] = (s[i00 + 1] * a00 + s[i10 + 1] * a10 + s[i01 + 1] * a01 + s[i11 + 1] * a11) * inv;
      o[i + 2] = (s[i00 + 2] * a00 + s[i10 + 2] * a10 + s[i01 + 2] * a01 + s[i11 + 2] * a11) * inv;
      o[i + 3] = alpha * coverage;
    }
  }
  return out;
}

/**
 * The source position (u, v) that the bilinear map takes to (hx, hy),
 * relative to the quad's first corner, written to `out`. Where two do, the one
 * inside (or nearest) the source; where none does, the nearest real solution.
 * Returns false if that is too far outside the source to mean anything.
 */
function unmapBilinear(g: WarpGeometry, hx: number, hy: number, out: { u: number; v: number }): boolean {
  const k1 = g.ef + hx * g.gy - hy * g.gx;
  const k0 = hx * g.ey - hy * g.ex;
  let u: number, v: number;
  if (g.linear) {
    if (k1 === 0) return false;
    v = -k0 / k1;
    u = uAt(g, hx, hy, v);
  } else {
    let disc = k1 * k1 - 4 * k0 * g.k2;
    if (disc < 0) disc = 0;
    const w = Math.sqrt(disc);
    // The roots q/k2 and k0/q, without cancellation; `v` is (-k1 - w) / 2k2.
    const q = -0.5 * (k1 >= 0 ? k1 + w : k1 - w);
    v = k1 >= 0 ? q / g.k2 : k0 / q;
    u = uAt(g, hx, hy, v);
    // With q = 0 both roots are 0.
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1) && q !== 0) {
      const v2 = k1 >= 0 ? k0 / q : q / g.k2;
      const u2 = uAt(g, hx, hy, v2);
      if (outside(u2, v2) < outside(u, v)) { u = u2; v = v2; }
    }
  }
  if (!(u > -1 && u < 2 && v > -1 && v < 2)) return false;
  out.u = u;
  out.v = v;
  return true;
}

/**
 * `unmapBilinear` a hundredth of a pixel from (hx, hy) towards the middle of
 * either lobe. Where a whole source edge maps to one point (corners dragged
 * together, or the crossing of a symmetric bow-tie) that point has no single
 * source position, but just inside the outline next to it does.
 */
function unmapTowardLobes(g: WarpGeometry, hx: number, hy: number, out: { u: number; v: number }): boolean {
  for (const c of g.centroids) {
    const dx = c.x - hx, dy = c.y - hy, len = Math.hypot(dx, dy);
    if (len > 0 && unmapBilinear(g, hx + 0.01 * dx / len, hy + 0.01 * dy / len, out)) return true;
  }
  return false;
}

/**
 * u, given v, from whichever coordinate of P(u, v) depends on u more; far
 * outside the source where neither does (as on the GPU, which can't divide by 0).
 */
function uAt(g: WarpGeometry, hx: number, hy: number, v: number): number {
  const dx = g.ex + g.gx * v, dy = g.ey + g.gy * v;
  if (Math.abs(dx) > Math.abs(dy)) return (hx - g.fx * v) / dx;
  return dy !== 0 ? (hy - g.fy * v) / dy : 1e30;
}

/**
 * How much of the pixel square with top-left corner (x0, y0) the quad covers
 * (nonzero winding), from the lobes of `WarpGeometry.lobes`.
 */
function pixelCoverage(lobes: Float64Array, x0: number, y0: number): number {
  let first = 0, second = 0;
  for (let i = 0; i < 16; i += 4) first += edgeArea(lobes[i], lobes[i + 1], lobes[i + 2], lobes[i + 3], x0, y0);
  for (let i = 16; i < 32; i += 4) second += edgeArea(lobes[i], lobes[i + 1], lobes[i + 2], lobes[i + 3], x0, y0);
  const coverage = Math.abs(first) + Math.abs(second);
  return coverage < 1 ? coverage : 1;
}

/**
 * The edge (px, py)–(qx, qy)'s share of a closed outline's winding number,
 * integrated over the pixel square with top-left corner (x0, y0): the part of
 * the square left of the edge, signed by whether the edge goes up or down.
 * Summed over a closed outline, the edges give the area of the square it
 * winds around (negative where it winds the other way).
 */
function edgeArea(px: number, py: number, qx: number, qy: number, x0: number, y0: number): number {
  if (py === qy) return 0;
  const top = py < qy ? py : qy, bottom = py < qy ? qy : py;
  const ya = top > y0 ? top : y0, yb = bottom < y0 + 1 ? bottom : y0 + 1;
  if (ya >= yb) return 0;
  const slope = (qx - px) / (qy - py);
  // Where the edge is across the square at its top and bottom, 0 to 1.
  const la = px + (ya - py) * slope - x0, lb = px + (yb - py) * slope - x0;
  const area = (yb - ya) * meanClamped(la, lb);
  return qy > py ? area : -area;
}

/** The mean of clamp(t, 0, 1) as t runs evenly from `la` to `lb`. */
function meanClamped(la: number, lb: number): number {
  const lo = la < lb ? la : lb, hi = la < lb ? lb : la;
  if (hi <= 0) return 0;
  if (lo >= 1) return 1;
  if (hi === lo) return lo;
  // Past 1 the clamp is 1; between 0 and 1 it is t itself.
  const a = lo > 0 ? lo : 0, b = hi < 1 ? hi : 1;
  return ((hi > 1 ? hi - 1 : 0) + (b - a) * (a + b) / 2) / (hi - lo);
}

/**
 * Squared distance from (x, y) to the quad's outline. The nearest point of the
 * outline, and the vector along its edge, are written to `out`.
 */
function nearestOnQuad(
  q: [Point, Point, Point, Point], x: number, y: number, out: { x: number; y: number; ex: number; ey: number },
): number {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    const qx = n.x - p.x, qy = n.y - p.y, wx = x - p.x, wy = y - p.y;
    const len2 = qx * qx + qy * qy;
    // Corners dragged together: the edges either side say where the outline goes.
    if (len2 === 0) continue;
    let t = (wx * qx + wy * qy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = wx - qx * t, dy = wy - qy * t;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      out.x = p.x + qx * t;
      out.y = p.y + qy * t;
      out.ex = qx;
      out.ey = qy;
    }
  }
  return best;
}

/** How far (u, v) lies outside the unit square, in u/v units; 0 inside, Infinity if undefined. */
function outside(u: number, v: number): number {
  if (u !== u || v !== v) return Infinity;
  const du = u < 0 ? -u : u > 1 ? u - 1 : 0;
  const dv = v < 0 ? -v : v > 1 ? v - 1 : 0;
  return du > dv ? du : dv;
}

/** Whether every corner of the quad turns the same way (or not at all). */
function isConvex(q: [Point, Point, Point, Point]): boolean {
  let left = false, right = false;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4], m = q[(i + 2) % 4];
    const turn = (n.x - p.x) * (m.y - n.y) - (n.y - p.y) * (m.x - n.x);
    if (turn > 0) left = true;
    else if (turn < 0) right = true;
  }
  return !(left && right);
}

/** The quad outline's winding number around (x, y): nonzero inside. */
function quadWinding(q: [Point, Point, Point, Point], x: number, y: number): number {
  let winding = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    const side = (n.x - p.x) * (y - p.y) - (x - p.x) * (n.y - p.y);
    if (p.y <= y) {
      if (n.y > y && side > 0) winding++;
    } else if (n.y <= y && side < 0) {
      winding--;
    }
  }
  return winding;
}

/**
 * The columns of row `y` (relative to `rx`, clamped to `[0, rw)`) that the
 * quad's outline comes within a pixel and a half of: everything a warp row
 * can touch, so the rest of the bounding box is skipped.
 */
function quadRowSpan(q: [Point, Point, Point, Point], y: number, rx: number, rw: number): [number, number] {
  const top = y - 1, bottom = y + 2;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    const lo = Math.max(top, Math.min(p.y, n.y)), hi = Math.min(bottom, Math.max(p.y, n.y));
    if (lo > hi) continue;
    // The edge's x at both ends of its part within the band (all of a
    // horizontal edge).
    let x0 = p.x, x1 = n.x;
    if (n.y !== p.y) {
      x0 = p.x + (n.x - p.x) * (lo - p.y) / (n.y - p.y);
      x1 = p.x + (n.x - p.x) * (hi - p.y) / (n.y - p.y);
    }
    min = Math.min(min, x0, x1);
    max = Math.max(max, x0, x1);
  }
  if (min > max) return [0, 0];
  return [
    Math.max(0, Math.floor(min - 1.5) - rx),
    Math.min(rw, Math.ceil(max + 1.5) - rx),
  ];
}

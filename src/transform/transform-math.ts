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
 * Compute the 4 destination corners for perspective warp.
 * Each corner is the affine-transformed position plus a per-corner offset.
 */
export function getPerspectiveDestCorners(
  state: TransformState,
  offsets: PerspectiveCorners,
): [Point, Point, Point, Point] {
  const [tl, tr, br, bl] = getTransformedCorners(state);
  return [
    { x: tl.x + offsets.nw.x, y: tl.y + offsets.nw.y },
    { x: tr.x + offsets.ne.x, y: tr.y + offsets.ne.y },
    { x: br.x + offsets.se.x, y: br.y + offsets.se.y },
    { x: bl.x + offsets.sw.x, y: bl.y + offsets.sw.y },
  ];
}

/**
 * Warp `src` onto the quad `dst` (top-left, top-right, bottom-right,
 * bottom-left), returning the pixels of `region` in document space.
 *
 * Every pixel is mapped back through the inverse of the bilinear map from the
 * source rectangle onto the quad and sampled bilinearly with premultiplied
 * alpha, so there is no triangle mesh to leave seams at its edges. The quad's
 * outline is anti-aliased from each pixel's distance to it, and the source is
 * clamped at its border, so an enlarged edge stays crisp. A concave or
 * self-intersecting quad is filled up to its outline (nonzero winding), where
 * the map folds past it. Each pixel depends only on its own position, so a
 * region is exactly that crop of the whole warp.
 */
export function warpPerspective(
  src: ImageData,
  dst: [Point, Point, Point, Point],
  region: TransformRect,
): ImageData {
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const out = new ImageData(rw, rh);
  const o = out.data, s = src.data, W = src.width, H = src.height;
  const [a, b, c, d] = dst;
  // P(u, v) = a + e·u + f·v + g·u·v
  const ex = b.x - a.x, ey = b.y - a.y;
  const fx = d.x - a.x, fy = d.y - a.y;
  const gx = a.x - b.x + c.x - d.x, gy = a.y - b.y + c.y - d.y;
  // Solving P(u, v) = p for v gives k2·v² + k1·v + k0 = 0.
  const k2 = gx * fy - gy * fx;
  const ef = ex * fy - ey * fx;
  const linear = Math.abs(k2) <= 1e-9 * Math.abs(ef);
  const ik2 = 0.5 / k2;
  const uAt = (hx: number, hy: number, v: number) => {
    const dx = ex + gx * v, dy = ey + gy * v;
    return Math.abs(dx) > Math.abs(dy) ? (hx - fx * v) / dx : (hy - fy * v) / dy;
  };
  // A convex quad is exactly the image of the source rectangle. Past a concave
  // corner the map folds outside the outline, so there the outline itself
  // decides what is inside (the source rectangle still covers all of it).
  const convex = isConvex(dst);

  const nearest = { x: 0, y: 0, ex: 0, ey: 0 };

  for (let py = 0; py < rh; py++) {
    const [spanStart, spanEnd] = quadRowSpan(dst, ry + py, rx, rw);
    const cy = ry + py + 0.5;
    for (let px = spanStart; px < spanEnd; px++) {
      const cx = rx + px + 0.5;
      let hx = cx - a.x, hy = cy - a.y;
      // A quad that isn't convex is covered by its outline alone, anti-aliased
      // from the distance to it. On and just outside the outline, the map shows
      // folded-away parts of the source if anything, so a pixel there takes its
      // colour from a quarter pixel inside the nearest outline point.
      let coverage = 1;
      if (!convex) {
        const dist = Math.sqrt(nearestOnQuad(dst, cx, cy, nearest));
        const inside = quadWinding(dst, cx, cy) !== 0;
        coverage = inside ? 0.5 + dist : 0.5 - dist;
        if (coverage <= 0) continue;
        if (coverage > 1) coverage = 1;
        const len = Math.hypot(nearest.ex, nearest.ey);
        if ((!inside || dist < 0.25) && len > 0) {
          const nx = -0.25 * nearest.ey / len, ny = 0.25 * nearest.ex / len;
          const side = quadWinding(dst, nearest.x + nx, nearest.y + ny) !== 0 ? 1 : -1;
          hx = nearest.x + side * nx - a.x;
          hy = nearest.y + side * ny - a.y;
        }
      }

      const k1 = ef + hx * gy - hy * gx;
      const k0 = hx * ey - hy * ex;
      let u: number, v: number;
      if (linear) {
        v = -k0 / k1;
        u = uAt(hx, hy, v);
      } else {
        let disc = k1 * k1 - 4 * k0 * k2;
        if (disc < 0) {
          // Unmapped. Within a non-convex quad's anti-aliased fringe, take
          // the nearest real solution.
          if (convex) continue;
          disc = 0;
        }
        const w = Math.sqrt(disc);
        v = (-k1 - w) * ik2;
        u = uAt(hx, hy, v);
        // Of the two roots, keep the one inside (or nearest) the source.
        if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
          const v2 = (-k1 + w) * ik2;
          const u2 = uAt(hx, hy, v2);
          if (outside(u2, v2) < outside(u, v)) { u = u2; v = v2; }
        }
      }
      if (!(u > -1 && u < 2 && v > -1 && v < 2)) continue;

      if (convex) {
        // Only pixels within half a pixel of the outline are partially covered.
        // Inside, (distance in u or v) × |Jacobian| / |other partial derivative|
        // estimates the distance to the nearest edge cheaply (squared, sparing
        // the square roots); near or outside the outline, where that estimate
        // breaks down, the distance to the edges is measured directly.
        const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
        const mu = u < 1 - u ? u : 1 - u, mv = v < 1 - v ? v : 1 - v;
        const pux = ex + gx * v, puy = ey + gy * v;
        const pvx = fx + gx * u, pvy = fy + gy * u;
        const jac = pux * pvy - puy * pvx;
        const du = mu * jac, dv = mv * jac;
        if (!inside || du * du < 0.25 * (pvx * pvx + pvy * pvy) || dv * dv < 0.25 * (pux * pux + puy * puy)) {
          const dist = Math.sqrt(nearestOnQuad(dst, cx, cy, nearest));
          coverage = inside ? 0.5 + dist : 0.5 - dist;
          if (coverage <= 0) continue;
          if (coverage > 1) coverage = 1;
        }
      }

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
    let t = len2 > 0 ? (wx * qx + wy * qy) / len2 : 0;
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

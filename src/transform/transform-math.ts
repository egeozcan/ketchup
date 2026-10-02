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
 * clamped at its border, so an enlarged edge stays crisp.
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

  for (let py = 0; py < rh; py++) {
    const [spanStart, spanEnd] = quadRowSpan(dst, ry + py, rx, rw);
    const hy = ry + py + 0.5 - a.y;
    let hx = rx + spanStart + 0.5 - a.x;
    let k1 = ef + hx * gy - hy * gx;
    let k0 = hx * ey - hy * ex;
    for (let px = spanStart; px < spanEnd; px++, hx += 1, k1 += gy, k0 += ey) {
      let u: number, v: number;
      if (linear) {
        v = -k0 / k1;
        u = uAt(hx, hy, v);
      } else {
        const disc = k1 * k1 - 4 * k0 * k2;
        if (disc < 0) continue;
        const w = Math.sqrt(disc);
        v = (-k1 - w) * ik2;
        u = uAt(hx, hy, v);
        // Of the two roots, keep the one inside (or nearest) the source.
        if (u < 0 || u > 1 || v < 0 || v > 1) {
          const v2 = (-k1 + w) * ik2;
          const u2 = uAt(hx, hy, v2);
          if (outside(u2, v2) < outside(u, v)) { u = u2; v = v2; }
        }
      }
      if (!(u > -1 && u < 2 && v > -1 && v < 2)) continue;

      // Distance in pixels to the nearest edge is (distance in u or v) times
      // |Jacobian| over the length of the other partial derivative. Only
      // pixels within half a pixel of an edge are partially covered.
      const mu = u < 1 - u ? u : 1 - u, mv = v < 1 - v ? v : 1 - v;
      const pux = ex + gx * v, puy = ey + gy * v;
      const pvx = fx + gx * u, pvy = fy + gy * u;
      let jac = pux * pvy - puy * pvx;
      if (jac < 0) jac = -jac;
      const du = mu * jac, dv = mv * jac;
      let coverage = 1;
      // Squared comparisons spare the square roots for the pixels well inside.
      const lu2 = pvx * pvx + pvy * pvy, lv2 = pux * pux + puy * puy;
      if (du < 0 || dv < 0 || du * du < 0.25 * lu2 || dv * dv < 0.25 * lv2) {
        const dist = Math.min(du / Math.sqrt(lu2), dv / Math.sqrt(lv2));
        if (!(dist > -0.5)) continue;
        if (dist < 0.5) coverage = dist + 0.5;
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

/** How far (u, v) lies outside the unit square, in u/v units; 0 inside. */
function outside(u: number, v: number): number {
  const du = u < 0 ? -u : u > 1 ? u - 1 : 0;
  const dv = v < 0 ? -v : v > 1 ? v - 1 : 0;
  return du > dv ? du : dv;
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
    // The edge's x at both ends of its part within the band.
    for (const yy of [lo, hi]) {
      const x = n.y === p.y ? p.x : p.x + (n.x - p.x) * (yy - p.y) / (n.y - p.y);
      if (x < min) min = x;
      if (x > max) max = x;
    }
    if (n.y === p.y) {
      min = Math.min(min, p.x, n.x);
      max = Math.max(max, p.x, n.x);
    }
  }
  if (min > max) return [0, 0];
  return [
    Math.max(0, Math.floor(min - 1.5) - rx),
    Math.min(rw, Math.ceil(max + 1.5) - rx),
  ];
}

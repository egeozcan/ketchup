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

// --- Perspective mesh warp ---

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
 * Draw a perspective-warped image using triangle mesh subdivision.
 * Subdivides the source image into a grid of triangles and fills each with
 * the source as a pattern under that triangle's affine approximation.
 *
 * Draw into a transparent canvas and composite that onto its destination:
 * for a convex destination quad the triangles are summed with `lighter`,
 * so the anti-aliased coverage of two triangles sharing an edge adds up to
 * the full pixel instead of leaving a faint seam, as source-over would.
 * A concave or folded quad's triangles may overlap, and summing would
 * brighten the overlap, so those fall back to source-over.
 */
export function drawPerspectiveMesh(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  srcCorners: [Point, Point, Point, Point],
  dstCorners: [Point, Point, Point, Point],
  gridSize: number,
): void {
  const pattern = ctx.createPattern(sourceCanvas, 'no-repeat');
  if (!pattern) return;
  const [sTL, sTR, sBR, sBL] = srcCorners;
  const [dTL, dTR, dBR, dBL] = dstCorners;

  ctx.save();
  if (isConvexQuad(dstCorners)) ctx.globalCompositeOperation = 'lighter';
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const u0 = col / gridSize;
      const u1 = (col + 1) / gridSize;
      const v0 = row / gridSize;
      const v1 = (row + 1) / gridSize;

      const sP00 = bilinear(sTL, sTR, sBR, sBL, u0, v0);
      const sP10 = bilinear(sTL, sTR, sBR, sBL, u1, v0);
      const sP01 = bilinear(sTL, sTR, sBR, sBL, u0, v1);
      const sP11 = bilinear(sTL, sTR, sBR, sBL, u1, v1);

      const dP00 = bilinear(dTL, dTR, dBR, dBL, u0, v0);
      const dP10 = bilinear(dTL, dTR, dBR, dBL, u1, v0);
      const dP01 = bilinear(dTL, dTR, dBR, dBL, u0, v1);
      const dP11 = bilinear(dTL, dTR, dBR, dBL, u1, v1);

      drawTexturedTriangle(ctx, pattern, sP00, sP10, sP01, dP00, dP10, dP01);
      drawTexturedTriangle(ctx, pattern, sP10, sP11, sP01, dP10, dP11, dP01);
    }
  }
  ctx.restore();
}

/** True if every turn of the quad goes the same way (no dent, no fold). */
function isConvexQuad(q: [Point, Point, Point, Point]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Bilinear interpolation across a quad. */
function bilinear(tl: Point, tr: Point, br: Point, bl: Point, u: number, v: number): Point {
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/**
 * Fill destination triangle (d0,d1,d2) with the source pattern mapped by the
 * affine transform taking source triangle (s0,s1,s2) onto it.
 */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  pattern: CanvasPattern,
  s0: Point, s1: Point, s2: Point,
  d0: Point, d1: Point, d2: Point,
): void {
  const sx0 = s1.x - s0.x, sy0 = s1.y - s0.y;
  const sx1 = s2.x - s0.x, sy1 = s2.y - s0.y;
  const dx0 = d1.x - d0.x, dy0 = d1.y - d0.y;
  const dx1 = d2.x - d0.x, dy1 = d2.y - d0.y;

  const det = sx0 * sy1 - sx1 * sy0;
  if (Math.abs(det) < 1e-10) return;

  const idet = 1 / det;
  const a = sy1 * idet, b = -sx1 * idet;
  const c = -sy0 * idet, d = sx0 * idet;

  const ma = a * dx0 + c * dx1;
  const mb = b * dx0 + d * dx1;
  const mc = a * dy0 + c * dy1;
  const md = b * dy0 + d * dy1;
  const me = d0.x - ma * s0.x - mb * s0.y;
  const mf = d0.y - mc * s0.x - md * s0.y;

  // The pattern transform is applied on top of the caller's transform: the
  // preview renders into an offscreen canvas translated to the warped bounds' origin.
  pattern.setTransform({ a: ma, b: mc, c: mb, d: md, e: me, f: mf });
  ctx.fillStyle = pattern;
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.fill();
}

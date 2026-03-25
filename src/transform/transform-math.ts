import type { Point } from '../types.js';
import type { TransformState, TransformRect, PerspectiveCorners } from './transform-types.js';

/**
 * Compose a DOMMatrix from individual transform parameters.
 * Order: translate to origin → rotate → scale → skew → translate back → translate to position.
 */
export function composeMatrix(state: TransformState): DOMMatrix {
  const cx = state.width / 2;
  const cy = state.height / 2;

  const m = new DOMMatrix();
  m.translateSelf(state.x + cx, state.y + cy);
  m.rotateSelf((state.rotation * 180) / Math.PI);
  m.skewXSelf(state.skewX);
  m.skewYSelf(state.skewY);
  m.scaleSelf(state.scaleX, state.scaleY);
  m.translateSelf(-cx, -cy);

  return m;
}

/**
 * Transform a point from document space to the local (untransformed) coordinate
 * system of the float. Used for hit-testing handles on a rotated/skewed selection.
 */
export function docToLocal(p: Point, state: TransformState): Point {
  const matrix = composeMatrix(state);
  const inv = matrix.inverse();
  const dp = new DOMPoint(p.x, p.y);
  const lp = inv.transformPoint(dp);
  return { x: lp.x, y: lp.y };
}

/**
 * Transform a point from local (untransformed) float space to document space.
 * Used for drawing handles at their screen positions.
 */
export function localToDoc(p: Point, state: TransformState): Point {
  const matrix = composeMatrix(state);
  const dp = new DOMPoint(p.x, p.y);
  const tp = matrix.transformPoint(dp);
  return { x: tp.x, y: tp.y };
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
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
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
 * Subdivides the source image into a grid of triangles and draws each
 * with an affine approximation.
 */
export function drawPerspectiveMesh(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  srcCorners: [Point, Point, Point, Point],
  dstCorners: [Point, Point, Point, Point],
  gridSize: number,
): void {
  const [sTL, sTR, sBR, sBL] = srcCorners;
  const [dTL, dTR, dBR, dBL] = dstCorners;

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

      drawTexturedTriangle(ctx, sourceCanvas, sP00, sP10, sP01, dP00, dP10, dP01);
      drawTexturedTriangle(ctx, sourceCanvas, sP10, sP11, sP01, dP10, dP11, dP01);
    }
  }
}

/** Bilinear interpolation across a quad. */
function bilinear(tl: Point, tr: Point, br: Point, bl: Point, u: number, v: number): Point {
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/**
 * Draw a single textured triangle using affine transform.
 * Maps source triangle (s0,s1,s2) onto destination triangle (d0,d1,d2).
 */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
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

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(ma, mc, mb, md, me, mf);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

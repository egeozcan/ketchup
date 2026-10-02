import type { Point } from '../types.js';
import type { HandleType, HandleConfig } from './transform-types.js';

/** The transform's corners as shown: top-left, top-right, bottom-right, bottom-left. */
type Corners = [Point, Point, Point, Point];

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Get handle positions in document space: on the corners as shown (so on a
 * perspective warp's corners) and halfway along its edges.
 */
export function getDocHandlePositions(corners: Corners): Record<HandleType, Point> {
  const [nw, ne, se, sw] = corners;
  return { nw, n: mid(nw, ne), ne, e: mid(ne, se), se, s: mid(se, sw), sw, w: mid(sw, nw) };
}

/** The middle of the corners: the transform's centre, or a perspective warp's. */
function cornersCenter(corners: Corners): Point {
  return {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
    y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
  };
}

/**
 * Get the rotation handle position in document space: out from the middle of
 * the top edge as shown, so a warped edge never runs under it.
 */
export function getRotationHandlePos(
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): Point {
  const topCenter = mid(corners[0], corners[1]);
  const center = cornersCenter(corners);
  let dx = topCenter.x - center.x;
  let dy = topCenter.y - center.y;
  let len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) {
    // The top edge's middle is (nearly) the centre, as on a symmetric bow-tie
    // or a float under 2 px tall: go out square to the top edge instead, on
    // the side away from the bottom edge, clear of the handles there.
    dx = corners[1].y - corners[0].y;
    dy = corners[0].x - corners[1].x;
    const bottom = mid(corners[2], corners[3]);
    if (dx * (topCenter.x - bottom.x) + dy * (topCenter.y - bottom.y) < 0) {
      dx = -dx;
      dy = -dy;
    }
    len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return topCenter;
  }
  const offsetPx = config.rotationStemLength / zoom;
  return {
    x: topCenter.x + (dx / len) * offsetPx,
    y: topCenter.y + (dy / len) * offsetPx,
  };
}

/**
 * Hit-test the 8 resize handles. Returns the nearest one in reach (warped
 * corners and midpoints can meet), or null.
 */
export function hitTestHandle(
  docPoint: Point,
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): HandleType | null {
  const positions = getDocHandlePositions(corners);
  let hitDist = config.hitRadius / zoom;
  // Inside a float small on screen, full-size handles would cover it and leave
  // nothing to move it by: there they reach at most a quarter of its narrower side.
  if (isInsideTransform(docPoint, corners)) {
    let side = Infinity;
    for (let i = 0; i < 4; i++) {
      const p = corners[i], n = corners[(i + 1) % 4];
      side = Math.min(side, Math.hypot(n.x - p.x, n.y - p.y) * zoom);
    }
    hitDist = Math.min(config.hitRadius, side / 4) / zoom;
  }

  let nearest: HandleType | null = null;
  let best = hitDist * hitDist;
  for (const [key, hp] of Object.entries(positions)) {
    const dx = docPoint.x - hp.x;
    const dy = docPoint.y - hp.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= best) {
      best = d2;
      nearest = key as HandleType;
    }
  }
  return nearest;
}

/**
 * Hit-test the rotation handle.
 */
export function hitTestRotationHandle(
  docPoint: Point,
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): boolean {
  const hp = getRotationHandlePos(corners, config, zoom);
  const hitDist = config.hitRadius / zoom;
  const dx = docPoint.x - hp.x;
  const dy = docPoint.y - hp.y;
  return dx * dx + dy * dy <= hitDist * hitDist;
}

/**
 * Test if a document-space point is inside the outline the corners make (by
 * nonzero winding, as a self-intersecting perspective warp is filled), or on it.
 */
export function isInsideTransform(docPoint: Point, corners: Corners): boolean {
  const { x, y } = docPoint;
  let winding = 0;
  for (let i = 0; i < 4; i++) {
    const p = corners[i], n = corners[(i + 1) % 4];
    const cross = (n.x - p.x) * (y - p.y) - (x - p.x) * (n.y - p.y);
    // On the edge itself.
    if (cross === 0 && Math.min(p.x, n.x) <= x && x <= Math.max(p.x, n.x)
      && Math.min(p.y, n.y) <= y && y <= Math.max(p.y, n.y)) return true;
    if (p.y <= y) {
      if (n.y > y && cross > 0) winding++;
    } else if (n.y <= y && cross < 0) {
      winding--;
    }
  }
  return winding !== 0;
}

/**
 * Draw all 8 resize handles on a viewport-space canvas context.
 */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): void {
  const positions = getDocHandlePositions(corners);
  const halfSize = config.size / 2 / zoom;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / zoom;

  for (const hp of Object.values(positions)) {
    if (config.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, halfSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(hp.x - halfSize, hp.y - halfSize, halfSize * 2, halfSize * 2);
      ctx.strokeRect(hp.x - halfSize, hp.y - halfSize, halfSize * 2, halfSize * 2);
    }
  }
  ctx.restore();
}

/**
 * Draw the rotation handle (stem line + circle).
 */
export function drawRotationHandle(
  ctx: CanvasRenderingContext2D,
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): void {
  const topCenter = mid(corners[0], corners[1]);
  const handlePos = getRotationHandlePos(corners, config, zoom);
  const radius = (config.shape === 'circle' ? 8 : 6) / zoom;

  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / zoom;
  ctx.fillStyle = '#ffffff';

  ctx.beginPath();
  ctx.moveTo(topCenter.x, topCenter.y);
  ctx.lineTo(handlePos.x, handlePos.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(handlePos.x, handlePos.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Get positions for commit/cancel floating buttons: out from the top-right
 * corner as shown, diagonally between the float's own up and right, so
 * neither the top-right corner nor the rotation handle above the top edge
 * ends up under them, however narrow the float.
 */
export function getCommitCancelPositions(
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): { commitCenter: Point; cancelCenter: Point; buttonRadius: number } {
  const tr = corners[1];
  const center = cornersCenter(corners);
  const unit = (p: Point) => {
    const l = Math.hypot(p.x - center.x, p.y - center.y);
    return l > 0 ? { x: (p.x - center.x) / l, y: (p.y - center.y) / l } : { x: 0, y: 0 };
  };
  const up = unit(mid(corners[0], corners[1])), right = unit(mid(corners[1], corners[2]));
  let dx = up.x + right.x;
  let dy = up.y + right.y;
  let len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) {
    dx = tr.x - center.x;
    dy = tr.y - center.y;
    len = Math.sqrt(dx * dx + dy * dy);
  }
  const touch = config.shape === 'circle';
  const offsetPx = (touch ? 38 : 30) / zoom;
  const buttonRadius = (touch ? 22 : 12) / zoom;
  const gap = (touch ? 48 : 28) / zoom;

  const ux = len > 1e-6 ? dx / len : Math.SQRT1_2, uy = len > 1e-6 ? dy / len : -Math.SQRT1_2;
  // The cancel button beside it, further along the float's own right (level
  // with it on an upright float), so it stays clear of the handles however
  // the float is turned or flipped.
  const px = right.x || right.y ? right.x : 1, py = right.x || right.y ? right.y : 0;

  return {
    commitCenter: { x: tr.x + ux * offsetPx, y: tr.y + uy * offsetPx },
    cancelCenter: { x: tr.x + ux * offsetPx + px * gap, y: tr.y + uy * offsetPx + py * gap },
    buttonRadius,
  };
}

/**
 * Draw commit (checkmark) and cancel (X) buttons.
 */
export function drawCommitCancelButtons(
  ctx: CanvasRenderingContext2D,
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): void {
  const { commitCenter, cancelCenter, buttonRadius } = getCommitCancelPositions(corners, config, zoom);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Commit button — white fill with green border and checkmark
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  ctx.arc(commitCenter.x, commitCenter.y, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Checkmark
  ctx.strokeStyle = '#16a34a';
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  const cs = buttonRadius * 0.4;
  ctx.moveTo(commitCenter.x - cs, commitCenter.y + cs * 0.1);
  ctx.lineTo(commitCenter.x - cs * 0.15, commitCenter.y + cs * 0.65);
  ctx.lineTo(commitCenter.x + cs, commitCenter.y - cs * 0.55);
  ctx.stroke();

  // Cancel button — white fill with red border and X
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  ctx.arc(cancelCenter.x, cancelCenter.y, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // X mark
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  const xs = buttonRadius * 0.32;
  ctx.moveTo(cancelCenter.x - xs, cancelCenter.y - xs);
  ctx.lineTo(cancelCenter.x + xs, cancelCenter.y + xs);
  ctx.moveTo(cancelCenter.x + xs, cancelCenter.y - xs);
  ctx.lineTo(cancelCenter.x - xs, cancelCenter.y + xs);
  ctx.stroke();

  ctx.restore();
}

const RESIZE_CURSORS: Record<HandleType, string> = {
  nw: 'nwse-resize', ne: 'nesw-resize', se: 'nwse-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

/**
 * The resize cursor for a handle, pointing the way it lies from the centre as
 * shown, so a rotated, flipped, skewed or warped float gets the right one.
 */
export function getHandleCursor(handle: HandleType, corners: Corners): string {
  const positions = getDocHandlePositions(corners);
  const c = cornersCenter(corners);
  const out = (h: HandleType) => {
    const p = positions[h], l = Math.hypot(p.x - c.x, p.y - c.y);
    return l > 1e-9 ? { x: (p.x - c.x) / l, y: (p.y - c.y) / l } : { x: 0, y: 0 };
  };
  // A corner points out between its two edges, whatever the float's proportions.
  const [a, b] = handle.length === 2 ? [out(handle[0] as HandleType), out(handle[1] as HandleType)] : [out(handle), { x: 0, y: 0 }];
  const dx = a.x + b.x, dy = a.y + b.y;
  if (Math.hypot(dx, dy) < 1e-9) return RESIZE_CURSORS[handle];
  // 0° is right, 90° down; cursors repeat every 180°.
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 180;
  if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
  if (deg < 67.5) return 'nwse-resize';
  if (deg < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/**
 * Get the CSS cursor for a given document-space point.
 */
export function getCursorForPoint(
  docPoint: Point,
  corners: Corners,
  config: HandleConfig,
  zoom: number,
): string {
  if (hitTestRotationHandle(docPoint, corners, config, zoom)) {
    return 'grab';
  }

  const handle = hitTestHandle(docPoint, corners, config, zoom);
  if (handle) return getHandleCursor(handle, corners);

  if (isInsideTransform(docPoint, corners)) {
    return 'move';
  }

  return 'crosshair';
}

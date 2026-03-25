import type { Point } from '../types.js';
import type { HandleType, HandleConfig, TransformState } from './transform-types.js';
import { localToDoc, docToLocal, getTransformCenter } from './transform-math.js';

/** Positions of 8 resize handles in local (untransformed) space. */
function getLocalHandlePositions(w: number, h: number): Record<HandleType, Point> {
  return {
    nw: { x: 0, y: 0 },
    n:  { x: w / 2, y: 0 },
    ne: { x: w, y: 0 },
    e:  { x: w, y: h / 2 },
    se: { x: w, y: h },
    s:  { x: w / 2, y: h },
    sw: { x: 0, y: h },
    w:  { x: 0, y: h / 2 },
  };
}

/**
 * Get handle positions in document space (after transform).
 */
export function getDocHandlePositions(state: TransformState): Record<HandleType, Point> {
  const local = getLocalHandlePositions(state.width, state.height);
  const result = {} as Record<HandleType, Point>;
  for (const [key, lp] of Object.entries(local)) {
    result[key as HandleType] = localToDoc(lp, state);
  }
  return result;
}

/**
 * Get the rotation handle position in document space.
 */
export function getRotationHandlePos(
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): Point {
  const topCenter = localToDoc({ x: state.width / 2, y: 0 }, state);
  const center = getTransformCenter(state);
  const dx = topCenter.x - center.x;
  const dy = topCenter.y - center.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return topCenter;
  const offsetPx = config.rotationStemLength / zoom;
  return {
    x: topCenter.x + (dx / len) * offsetPx,
    y: topCenter.y + (dy / len) * offsetPx,
  };
}

/**
 * Hit-test the 8 resize handles. Returns the handle type or null.
 */
export function hitTestHandle(
  docPoint: Point,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): HandleType | null {
  const positions = getDocHandlePositions(state);
  const hitDist = config.hitRadius / zoom;

  for (const [key, hp] of Object.entries(positions)) {
    const dx = docPoint.x - hp.x;
    const dy = docPoint.y - hp.y;
    if (dx * dx + dy * dy <= hitDist * hitDist) {
      return key as HandleType;
    }
  }
  return null;
}

/**
 * Hit-test the rotation handle.
 */
export function hitTestRotationHandle(
  docPoint: Point,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): boolean {
  const hp = getRotationHandlePos(state, config, zoom);
  const hitDist = config.hitRadius / zoom;
  const dx = docPoint.x - hp.x;
  const dy = docPoint.y - hp.y;
  return dx * dx + dy * dy <= hitDist * hitDist;
}

/**
 * Test if a document-space point is inside the transformed bounding box.
 */
export function isInsideTransform(docPoint: Point, state: TransformState): boolean {
  const local = docToLocal(docPoint, state);
  return local.x >= 0 && local.x <= state.width && local.y >= 0 && local.y <= state.height;
}

/**
 * Draw all 8 resize handles on a viewport-space canvas context.
 */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): void {
  const positions = getDocHandlePositions(state);
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
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): void {
  const topCenter = localToDoc({ x: state.width / 2, y: 0 }, state);
  const handlePos = getRotationHandlePos(state, config, zoom);
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
 * Get positions for commit/cancel floating buttons.
 */
export function getCommitCancelPositions(
  state: TransformState,
  zoom: number,
): { commitCenter: Point; cancelCenter: Point; buttonRadius: number } {
  const tr = localToDoc({ x: state.width, y: 0 }, state);
  const center = getTransformCenter(state);
  const dx = tr.x - center.x;
  const dy = tr.y - center.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const offsetPx = 30 / zoom;
  const buttonRadius = 12 / zoom;
  const gap = 28 / zoom;

  const baseX = len > 1 ? tr.x + (dx / len) * offsetPx : tr.x + offsetPx;
  const baseY = len > 1 ? tr.y + (dy / len) * offsetPx : tr.y - offsetPx;

  return {
    commitCenter: { x: baseX, y: baseY },
    cancelCenter: { x: baseX + gap, y: baseY },
    buttonRadius,
  };
}

/**
 * Draw commit (checkmark) and cancel (X) buttons.
 */
export function drawCommitCancelButtons(
  ctx: CanvasRenderingContext2D,
  state: TransformState,
  zoom: number,
): void {
  const { commitCenter, cancelCenter, buttonRadius } = getCommitCancelPositions(state, zoom);

  ctx.save();

  ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
  ctx.beginPath();
  ctx.arc(commitCenter.x, commitCenter.y, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / zoom;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const cs = buttonRadius * 0.45;
  ctx.moveTo(commitCenter.x - cs, commitCenter.y);
  ctx.lineTo(commitCenter.x - cs * 0.2, commitCenter.y + cs * 0.7);
  ctx.lineTo(commitCenter.x + cs, commitCenter.y - cs * 0.5);
  ctx.stroke();

  ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
  ctx.beginPath();
  ctx.arc(cancelCenter.x, cancelCenter.y, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  const xs = buttonRadius * 0.35;
  ctx.moveTo(cancelCenter.x - xs, cancelCenter.y - xs);
  ctx.lineTo(cancelCenter.x + xs, cancelCenter.y + xs);
  ctx.moveTo(cancelCenter.x + xs, cancelCenter.y - xs);
  ctx.lineTo(cancelCenter.x - xs, cancelCenter.y + xs);
  ctx.stroke();

  ctx.restore();
}

/**
 * Get the CSS cursor for a given document-space point.
 */
export function getCursorForPoint(
  docPoint: Point,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): string {
  if (hitTestRotationHandle(docPoint, state, config, zoom)) {
    return 'grab';
  }

  const handle = hitTestHandle(docPoint, state, config, zoom);
  if (handle) {
    const cursors: Record<HandleType, string> = {
      nw: 'nwse-resize', ne: 'nesw-resize', se: 'nwse-resize', sw: 'nesw-resize',
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    };
    return cursors[handle];
  }

  if (isInsideTransform(docPoint, state)) {
    return 'move';
  }

  return 'crosshair';
}

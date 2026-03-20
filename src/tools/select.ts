/**
 * Draw a selection rectangle with marching-ants effect.
 * Two overlapping dashed strokes: white base + blue with offset.
 */
export function drawSelectionRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  dashOffset: number,
) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);

  // White base stroke
  ctx.strokeStyle = '#ffffff';
  ctx.lineDashOffset = 0;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);

  // Blue overlay with animated offset
  ctx.strokeStyle = '#3b82f6';
  ctx.lineDashOffset = dashOffset;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);

  ctx.restore();
}

/** Length of the line connecting the top-center handle to the rotation handle (in viewport px). */
export const ROTATION_HANDLE_OFFSET = 30;

/** Radius of the rotation handle circle (in viewport px). */
export const ROTATION_HANDLE_RADIUS = 6;

/**
 * Draw the rotation handle: a line from top-center of the rect upward,
 * ending in a circle. Coordinates are in viewport space.
 */
export function drawRotationHandle(
  ctx: CanvasRenderingContext2D,
  /** Top-center X in viewport coords */
  tcx: number,
  /** Top-center Y in viewport coords */
  tcy: number,
  /** Rotation angle in radians */
  rotation: number,
) {
  // The handle extends "upward" from the top-center, but rotated by the selection's angle
  const hx = tcx + Math.sin(-rotation) * -ROTATION_HANDLE_OFFSET;
  const hy = tcy + Math.cos(-rotation) * -ROTATION_HANDLE_OFFSET;

  ctx.save();

  // Connector line
  ctx.setLineDash([]);
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tcx, tcy);
  ctx.lineTo(hx, hy);
  ctx.stroke();

  // Circle handle
  ctx.beginPath();
  ctx.arc(hx, hy, ROTATION_HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Small rotation icon (curved arrow) inside the circle
  ctx.beginPath();
  ctx.arc(hx, hy, 3, -Math.PI * 0.7, Math.PI * 0.4);
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Arrowhead
  const tipAngle = Math.PI * 0.4;
  const tipX = hx + 3 * Math.cos(tipAngle);
  const tipY = hy + 3 * Math.sin(tipAngle);
  ctx.beginPath();
  ctx.moveTo(tipX + 2, tipY - 1);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(tipX + 2, tipY + 2);
  ctx.stroke();

  ctx.restore();
}

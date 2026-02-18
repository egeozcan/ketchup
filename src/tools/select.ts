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

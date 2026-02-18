import type { Point } from '../types.js';

export function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  shape: 'rectangle' | 'circle' | 'line' | 'triangle',
  start: Point,
  end: Point,
  strokeColor: string,
  fillColor: string,
  useFill: boolean,
  lineWidth: number,
) {
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (useFill) {
    ctx.fillStyle = fillColor;
  }

  switch (shape) {
    case 'line':
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      break;

    case 'rectangle': {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      if (useFill) ctx.fill();
      ctx.stroke();
      break;
    }

    case 'circle': {
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (useFill) ctx.fill();
      ctx.stroke();
      break;
    }

    case 'triangle': {
      const midX = (start.x + end.x) / 2;
      ctx.beginPath();
      ctx.moveTo(midX, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.lineTo(start.x, end.y);
      ctx.closePath();
      if (useFill) ctx.fill();
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

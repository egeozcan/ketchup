import { SHAPE_TOOLS } from '../types.js';
import type { Point, ShapeType, ToolType } from '../types.js';

export { SHAPE_TOOLS };

export function isShapeTool(tool: ToolType): tool is ShapeType {
  return (SHAPE_TOOLS as readonly ToolType[]).includes(tool);
}

function finishPath(ctx: CanvasRenderingContext2D, useFill: boolean) {
  if (useFill) ctx.fill();
  ctx.stroke();
}

function drawRegularPolygon(
  ctx: CanvasRenderingContext2D,
  sides: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rx = width / 2;
  const ry = height / 2;

  for (let i = 0; i < sides; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / sides;
    const px = cx + Math.cos(angle) * rx;
    const py = cy + Math.sin(angle) * ry;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function drawShapePreview(
  ctx: CanvasRenderingContext2D,
  shape: ShapeType,
  start: Point,
  end: Point,
  strokeColor: string,
  fillColor: string,
  useFill: boolean,
  lineWidth: number,
) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

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
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      finishPath(ctx, useFill);
      break;
    }

    case 'circle': {
      const cx = x + width / 2;
      const cy = y + height / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, width / 2, height / 2, 0, 0, Math.PI * 2);
      finishPath(ctx, useFill);
      break;
    }

    case 'triangle': {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
      finishPath(ctx, useFill);
      break;
    }

    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width / 2, y + height);
      ctx.lineTo(x, y + height / 2);
      ctx.closePath();
      finishPath(ctx, useFill);
      break;
    }

    case 'pentagon': {
      ctx.beginPath();
      drawRegularPolygon(ctx, 5, x, y, width, height);
      finishPath(ctx, useFill);
      break;
    }

    case 'hexagon': {
      ctx.beginPath();
      ctx.moveTo(x + width * 0.25, y);
      ctx.lineTo(x + width * 0.75, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width * 0.75, y + height);
      ctx.lineTo(x + width * 0.25, y + height);
      ctx.lineTo(x, y + height / 2);
      ctx.closePath();
      finishPath(ctx, useFill);
      break;
    }

    case 'star': {
      const cx = x + width / 2;
      const cy = y + height / 2;
      const outerRx = width / 2;
      const outerRy = height / 2;
      const innerRatio = 0.42;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const radius = i % 2 === 0 ? 1 : innerRatio;
        const px = cx + Math.cos(angle) * outerRx * radius;
        const py = cy + Math.sin(angle) * outerRy * radius;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      finishPath(ctx, useFill);
      break;
    }

    case 'heart': {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y + height);
      ctx.bezierCurveTo(x + width * 0.12, y + height * 0.72, x, y + height * 0.42, x, y + height * 0.27);
      ctx.bezierCurveTo(x, y + height * 0.04, x + width * 0.38, y, x + width / 2, y + height * 0.2);
      ctx.bezierCurveTo(x + width * 0.62, y, x + width, y + height * 0.04, x + width, y + height * 0.27);
      ctx.bezierCurveTo(x + width, y + height * 0.42, x + width * 0.88, y + height * 0.72, x + width / 2, y + height);
      ctx.closePath();
      finishPath(ctx, useFill);
      break;
    }

    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(x, y + height * 0.3);
      ctx.lineTo(x + width * 0.58, y + height * 0.3);
      ctx.lineTo(x + width * 0.58, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width * 0.58, y + height);
      ctx.lineTo(x + width * 0.58, y + height * 0.7);
      ctx.lineTo(x, y + height * 0.7);
      ctx.closePath();
      finishPath(ctx, useFill);
      break;
    }
  }

  ctx.restore();
}

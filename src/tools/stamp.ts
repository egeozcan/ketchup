import type { Point } from '../types.js';

export function drawStamp(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  pos: Point,
  size: number,
) {
  const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, pos.x - w / 2, pos.y - h / 2, w, h);
}

/**
 * Flood fill using a scanline approach for performance.
 */
export function floodFill(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  fillColor: string,
  tolerance: number = 32,
) {
  const { width, height } = ctx.canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const sx = Math.round(startX);
  const sy = Math.round(startY);

  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;

  // Parse fill color
  const fc = parseColor(fillColor);
  const targetIdx = (sy * width + sx) * 4;
  const tr = data[targetIdx];
  const tg = data[targetIdx + 1];
  const tb = data[targetIdx + 2];
  const ta = data[targetIdx + 3];

  // Don't fill if target is the same color
  if (tr === fc.r && tg === fc.g && tb === fc.b && ta === fc.a) return;

  const visited = new Uint8Array(width * height);

  const stack: [number, number][] = [[sx, sy]];

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;

    if (x < 0 || x >= width || y < 0 || y >= height) continue;

    const vi = y * width + x;
    if (visited[vi]) continue;

    const idx = vi * 4;
    if (!colorMatch(data, idx, tr, tg, tb, ta, tolerance)) continue;

    // Scan left
    let lx = x;
    while (lx > 0) {
      const li = (y * width + (lx - 1)) * 4;
      if (visited[y * width + (lx - 1)] || !colorMatch(data, li, tr, tg, tb, ta, tolerance)) break;
      lx--;
    }

    // Scan right
    let rx = x;
    while (rx < width - 1) {
      const ri = (y * width + (rx + 1)) * 4;
      if (visited[y * width + (rx + 1)] || !colorMatch(data, ri, tr, tg, tb, ta, tolerance)) break;
      rx++;
    }

    // Fill the scanline and check neighbors
    for (let px = lx; px <= rx; px++) {
      const pi = (y * width + px) * 4;
      data[pi] = fc.r;
      data[pi + 1] = fc.g;
      data[pi + 2] = fc.b;
      data[pi + 3] = fc.a;
      visited[y * width + px] = 1;

      if (y > 0) stack.push([px, y - 1]);
      if (y < height - 1) stack.push([px, y + 1]);
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function colorMatch(
  data: Uint8ClampedArray,
  idx: number,
  tr: number,
  tg: number,
  tb: number,
  ta: number,
  tolerance: number,
): boolean {
  return (
    Math.abs(data[idx] - tr) <= tolerance &&
    Math.abs(data[idx + 1] - tg) <= tolerance &&
    Math.abs(data[idx + 2] - tb) <= tolerance &&
    Math.abs(data[idx + 3] - ta) <= tolerance
  );
}

function parseColor(color: string): { r: number; g: number; b: number; a: number } {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a };
}

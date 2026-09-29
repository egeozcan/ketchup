/**
 * Flood fill using a scanline approach for performance.
 *
 * The work stack holds flat (x, y) pairs and only span seeds are pushed: after a
 * span is filled, the rows above and below are scanned once and a seed is pushed
 * per contiguous matching run, not per pixel. A run can occasionally be seeded
 * by more than one span; the duplicate is discarded by the `visited` check when
 * popped, so it costs a stack slot but never changes the result.
 */
export function floodFill(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  fillColor: string,
  tolerance: number = 32,
): boolean {
  const { width, height } = ctx.canvas;

  const sx = Math.floor(startX);
  const sy = Math.floor(startY);

  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return false;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Parse fill color
  const fc = parseColor(fillColor);
  const targetIdx = (sy * width + sx) * 4;
  const tr = data[targetIdx];
  const tg = data[targetIdx + 1];
  const tb = data[targetIdx + 2];
  const ta = data[targetIdx + 3];

  // Don't fill if target is the same color (only safe with zero tolerance;
  // with tolerance > 0, neighbors may differ and still need filling).
  if (tolerance === 0 && tr === fc.r && tg === fc.g && tb === fc.b && ta === fc.a) return false;

  const visited = new Uint8Array(width * height);
  const matches = (vi: number) => colorMatch(data, vi * 4, tr, tg, tb, ta, tolerance);

  const stack: number[] = [sx, sy];

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;

    const row = y * width;
    if (visited[row + x] || !matches(row + x)) continue;

    // Scan left
    let lx = x;
    while (lx > 0 && !visited[row + lx - 1] && matches(row + lx - 1)) lx--;

    // Scan right
    let rx = x;
    while (rx < width - 1 && !visited[row + rx + 1] && matches(row + rx + 1)) rx++;

    // Fill the span
    for (let px = lx; px <= rx; px++) {
      const pi = (row + px) * 4;
      data[pi] = fc.r;
      data[pi + 1] = fc.g;
      data[pi + 2] = fc.b;
      data[pi + 3] = fc.a;
      visited[row + px] = 1;
    }

    // Seed one entry per contiguous run of fillable pixels in the adjacent rows
    if (y > 0) seedRow(stack, visited, matches, width, y - 1, lx, rx);
    if (y < height - 1) seedRow(stack, visited, matches, width, y + 1, lx, rx);
  }

  ctx.putImageData(imageData, 0, 0);
  return true;
}

/** Push the left edge of each unvisited, matching run in row `y` between `lx` and `rx`. */
function seedRow(
  stack: number[],
  visited: Uint8Array,
  matches: (vi: number) => boolean,
  width: number,
  y: number,
  lx: number,
  rx: number,
): void {
  const row = y * width;
  let inRun = false;
  for (let x = lx; x <= rx; x++) {
    const fillable = !visited[row + x] && matches(row + x);
    if (fillable && !inRun) stack.push(x, y);
    inRun = fillable;
  }
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

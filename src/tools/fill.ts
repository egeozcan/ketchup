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

  const visited = acquireVisited(width * height);
  const mark = visitedGen;
  const matches = (vi: number) => colorMatch(data, vi * 4, tr, tg, tb, ta, tolerance);

  const stack: number[] = [sx, sy];

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;

    const row = y * width;
    if (visited[row + x] === mark || !matches(row + x)) continue;

    // Scan left
    let lx = x;
    while (lx > 0 && visited[row + lx - 1] !== mark && matches(row + lx - 1)) lx--;

    // Scan right
    let rx = x;
    while (rx < width - 1 && visited[row + rx + 1] !== mark && matches(row + rx + 1)) rx++;

    // Fill the span
    for (let px = lx; px <= rx; px++) {
      const pi = (row + px) * 4;
      data[pi] = fc.r;
      data[pi + 1] = fc.g;
      data[pi + 2] = fc.b;
      data[pi + 3] = fc.a;
      visited[row + px] = mark;
    }

    // Seed one entry per contiguous run of fillable pixels in the adjacent rows
    if (y > 0) seedRow(stack, visited, mark, matches, width, y - 1, lx, rx);
    if (y < height - 1) seedRow(stack, visited, mark, matches, width, y + 1, lx, rx);
  }

  ctx.putImageData(imageData, 0, 0);
  return true;
}

/** Push the left edge of each unvisited, matching run in row `y` between `lx` and `rx`. */
function seedRow(
  stack: number[],
  visited: Uint16Array,
  mark: number,
  matches: (vi: number) => boolean,
  width: number,
  y: number,
  lx: number,
  rx: number,
): void {
  const row = y * width;
  let inRun = false;
  for (let x = lx; x <= rx; x++) {
    const fillable = visited[row + x] !== mark && matches(row + x);
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

// Visited buffer reused across fills. Each fill stamps cells with a fresh
// generation value, so the buffer only needs clearing when the counter wraps.
let visitedBuf = new Uint16Array(0);
let visitedGen = 0;

function acquireVisited(size: number): Uint16Array {
  if (visitedBuf.length < size) {
    visitedBuf = new Uint16Array(size);
    visitedGen = 0;
  }
  if (++visitedGen > 0xffff) {
    visitedBuf.fill(0);
    visitedGen = 1;
  }
  return visitedBuf;
}

type RGBA = { r: number; g: number; b: number; a: number };

const colorCache = new Map<string, RGBA>();
let parseCtx: CanvasRenderingContext2D | null = null;

function parseColor(color: string): RGBA {
  const cached = colorCache.get(color);
  if (cached) return cached;
  if (!parseCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    parseCtx = canvas.getContext('2d', { willReadFrequently: true })!;
  }
  parseCtx.clearRect(0, 0, 1, 1);
  parseCtx.fillStyle = color;
  parseCtx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = parseCtx.getImageData(0, 0, 1, 1).data;
  const parsed = { r, g, b, a };
  if (colorCache.size > 64) colorCache.clear();
  colorCache.set(color, parsed);
  return parsed;
}

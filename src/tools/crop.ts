import type { Point } from '../types.js';

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HANDLE_SIZE = 8;

/**
 * Draw the crop overlay on the preview canvas: dim area outside crop rect,
 * solid border, 8 resize handles, and dimensions label.
 * All coordinates are in document space; caller must set up pan/zoom transform first.
 */
export function drawCropOverlay(
  ctx: CanvasRenderingContext2D,
  rect: CropRect,
  docWidth: number,
  docHeight: number,
  zoom: number,
) {
  const hs = HANDLE_SIZE / zoom;
  const half = hs / 2;

  // Dim area outside crop rect using four rectangles (avoid clearRect issues)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  // Top
  ctx.fillRect(0, 0, docWidth, rect.y);
  // Bottom
  ctx.fillRect(0, rect.y + rect.h, docWidth, docHeight - rect.y - rect.h);
  // Left
  ctx.fillRect(0, rect.y, rect.x, rect.h);
  // Right
  ctx.fillRect(rect.x + rect.w, rect.y, docWidth - rect.x - rect.w, rect.h);

  // Border
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  // Handles
  const handlePositions: { cx: number; cy: number }[] = [
    { cx: rect.x, cy: rect.y },                         // nw
    { cx: rect.x + rect.w / 2, cy: rect.y },            // n
    { cx: rect.x + rect.w, cy: rect.y },                // ne
    { cx: rect.x + rect.w, cy: rect.y + rect.h / 2 },  // e
    { cx: rect.x + rect.w, cy: rect.y + rect.h },       // se
    { cx: rect.x + rect.w / 2, cy: rect.y + rect.h },   // s
    { cx: rect.x, cy: rect.y + rect.h },                // sw
    { cx: rect.x, cy: rect.y + rect.h / 2 },            // w
  ];

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1 / zoom;
  for (const { cx, cy } of handlePositions) {
    ctx.fillRect(cx - half, cy - half, hs, hs);
    ctx.strokeRect(cx - half, cy - half, hs, hs);
  }

  // Dimensions label
  const label = `${Math.round(rect.w)} \u00d7 ${Math.round(rect.h)}`;
  const fontSize = Math.max(10, 12 / zoom);
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const labelX = rect.x + rect.w;
  const labelY = rect.y + rect.h + 4 / zoom;
  // Background
  const metrics = ctx.measureText(label);
  const pad = 3 / zoom;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(
    labelX - metrics.width - pad * 2,
    labelY,
    metrics.width + pad * 2,
    fontSize + pad * 2,
  );
  // Text
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, labelX - pad, labelY + pad);
}

/**
 * Hit-test pointer position against crop rect handles and interior.
 * Returns handle name, 'move' if inside rect, or null if outside.
 */
export function hitTestCropHandle(
  rect: CropRect,
  p: Point,
  zoom: number,
): CropHandle | null {
  const hs = HANDLE_SIZE / zoom;
  const half = hs / 2;

  const handles: { handle: CropHandle; cx: number; cy: number }[] = [
    { handle: 'nw', cx: rect.x, cy: rect.y },
    { handle: 'n',  cx: rect.x + rect.w / 2, cy: rect.y },
    { handle: 'ne', cx: rect.x + rect.w, cy: rect.y },
    { handle: 'e',  cx: rect.x + rect.w, cy: rect.y + rect.h / 2 },
    { handle: 'se', cx: rect.x + rect.w, cy: rect.y + rect.h },
    { handle: 's',  cx: rect.x + rect.w / 2, cy: rect.y + rect.h },
    { handle: 'sw', cx: rect.x, cy: rect.y + rect.h },
    { handle: 'w',  cx: rect.x, cy: rect.y + rect.h / 2 },
  ];

  for (const { handle, cx, cy } of handles) {
    if (p.x >= cx - half && p.x <= cx + half && p.y >= cy - half && p.y <= cy + half) {
      return handle;
    }
  }

  // Interior -> move
  if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
    return 'move';
  }

  return null;
}

/**
 * Parse an aspect ratio string (e.g. "16:9") into a numeric ratio (width/height),
 * or return null for "free".
 */
export function parseAspectRatio(ratio: string): number | null {
  if (ratio === 'free') return null;
  const parts = ratio.split(':');
  if (parts.length !== 2) return null;
  const w = parseFloat(parts[0]);
  const h = parseFloat(parts[1]);
  if (!w || !h) return null;
  return w / h;
}

/**
 * Constrain a rectangle to an aspect ratio, adjusting based on which handle
 * is being dragged. Returns the adjusted rect.
 */
export function constrainCropToRatio(
  rect: CropRect,
  ratio: number,
  handle: CropHandle | 'draw',
): CropRect {
  const { x, y, w, h } = rect;
  const absW = Math.abs(w);
  const absH = Math.abs(h);
  const signW = w >= 0 ? 1 : -1;
  const signH = h >= 0 ? 1 : -1;

  let newW: number;
  let newH: number;

  if (handle === 'n' || handle === 's') {
    // Vertical edge drag: height is primary
    newH = absH;
    newW = absH * ratio;
  } else if (handle === 'e' || handle === 'w') {
    // Horizontal edge drag: width is primary
    newW = absW;
    newH = absW / ratio;
  } else {
    // Corner or initial draw: larger dimension is primary
    if (absW / ratio >= absH) {
      newW = absW;
      newH = absW / ratio;
    } else {
      newH = absH;
      newW = absH * ratio;
    }
  }

  return { x, y, w: newW * signW, h: newH * signH };
}

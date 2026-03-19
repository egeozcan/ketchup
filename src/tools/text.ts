const LINE_HEIGHT = 1.2;

function buildFontString(
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
}

/**
 * Render multi-line text onto a canvas context.
 * Each line is split at '\n' and offset vertically by fontSize * LINE_HEIGHT.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
  color: string,
): void {
  if (!text) return;
  ctx.save();
  ctx.font = buildFontString(fontSize, fontFamily, bold, italic);
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  const lineHeight = fontSize * LINE_HEIGHT;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, y + i * lineHeight);
  }
  ctx.restore();
}

/**
 * Measure the bounding box of a multi-line text block.
 * Returns max line width, total height, and per-line widths.
 */
export function measureTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
): { width: number; height: number; lineWidths: number[] } {
  ctx.save();
  ctx.font = buildFontString(fontSize, fontFamily, bold, italic);
  ctx.textBaseline = 'top';
  const lines = text.split('\n');
  const lineHeight = fontSize * LINE_HEIGHT;
  const lineWidths = lines.map(line => ctx.measureText(line).width);
  const width = Math.max(0, ...lineWidths);
  // Always at least one line tall even if text is empty
  const height = Math.max(1, lines.length) * lineHeight;
  ctx.restore();
  return { width, height, lineWidths };
}

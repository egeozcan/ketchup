import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas, exportFileBaseName } from '../src/components/drawing-canvas.ts';
import { attachCanvasElements, makeLayer, makeState } from './helpers.ts';

function setupCanvas(docWidth: number, docHeight: number, viewWidth: number, viewHeight: number) {
  const canvas = new DrawingCanvas();
  const layer = makeLayer(docWidth, docHeight);
  const state = makeState({
    layers: [layer],
    activeLayerId: layer.id,
    documentWidth: docWidth,
    documentHeight: docHeight,
  });
  (canvas as any)._ctx = { value: { state } };
  const { mainCanvas } = attachCanvasElements(canvas, viewWidth, viewHeight);
  mainCanvas.width = viewWidth;
  mainCanvas.height = viewHeight;
  (canvas as any).composite = vi.fn();
  (canvas as any).requestUpdate = vi.fn();
  return canvas;
}

describe('DrawingCanvas.resetView', () => {
  it('shows a document that fits at 100%, centered', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);
    (canvas as any)._zoom = 3;

    canvas.resetView();

    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 200, panY: 100 });
  });

  it('shrinks a document larger than the viewport so all of it is visible', () => {
    const canvas = setupCanvas(800, 600, 390, 600);

    canvas.resetView();

    const { zoom, panX, panY } = canvas.getViewport();
    expect(zoom).toBeLessThan(1);
    expect(800 * zoom).toBeLessThanOrEqual(390);
    expect(panX).toBeGreaterThanOrEqual(0);
    expect(panY).toBeGreaterThanOrEqual(0);
  });
});

describe('exportFileBaseName', () => {
  it('uses the project name', () => {
    expect(exportFileBaseName('My sketch')).toBe('My sketch');
  });

  it('replaces characters that are invalid in file names', () => {
    expect(exportFileBaseName('a/b:c*?')).toBe('a-b-c-');
    expect(exportFileBaseName('-draft-')).toBe('-draft-');
    expect(exportFileBaseName('tab\there\u007f.')).toBe('tab-here-');
  });

  it('falls back to "drawing" for empty or missing names', () => {
    expect(exportFileBaseName(undefined)).toBe('drawing');
    expect(exportFileBaseName('   ')).toBe('drawing');
    expect(exportFileBaseName('...')).toBe('drawing');
  });
});

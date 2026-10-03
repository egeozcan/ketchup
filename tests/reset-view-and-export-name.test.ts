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
  (canvas as any)._laidOut = true;
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

describe('DrawingCanvas resizing', () => {
  function resizer(canvas: DrawingCanvas) {
    return (width: number, height: number) => {
      (canvas as any).getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
      (canvas as any)._resizeToFit();
    };
  }

  it('comes back to the same view when the viewport changes size by an odd amount and back', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);
    canvas.setViewport(1, 200, 100);
    const resize = resizer(canvas);
    for (let i = 0; i < 5; i++) {
      resize(1200, 793);
      expect(Number.isInteger(canvas.getViewport().panY)).toBe(true);
      resize(1200, 800);
    }
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 200, panY: 100 });
  });

  it('comes back to the same view after growing a pixel at a time and shrinking back', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);
    canvas.setViewport(1, 200, 100);
    const resize = resizer(canvas);
    for (let d = 1; d <= 41; d++) resize(1200 + d, 800 + d);
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 221, panY: 121 });
    for (let d = 40; d >= 0; d--) resize(1200 + d, 800 + d);
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 200, panY: 100 });
  });

  it('comes back to a restored view when the canvas then settles to the size it was saved at', () => {
    // Restored before the tool bar takes the saved tool's height.
    const canvas = setupCanvas(800, 600, 1200, 804);
    canvas.restoreViewport(1, 101, 54, { width: 1200, height: 797 });
    resizer(canvas)(1200, 797);
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 101, panY: 54 });
  });

  it('keeps a pan made between resizes', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);
    canvas.setViewport(1, 200, 100);
    const resize = resizer(canvas);
    resize(1201, 801);
    canvas.setViewport(1, 150, 60);
    resize(1200, 800);
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 150, panY: 60 });
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

describe('DrawingCanvas.restoreViewport', () => {
  it('keeps a saved view taken on the same screen size', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);

    canvas.restoreViewport(2, -300, -200, { width: 1200, height: 800 });

    expect(canvas.getViewport()).toEqual({ zoom: 2, panX: -300, panY: -200 });
  });

  it('keeps the same point centred when the screen is only a little different', () => {
    const canvas = setupCanvas(800, 600, 1100, 800);

    canvas.restoreViewport(2, -300, -200, { width: 1200, height: 800 });

    expect(canvas.getViewport()).toEqual({ zoom: 2, panX: -350, panY: -200 });
  });

  it('keeps a restored view on whole pixels when the screen differs by an odd amount', () => {
    const canvas = setupCanvas(800, 600, 1101, 801);

    canvas.restoreViewport(1, 100, 50, { width: 1200, height: 800 });

    const { panX, panY } = canvas.getViewport();
    expect(Number.isInteger(panX) && Number.isInteger(panY)).toBe(true);
  });

  it('measures the canvas before restoring, so a layout just changed (the phone\'s) isn\'t taken for another screen', () => {
    // Still sized for the desktop layout when the phone layout has been chosen.
    const canvas = setupCanvas(800, 600, 129, 698);
    (canvas as any).getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 796 });
    canvas.restoreViewport(1, 5, 100, { width: 390, height: 796 });
    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 5, panY: 100 });
  });

  it('keeps a view reloaded at window sizes an odd pixel apart where it was', () => {
    let saved = { zoom: 1, panX: 101, panY: 61, size: { width: 1200, height: 800 } };
    for (let i = 0; i < 4; i++) {
      const size = i % 2 ? { width: 1200, height: 800 } : { width: 1201, height: 801 };
      const canvas = setupCanvas(800, 600, size.width, size.height);
      canvas.restoreViewport(saved.zoom, saved.panX, saved.panY, saved.size);
      saved = { ...canvas.getViewport(), size };
    }
    expect(saved).toMatchObject({ panX: 101, panY: 61 });
  });

  it('shows the whole document when the view was saved on a much larger screen', () => {
    const canvas = setupCanvas(1920, 1080, 390, 700);

    canvas.restoreViewport(1, 40, 60, { width: 2000, height: 1150 });

    const { zoom, panX, panY } = canvas.getViewport();
    expect(1920 * zoom).toBeLessThanOrEqual(390);
    expect(panX).toBeGreaterThanOrEqual(0);
    expect(panY).toBeGreaterThanOrEqual(0);
  });

  it('ignores the saved size until the canvas has real layout', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);
    (canvas as any)._laidOut = false;

    canvas.restoreViewport(2, -300, -200, { width: 390, height: 700 });

    expect(canvas.getViewport()).toEqual({ zoom: 2, panX: -300, panY: -200 });
    expect(canvas.getViewportSize()).toBeNull();
  });

  it('shows the whole document when an older saved view leaves it off-screen', () => {
    const canvas = setupCanvas(800, 600, 390, 700);

    // No saved screen size (older project), and the pan puts the page past the right edge.
    canvas.restoreViewport(1, 400, 50);

    const { zoom, panX } = canvas.getViewport();
    expect(800 * zoom).toBeLessThanOrEqual(390);
    expect(panX).toBeGreaterThanOrEqual(0);
  });

  it('keeps an older saved view that still shows most of the document', () => {
    const canvas = setupCanvas(800, 600, 1200, 800);

    canvas.restoreViewport(1, 250, 150);

    expect(canvas.getViewport()).toEqual({ zoom: 1, panX: 250, panY: 150 });
  });
});

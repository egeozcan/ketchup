import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';

describe('DrawingCanvas selection bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clamps selection rectangle to document bounds before lifting', () => {
    const canvas = new DrawingCanvas();
    const liftSpy = vi.fn();
    (canvas as any)._liftToFloat = liftSpy;
    (canvas as any)._selectionDrawing = true;
    (canvas as any)._startPoint = { x: -10, y: -20 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 900, y: 700 }));

    (canvas as any)._handleSelectPointerUp({} as PointerEvent);

    expect(liftSpy).toHaveBeenCalledWith(0, 0, 800, 600);
  });

  it('defensively clamps _liftToFloat() reads/writes to document bounds', () => {
    const canvas = new DrawingCanvas();
    const fakeImageData = {
      data: new Uint8ClampedArray(800 * 600 * 4),
      width: 800,
      height: 600,
    } as unknown as ImageData;
    const getImageData = vi.fn(() => fakeImageData);
    const clearRect = vi.fn();
    const putImageData = vi.fn();
    const drawImage = vi.fn();

    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ putImageData, drawImage }),
        } as unknown as HTMLCanvasElement;
      }
      return realCreateElement(tagName as any);
    }) as typeof document.createElement);

    (canvas as any)._captureBeforeDraw = vi.fn();
    (canvas as any)._getActiveLayerCtx = vi.fn(() => ({ getImageData, clearRect }));
    (canvas as any).composite = vi.fn();
    (canvas as any)._startSelectionAnimation = vi.fn();

    (canvas as any)._liftToFloat(-10, -20, 900, 700);

    expect(getImageData).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect((canvas as any)._float.currentRect).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

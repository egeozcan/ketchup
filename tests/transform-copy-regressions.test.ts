import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { attachCanvasElements, makeLayer, makeState } from './helpers.ts';

function setupTransformedCanvas() {
  const canvas = new DrawingCanvas();
  const layer = makeLayer(100, 100);
  (canvas as any)._ctx = {
    value: {
      state: makeState({
        activeTool: 'select',
        layers: [layer],
        activeLayerId: layer.id,
        documentWidth: 100,
        documentHeight: 100,
      }),
    },
  };
  const { previewCanvas } = attachCanvasElements(canvas, 100, 100);
  (canvas as any).composite = vi.fn();
  (canvas as any).requestUpdate = vi.fn();
  (canvas as any)._writeToSystemClipboard = vi.fn();
  (canvas as any)._beforeDrawData = new ImageData(100, 100);

  const transform = new TransformManager(
    new ImageData(10, 10),
    { x: 20, y: 30, w: 10, h: 10 },
    previewCanvas,
    1,
    { x: 0, y: 0 },
  );
  transform.width = 16;
  transform.height = 6;
  transform.x = 5;
  transform.y = 7;
  (canvas as any)._transformManager = transform;

  return { canvas, layer };
}

describe('DrawingCanvas transformed selection clipboard operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('copySelection captures the transformed bounds and origin', () => {
    const { canvas } = setupTransformedCanvas();

    canvas.copySelection();

    expect((canvas as any)._clipboard.width).toBe(16);
    expect((canvas as any)._clipboard.height).toBe(6);
    expect((canvas as any)._clipboardOrigin).toEqual({ x: 5, y: 7 });
  });

  it('cutSelection clears the transformed region, not the original source rect', () => {
    const { canvas, layer } = setupTransformedCanvas();
    const layerCtx = layer.canvas.getContext('2d')!;
    const clearRectSpy = vi.spyOn(layerCtx, 'clearRect');

    canvas.cutSelection();

    expect(clearRectSpy).toHaveBeenCalledWith(5, 7, 16, 6);
  });

  it('duplicateInPlace duplicates the current transformed result', () => {
    const { canvas } = setupTransformedCanvas();

    canvas.duplicateInPlace();

    expect((canvas as any)._clipboard.width).toBe(16);
    expect((canvas as any)._clipboard.height).toBe(6);
    expect((canvas as any)._clipboardOrigin).toEqual({ x: 5, y: 7 });
    expect((canvas as any).getTransformValues()).toMatchObject({
      x: 5,
      y: 7,
      width: 16,
      height: 6,
    });
  });
});

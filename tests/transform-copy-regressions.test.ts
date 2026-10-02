import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { attachCanvasElements, makeCanvas, makeLayer, makeState } from './helpers.ts';

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
  (canvas as any)._beforeDrawCanvas = makeCanvas(100, 100);

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
    expect((canvas as any)._clipboardOrigin).toEqual({ x: 2, y: 9 });
  });

  it('cutSelection copies the transformed float, then deletes it without touching anything around it', () => {
    const { canvas, layer } = setupTransformedCanvas();
    const layerCtx = layer.canvas.getContext('2d')!;
    const clearRectSpy = vi.spyOn(layerCtx, 'clearRect');
    const commit = vi.spyOn(canvas, 'commitTransform');
    const pushHistory = vi.spyOn(canvas as any, '_pushDrawHistory').mockImplementation(() => {});

    canvas.cutSelection();

    // Committing and then clearing the float's bounds would also clear what
    // else is in them (a rotated or warped float covers less) and what it
    // was moved over.
    expect(commit).not.toHaveBeenCalled();
    expect(clearRectSpy).not.toHaveBeenCalled();
    expect((canvas as any)._clipboard.width).toBe(16);
    expect((canvas as any)._clipboardOrigin).toEqual({ x: 2, y: 9 });
    expect(canvas.isTransformActive()).toBe(false);
    // The lift's hole is what stays: one undo step back to before it.
    expect(pushHistory).toHaveBeenCalledWith(true);
  });

  it('cutSelection of a pasted image removes the layer it came on', () => {
    const { canvas } = setupTransformedCanvas();
    (canvas as any)._floatIsExternalImage = true;
    const cancelExternal = vi.spyOn(canvas, 'cancelExternalFloat');

    canvas.cutSelection();

    expect(cancelExternal).toHaveBeenCalled();
    expect((canvas as any)._clipboard.width).toBe(16);
  });

  it('deleting a pasted image leaves the next float an ordinary one', () => {
    const { canvas } = setupTransformedCanvas();
    (canvas as any)._floatIsExternalImage = true;
    (canvas as any)._transformContentMode = 'inserted';

    canvas.deleteSelection();
    (canvas as any)._transformManager = new TransformManager(
      new ImageData(4, 4), { x: 0, y: 0, w: 4, h: 4 }, makeCanvas(100, 100), 1, { x: 0, y: 0 },
    );

    // Otherwise Escape would discard this float's pixels as if pasted.
    expect(canvas.hasExternalFloat).toBe(false);
  });

  it('duplicateInPlace duplicates the current transformed result', () => {
    const { canvas } = setupTransformedCanvas();

    canvas.duplicateInPlace();

    expect((canvas as any)._clipboard.width).toBe(16);
    expect((canvas as any)._clipboard.height).toBe(6);
    expect((canvas as any)._clipboardOrigin).toEqual({ x: 2, y: 9 });
    expect((canvas as any).getTransformValues()).toMatchObject({
      x: 2,
      y: 9,
      width: 16,
      height: 6,
    });
  });
});

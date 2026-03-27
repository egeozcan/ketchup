import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { attachCanvasElements, makeLayer, makeState, makeTransformManagerStub } from './helpers.ts';

describe('DrawingCanvas viewport updates with active transform', () => {
  function setupCanvas() {
    const canvas = new DrawingCanvas();
    const layer = makeLayer(800, 600);
    (canvas as any)._ctx = {
      value: {
        state: makeState({
          layers: [layer],
          activeLayerId: layer.id,
          documentWidth: 800,
          documentHeight: 600,
        }),
      },
    };
    attachCanvasElements(canvas, 800, 600);
    return canvas;
  }

  it('setViewport forwards the new viewport to the active transform', () => {
    const canvas = setupCanvas();
    const transform = makeTransformManagerStub();
    (canvas as any)._transformManager = transform;
    (canvas as any).composite = vi.fn();
    (canvas as any)._dispatchViewportChange = vi.fn();

    canvas.setViewport(2, 100, 50);

    expect(transform.updateViewport).toHaveBeenCalledWith(2, { x: 100, y: 50 });
  });

  it('centerDocument also refreshes the active transform viewport', () => {
    const canvas = setupCanvas();
    const transform = makeTransformManagerStub();
    (canvas as any)._transformManager = transform;
    (canvas as any).composite = vi.fn();
    (canvas as any)._dispatchViewportChange = vi.fn();

    canvas.centerDocument();

    expect(transform.updateViewport).toHaveBeenCalled();
  });
});

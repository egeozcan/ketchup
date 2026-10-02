import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { attachCanvasElements, makeCanvas, makeLayer, makeState, makeTransformManagerStub } from './helpers.ts';

describe('perspective preview and commit', () => {
  function makePerspectiveManager() {
    const tm = new TransformManager(
      new ImageData(10, 10), { x: 0, y: 0, w: 10, h: 10 }, makeCanvas(100, 100), 1, { x: 0, y: 0 },
    );
    (tm as any)._perspectiveActive = true;
    (tm as any)._perspectiveCorners.se = { x: 6, y: 4 };
    return tm;
  }

  it('commits the very warp the preview showed', () => {
    const tm = makePerspectiveManager();
    const displayCtx = makeCanvas(100, 100).getContext('2d')!;
    const previewDraw = vi.spyOn(displayCtx, 'drawImage');
    tm.renderTransformed(displayCtx);

    const layer = makeCanvas(100, 100);
    const layerCtx = layer.getContext('2d')!;
    const commitDraw = vi.spyOn(layerCtx, 'drawImage');
    const commitFill = vi.spyOn(layerCtx, 'fill');
    tm.commit(layer);

    expect(previewDraw).toHaveBeenCalledTimes(1);
    expect(commitDraw).toHaveBeenCalledTimes(1);
    expect(commitDraw.mock.calls[0]).toEqual(previewDraw.mock.calls[0]);
    // The mesh sums its triangles, so it never draws straight onto layer pixels.
    expect(commitFill).not.toHaveBeenCalled();
  });
});

describe('transform preview under a layer blend mode', () => {
  function setup() {
    const canvas = new DrawingCanvas();
    const layer = makeLayer(100, 100, { blendMode: 'multiply', opacity: 0.5 });
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id }) } };
    const { mainCanvas } = attachCanvasElements(canvas, 100, 100);
    const float = makeCanvas(20, 20);
    const renderTransformed = vi.fn((ctx: CanvasRenderingContext2D) => {
      // Commit merges onto the layer with source-over; the preview must too.
      expect(ctx.globalCompositeOperation).toBe('source-over');
      expect(ctx.globalAlpha).toBe(1);
      ctx.drawImage(float, 10, 10);
    });
    (canvas as any)._transformManager = makeTransformManagerStub({ renderTransformed });
    return { canvas, layer, mainCanvas, renderTransformed };
  }

  it('merges the floating content into its layer before blending the layer', () => {
    const { canvas, layer, mainCanvas, renderTransformed } = setup();
    const displayCtx = mainCanvas.getContext('2d')!;
    const blended: { src: unknown; op: string; alpha: number }[] = [];
    vi.spyOn(displayCtx, 'drawImage').mockImplementation(((src: unknown) => {
      blended.push({ src, op: displayCtx.globalCompositeOperation, alpha: displayCtx.globalAlpha });
    }) as typeof displayCtx.drawImage);

    canvas.composite();

    expect(renderTransformed).toHaveBeenCalledTimes(1);
    expect(renderTransformed.mock.calls[0][0]).not.toBe(displayCtx);
    const merged = (canvas as any)._transformMergeCanvas as HTMLCanvasElement;
    expect(blended).toContainEqual({ src: merged, op: 'multiply', alpha: 0.5 });
    expect(blended.some(d => d.src === layer.canvas)).toBe(false);
  });

  it('flattens the merged layer for export', () => {
    const { canvas, renderTransformed } = setup();
    canvas.renderFlattened(null);
    expect(renderTransformed).toHaveBeenCalledTimes(1);
  });
});

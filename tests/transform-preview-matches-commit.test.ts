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
    tm.commit(layer);

    expect(previewDraw).toHaveBeenCalledTimes(1);
    expect(commitDraw).toHaveBeenCalledTimes(1);
    expect(commitDraw.mock.calls[0]).toEqual(previewDraw.mock.calls[0]);
  });

  it('warps only what fits on the layer when a corner is dragged far outside it', () => {
    const tm = makePerspectiveManager();
    (tm as any)._perspectiveCorners.se = { x: 20000, y: 20000 };
    tm.commit(makeCanvas(100, 100));
    const warp = (tm as any)._warpCache.canvas as HTMLCanvasElement;
    expect(warp.width).toBeLessThanOrEqual(100);
    expect(warp.height).toBeLessThanOrEqual(100);
  });

  it('previews a huge warp only where the target can show it', () => {
    const tm = makePerspectiveManager();
    (tm as any)._perspectiveCorners.se = { x: 20000, y: 20000 };
    const ctx = makeCanvas(300, 200).getContext('2d')!;
    ctx.setTransform(2, 0, 0, 2, -40, -20);
    tm.renderTransformed(ctx);
    const cache = (tm as any)._warpCache;
    expect(cache.x).toBe(20);
    expect(cache.y).toBe(10);
    expect(cache.canvas.width).toBe(150);
    expect(cache.canvas.height).toBe(100);
  });

  it('frees the warp when disposed', () => {
    const tm = makePerspectiveManager();
    tm.renderTransformed(makeCanvas(100, 100).getContext('2d')!);
    const warp = (tm as any)._warpCache.canvas as HTMLCanvasElement;
    tm.dispose();
    expect(warp.width).toBe(0);
  });
});

describe('transform preview under a layer blend mode', () => {
  function setup(layerOverrides: Parameters<typeof makeLayer>[2] = { blendMode: 'multiply', opacity: 0.5 }) {
    const canvas = new DrawingCanvas();
    const layer = makeLayer(100, 100, layerOverrides);
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id }) } };
    const { mainCanvas } = attachCanvasElements(canvas, 100, 100);
    const displayCtx = mainCanvas.getContext('2d')!;
    const float = makeCanvas(20, 20);
    const merges: CanvasRenderingContext2D[] = [];
    const renderTransformed = vi.fn((ctx: CanvasRenderingContext2D) => {
      if (ctx !== displayCtx) {
        // Commit merges onto the layer with source-over; the preview must too.
        expect(ctx.globalCompositeOperation).toBe('source-over');
        expect(ctx.globalAlpha).toBe(1);
        merges.push(ctx);
      }
      ctx.drawImage(float, 10, 10);
    });
    const tm = makeTransformManagerStub({
      renderTransformed,
      renderKey: 'a',
      getBounds: vi.fn(() => ({ x: 10, y: 10, w: 20, h: 20 })),
    });
    (canvas as any)._transformManager = tm;
    return { canvas, layer, displayCtx, tm, merges, renderTransformed };
  }

  function recordDraws(ctx: CanvasRenderingContext2D) {
    const draws: { src: unknown; op: string; alpha: number }[] = [];
    vi.spyOn(ctx, 'drawImage').mockImplementation(((src: unknown) => {
      draws.push({ src, op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha });
    }) as typeof ctx.drawImage);
    return draws;
  }

  it('merges the floating content into its layer before blending the layer', () => {
    const { canvas, layer, displayCtx, merges } = setup();
    const blended = recordDraws(displayCtx);

    canvas.composite();

    expect(merges).toHaveLength(1);
    const merged = merges[0].canvas;
    expect(blended).toContainEqual({ src: merged, op: 'multiply', alpha: 0.5 });
    expect(blended.some(d => d.src === layer.canvas)).toBe(false);
  });

  it('draws the float straight onto the display over a normal, opaque layer', () => {
    const { canvas, layer, displayCtx, merges, renderTransformed } = setup({});
    const drawn = recordDraws(displayCtx);

    canvas.composite();

    expect(merges).toHaveLength(0);
    expect(renderTransformed).toHaveBeenCalledWith(displayCtx);
    expect(drawn.some(d => d.src === layer.canvas)).toBe(true);
  });

  it('reuses the merged layer until the transform changes, then redoes only the float\'s area', () => {
    const { canvas, layer, tm, merges } = setup();
    canvas.composite();
    const mergeCtx = merges[0];
    const calls: string[] = [];
    vi.spyOn(mergeCtx, 'clearRect').mockImplementation((...args) => { calls.push(`clear ${args.join(',')}`); });
    vi.spyOn(mergeCtx, 'drawImage').mockImplementation(((src: unknown, ...args: number[]) => {
      calls.push(src === layer.canvas ? `layer ${args.slice(0, 4).join(',')}` : 'float');
    }) as typeof mergeCtx.drawImage);

    // Pan, zoom and hover frames keep the transform as it was.
    canvas.composite();
    expect(merges).toHaveLength(1);

    tm.renderKey = 'b';
    tm.getBounds.mockReturnValue({ x: 40, y: 10, w: 20, h: 20 });
    canvas.composite();

    expect(merges).toHaveLength(2);
    // The union of the old and new bounds, with a pixel of margin.
    expect(calls).toEqual(['clear 9,9,52,22', 'layer 9,9,52,22', 'float']);
  });

  it('still shows the float outside the document on a blended layer', () => {
    const { canvas, displayCtx, renderTransformed } = setup();
    const clip = vi.spyOn(displayCtx, 'clip');
    canvas.composite();
    expect(renderTransformed).toHaveBeenCalledWith(displayCtx);
    expect(clip).toHaveBeenCalledWith('evenodd');
  });

  it('frees the merged layer once the transform ends', () => {
    const { canvas, merges } = setup();
    canvas.composite();
    const merged = merges[0].canvas;
    (canvas as any)._transformManager = null;
    canvas.composite();
    expect(merged.width).toBe(0);
    expect((canvas as any)._transformMerge).toBeNull();
  });

  it('flattens the merged layer for export', () => {
    const { canvas, merges } = setup();
    canvas.renderFlattened(null);
    expect(merges).toHaveLength(1);
  });

  it('samples the merged layer under the layer\'s blend mode', () => {
    const { canvas, layer, merges } = setup();
    const realCreate = document.createElement.bind(document);
    let draws: ReturnType<typeof recordDraws> = [];
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'canvas' && !(canvas as any)._samplingBuffer) {
        draws = recordDraws((el as HTMLCanvasElement).getContext('2d', { willReadFrequently: true })!);
      }
      return el;
    }) as typeof document.createElement);

    (canvas as any)._ensureSamplingBuffer();
    vi.restoreAllMocks();

    expect(merges).toHaveLength(1);
    expect(draws).toContainEqual({ src: merges[0].canvas, op: 'multiply', alpha: 0.5 });
    expect(draws.some(d => d.src === layer.canvas)).toBe(false);
  });
});

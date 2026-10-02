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

  it('previews a huge warp at reduced resolution but commits it at full resolution', () => {
    const tm = makePerspectiveManager();
    (tm as any)._perspectiveCorners.se = { x: 20000, y: 20000 };
    tm.renderTransformed(makeCanvas(300, 200).getContext('2d')!);
    const preview = (tm as any)._warpCache;
    expect(preview.scale).toBeLessThan(1);
    expect(preview.canvas.width * preview.canvas.height).toBeLessThanOrEqual(4096 * 4096);

    const layer = makeCanvas(100, 100);
    tm.commit(layer);
    const committed = (tm as any)._warpCache;
    expect(committed.scale).toBe(1);
    expect([committed.x, committed.y, committed.w, committed.h]).toEqual([0, 0, 100, 100]);
  });

  it('drafts a large warp while a handle is dragged, and redoes it in full on release', () => {
    const tm = new TransformManager(
      new ImageData(1500, 1500), { x: 0, y: 0, w: 1500, h: 1500 }, makeCanvas(100, 100), 1, { x: 0, y: 0 },
    );
    (tm as any)._perspectiveActive = true;
    (tm as any)._perspectiveCorners.se = { x: 30, y: 20 };
    const ctx = makeCanvas(100, 100).getContext('2d')!;

    (tm as any)._interaction = { type: 'perspective', corner: 'se', startPoint: { x: 1500, y: 1500 } };
    tm.renderTransformed(ctx);
    expect((tm as any)._warpCache.scale).toBeLessThan(1);

    tm.onPointerUp({ x: 1500, y: 1500 });
    tm.renderTransformed(ctx);
    expect((tm as any)._warpCache.scale).toBe(1);
  });

  it('snapshots only the part on the document, at full resolution, when clipped', () => {
    const tm = makePerspectiveManager();
    (tm as any)._perspectiveCorners.se = { x: 20000, y: 20000 };
    (tm as any)._interaction = { type: 'perspective', corner: 'se', startPoint: { x: 10, y: 10 } };
    const snap = tm.snapshot({ x: 0, y: 0, w: 100, h: 80 })!;
    expect([snap.x, snap.y, snap.w, snap.h]).toEqual([0, 0, 100, 80]);
    expect((tm as any)._warpCache.scale).toBe(1);
    expect(tm.snapshot({ x: 500, y: -500, w: 10, h: 10 })).toBeNull();
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
    (canvas as any)._transformManager = makeTransformManagerStub({ renderTransformed });
    return { canvas, layer, displayCtx, merges, renderTransformed };
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
    const scratch = merges[0].canvas;
    expect(scratch).not.toBe(layer.canvas);
    expect(blended).toContainEqual({ src: scratch, op: 'multiply', alpha: 0.5 });
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

  it('still shows the float outside the document, and only there, on a blended layer', () => {
    const { canvas, displayCtx, renderTransformed } = setup();
    const path: string[] = [];
    vi.spyOn(displayCtx, 'beginPath').mockImplementation(() => { path.length = 0; });
    vi.spyOn(displayCtx, 'rect').mockImplementation((...args) => { path.push(args.join(',')); });
    let clipped: string[] | null = null;
    vi.spyOn(displayCtx, 'clip').mockImplementation(((rule?: string) => {
      if (rule === 'evenodd') clipped = [...path];
    }) as typeof displayCtx.clip);

    canvas.composite();

    expect(renderTransformed).toHaveBeenCalledWith(displayCtx);
    // Everything except the document, which the merged layer already covers.
    expect(clipped).toContain('0,0,100,100');
    expect(clipped).toHaveLength(2);
  });

  it('frees the scratch canvas once the transform ends', () => {
    const { canvas, merges } = setup();
    canvas.composite();
    const scratch = merges[0].canvas;
    (canvas as any)._transformManager = null;
    canvas.composite();
    expect(scratch.width).toBe(0);
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

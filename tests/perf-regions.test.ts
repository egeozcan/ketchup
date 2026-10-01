import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { floodFill } from '../src/tools/fill.ts';
import { shapeBounds } from '../src/tools/shapes.ts';
import { StrokeBufferPool } from '../src/engine/stroke-buffer-pool.ts';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { BrushTipCache } from '../src/engine/brush-tip-cache.ts';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { MemoryBackend } from '../src/storage/memory/index.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { hashImageData } from '../src/utils/image-diff.ts';
import { attachCanvasElements, makeAppCanvasStub, makeBrush, makeCanvas, makeLayer, makeState } from './helpers.ts';

function setupCanvas(stateOverrides: Record<string, unknown> = {}) {
  const canvas = new DrawingCanvas();
  const layer = makeLayer(100, 100);
  const state = makeState({ layers: [layer], activeLayerId: layer.id, ...(stateOverrides as object) });
  (canvas as any)._ctx = { value: { state } };
  attachCanvasElements(canvas, 100, 100);
  (canvas as any).requestUpdate = vi.fn();
  return { canvas, layer };
}

describe('flood fill writes back and records only what it filled', () => {
  it('returns the filled bounds and uploads only that rectangle', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 10;
    canvas.height = 5;
    const ctx = canvas.getContext('2d')!;
    // An opaque wall at column 4 stops a fill started on its left.
    const img = new ImageData(10, 5);
    for (let y = 0; y < 5; y++) img.data[(y * 10 + 4) * 4 + 3] = 255;
    vi.spyOn(ctx, 'getImageData').mockReturnValue(img);
    const put = vi.spyOn(ctx, 'putImageData');

    const bounds = floodFill(ctx, 1, 1, '#ff0000', 1);

    expect(bounds).toEqual({ x: 0, y: 0, w: 4, h: 5 });
    expect(put).toHaveBeenCalledWith(img, 0, 0, 0, 0, 4, 5);
  });

  it('diffs only the filled region for history', () => {
    const { canvas, layer } = setupCanvas({ activeTool: 'fill' });
    (canvas as any).composite = vi.fn();
    const layerCtx = layer.canvas.getContext('2d')!;
    vi.spyOn(layerCtx, 'getImageData').mockImplementation(((_x: number, _y: number, w: number, h: number) => {
      const img = new ImageData(w, h);
      // A wall at column 20 confines the fill to x < 20.
      if (w === 100) for (let y = 0; y < h; y++) img.data[(y * w + 20) * 4 + 3] = 255;
      return img;
    }) as typeof layerCtx.getImageData);
    const push = vi.spyOn(canvas as any, '_pushDrawHistory');

    (canvas as any)._onPointerDown({ button: 0, clientX: 5, clientY: 5, pointerId: 1 } as PointerEvent);

    expect(push).toHaveBeenCalledWith(false, { x: 0, y: 0, w: 20, h: 100 });
  });
});

describe('shape commits record only the shape region', () => {
  it('pads the drag box by half the line width plus anti-aliasing', () => {
    expect(shapeBounds({ x: 30, y: 20 }, { x: 10, y: 40 }, 6)).toEqual({ x: 5, y: 15, w: 30, h: 30 });
  });

  it('passes the shape bounds to history on pointerup', () => {
    const { canvas } = setupCanvas({ activeTool: 'rectangle', brush: { size: 4 } });
    (canvas as any).composite = vi.fn();
    (canvas as any)._drawing = true;
    (canvas as any)._startPoint = { x: 10, y: 10 };
    (canvas as any)._lastPoint = { x: 10, y: 10 };
    (canvas as any)._getDocPoint = vi.fn(() => ({ x: 30, y: 20 }));
    const push = vi.spyOn(canvas as any, '_pushDrawHistory');

    (canvas as any)._onPointerUp({ pointerId: 1 } as PointerEvent);

    expect(push).toHaveBeenCalledWith(false, shapeBounds({ x: 10, y: 10 }, { x: 30, y: 20 }, 4));
  });
});

describe('stroke buffer works on the stroke footprint', () => {
  it('clears only the previous stroke region and composites only the current one', () => {
    const pool = new StrokeBufferPool();
    const buffer = pool.acquire(200, 200, null) as HTMLCanvasElement;
    const bufCtx = buffer.getContext('2d')!;
    const clear = vi.spyOn(bufCtx, 'clearRect');

    pool.acquire(200, 200, { x: 10, y: 20, w: 30, h: 40 });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(10, 20, 30, 40);

    const target = document.createElement('canvas').getContext('2d')!;
    const draw = vi.spyOn(target, 'drawImage');
    const fill = vi.spyOn(bufCtx, 'fillRect');
    pool.commit(target, '#ff0000', 1, false, { x: 5, y: 6, w: 7, h: 8 });
    expect(fill).toHaveBeenCalledWith(5, 6, 7, 8);
    expect(draw).toHaveBeenCalledWith(buffer, 5, 6, 7, 8, 5, 6, 7, 8);

    draw.mockClear();
    pool.commit(target, '#ff0000', 1, false, null);
    expect(draw).not.toHaveBeenCalled();
  });

  it('hands the next stroke the previous stroke footprint to clear', () => {
    const engine = new StampStrokeEngine();
    const acquire = vi.spyOn((engine as any)._bufferPool, 'acquire');
    engine.begin(makeBrush({ size: 10 }), '#000000', false, 100, 100);
    expect(acquire).toHaveBeenLastCalledWith(100, 100, null);
    engine.stroke(50, 50, 1);
    const target = document.createElement('canvas').getContext('2d')!;
    engine.commit(target);
    const footprint = engine.getDirtyBounds()!;

    engine.begin(makeBrush({ size: 10 }), '#000000', false, 100, 100);

    const stale = acquire.mock.lastCall![2] as { x: number; y: number; w: number; h: number };
    expect(stale).not.toBeNull();
    expect(stale.x).toBeLessThanOrEqual(footprint.x);
    expect(stale.y).toBeLessThanOrEqual(footprint.y);
    expect(stale.x + stale.w).toBeGreaterThanOrEqual(footprint.x + footprint.w);
    expect(stale.y + stale.h).toBeGreaterThanOrEqual(footprint.y + footprint.h);
  });
});

describe('brush tip cache', () => {
  it('keeps recently used tips and evicts the least recently used past its byte budget', () => {
    const cache = new BrushTipCache();
    const tip = makeBrush().tip;
    const first = cache.get(1000, 1, tip);
    const second = cache.get(1002, 1, tip);
    // Touch the first so the second becomes least recently used.
    expect(cache.get(1000, 1, tip)).toBe(first);
    // Each ~1000px tip is ~4 MB; enough of them overflow the 32 MB budget.
    for (let d = 1004; d < 1020; d += 2) cache.get(d, 1, tip);

    expect(cache.get(1002, 1, tip)).not.toBe(second);
  });
});

describe('composited reports whether layer content changed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function capture(canvas: DrawingCanvas) {
    const details: unknown[] = [];
    canvas.addEventListener('composited', (e) => details.push((e as CustomEvent).detail));
    return details;
  }

  it('marks view-only composites, and keeps the sampling buffer', () => {
    const { canvas } = setupCanvas();
    const details = capture(canvas);
    (canvas as any)._samplingDirty = false;

    canvas.scheduleComposite(false);
    vi.advanceTimersByTime(50);

    expect(details).toEqual([{ contentChanged: false }]);
    expect((canvas as any)._samplingDirty).toBe(false);
  });

  it('reports a content change if any request in the frame had one', () => {
    const { canvas } = setupCanvas();
    const details = capture(canvas);

    canvas.scheduleComposite(true);
    canvas.scheduleComposite(false);
    vi.advanceTimersByTime(50);
    canvas.composite();

    expect(details).toEqual([{ contentChanged: true }, { contentChanged: true }]);
    expect((canvas as any)._samplingDirty).toBe(true);
  });
});

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reuses stored layers after a settings-only change', () => {
    const app = new DrawingApp();
    const before = (app as any)._contentVersion;
    (app as any)._markDirty('setting');
    (app as any)._markDirty('viewport');
    expect((app as any)._contentVersion).toBe(before);
    (app as any)._markDirty('work');
    expect((app as any)._contentVersion).toBe(before + 1);
  });

  it('waits for a pointer gesture to end before saving', () => {
    const app = new DrawingApp();
    let gesture = true;
    Object.defineProperty(app, 'canvas', { value: { isGestureActive: () => gesture } });
    const save = vi.spyOn(app as any, '_save').mockResolvedValue(undefined);

    (app as any)._markDirty('work');
    vi.advanceTimersByTime(2000);
    expect(save).not.toHaveBeenCalled();

    gesture = false;
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves anyway if the gesture never seems to end', () => {
    const app = new DrawingApp();
    Object.defineProperty(app, 'canvas', { value: { isGestureActive: () => true } });
    const save = vi.spyOn(app as any, '_save').mockResolvedValue(undefined);

    (app as any)._markDirty('work');
    vi.advanceTimersByTime(30_000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('memory backend stamps', () => {
  it('frees a deleted stamp\'s blob', async () => {
    const backend = new MemoryBackend();
    const stamp = await backend.stamps.add('p1', new Blob(['x']));
    await backend.stamps.delete(stamp.id);
    await Promise.resolve();
    expect(await backend.blobs.get(stamp.blobRef).catch(() => null)).toBeNull();
  });
});

describe('wet brush tinting', () => {
  it('crops a smaller tip out of the grown tint canvas instead of scaling it', () => {
    const engine = new StampStrokeEngine();
    const layer = document.createElement('canvas').getContext('2d')!;
    const brush = (size: number) => makeBrush({ size, pressureSize: false, ink: { wetness: 0.5 } });

    engine.begin(brush(60), '#ff0000', false, 200, 200);
    engine.stroke(100, 100, 1, layer);
    engine.commit(layer);

    engine.begin(brush(10), '#ff0000', false, 200, 200);
    const buffer = (engine as any)._bufferPool.current as HTMLCanvasElement;
    const draw = vi.spyOn(buffer.getContext('2d')!, 'drawImage');
    engine.stroke(100, 100, 1, layer);

    const tint = (engine as any)._tintCanvas as HTMLCanvasElement;
    // The canvas mock's drawImage is already a mock carrying the first stroke's
    // calls, so take the last draw of the tint canvas.
    const call = draw.mock.calls.filter(args => args[0] === tint).at(-1)!;
    expect(tint.width).toBeGreaterThan(10);
    expect(call).toHaveLength(9);
    // Source rectangle is the tip's own size, matching the destination size.
    expect(call[3]).toBe(call[7]);
    expect(call[4]).toBe(call[8]);
    expect(call[3]).toBeLessThan(tint.width);
  });
});

describe('saves that reuse stored layers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupSave(canvasOverrides: Record<string, unknown> = {}) {
    const backend = new MockBackend();
    await backend.init();
    const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
    const app = new DrawingApp();
    const layer = makeLayer(20, 20, { id: 'l1' });
    (app as any)._state = makeState({ layers: [layer], activeLayerId: 'l1', documentWidth: 20, documentHeight: 20 });
    (app as any)._currentProject = project;
    (app as any)._backend = backend;
    Object.defineProperty(app, 'canvas', {
      configurable: true,
      value: makeAppCanvasStub({ mainCanvas: makeCanvas(40, 30), ...canvasOverrides }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['png'], { type: 'image/png' }));
    });
    const save = async (kind: 'work' | 'setting') => {
      (app as any)._dirty = true;
      (app as any)._dirtyVersion++;
      if (kind === 'work') (app as any)._contentVersion++;
      await (app as any)._save(true);
    };
    return { app, backend, project, layer, save };
  }

  it('does not trust layers snapshotted during a pointer gesture', async () => {
    let gesture = true;
    const { app, layer, save } = await setupSave({ isGestureActive: () => gesture });
    await save('work');
    expect((app as any)._savedContentVersion).toBe(-1);

    gesture = false;
    const read = vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData');
    await save('setting');
    // The next save re-reads the layer instead of keeping the mid-gesture blob.
    expect(read).toHaveBeenCalled();
    expect((app as any)._savedContentVersion).toBe((app as any)._contentVersion);
  });

  it('encodes the live layer when the stored state lost the reused blob', async () => {
    const { app, backend, project, layer, save } = await setupSave();
    await save('work');
    // The layer now differs from what the first save hashed.
    const live = new ImageData(20, 20);
    live.data[3] = 255;
    vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData').mockReturnValue(live);
    // Another tab saved this project with different layer blobs.
    const state = (await backend.state.get(project.id))!;
    const otherRef = await backend.blobs.put(new Blob(['other']));
    await backend.state.save({ ...state, layers: state.layers.map(l => ({ ...l, imageBlobRef: otherRef })) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await save('setting');

    expect(error).not.toHaveBeenCalled();
    const ref = (await backend.state.get(project.id))!.layers[0].imageBlobRef;
    expect(ref).not.toBe(otherRef);
    expect(await backend.blobs.get(ref)).toBeInstanceOf(Blob);
    expect((app as any)._savedContentVersion).toBe(-1);
    // The recorded hash is that of the pixels stored, not the stale one.
    expect((app as any)._savedLayerBlobs.get('l1')).toEqual({ hash: hashImageData(live), blobRef: ref });
  });

  it('keeps the thumbnail on a settings-only save, and retries one that failed', async () => {
    const { backend, save } = await setupSave();
    const update = vi.spyOn(backend.projects, 'update').mockRejectedValueOnce(new Error('quota'));
    await save('work');
    // The thumbnail write failed, so the next save, even settings-only, retries it.
    await save('setting');
    expect(update.mock.calls.at(-1)![1]).toHaveProperty('thumbnailRef');

    update.mockClear();
    await save('setting');
    expect(update.mock.calls.at(-1)![1]).toEqual({});
  });
});

describe('coalesced viewport-change', () => {
  it('can be flushed before the next frame, once', () => {
    const { canvas } = setupCanvas();
    const seen = vi.fn();
    canvas.addEventListener('viewport-change', seen);

    (canvas as any)._scheduleViewportChange();
    canvas.flushViewportChange();
    canvas.flushViewportChange();

    expect(seen).toHaveBeenCalledTimes(1);
  });
});

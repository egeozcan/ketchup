import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { paintStroke, strokeCompositeOp } from '../src/engine/stroke-buffer-pool.ts';
import { copyDescriptor, getDefaultDescriptor, BRUSH_PRESETS } from '../src/engine/brush-presets.ts';
import { BRUSH_BLEND_MODE_LABELS, isBrushBlendMode, type BrushBlendMode } from '../src/engine/types.ts';
import { blendColor, blendKeepingAlpha } from '../src/engine/blend-math.ts';
import { floodFill } from '../src/tools/fill.ts';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import { deserializeHistoryEntry, deserializeLayer, serializeHistoryEntry, serializeLayerFromImageData } from '../src/utils/storage-serialization.ts';
import type { HistoryEntry } from '../src/types.ts';
import { attachCanvasElements, makeAppCanvasStub, makeBrush, makeLayer, makeState } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const DOC = 100;

interface Draw { onto: HTMLCanvasElement; from: unknown; op: string; alpha: number }

/** Every drawImage into a canvas of document size, with the operation and alpha it was made under. */
function recordDraws(): Draw[] {
  const draws: Draw[] = [];
  // Offscreen canvases (the stroke buffer and the lock scratch) have a context class of their own.
  const protos = [CanvasRenderingContext2D.prototype, typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D.prototype : null];
  for (const proto of protos) {
    if (!proto) continue;
    vi.spyOn(proto, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      draws.push({ onto: this.canvas, from: args[0], op: this.globalCompositeOperation, alpha: this.globalAlpha });
    });
  }
  return draws;
}

/** One dab of a stroke committed onto `target`; returns the draws that landed on the target itself. */
function commitStroke(brush: Parameters<typeof makeBrush>[0], opts: { eraser?: boolean; alphaLocked?: boolean } = {}) {
  const target = document.createElement('canvas');
  target.width = DOC;
  target.height = DOC;
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, pressureSize: false, ...brush }), '#336699', opts.eraser ?? false, DOC, DOC, { seed: 1, alphaLocked: opts.alphaLocked });
  engine.stroke(50, 50, 1);
  const preview = engine.getStrokePreview();
  const draws = recordDraws();
  engine.commit(target.getContext('2d')!);
  return { onto: draws.filter(d => d.onto === target), all: draws, target, preview, engine };
}

describe('brush blend modes', () => {
  it('maps every mode to its canvas operation', () => {
    const ops: Record<BrushBlendMode, string> = {
      'normal': 'source-over', 'multiply': 'multiply', 'screen': 'screen', 'overlay': 'overlay',
      'darken': 'darken', 'lighten': 'lighten', 'color-burn': 'color-burn', 'color-dodge': 'color-dodge',
      'hue': 'hue', 'saturation': 'saturation', 'color': 'color', 'luminosity': 'luminosity',
      'behind': 'destination-over', 'clear': 'destination-out',
    };
    expect(Object.keys(BRUSH_BLEND_MODE_LABELS).sort()).toEqual(Object.keys(ops).sort());
    for (const mode of Object.keys(ops) as BrushBlendMode[]) {
      expect(strokeCompositeOp(false, mode, false)).toBe(ops[mode]);
    }
  });

  it('composites the committed stroke with its mode and the stroke opacity', () => {
    for (const [mode, op] of [['multiply', 'multiply'], ['color-dodge', 'color-dodge'], ['behind', 'destination-over'], ['clear', 'destination-out'], ['normal', 'source-over']] as const) {
      const { onto } = commitStroke({ opacity: 0.5, blendMode: mode });
      expect(onto).toHaveLength(1);
      expect(onto[0].op).toBe(op);
      expect(onto[0].alpha).toBe(0.5);
    }
  });

  it('keeps the eraser tool erasing whatever the brush mode is', () => {
    expect(strokeCompositeOp(true, 'multiply', false)).toBe('destination-out');
    const { onto } = commitStroke({ blendMode: 'screen' }, { eraser: true });
    expect(onto.map(d => d.op)).toEqual(['destination-out']);
  });

  it('hands the preview the mode and lock commit will use', () => {
    const { preview } = commitStroke({ blendMode: 'overlay' }, { alphaLocked: true });
    expect(preview).toMatchObject({ mode: 'overlay', alphaLocked: true, eraser: false });
  });

  it('defaults to normal in presets, copies and stored brushes without a mode', () => {
    for (const preset of BRUSH_PRESETS) expect(preset.descriptor.blendMode).toBe('normal');
    expect(getDefaultDescriptor().blendMode).toBe('normal');
    const legacy: Partial<ReturnType<typeof getDefaultDescriptor>> = { ...getDefaultDescriptor() };
    delete legacy.blendMode;
    expect(copyDescriptor(legacy as ReturnType<typeof getDefaultDescriptor>).blendMode).toBe('normal');
    expect(copyDescriptor({ ...getDefaultDescriptor(), blendMode: 'bogus' as BrushBlendMode }).blendMode).toBe('normal');
    expect(copyDescriptor({ ...getDefaultDescriptor(), blendMode: 'hue' }).blendMode).toBe('hue');
    expect(isBrushBlendMode('behind')).toBe(true);
    expect(isBrushBlendMode('toString')).toBe(false);
  });
});

/** The canvas mock has no colour parser: make fill's 1x1 parse of any colour read red. */
function redIsParsed() {
  vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData').mockImplementation(() => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }) as ImageData);
}

describe('alpha lock', () => {
  it('paints a plain stroke with source-atop, which keeps the layer alpha', () => {
    const { onto } = commitStroke({ opacity: 0.7 }, { alphaLocked: true });
    expect(onto).toHaveLength(1);
    expect(onto[0].op).toBe('source-atop');
    expect(onto[0].alpha).toBe(0.7);
  });

  it('makes no canvas blend into a locked layer for a mode', () => {
    expect(commitStroke({ opacity: 0.6, blendMode: 'multiply' }, { alphaLocked: true }).onto).toHaveLength(0);
  });

  it('reads and writes just the stroke bounds for a locked blend', () => {
    const target = document.createElement('canvas');
    target.width = DOC;
    target.height = DOC;
    const ctx = target.getContext('2d')!;
    const read = vi.spyOn(ctx, 'getImageData');
    const put = vi.spyOn(ctx, 'putImageData');
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, pressureSize: false, blendMode: 'color' }), '#336699', false, DOC, DOC, { seed: 1, alphaLocked: true });
    engine.stroke(50, 50, 1);
    const b = engine.getDirtyBounds()!;
    engine.commit(ctx);
    expect(read).toHaveBeenCalledWith(b.x, b.y, b.w, b.h);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0].slice(1)).toEqual([b.x, b.y]);
  });

  it('does nothing for Behind, Clear and the eraser', () => {
    expect(commitStroke({ blendMode: 'behind' }, { alphaLocked: true }).all).toHaveLength(0);
    expect(commitStroke({ blendMode: 'clear' }, { alphaLocked: true }).all).toHaveLength(0);
    expect(commitStroke({}, { alphaLocked: true, eraser: true }).all).toHaveLength(0);
    expect(strokeCompositeOp(true, 'normal', true)).toBeNull();
  });

  it('leaves an unlocked layer to the plain operations', () => {
    expect(commitStroke({}, { alphaLocked: false }).onto.map(d => d.op)).toEqual(['source-over']);
  });

  it('fills an alpha-locked layer with the colour only', () => {
    const w = 3, h = 1;
    const image = new ImageData(w, h);
    image.data.set([0, 0, 0, 0, 10, 10, 10, 128, 10, 10, 10, 255]);
    const put = vi.fn();
    redIsParsed();
    const ctx = { canvas: { width: w, height: h }, getImageData: () => image, putImageData: put } as unknown as CanvasRenderingContext2D;
    expect(floodFill(ctx, 0, 0, '#ff0000', 255, true)).not.toBeNull();
    expect([...image.data]).toEqual([255, 0, 0, 0, 255, 0, 0, 128, 255, 0, 0, 255]);
  });

  it('fills the alpha too when the layer is not locked', () => {
    const image = new ImageData(1, 1);
    redIsParsed();
    const ctx = { canvas: { width: 1, height: 1 }, getImageData: () => image, putImageData: vi.fn() } as unknown as CanvasRenderingContext2D;
    floodFill(ctx, 0, 0, '#ff0000');
    expect([...image.data]).toEqual([255, 0, 0, 255]);
  });
});

const px = (r: number, g: number, b: number, a: number) => { const i = new ImageData(1, 1); i.data.set([r, g, b, a]); return i; };

describe('preview delta', () => {
  it('reports what was stamped since it was last taken', () => {
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 10, pressureSize: false, spacing: 0.25 }), '#000000', false, 400, 100, { seed: 1 });
    expect(engine.takePreviewDelta()).toBeNull();
    for (let x = 20; x <= 60; x += 4) engine.stroke(x, 50, 1);
    const first = engine.takePreviewDelta()!;
    expect(first).toEqual(engine.getDirtyBounds());
    expect(engine.takePreviewDelta()).toBeNull();
    for (let x = 64; x <= 120; x += 4) engine.stroke(x, 50, 1);
    const second = engine.takePreviewDelta()!;
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.x).toBeLessThanOrEqual(first.x + first.w);
    expect(second.x + second.w).toBe(engine.getDirtyBounds()!.x + engine.getDirtyBounds()!.w);
    engine.begin(makeBrush({ size: 10 }), '#000000', false, 400, 100, { seed: 1 });
    expect(engine.takePreviewDelta()).toBeNull();
  });
});

/** A context over a bare pixel array, enough for paintStroke's in-memory path. */
function pixelCtx(width: number, height: number, fill: number[]) {
  const image = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) image.data.set(fill, i * 4);
  const ctx = {
    getImageData(x: number, y: number, w: number, h: number) {
      const out = new ImageData(w, h);
      for (let r = 0; r < h; r++) out.data.set(image.data.subarray(((y + r) * width + x) * 4, ((y + r) * width + x + w) * 4), r * w * 4);
      return out;
    },
    putImageData(data: ImageData, x: number, y: number) {
      for (let r = 0; r < data.height; r++) image.data.set(data.data.subarray(r * data.width * 4, (r + 1) * data.width * 4), ((y + r) * width + x) * 4);
    },
  };
  return { image, ctx, canvas: { getContext: () => ctx } };
}

describe('paintStroke on a locked layer', () => {
  it('writes only the colour inside the bounds, and the same pixels whether done at once or in two parts', () => {
    const run = (parts: { x: number; y: number; w: number; h: number }[]) => {
      const layer = pixelCtx(4, 2, [0, 0, 0, 128]);
      layer.image.data.set([10, 20, 30, 0], 0); // a transparent pixel stays so
      const stroke = pixelCtx(4, 2, [255, 255, 255, 255]);
      for (const part of parts) {
        paintStroke(layer.ctx as unknown as CanvasRenderingContext2D, stroke.canvas as unknown as HTMLCanvasElement, part, { opacity: 1, eraser: false, mode: 'multiply', alphaLocked: true });
      }
      return [...layer.image.data];
    };
    const whole = run([{ x: 0, y: 0, w: 4, h: 2 }]);
    // White Multiply changes nothing, even over half-transparent pixels, and no alpha moves.
    expect(whole).toEqual([10, 20, 30, 0, ...Array(7).fill([0, 0, 0, 128]).flat()]);
    expect(run([{ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }])).toEqual(whole);
  });

  it('blends a coloured stroke at partial opacity and keeps the alpha', () => {
    const layer = pixelCtx(2, 1, [200, 100, 50, 128]);
    const stroke = pixelCtx(2, 1, [255, 0, 0, 255]);
    paintStroke(layer.ctx as unknown as CanvasRenderingContext2D, stroke.canvas as unknown as HTMLCanvasElement, { x: 0, y: 0, w: 2, h: 1 }, { opacity: 0.5, eraser: false, mode: 'multiply', alphaLocked: true });
    // Half way from the layer colour to its product with red (200, 0, 0).
    expect([...layer.image.data.subarray(0, 4)]).toEqual([200, 50, 25, 128]);
  });
});

describe('blend math', () => {
  it('follows the separable formulas', () => {
    expect(blendColor('multiply', [0.5, 1, 0], [0.5, 0.5, 1])).toEqual([0.25, 0.5, 0]);
    expect(blendColor('screen', [0.5, 0, 1], [0.5, 0.5, 0.5])).toEqual([0.75, 0.5, 1]);
    expect(blendColor('darken', [0.2, 0.9, 0.5], [0.4, 0.3, 0.5])).toEqual([0.2, 0.3, 0.5]);
    expect(blendColor('lighten', [0.2, 0.9, 0.5], [0.4, 0.3, 0.5])).toEqual([0.4, 0.9, 0.5]);
    // Overlay is hard light with the layers swapped: dark backdrops multiply, light ones screen.
    expect(blendColor('overlay', [0.25, 0.75, 0.5], [0.5, 0.5, 0.5])).toEqual([0.25, 0.75, 0.5]);
    expect(blendColor('color-dodge', [0, 0.25, 0.5], [0.5, 0.5, 1])).toEqual([0, 0.5, 1]);
    expect(blendColor('color-burn', [1, 0.75, 0.5], [0.5, 0.5, 0])).toEqual([1, 0.5, 0]);
  });

  it('follows the non-separable formulas', () => {
    const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
    const backdrop: [number, number, number] = [0.8, 0.4, 0.2];
    const source: [number, number, number] = [0.1, 0.3, 0.9];
    const color = blendColor('color', backdrop, source);
    expect(lum(color)).toBeCloseTo(lum(backdrop), 6);
    expect(color[2]).toBeGreaterThan(color[0]);
    const luminosity = blendColor('luminosity', backdrop, source);
    expect(lum(luminosity)).toBeCloseTo(lum(source), 6);
    const hue = blendColor('hue', backdrop, source);
    expect(lum(hue)).toBeCloseTo(lum(backdrop), 6);
    expect(sat(hue)).toBeCloseTo(sat(backdrop), 6);
    const saturation = blendColor('saturation', backdrop, source);
    expect(lum(saturation)).toBeCloseTo(lum(backdrop), 6);
    expect(sat(saturation)).toBeCloseTo(sat(source), 6);
    // A grey source has no hue or saturation to give.
    expect(sat(blendColor('saturation', backdrop, [0.5, 0.5, 0.5]))).toBeCloseTo(0, 6);
  });

  it('keeps the destination alpha and leaves uncovered or transparent pixels alone', () => {
    const dst = new ImageData(3, 1);
    dst.data.set([200, 100, 50, 128, 10, 20, 30, 0, 200, 100, 50, 128]);
    const src = new ImageData(3, 1);
    src.data.set([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0]);
    blendKeepingAlpha(dst, src, 1, 'multiply');
    // Covered: the colour is the blend; alpha stays. Transparent: untouched. Uncovered: untouched.
    expect([...dst.data]).toEqual([0, 0, 50, 128, 10, 20, 30, 0, 200, 100, 50, 128]);
  });

  it('weighs the stroke by its coverage and the stroke opacity', () => {
    const dst = px(200, 100, 50, 255);
    blendKeepingAlpha(dst, px(0, 0, 0, 128), 0.5, 'multiply');
    const cover = (128 / 255) * 0.5;
    expect([...dst.data]).toEqual([Math.round(200 * (1 - cover)), Math.round(100 * (1 - cover)), Math.round(50 * (1 - cover)), 255]);
  });

  it('does not lighten semi-transparent pixels under white Multiply', () => {
    const dst = px(0, 0, 0, 128);
    blendKeepingAlpha(dst, px(255, 255, 255, 255), 1, 'multiply');
    expect([...dst.data]).toEqual([0, 0, 0, 128]);
  });
});

describe('live preview matches commit', () => {
  function previewDraws(layerOverrides: Parameters<typeof makeLayer>[2], brush: Parameters<typeof makeBrush>[0], tool: 'pencil' | 'eraser' = 'pencil') {
    const layer = makeLayer(DOC, DOC, layerOverrides);
    const canvas = new DrawingCanvas();
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id, documentWidth: DOC, documentHeight: DOC, activeTool: tool, brush: { size: 20, pressureSize: false, ...brush } }) } };
    attachCanvasElements(canvas, DOC, DOC);
    (canvas as any).requestUpdate = vi.fn();
    (canvas as any)._zoom = 1;
    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    // Recording first: a context made before the spies keeps calling the original.
    const draws = recordDraws();
    (canvas as any)._onPointerDown({ button: 0, clientX: 50, clientY: 50, pointerId: 1, pointerType: 'mouse', timeStamp: 1 } as PointerEvent);
    // The press composited once already; keep one frame.
    draws.length = 0;
    (canvas as any)._composite(false);
    const scratch = (canvas as any)._tintPreviewCanvas as HTMLCanvasElement | null;
    return { draws, scratch, layer };
  }

  it('draws straight to the display only for a plain stroke on an unlocked, normal layer', () => {
    expect(previewDraws({}, {}).scratch).toBeNull();
    expect(previewDraws({}, { blendMode: 'multiply' }).scratch).not.toBeNull();
    expect(previewDraws({ alphaLocked: true }, {}).scratch).not.toBeNull();
  });

  it('applies the same operations on the layer copy as commit does', () => {
    const modes: [Parameters<typeof makeLayer>[2], Parameters<typeof makeBrush>[0]][] = [
      [{}, { blendMode: 'multiply' }],
      [{}, { blendMode: 'behind' }],
      [{ alphaLocked: true }, {}],
      [{ alphaLocked: true }, { blendMode: 'behind' }],
    ];
    for (const [layerOverrides, brush] of modes) {
      const { draws, scratch, layer } = previewDraws(layerOverrides, { opacity: 0.5, ...brush });
      const committed = commitStroke({ opacity: 0.5, ...brush }, { alphaLocked: layerOverrides?.alphaLocked });
      // The preview's copy of the layer is not the stroke; everything else drawn onto it is.
      const strokeOnto = (list: Draw[], onto: HTMLCanvasElement | null) => list.filter(d => d.onto === onto && d.from !== layer.canvas).map(d => [d.op, d.alpha]);
      // Nothing lands on the copy in the preview exactly when nothing lands on the layer in the commit.
      expect(strokeOnto(draws, scratch).length > 0).toBe(committed.all.length > 0);
      if (committed.all.length > 0) expect(strokeOnto(draws, scratch)).toEqual(strokeOnto(committed.all, committed.target));
    }
  });

  it('blends a locked layer in memory in the preview too, over the same region', () => {
    const layer = makeLayer(DOC, DOC, { alphaLocked: true });
    const canvas = new DrawingCanvas();
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id, documentWidth: DOC, documentHeight: DOC, activeTool: 'pencil', brush: { size: 20, pressureSize: false, blendMode: 'screen' } }) } };
    attachCanvasElements(canvas, DOC, DOC);
    (canvas as any).requestUpdate = vi.fn();
    (canvas as any)._zoom = 1;
    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    const put = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');
    (canvas as any)._onPointerDown({ button: 0, clientX: 50, clientY: 50, pointerId: 1, pointerType: 'mouse', timeStamp: 1 } as PointerEvent);
    const scratch = (canvas as any)._tintPreviewCanvas as HTMLCanvasElement;
    expect(put.mock.contexts.some(c => (c as CanvasRenderingContext2D).canvas === scratch)).toBe(true);
    expect(put.mock.contexts.some(c => (c as CanvasRenderingContext2D).canvas === layer.canvas)).toBe(false);
  });

  it('redoes only what the latest dabs touched when blending a locked layer in memory', () => {
    const layer = makeLayer(DOC, DOC, { alphaLocked: true });
    const canvas = new DrawingCanvas();
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id, documentWidth: DOC, documentHeight: DOC, activeTool: 'pencil', brush: { size: 10, pressureSize: false, spacing: 0.25, blendMode: 'screen' } }) } };
    attachCanvasElements(canvas, DOC, DOC);
    (canvas as any).requestUpdate = vi.fn();
    (canvas as any)._zoom = 1;
    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    const put = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');
    (canvas as any)._onPointerDown({ button: 0, clientX: 10, clientY: 50, pointerId: 1, pointerType: 'mouse', timeStamp: 1 } as PointerEvent);
    for (let x = 12; x <= 90; x += 2) {
      (canvas as any)._onPointerMove({ clientX: x, clientY: 50, pointerId: 1, pointerType: 'mouse', buttons: 1, timeStamp: x } as PointerEvent);
    }
    (canvas as any)._composite(false);
    put.mockClear();
    const engine = (canvas as any)._engine;
    const whole = engine.getDirtyBounds();
    // A frame with no new dabs redoes nothing; the copy holds the last result.
    (canvas as any)._composite(false);
    expect(put).not.toHaveBeenCalled();
    (canvas as any)._onPointerMove({ clientX: 92, clientY: 50, pointerId: 1, pointerType: 'mouse', buttons: 1, timeStamp: 200 } as PointerEvent);
    (canvas as any)._onPointerMove({ clientX: 94, clientY: 50, pointerId: 1, pointerType: 'mouse', buttons: 1, timeStamp: 210 } as PointerEvent);
    const copy = (canvas as any)._tintPreviewCanvas.getContext('2d') as CanvasRenderingContext2D;
    const restored = vi.spyOn(copy, 'drawImage');
    const cleared = vi.spyOn(copy, 'clearRect');
    (canvas as any)._composite(false);
    expect(put).toHaveBeenCalledTimes(1);
    const [, x, y, ] = put.mock.calls[0] as unknown as [ImageData, number, number];
    expect(x).toBeGreaterThan(whole.x + whole.w / 2);
    // The layer's pixels go back into the region first, or overlapping dabs would blend twice.
    const [, w, h] = [0, (put.mock.calls[0][0] as ImageData).width, (put.mock.calls[0][0] as ImageData).height];
    expect(cleared).toHaveBeenCalledWith(x, y, w, h);
    expect(restored).toHaveBeenCalledWith(layer.canvas, x, y, w, h, x, y, w, h);
    expect(cleared.mock.invocationCallOrder[0]).toBeLessThan(put.mock.invocationCallOrder[0]);
  });

  it('never tints an eraser preview', () => {
    const tint = vi.spyOn(DrawingCanvas.prototype as any, '_tintStrokeRegion');
    previewDraws({}, {}, 'eraser');
    expect(tint).not.toHaveBeenCalled();
  });

  it('shows the eraser as a no-op on a locked layer', () => {
    const { draws, scratch, layer } = previewDraws({ alphaLocked: true }, {}, 'eraser');
    // Only the copy of the layer, no stroke.
    expect(draws.filter(d => d.onto === scratch && d.from !== layer.canvas)).toHaveLength(0);
  });
});

describe('alphaLocked persistence', () => {
  it('round-trips a layer and defaults a stored layer without the flag to unlocked', async () => {
    const backend = new MockBackend();
    await backend.init();
    const data = new ImageData(4, 4);
    const locked = await serializeLayerFromImageData({ id: 'a', name: 'A', visible: true, opacity: 1, blendMode: 'normal', alphaLocked: true }, data, backend.blobs);
    expect(locked.alphaLocked).toBe(true);
    expect((await deserializeLayer(locked, 4, 4, backend.blobs)).alphaLocked).toBe(true);
    const unlocked = await serializeLayerFromImageData({ id: 'b', name: 'B', visible: true, opacity: 1 }, data, backend.blobs);
    expect(unlocked.alphaLocked).toBe(false);
    const { alphaLocked: _drop, ...legacy } = locked;
    expect((await deserializeLayer(legacy, 4, 4, backend.blobs)).alphaLocked).toBe(false);
  });

  it('round-trips the lock in layer snapshots and its own history entry', async () => {
    const backend = new MockBackend();
    await backend.init();
    const snapshot = { id: 'a', name: 'A', visible: true, opacity: 1, blendMode: 'normal' as const, alphaLocked: true, imageData: new ImageData(2, 2) };
    for (const type of ['add-layer', 'delete-layer'] as const) {
      const stored = await serializeHistoryEntry({ type, layer: snapshot, index: 0 }, backend.blobs);
      const back = await deserializeHistoryEntry(stored, backend.blobs) as Extract<HistoryEntry, { type: 'add-layer' }>;
      expect(back.layer.alphaLocked).toBe(true);
    }
    const merge = await serializeHistoryEntry({
      type: 'merge', beforeLayers: [snapshot], afterLayers: [{ ...snapshot, alphaLocked: false }], previousActiveLayerId: 'a', afterActiveLayerId: 'a',
    }, backend.blobs);
    const merged = await deserializeHistoryEntry(merge, backend.blobs) as Extract<HistoryEntry, { type: 'merge' }>;
    expect([merged.beforeLayers[0].alphaLocked, merged.afterLayers[0].alphaLocked]).toEqual([true, false]);

    const lock: HistoryEntry = { type: 'alpha-lock', layerId: 'a', before: false, after: true };
    const storedLock = await serializeHistoryEntry(lock, backend.blobs);
    expect(await deserializeHistoryEntry(storedLock, backend.blobs)).toEqual(lock);

    // A snapshot stored before the flag existed comes back unlocked.
    const old = await serializeHistoryEntry({ type: 'add-layer', layer: snapshot, index: 0 }, backend.blobs) as any;
    delete old.layer.alphaLocked;
    expect((await deserializeHistoryEntry(old, backend.blobs) as any).layer.alphaLocked).toBe(false);
  });
});

describe('lock toggle', () => {
  it('pushes an undoable entry from the app and ignores a toggle that changes nothing', () => {
    const app = new DrawingApp();
    const pushed: HistoryEntry[] = [];
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub({ pushLayerOperation: vi.fn((e: HistoryEntry) => pushed.push(e)) }) });
    const ctx = (app as any)._buildContextValue();
    const id = (app as any)._state.layers[0].id;
    expect((app as any)._state.layers[0].alphaLocked).toBe(false);
    ctx.setLayerAlphaLocked(id, false);
    expect(pushed).toHaveLength(0);
    ctx.setLayerAlphaLocked(id, true);
    expect((app as any)._state.layers[0].alphaLocked).toBe(true);
    expect(pushed).toEqual([{ type: 'alpha-lock', layerId: id, before: false, after: true }]);
  });

  it('snapshots the lock for history entries', () => {
    const app = new DrawingApp();
    (app as any)._state.layers[0].alphaLocked = true;
    expect((app as any)._snapshotLayer((app as any)._state.layers[0]).alphaLocked).toBe(true);
  });

  it('undoes and redoes in the canvas without touching layer pixels', () => {
    const layer = makeLayer(DOC, DOC);
    const canvas = new DrawingCanvas();
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id, documentWidth: DOC, documentHeight: DOC }) } };
    attachCanvasElements(canvas, DOC, DOC);
    (canvas as any).composite = vi.fn();
    const events: unknown[] = [];
    canvas.addEventListener('layer-undo', e => events.push((e as CustomEvent).detail));
    layer.alphaLocked = true;
    const revision = canvas.getLayerRevision(layer.id);
    canvas.pushLayerOperation({ type: 'alpha-lock', layerId: layer.id, before: false, after: true });
    expect(canvas.getLayerRevision(layer.id)).toBe(revision);
    canvas.undo();
    expect(layer.alphaLocked).toBe(false);
    canvas.redo();
    expect(layer.alphaLocked).toBe(true);
    expect(events).toEqual([{ action: 'refresh' }, { action: 'refresh' }]);
  });
});

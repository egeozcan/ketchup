import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import {
  applyGrain, generate, getTexturePattern, registerTexturePattern, resolveGrain, textureActive, texturePatternList, unregisterTexturePattern,
} from '../src/engine/brush-texture.ts';
import { BRUSH_PRESETS, NO_TEXTURE, copyDescriptor, getDefaultDescriptor, getPresetById, normalizeTexture } from '../src/engine/brush-presets.ts';
import type { BrushTexture } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const BUILTIN = ['paper', 'canvas', 'noise', 'charcoal'];

function grain(over: Partial<BrushTexture> = {}) {
  return resolveGrain({ ...NO_TEXTURE, pattern: 'paper', depth: 1, ...over })!;
}

/** A w×h premultiplied buffer of one opaque or partly transparent value. */
function solid(w: number, h: number, a = 255): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = a; d[i * 4 + 1] = a; d[i * 4 + 2] = a; d[i * 4 + 3] = a; }
  return d;
}

describe('texture patterns', () => {
  it.each(BUILTIN)('%s is a 256x256 tile, the same every time it is generated', (id) => {
    const p = getTexturePattern(id)!;
    expect(p.width).toBe(256);
    expect(p.height).toBe(256);
    expect(p.data.length).toBe(256 * 256);
    expect(Array.from(generate(id))).toEqual(Array.from(p.data));
    expect(getTexturePattern(id)).toBe(p);
  });

  it.each(BUILTIN)('%s wraps: its edges are as close as neighbouring pixels are', (id) => {
    const { data } = getTexturePattern(id)!;
    const N = 256;
    // The weave jumps between threads every 8 pixels, so its seam is compared with those joins.
    const period = id === 'canvas' ? 8 : 1;
    let seam = 0, inner = 0, pairs = 0;
    for (let i = 0; i < N; i++) {
      seam += Math.abs(data[i * N] - data[i * N + N - 1]) + Math.abs(data[i] - data[(N - 1) * N + i]);
      for (let j = period - 1; j < N - 1; j += period) {
        inner += Math.abs(data[i * N + j] - data[i * N + j + 1]) + Math.abs(data[j * N + i] - data[(j + 1) * N + i]);
        pairs += 2;
      }
    }
    // A tile that did not wrap would put two unrelated pixels across the seam.
    expect(seam / (2 * N)).toBeLessThan((inner / pairs) * 1.5 + 1);
  });

  it.each(BUILTIN)('%s spreads over the full range of heights, so depth means a share of holes', (id) => {
    const { data } = getTexturePattern(id)!;
    expect(Math.min(...data)).toBeLessThan(20);
    expect(Math.max(...data)).toBeGreaterThan(235);
  });

  it('has a registry other tiles can join, and never for none or a built-in id', () => {
    expect(registerTexturePattern('none', 'x', 1, 1, new Uint8Array(1))).toBe(false);
    expect(registerTexturePattern('paper', 'x', 1, 1, new Uint8Array(1))).toBe(false);
    expect(registerTexturePattern('bad', 'x', 2, 2, new Uint8Array(3))).toBe(false);
    expect(registerTexturePattern('custom', 'Custom', 2, 1, new Uint8Array([0, 255]))).toBe(true);
    expect(texturePatternList().map(p => p.id)).toEqual([...BUILTIN, 'custom']);
    expect(textureActive({ ...NO_TEXTURE, pattern: 'custom' })).toBe(true);
    unregisterTexturePattern('custom');
    expect(textureActive({ ...NO_TEXTURE, pattern: 'custom' })).toBe(false);
  });

  it('is inactive for none, no depth and an unknown pattern', () => {
    expect(textureActive(NO_TEXTURE)).toBe(false);
    expect(textureActive({ ...NO_TEXTURE, pattern: 'paper', depth: 0 })).toBe(false);
    expect(textureActive({ ...NO_TEXTURE, pattern: 'gone' })).toBe(false);
    expect(textureActive({ ...NO_TEXTURE, pattern: 'paper' })).toBe(true);
    expect(resolveGrain(undefined)).toBeNull();
  });
});

describe('applyGrain', () => {
  it('is anchored in the document: a region gives what the same pixels of a larger one do', () => {
    for (const scale of [1, 0.37, 2.5]) {
      const g = grain({ scale, mode: 'subtract', depth: 0.8 });
      const big = solid(80, 60);
      applyGrain(big, 80, 60, 300, 700, g);
      const sub = solid(20, 15);
      applyGrain(sub, 20, 15, 300 + 31, 700 + 22, g);
      for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 20; x++) {
          expect(sub[(y * 20 + x) * 4 + 3]).toBe(big[((y + 22) * 80 + x + 31) * 4 + 3]);
        }
      }
    }
  });

  it('repeats every tile width at scale 1, and every scaled tile width otherwise', () => {
    const a = solid(30, 3), b = solid(30, 3);
    applyGrain(a, 30, 3, 5, 9, grain());
    applyGrain(b, 30, 3, 5 + 256, 9 + 256, grain());
    expect(Array.from(b)).toEqual(Array.from(a));
    const c = solid(30, 3), d = solid(30, 3);
    applyGrain(c, 30, 3, 5, 9, grain({ scale: 2 }));
    applyGrain(d, 30, 3, 5 + 512, 9 + 512, grain({ scale: 2 }));
    expect(Array.from(d)).toEqual(Array.from(c));
  });

  it('is exactly the tile at scale 1', () => {
    const p = getTexturePattern('paper')!;
    const img = solid(16, 1);
    applyGrain(img, 16, 1, 40, 7, grain({ mode: 'multiply', depth: 1 }));
    for (let x = 0; x < 16; x++) expect(img[x * 4 + 3]).toBe(Math.round(255 * (p.data[7 * 256 + 40 + x] / 255)));
  });

  it('leaves a stroke with no depth and transparent pixels alone', () => {
    const img = solid(8, 8);
    applyGrain(img, 8, 8, 0, 0, grain(), 0);
    expect(Array.from(img)).toEqual(Array.from(solid(8, 8)));
    const clear = new Uint8ClampedArray(8 * 8 * 4);
    applyGrain(clear, 8, 8, 0, 0, grain());
    expect(Math.max(...clear)).toBe(0);
  });

  it('invert swaps peaks and pits', () => {
    const a = solid(32, 32), b = solid(32, 32);
    applyGrain(a, 32, 32, 0, 0, grain({ mode: 'multiply', depth: 1 }));
    applyGrain(b, 32, 32, 0, 0, grain({ mode: 'multiply', depth: 1, invert: true }));
    for (let i = 0; i < 32 * 32; i++) expect(Math.abs(a[i * 4 + 3] + b[i * 4 + 3] - 255)).toBeLessThanOrEqual(1);
  });

  it('changes only alpha: getImageData gives straight colour', () => {
    const img = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) img.set([255, 10, 20, 200], i * 4);
    applyGrain(img, 32, 32, 0, 0, grain({ depth: 0.7 }));
    for (let i = 0; i < 32 * 32; i++) expect(Array.from(img.slice(i * 4, i * 4 + 3))).toEqual([255, 10, 20]);
  });

  it('multiply scales, subtract takes off, height thresholds', () => {
    const half = 128;
    const m = solid(64, 64, half), s = solid(64, 64, half), h = solid(64, 64, half);
    applyGrain(m, 64, 64, 0, 0, grain({ mode: 'multiply', depth: 1 }));
    applyGrain(s, 64, 64, 0, 0, grain({ mode: 'subtract', depth: 1 }));
    applyGrain(h, 64, 64, 0, 0, grain({ mode: 'height', depth: 1 }));
    let mSum = 0, sSum = 0;
    let hFull = 0, hNone = 0;
    for (let i = 0; i < 64 * 64; i++) {
      mSum += m[i * 4 + 3]; sSum += s[i * 4 + 3];
      expect(m[i * 4 + 3]).toBeLessThanOrEqual(half);
      expect(s[i * 4 + 3]).toBeLessThanOrEqual(half);
      if (h[i * 4 + 3] === 0) hNone++;
      if (h[i * 4 + 3] > 0) hFull++;
    }
    // Subtract takes off as much as the hole is deep, multiply only a share of what is there.
    expect(sSum).toBeLessThan(mSum);
    // At half coverage, height shows the upper half of the paper only.
    expect(hFull).toBeGreaterThan(64 * 64 * 0.3);
    expect(hNone).toBeGreaterThan(64 * 64 * 0.3);
    // Full coverage fills the pits too.
    const full = solid(64, 64, 255);
    applyGrain(full, 64, 64, 0, 0, grain({ mode: 'height', depth: 0.5 }));
    for (let i = 0; i < 64 * 64; i++) expect(full[i * 4 + 3]).toBeGreaterThan(0);
  });

  it('shows less grain at a lighter depth', () => {
    const lost = (depth: number) => {
      const img = solid(64, 64);
      applyGrain(img, 64, 64, 0, 0, grain(), depth);
      let sum = 0;
      for (let i = 0; i < 64 * 64; i++) sum += 255 - img[i * 4 + 3];
      return sum;
    };
    expect(lost(0.2)).toBeLessThan(lost(0.6));
    expect(lost(0.6)).toBeLessThan(lost(1));
  });
});

describe('texture descriptor', () => {
  it('defaults to none in presets, copies and brushes stored without one', () => {
    for (const p of BRUSH_PRESETS) if (p.id !== 'charcoal') expect(p.descriptor.texture).toEqual(NO_TEXTURE);
    expect(getDefaultDescriptor().texture.pattern).toBe('none');
    const legacy: Partial<ReturnType<typeof getDefaultDescriptor>> = { ...getDefaultDescriptor() };
    delete legacy.texture;
    expect(copyDescriptor(legacy as ReturnType<typeof getDefaultDescriptor>).texture).toEqual(NO_TEXTURE);
  });

  it('copies deeply', () => {
    const d = getDefaultDescriptor();
    const c = copyDescriptor(d);
    c.texture.depth = 0.1;
    expect(d.texture.depth).toBe(NO_TEXTURE.depth);
  });

  it('keeps a registered pattern through a copy, whatever the length of its id, or refuses it', () => {
    const ok = 'p'.repeat(100);
    expect(registerTexturePattern(ok, 'Long', 1, 1, new Uint8Array([9]))).toBe(true);
    expect(copyDescriptor({ ...getDefaultDescriptor(), texture: { ...NO_TEXTURE, pattern: ok } }).texture.pattern).toBe(ok);
    unregisterTexturePattern(ok);
    expect(registerTexturePattern('p'.repeat(101), 'Too long', 1, 1, new Uint8Array([9]))).toBe(false);
  });

  it('normalises stored values', () => {
    expect(normalizeTexture(undefined)).toEqual(NO_TEXTURE);
    expect(normalizeTexture({ pattern: 'canvas', scale: 99, depth: -3, mode: 'subtract', invert: true, perTip: true, depthPressure: true }))
      .toEqual({ pattern: 'canvas', scale: 4, depth: 0, mode: 'subtract', invert: true, perTip: true, depthPressure: true });
    expect(normalizeTexture({ pattern: 7, scale: 'x', depth: NaN, mode: 'bogus', invert: 1 } as unknown as Partial<BrushTexture>)).toEqual(NO_TEXTURE);
    expect(normalizeTexture({ scale: 0 }).scale).toBe(0.1);
  });

  it('has a charcoal preset that uses it', () => {
    const t = getPresetById('charcoal')!.descriptor.texture;
    expect(textureActive(t)).toBe(true);
  });
});

/** An engine over a recording canvas: what each commit lays on the layer, and from which canvas. */
function stroke(texture: Partial<BrushTexture> | undefined, opts: { eraser?: boolean; pressure?: number } = {}) {
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, spacing: 0.25, flow: 1, pressureSize: false, pressureOpacity: false, texture }), '#000000', !!opts.eraser, 300, 120, { seed: 5 });
  for (let i = 0; i < 20; i++) engine.stroke(40 + i * 5, 60, opts.pressure ?? 1, undefined, i * 8);
  return engine;
}

describe('texture in the engine', () => {
  it('paints as before with no texture: the preview is the stroke buffer itself', () => {
    const get = vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData');
    const engine = stroke(undefined);
    const preview = engine.getStrokePreview()!;
    expect(preview.canvas).toBe((engine as any)._bufferPool.current);
    expect(get).not.toHaveBeenCalled();
    const layer = document.createElement('canvas').getContext('2d')!;
    const draw = vi.spyOn(layer, 'drawImage');
    engine.commit(layer);
    expect(draw.mock.calls[0][0]).toBe(preview.canvas);
    expect(get).not.toHaveBeenCalled();
  });

  it('shows and commits the same grained canvas, not the buffer the dabs build', () => {
    const engine = stroke({ pattern: 'paper', depth: 1 });
    const preview = engine.getStrokePreview()!;
    expect(preview.canvas).not.toBe((engine as any)._bufferPool.current);
    const layer = document.createElement('canvas').getContext('2d')!;
    const draw = vi.spyOn(layer, 'drawImage');
    engine.commit(layer);
    expect(draw.mock.calls[0][0]).toBe(preview.canvas);
  });

  it('works on only what was stamped since the last frame', () => {
    const get = vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData');
    const engine = stroke({ pattern: 'paper', depth: 1 });
    engine.getStrokePreview();
    expect(get).toHaveBeenCalledTimes(1);
    const first = get.mock.calls[0];
    engine.getStrokePreview();
    expect(get).toHaveBeenCalledTimes(1);
    engine.stroke(150, 60, 1, undefined, 400);
    engine.stroke(155, 60, 1, undefined, 410);
    engine.getStrokePreview();
    expect(get).toHaveBeenCalledTimes(2);
    // The new dabs only, far smaller than the stroke so far.
    expect((get.mock.calls[1][2] as number) * (get.mock.calls[1][3] as number)).toBeLessThan((first[2] as number) * (first[3] as number));
    expect(get.mock.calls[1][0]).toBeGreaterThan(first[0] as number);
  });

  it('grains the eraser too', () => {
    const engine = stroke({ pattern: 'canvas', depth: 1 }, { eraser: true });
    expect(engine.getStrokePreview()!.canvas).not.toBe((engine as any)._bufferPool.current);
  });

  it('with texture on each tip, grains every dab and leaves the buffer as drawn', () => {
    const get = vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData');
    const engine = stroke({ pattern: 'paper', depth: 1, perTip: true });
    const dabs = get.mock.calls.length;
    expect(dabs).toBeGreaterThan(5);
    // Each read is one dab's box, never the stroke.
    for (const c of get.mock.calls) expect(c[2] as number).toBeLessThan(40);
    expect(engine.getStrokePreview()!.canvas).toBe((engine as any)._bufferPool.current);
    expect(get).toHaveBeenCalledTimes(dabs);
  });

  it('stays off with the texture off, whatever else is set', () => {
    const get = vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData');
    stroke({ pattern: 'none', depth: 1, perTip: true, mode: 'subtract' });
    stroke({ pattern: 'paper', depth: 0 });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('texture pixels through the engine', () => {
  /** getImageData hands back opaque pixels of the size asked for; putImageData is recorded. */
  function pixelStubs() {
    const puts: { x: number; y: number; w: number; h: number; data: Uint8ClampedArray }[] = [];
    vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData').mockImplementation(((x: number, y: number, w: number, h: number) =>
      ({ data: solid(w, h), width: w, height: h })) as never);
    vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData').mockImplementation(((img: ImageData, x: number, y: number) => {
      puts.push({ x, y, w: img.width, h: img.height, data: new Uint8ClampedArray(img.data) });
    }) as never);
    return puts;
  }

  const tex: Partial<BrushTexture> = { pattern: 'paper', depth: 1, mode: 'multiply' };

  it('grains each region by its place in the document, as the frames and the commit see it', () => {
    const puts = pixelStubs();
    const engine = stroke(tex);
    engine.getStrokePreview();
    engine.stroke(160, 60, 1, undefined, 400);
    engine.stroke(170, 60, 1, undefined, 410);
    engine.getStrokePreview();
    engine.commit(document.createElement('canvas').getContext('2d')!);
    // The commit lays the spline's last segment and grains that too.
    expect(puts.length).toBeGreaterThanOrEqual(2);
    for (const put of puts) {
      const expected = solid(put.w, put.h);
      applyGrain(expected, put.w, put.h, put.x, put.y, resolveGrain({ ...NO_TEXTURE, ...tex })!);
      expect(Array.from(put.data)).toEqual(Array.from(expected));
      // Not left whole: the grain really took paint away.
      expect(put.data.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
    }
    // The second frame only redid the dabs added after the first.
    expect(puts[1].x).toBeGreaterThan(puts[0].x);
  });

  it('starts the next stroke clean', () => {
    const puts = pixelStubs();
    const engine = stroke(tex);
    engine.getStrokePreview();
    engine.commit(document.createElement('canvas').getContext('2d')!);
    const grainCanvas = (engine as any)._grainCanvas as HTMLCanvasElement;
    const clear = vi.spyOn(grainCanvas.getContext('2d')!, 'clearRect');
    engine.begin(makeBrush({ size: 20, texture: tex }), '#000000', false, 300, 120, { seed: 5 });
    expect(clear).toHaveBeenCalled();
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows less grain on a dab pressed lightly when pressure scales depth', () => {
    const lost = (pressure: number) => {
      const puts = pixelStubs();
      stroke({ ...tex, perTip: true, depthPressure: true }, { pressure });
      vi.restoreAllMocks();
      let sum = 0;
      for (const p of puts) for (let i = 3; i < p.data.length; i += 4) sum += 255 - p.data[i];
      return sum;
    };
    expect(lost(0.3)).toBeLessThan(lost(1));
  });

  it('treats a zero pressure sample as a lift when pressure scales depth', () => {
    pixelStubs();
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, pressureSize: false, texture: { ...tex, perTip: true, depthPressure: true } }), '#000000', false, 300, 120, { seed: 5 });
    engine.stroke(40, 60, 1, undefined, 0);
    engine.stroke(60, 60, 0, undefined, 8);
    expect((engine as any)._prevStamp).toBeNull();
  });
});

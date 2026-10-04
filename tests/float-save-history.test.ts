import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { MockBackend } from '../src/storage/testing/mock-backend.ts';
import type { BlobStore, SerializedHistoryEntry, SerializedImageData } from '../src/storage/types.ts';
import type { HistoryEntry, Layer } from '../src/types.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import * as serialization from '../src/utils/storage-serialization.ts';
import { attachCanvasElements, makeLayer, makeState } from './helpers.ts';

// A save with a live float stores it as its commit would leave things: merged
// into its layer, with the entry that commit pushes on top of history. These
// run the real canvas and save on a 2D context that keeps pixels (the canvas
// mock keeps none), for integer moves, which is all a moved float needs.

const W = 40;
const H = 20;

/** A 2D context with real RGBA pixels: put/get, clearRect, and drawImage of another such canvas at a whole-pixel offset. */
class PixelContext {
  private _data = new Uint8ClampedArray(0);
  private _w = -1;
  private _h = -1;
  private _stack: { e: number; f: number; scaled: boolean; alpha: number }[] = [];
  private _e = 0;
  private _f = 0;
  private _scaled = false;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  constructor(readonly canvas: HTMLCanvasElement) {}

  /** Pixels, cleared when the canvas was resized (as setting width does). */
  pixels(): Uint8ClampedArray {
    if (this._w !== this.canvas.width || this._h !== this.canvas.height) {
      this._w = this.canvas.width;
      this._h = this.canvas.height;
      this._data = new Uint8ClampedArray(this._w * this._h * 4);
    }
    return this._data;
  }
  getImageData(x: number, y: number, w: number, h: number): ImageData {
    const src = this.pixels();
    const out = new ImageData(w, h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const sx = x + col, sy = y + row;
        if (sx < 0 || sy < 0 || sx >= this._w || sy >= this._h) continue;
        const s = (sy * this._w + sx) * 4, d = (row * w + col) * 4;
        out.data.set(src.subarray(s, s + 4), d);
      }
    }
    return out;
  }
  putImageData(img: ImageData, dx: number, dy: number) {
    const dst = this.pixels();
    for (let row = 0; row < img.height; row++) {
      for (let col = 0; col < img.width; col++) {
        const x = dx + col, y = dy + row;
        if (x < 0 || y < 0 || x >= this._w || y >= this._h) continue;
        const s = (row * img.width + col) * 4;
        dst.set(img.data.subarray(s, s + 4), (y * this._w + x) * 4);
      }
    }
  }
  clearRect(x: number, y: number, w: number, h: number) {
    const dst = this.pixels();
    for (let row = Math.max(0, y); row < Math.min(this._h, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(this._w, x + w); col++) dst.fill(0, (row * this._w + col) * 4, (row * this._w + col) * 4 + 4);
    }
  }
  drawImage(src: unknown, ...args: number[]) {
    if (!(src instanceof HTMLCanvasElement)) return;
    const from = contexts.get(src);
    if (!from) return;
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx: number, dy: number, dw = src.width, dh = src.height;
    if (args.length === 2) [dx, dy] = args;
    else if (args.length === 4) [dx, dy, dw, dh] = args;
    else [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    // Only unscaled draws at whole pixels (a thumbnail's downscale is skipped).
    if (this._scaled || dw !== sw || dh !== sh) return;
    dx += this._e;
    dy += this._f;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
    const img = from.getImageData(sx, sy, sw, sh);
    const dst = this.pixels();
    for (let row = 0; row < sh; row++) {
      for (let col = 0; col < sw; col++) {
        const x = dx + col, y = dy + row;
        if (x < 0 || y < 0 || x >= this._w || y >= this._h) continue;
        const s = (row * sw + col) * 4, d = (y * this._w + x) * 4;
        const a = (img.data[s + 3] / 255) * this.globalAlpha;
        if (a === 0) continue;
        const da = dst[d + 3] / 255;
        const oa = a + da * (1 - a);
        for (let c = 0; c < 3; c++) {
          dst[d + c] = Math.round((img.data[s + c] * a + dst[d + c] * da * (1 - a)) / oa);
        }
        dst[d + 3] = Math.round(oa * 255);
      }
    }
  }
  save() { this._stack.push({ e: this._e, f: this._f, scaled: this._scaled, alpha: this.globalAlpha }); }
  restore() {
    const s = this._stack.pop();
    if (s) ({ e: this._e, f: this._f, scaled: this._scaled, alpha: this.globalAlpha } = s);
  }
  setTransform(a: number | DOMMatrix2DInit = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    if (typeof a === 'object') ({ a = 1, b = 0, c = 0, d = 1, e = 0, f = 0 } = a);
    this._scaled = a !== 1 || b !== 0 || c !== 0 || d !== 1;
    this._e = e;
    this._f = f;
  }
  resetTransform() { this.setTransform(); }
  translate(x: number, y: number) { this._e += x; this._f += y; }
  scale(x: number, y: number) { if (x !== 1 || y !== 1) this._scaled = true; }
  rotate(r: number) { if (r) this._scaled = true; }
  transform() { this._scaled = true; }
  getTransform() { return new DOMMatrix([1, 0, 0, 1, this._e, this._f]); }
  createPattern() { return null; }
  measureText() { return { width: 0 }; }
}

const contexts = new WeakMap<HTMLCanvasElement, PixelContext>();

function installPixelCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
    if (type !== '2d') return null;
    let ctx = contexts.get(this);
    if (!ctx) {
      const pixelCtx = new PixelContext(this);
      // Anything else a canvas is asked to do here draws nothing.
      ctx = new Proxy(pixelCtx, {
        get: (target, prop) => (prop in target ? (target as any)[prop] : () => undefined),
      }) as PixelContext;
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext);
}

function rect(color: [number, number, number], w: number, h: number) {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([...color, 255], i * 4);
  return img;
}

/** Where on the layer the colour is: the opaque pixels' bounding box, and how many. */
function painted(layer: Layer) {
  const { data } = layer.canvas.getContext('2d')!.getImageData(0, 0, W, H);
  let count = 0, minX = W, minY = H;
  for (let i = 0; i < W * H; i++) {
    if (!data[i * 4 + 3]) continue;
    count++;
    minX = Math.min(minX, i % W);
    minY = Math.min(minY, Math.floor(i / W));
  }
  return count ? { count, x: minX, y: minY } : { count: 0 };
}

function setupCanvas(layers: Layer[]) {
  const canvas = new DrawingCanvas();
  const state = makeState({ layers, activeLayerId: layers[0].id, documentWidth: W, documentHeight: H });
  (canvas as any)._ctx = { value: { state } };
  attachCanvasElements(canvas, W, H);
  (canvas as any).composite = vi.fn();
  (canvas as any)._composite = vi.fn();
  (canvas as any).requestUpdate = vi.fn();
  return { canvas, state };
}

/** Records pixels in memory by blob ref, since jsdom can't encode them. */
function fakePixelStorage() {
  const pixels = new Map<string, ImageData>();
  const copy = (d: ImageData) => new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);
  const put = async (d: ImageData, blobs: BlobStore): Promise<SerializedImageData> => {
    const blobRef = await blobs.put(new Blob(['px']));
    pixels.set(blobRef, copy(d));
    return { width: d.width, height: d.height, blobRef };
  };
  vi.spyOn(serialization, 'serializeLayerFromImageData').mockImplementation(async (meta, imageData, blobs) => {
    const { blobRef } = await put(imageData, blobs);
    return { id: meta.id, name: meta.name, visible: meta.visible, opacity: meta.opacity, blendMode: meta.blendMode ?? 'normal', imageBlobRef: blobRef };
  });
  const serializeHistory = vi.spyOn(serialization, 'serializeHistoryEntry').mockImplementation(async (entry, blobs) => {
    if (entry.type === 'patch') {
      return { ...entry, before: await put(entry.before, blobs), after: await put(entry.after, blobs) } as SerializedHistoryEntry;
    }
    if (entry.type === 'add-layer') {
      const { canvas: _c, ...meta } = entry.layer as any;
      return { ...entry, layer: { ...meta, imageData: await put(entry.layer.imageData, blobs) } } as SerializedHistoryEntry;
    }
    throw new Error(`not handled here: ${entry.type}`);
  });
  const read = (s: SerializedImageData) => copy(pixels.get(s.blobRef)!);
  const deserialize = (s: SerializedHistoryEntry): HistoryEntry => {
    if (s.type === 'patch') return { ...s, before: read(s.before), after: read(s.after) } as HistoryEntry;
    if (s.type === 'add-layer') return { ...s, layer: { ...s.layer, imageData: read(s.layer.imageData) } } as HistoryEntry;
    throw new Error(`not handled here: ${s.type}`);
  };
  return { pixels, read, deserialize, serializeHistory };
}

async function setup() {
  installPixelCanvas();
  const storage = fakePixelStorage();
  const backend = new MockBackend();
  await backend.init();
  const project = await backend.projects.create({ name: 'P', thumbnailRef: null });
  const layer = makeLayer(W, H, { id: 'l1' });
  const { canvas, state } = setupCanvas([layer]);
  const app = new DrawingApp();
  (app as any)._state = state;
  (app as any)._currentProject = project;
  (app as any)._backend = backend;
  Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
  canvas.addEventListener('history-change', e => (app as any)._onHistoryChange(e));
  const save = async () => {
    if ((app as any)._saveTimer) clearTimeout((app as any)._saveTimer);
    (app as any)._saveTimer = null;
    (app as any)._dirty = true;
    (app as any)._dirtyVersion++;
    await (app as any)._save(true);
  };
  /** Opens what is stored on a fresh canvas, as a reload would. */
  const load = async () => {
    const stored = (await backend.state.get(project.id))!;
    const records = (await backend.history.getEntries(project.id)).sort((a, b) => a.index - b.index);
    const layers = stored.layers.map(sl => {
      const l = makeLayer(W, H, { id: sl.id, name: sl.name });
      l.canvas.getContext('2d')!.putImageData(storage.read({ width: W, height: H, blobRef: sl.imageBlobRef }), 0, 0);
      return l;
    });
    const loaded = setupCanvas(layers);
    const history = records.map(r => storage.deserialize(r.entry));
    loaded.canvas.setHistory(history, stored.historyIndex);
    return { ...loaded, layers, history, historyIndex: stored.historyIndex };
  };
  /** Paints a block as a stroke would: an undoable patch. */
  const draw = (x: number, y: number, color: [number, number, number] = [255, 0, 0]) => {
    (canvas as any)._captureBeforeDraw();
    layer.canvas.getContext('2d')!.putImageData(rect(color, 4, 4), x, y);
    (canvas as any)._pushDrawHistory();
    (app as any)._markDirty();
  };
  return { app, backend, project, canvas, state, layer, storage, save, load, draw };
}

describe('saving a live float', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a moved lifted float with the entry its commit pushes, so undo and redo after a reload are right', async () => {
    const { canvas, layer, save, load, draw } = await setup();
    draw(2, 2);
    canvas.enterTransformMode();
    canvas.setTransformValue('x', 20);
    await save();
    // Still floating here, untouched by the save.
    expect(painted(layer).count).toBe(0);

    const reloaded = await load();
    const l = reloaded.layers[0];
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.historyIndex).toBe(1);
    expect(painted(l)).toEqual({ count: 16, x: 20, y: 2 });
    reloaded.canvas.undo();
    expect(painted(l)).toEqual({ count: 16, x: 2, y: 2 });
    reloaded.canvas.undo();
    expect(painted(l)).toEqual({ count: 0 });
    reloaded.canvas.redo();
    reloaded.canvas.redo();
    // One copy, where it was moved to.
    expect(painted(l)).toEqual({ count: 16, x: 20, y: 2 });
  });

  it('stores an unmoved lift as no step at all', async () => {
    const { canvas, save, load, draw } = await setup();
    draw(2, 2);
    canvas.enterTransformMode();
    await save();
    const reloaded = await load();
    expect(reloaded.history).toHaveLength(1);
    expect(painted(reloaded.layers[0])).toEqual({ count: 16, x: 2, y: 2 });
  });

  it('stores a pasted float as its patch, dropping the redo entries its commit would end', async () => {
    const { canvas, save, load, draw } = await setup();
    draw(2, 2);
    draw(10, 10, [0, 0, 255]);
    canvas.undo();
    (canvas as any)._clipboard = rect([0, 255, 0], 4, 4);
    (canvas as any)._clipboardOrigin = { x: 30, y: 5 };
    canvas.pasteSelection();
    await save();

    const reloaded = await load();
    const l = reloaded.layers[0];
    expect(reloaded.history).toHaveLength(2);
    expect(painted(l).count).toBe(32);
    reloaded.canvas.undo();
    expect(painted(l)).toEqual({ count: 16, x: 2, y: 2 });
    reloaded.canvas.redo();
    expect(painted(l).count).toBe(32);
  });

  it('stores an image pasted onto a new layer after the add-layer entry', async () => {
    const { app, canvas, state, save, load, draw } = await setup();
    draw(2, 2);
    // As _handleExternalImage: a new layer (its add-layer entry), then the image floats on it.
    const added = makeLayer(W, H, { id: 'l2', name: 'Pasted' });
    state.layers.push(added);
    state.activeLayerId = 'l2';
    canvas.pushLayerOperation({
      type: 'add-layer', index: 1,
      layer: { id: 'l2', name: 'Pasted', visible: true, opacity: 1, blendMode: 'normal', imageData: new ImageData(W, H) },
    });
    (canvas as any)._captureBeforeDraw();
    (canvas as any)._floatIsExternalImage = true;
    (canvas as any)._transformContentMode = 'inserted';
    (canvas as any)._transformManager = new TransformManager(
      rect([0, 255, 0], 6, 6), { x: 8, y: 8, w: 6, h: 6 }, (canvas as any).previewCanvas, 1, { x: 0, y: 0 },
    );
    (app as any)._markDirty();
    await save();

    const reloaded = await load();
    expect(reloaded.history.map(e => e.type)).toEqual(['patch', 'add-layer', 'patch']);
    expect(reloaded.historyIndex).toBe(2);
    const pasted = reloaded.layers.find(l => l.id === 'l2')!;
    expect(painted(pasted)).toEqual({ count: 36, x: 8, y: 8 });
    reloaded.state.activeLayerId = 'l2';
    reloaded.canvas.undo();
    expect(painted(pasted)).toEqual({ count: 0 });
  });

  it('commits a saved float as the stored entry: nothing more to store, and leaving needn\'t ask', async () => {
    const { app, canvas, layer, storage, save, load, draw } = await setup();
    draw(2, 2);
    canvas.enterTransformMode();
    canvas.setTransformValue('x', 20);
    await save();
    const storedTop = (app as any)._storedHistoryTop;

    canvas.commitTransform();
    expect(canvas.getHistory()[canvas.getHistoryIndex()]).toBe(storedTop);
    expect((app as any)._hasUnsavedWork()).toBe(false);
    expect(painted(layer)).toEqual({ count: 16, x: 20, y: 2 });

    storage.serializeHistory.mockClear();
    await save();
    expect(storage.serializeHistory).not.toHaveBeenCalled();
    const reloaded = await load();
    expect(reloaded.history).toHaveLength(2);
    reloaded.canvas.undo();
    expect(painted(reloaded.layers[0])).toEqual({ count: 16, x: 2, y: 2 });
  });

  it('replaces the stored entry when the float is moved again before it is committed', async () => {
    const { app, canvas, save, load, draw } = await setup();
    draw(2, 2);
    canvas.enterTransformMode();
    canvas.setTransformValue('x', 20);
    await save();
    canvas.setTransformValue('x', 30);
    canvas.commitTransform();
    expect((app as any)._hasUnsavedWork()).toBe(true);
    await save();

    const reloaded = await load();
    const l = reloaded.layers[0];
    expect(reloaded.history).toHaveLength(2);
    expect(painted(l)).toEqual({ count: 16, x: 30, y: 2 });
    reloaded.canvas.undo();
    expect(painted(l)).toEqual({ count: 16, x: 2, y: 2 });
    reloaded.canvas.redo();
    expect(painted(l)).toEqual({ count: 16, x: 30, y: 2 });
  });

  it('drops the stored entry, and brings back the redo entries, when the float is cancelled after the save', async () => {
    const { canvas, save, load, draw } = await setup();
    draw(2, 2);
    draw(10, 10, [0, 0, 255]);
    canvas.undo();
    // Lift what is left (the red block) and move it; the blue block can still be redone.
    canvas.enterTransformMode();
    canvas.setTransformValue('x', 20);
    await save();
    let reloaded = await load();
    expect(reloaded.history).toHaveLength(2);
    expect(painted(reloaded.layers[0])).toEqual({ count: 16, x: 20, y: 2 });

    canvas.cancelTransform();
    await save();
    reloaded = await load();
    const l = reloaded.layers[0];
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.historyIndex).toBe(0);
    expect(painted(l)).toEqual({ count: 16, x: 2, y: 2 });
    reloaded.canvas.redo();
    expect(painted(l).count).toBe(32);
    reloaded.canvas.undo();
    reloaded.canvas.undo();
    expect(painted(l)).toEqual({ count: 0 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { BrushTipCache } from '../src/engine/brush-tip-cache.ts';
import { tipFootprint } from '../src/engine/tip-generators.ts';
import { clearTipMasks, getTipMask, hasTipMask, registerTipMask, resolveTipForStroke, unregisterTipMask } from '../src/engine/tip-images.ts';
import { coverageFromRGBA, cropMask, downscaleMask, maskFromRGBA, thumbnailMask, MAX_TIP_SIZE } from '../src/engine/tip-mask.ts';
import type { TipMask } from '../src/engine/tip-mask.ts';
import { copyDescriptor, getDefaultDescriptor, normalizeBrushDescriptor, normalizeTip, BRUSH_PRESETS } from '../src/engine/brush-presets.ts';
import { getDefaultTipDescriptor, getTipCapabilities } from '../src/engine/brush-capabilities.ts';
import { BrushLibrary } from '../src/engine/brush-library.ts';
import { MemoryBackend } from '../src/storage/memory/index.ts';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';
import type { BrushLibraryStore, BrushTipMeta, UserBrushPreset } from '../src/storage/types.ts';
import { makeBrush } from './helpers.ts';

function solid(width: number, height: number, value = 255): TipMask {
  return { width, height, alpha: new Uint8Array(width * height).fill(value) };
}

function rgba(pixels: number[][]): Uint8ClampedArray {
  return Uint8ClampedArray.from(pixels.flat());
}

beforeEach(() => clearTipMasks());
afterEach(() => vi.restoreAllMocks());

describe('tip masks from pixels', () => {
  it('reads dark as paint and white as none, scaled by alpha', () => {
    const cov = coverageFromRGBA(rgba([
      [0, 0, 0, 255],        // black, opaque
      [255, 255, 255, 255],  // white paper
      [0, 0, 0, 0],          // transparent
      [0, 0, 0, 128],        // half-transparent black
      [128, 128, 128, 255],  // mid grey
    ]), 5, 1);
    expect(cov[0]).toBe(255);
    expect(cov[1]).toBe(0);
    expect(cov[2]).toBe(0);
    expect(cov[3]).toBe(128);
    expect(cov[4]).toBeGreaterThan(120);
    expect(cov[4]).toBeLessThan(135);
  });

  it('weighs green over blue in luminance', () => {
    const [green, blue] = coverageFromRGBA(rgba([[0, 255, 0, 255], [0, 0, 255, 255]]), 2, 1);
    expect(green).toBeLessThan(blue);
  });

  it('crops to the painted box and drops noise-level coverage outside it', () => {
    const w = 6, h = 5;
    const alpha = new Uint8Array(w * h);
    alpha[1 * w + 2] = 200;
    alpha[3 * w + 4] = 255;
    alpha[0] = 2; // scanner noise in the corner
    const cropped = cropMask({ width: w, height: h, alpha })!;
    expect([cropped.width, cropped.height]).toEqual([3, 3]);
    expect(cropped.alpha[0]).toBe(200);
    expect(cropped.alpha[8]).toBe(255);
  });

  it('is null for an image that paints nothing', () => {
    const white = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    expect(maskFromRGBA(white, 4, 4)).toBeNull();
    expect(maskFromRGBA(new Uint8ClampedArray(4 * 4 * 4), 4, 4)).toBeNull();
    expect(maskFromRGBA([], 0, 0)).toBeNull();
  });

  it('scales a large mask down to 1024 on the long side, keeping proportions and weight', () => {
    const big = solid(2048, 1024, 200);
    const small = downscaleMask(big, MAX_TIP_SIZE);
    expect([small.width, small.height]).toEqual([1024, 512]);
    expect(small.alpha.every(v => v === 200)).toBe(true);
    // A one pixel line keeps its weight when averaged down 2x.
    const line = solid(4, 4, 0);
    for (let y = 0; y < 4; y++) line.alpha[y * 4 + 1] = 255;
    const half = downscaleMask(line, 2);
    expect(half.alpha[0]).toBe(128);
    expect(downscaleMask(small, 2000)).toBe(small);
    expect(thumbnailMask(big).width).toBe(48);
  });
});

describe('sampled tips in the engine', () => {
  const imageTip = (imageId: string) => ({ ...getDefaultTipDescriptor('image'), imageId });

  it('has a footprint at the image\'s proportions, long side the size', () => {
    registerTipMask('wide', solid(40, 10));
    registerTipMask('tall', solid(10, 40));
    expect(tipFootprint(20, imageTip('wide'))).toEqual({ w: 20, h: 5 });
    expect(tipFootprint(20, imageTip('tall'))).toEqual({ w: 5, h: 20 });
    expect(tipFootprint(0.2, imageTip('tall')).h).toBe(1);
  });

  it('is round while the image is missing', () => {
    expect(tipFootprint(20, imageTip('nope'))).toEqual({ w: 20, h: 20 });
    expect(resolveTipForStroke(imageTip('nope')).shape).toBe('round');
    registerTipMask('here', solid(8, 8));
    expect(resolveTipForStroke(imageTip('here')).shape).toBe('image');
  });

  it('does not serve the round stand-in once the image has loaded', () => {
    const cache = new BrushTipCache();
    const tip = imageTip('late');
    const stand = cache.get(20, 1, tip);
    expect([stand.width, stand.height]).toEqual([20, 20]);
    registerTipMask('late', solid(40, 10));
    const real = cache.get(20, 1, tip);
    expect(real).not.toBe(stand);
    expect([real.width, real.height]).toEqual([20, 5]);
    // Hardness is ignored: it neither splits nor alters the entry.
    expect(cache.get(20, 0.2, tip)).toBe(real);
  });

  it('keeps two tips of one size apart', () => {
    registerTipMask('a', solid(40, 10));
    registerTipMask('b', solid(10, 40));
    const cache = new BrushTipCache();
    expect(cache.get(20, 1, imageTip('a'))).not.toBe(cache.get(20, 1, imageTip('b')));
  });

  function dabs(brush: ReturnType<typeof makeBrush>) {
    const out: { w: number; h: number }[] = [];
    vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      // Dabs go on the document-sized stroke buffer; the tip's own mip levels are drawn on small canvases.
      if (args.length === 5 && this.canvas.width >= 200) out.push({ w: args[3] as number, h: args[4] as number });
    });
    const engine = new StampStrokeEngine();
    engine.begin(brush, '#000000', false, 400, 100, { seed: 1 });
    for (let i = 0; i <= 10; i++) engine.stroke(20 + i * 15, 50, 1, undefined, i * 8, { tiltX: 0, tiltY: 0 });
    engine.commit(document.createElement('canvas').getContext('2d')!);
    return { out, bounds: engine.getDirtyBounds() };
  }

  it('lays dabs at the image\'s aspect, and covers them in the dirty bounds', () => {
    registerTipMask('wide', solid(40, 10));
    const { out, bounds } = dabs(makeBrush({ size: 20, pressureSize: false, tip: imageTip('wide') }));
    expect(out.length).toBeGreaterThan(5);
    for (const d of out) expect(d.w / d.h).toBeCloseTo(4, 5);
    expect(bounds).not.toBeNull();
  });

  it('keeps every turned, scattered, tilted dab inside the dirty bounds', () => {
    registerTipMask('wide', solid(40, 10));
    const all: { x: number; y: number; w: number; h: number; m: DOMMatrix }[] = [];
    vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (args.length === 5 && this.canvas.width >= 200) {
        all.push({ x: args[1] as number, y: args[2] as number, w: args[3] as number, h: args[4] as number, m: this.getTransform() });
      }
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({
      size: 24, spacing: 0.4, pressureSize: false,
      tip: { ...imageTip('wide'), orientation: 'direction', angle: 30 },
      scatter: { amount: 1.5, bothAxes: true, count: 3, countJitter: 0 },
      jitter: { size: 0.3, angle: 0.5, roundness: 0.4, flow: 0 },
      dynamics: { sizeVelocity: 0, flowVelocity: 0, minSize: 0, tilt: 1 },
    }), '#000000', false, 400, 200, { seed: 5 });
    for (let i = 0; i <= 12; i++) engine.stroke(40 + i * 25, 100 + Math.sin(i / 2) * 40, 1, undefined, i * 8, { tiltX: 40, tiltY: 20 });
    engine.commit(document.createElement('canvas').getContext('2d')!);
    const bounds = engine.getDirtyBounds()!;
    expect(all.length).toBeGreaterThan(20);
    for (const d of all) {
      for (const [px, py] of [[d.x, d.y], [d.x + d.w, d.y], [d.x, d.y + d.h], [d.x + d.w, d.y + d.h]]) {
        // The bounds are clamped to the 400 x 200 document.
        const x = Math.min(400, Math.max(0, d.m.m11 * px + d.m.m21 * py + d.m.m41));
        const y = Math.min(200, Math.max(0, d.m.m12 * px + d.m.m22 * py + d.m.m42));
        expect(x).toBeGreaterThanOrEqual(bounds.x);
        expect(y).toBeGreaterThanOrEqual(bounds.y);
        expect(x).toBeLessThanOrEqual(bounds.x + bounds.w);
        expect(y).toBeLessThanOrEqual(bounds.y + bounds.h);
      }
    }
  });

  it('paints round, without throwing, when the tip is missing', () => {
    const { out } = dabs(makeBrush({ size: 20, pressureSize: false, tip: imageTip('missing') }));
    expect(out.length).toBeGreaterThan(5);
    for (const d of out) expect(d.w).toBe(d.h);
  });

  it('keeps the stroke round when the image arrives mid-stroke', () => {
    const out: { w: number; h: number }[] = [];
    vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      // Dabs go on the document-sized stroke buffer; the tip's own mip levels are drawn on small canvases.
      if (args.length === 5 && this.canvas.width >= 200) out.push({ w: args[3] as number, h: args[4] as number });
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, pressureSize: false, tip: imageTip('arrives') }), '#000000', false, 400, 100, { seed: 1 });
    for (let i = 0; i <= 5; i++) engine.stroke(20 + i * 15, 50, 1, undefined, i * 8, { tiltX: 0, tiltY: 0 });
    registerTipMask('arrives', solid(40, 10));
    for (let i = 6; i <= 12; i++) engine.stroke(20 + i * 15, 50, 1, undefined, i * 8, { tiltX: 0, tiltY: 0 });
    engine.commit(document.createElement('canvas').getContext('2d')!);
    expect(out.length).toBeGreaterThan(5);
    for (const d of out) expect(d.w).toBe(d.h);
  });

  it('keeps a loaded tip for the stroke when it is removed mid-stroke, and lets go when the stroke ends', () => {
    const out: { w: number; h: number }[] = [];
    vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (args.length === 5 && this.canvas.width >= 200) out.push({ w: args[3] as number, h: args[4] as number });
    });
    registerTipMask('leaves', solid(40, 10));
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, pressureSize: false, tip: imageTip('leaves') }), '#000000', false, 400, 100, { seed: 1 });
    for (let i = 0; i <= 5; i++) engine.stroke(20 + i * 15, 50, 1, undefined, i * 8, { tiltX: 0, tiltY: 0 });
    unregisterTipMask('leaves');
    // New strokes see it gone, this one still has it.
    expect(hasTipMask('leaves')).toBe(false);
    for (let i = 6; i <= 12; i++) engine.stroke(20 + i * 15, 50, 1, undefined, i * 8, { tiltX: 0, tiltY: 0 });
    engine.commit(document.createElement('canvas').getContext('2d')!);
    expect(out.length).toBeGreaterThan(8);
    for (const d of out) expect(d.w).toBeGreaterThan(d.h);
    expect(getTipMask('leaves')).toBeNull();
  });

  it('is a shape without bristles, aspect or hardness, but with rotation', () => {
    expect(getTipCapabilities('image')).toEqual({ aspect: false, rotation: true, bristles: false, hardness: false });
  });
});

describe('stored brushes with sampled tips', () => {
  it('leaves legacy brushes as they were', () => {
    for (const preset of BRUSH_PRESETS) {
      expect(normalizeBrushDescriptor(preset.descriptor)).toEqual(copyDescriptor(preset.descriptor));
    }
    const legacy = { size: 9, tip: { shape: 'flat', aspect: 3, angle: 10, orientation: 'direction' } } as const;
    const out = normalizeBrushDescriptor(legacy as never);
    expect(out.tip).toEqual({ shape: 'flat', aspect: 3, angle: 10, orientation: 'direction' });
    expect(out.size).toBe(9);
    expect(out.opacity).toBe(getDefaultDescriptor().opacity);
  });

  it('keeps a sampled tip with its id, and falls back to round without one or for an unknown shape', () => {
    expect(normalizeTip({ shape: 'image', imageId: 'abc', angle: 30 })).toMatchObject({ shape: 'image', imageId: 'abc', angle: 30 });
    expect(normalizeTip({ shape: 'image' })).toEqual(getDefaultTipDescriptor('round'));
    expect(normalizeTip({ shape: 'image', imageId: 7 as never })).toEqual(getDefaultTipDescriptor('round'));
    expect(normalizeTip({ shape: 'hologram' as never })).toEqual(getDefaultTipDescriptor('round'));
    expect(normalizeTip(undefined)).toEqual(getDefaultTipDescriptor('round'));
    expect(normalizeTip({ shape: 'flat', imageId: 'x' }).imageId).toBeUndefined();
  });

  it('copies the tip deeply', () => {
    const d = makeBrush({ tip: { ...getDefaultTipDescriptor('image'), imageId: 'abc' } });
    const c = copyDescriptor(d);
    expect(c.tip).toEqual(d.tip);
    expect(c.tip).not.toBe(d.tip);
  });
});

function meta(id: string, createdAt = 1): BrushTipMeta {
  return { id, name: `Tip ${id}`, width: 4, height: 2, spacing: 0.25, createdAt, thumb: solid(4, 2, 90) };
}
function preset(id: string, tipId?: string, createdAt = 1): UserBrushPreset {
  const descriptor = makeBrush(tipId ? { tip: { ...getDefaultTipDescriptor('image'), imageId: tipId } } : {});
  return { id, name: `Preset ${id}`, descriptor, tipId, createdAt };
}
function ramp(width: number, height: number): TipMask {
  return { width, height, alpha: Uint8Array.from({ length: width * height }, (_, i) => i % 256) };
}

const stores: [string, () => Promise<{ store: BrushLibraryStore; done: () => Promise<void> }>][] = [
  ['MemoryBackend', async () => ({ store: new MemoryBackend().brushes, done: async () => {} })],
  ['IndexedDBBackend', async () => {
    const backend = new IndexedDBBackend({ dbName: `brushes-${Math.random()}` });
    await backend.init();
    return { store: backend.brushes!, done: () => backend.dispose() };
  }],
];

describe.each(stores)('brush library store: %s', (_name, open) => {
  it('stores tips with masks and presets, and lists them in order', async () => {
    const { store, done } = await open();
    const mask = ramp(300, 5); // big enough to compress
    await store.putBatch({
      tips: [{ meta: meta('t2', 2), mask: solid(2, 2, 7) }, { meta: meta('t1', 1), mask }],
      presets: [preset('p2', 't2', 2), preset('p1', 't1', 1)],
    });
    const listed = await store.list();
    expect(listed.tips.map(t => t.id)).toEqual(['t1', 't2']);
    expect(listed.presets.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(Array.from(listed.tips[0].thumb.alpha)).toEqual(Array.from(solid(4, 2, 90).alpha));
    expect(listed.presets[0].descriptor.tip.imageId).toBe('t1');
    const back = (await store.getMask('t1'))!;
    expect([back.width, back.height]).toEqual([300, 5]);
    expect(Array.from(back.alpha)).toEqual(Array.from(mask.alpha));
    expect(await store.getMask('nothing')).toBeNull();
    await done();
  });

  it('replaces a tip stored again under its id', async () => {
    const { store, done } = await open();
    await store.putBatch({ tips: [{ meta: meta('t'), mask: solid(2, 2, 10) }] });
    await store.putBatch({ tips: [{ meta: meta('t'), mask: solid(3, 3, 20) }] });
    expect((await store.list()).tips).toHaveLength(1);
    expect(Array.from((await store.getMask('t'))!.alpha)).toEqual(Array.from(solid(3, 3, 20).alpha));
    await done();
  });

  it('deleting a preset deletes its tip only when no other preset uses it', async () => {
    const { store, done } = await open();
    await store.putBatch({
      tips: [{ meta: meta('shared'), mask: solid(2, 2) }, { meta: meta('solo'), mask: solid(2, 2) }],
      presets: [preset('a', 'shared'), preset('b', 'shared'), preset('c', 'solo')],
    });
    await store.deletePreset('a');
    expect((await store.list()).tips.map(t => t.id).sort()).toEqual(['shared', 'solo']);
    await store.deletePreset('b');
    await store.deletePreset('c');
    const left = await store.list();
    expect(left.tips).toEqual([]);
    expect(left.presets).toEqual([]);
    expect(await store.getMask('solo')).toBeNull();
    await done();
  });

  it('deleting a tip deletes its mask and the presets that use it', async () => {
    const { store, done } = await open();
    await store.putBatch({
      tips: [{ meta: meta('t'), mask: solid(2, 2) }, { meta: meta('u'), mask: solid(2, 2) }],
      presets: [preset('a', 't'), preset('b', 't'), preset('c', 'u'), preset('plain')],
    });
    await store.deleteTip('t');
    const left = await store.list();
    expect(left.tips.map(t => t.id)).toEqual(['u']);
    expect(left.presets.map(p => p.id).sort()).toEqual(['c', 'plain']);
    expect(await store.getMask('t')).toBeNull();
    await done();
  });
});

describe('IndexedDB upgrade to the brush library', () => {
  it('keeps projects and stamps of a v6 database and gives it the library', async () => {
    const name = `brushes-upgrade-${Math.random()}`;
    // What a v6 build left: no brush stores.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 6);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('projects', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        db.createObjectStore('project-state', { keyPath: 'projectId' });
        db.createObjectStore('project-history', { keyPath: 'id', autoIncrement: true }).createIndex('projectId', 'projectId');
        db.createObjectStore('project-stamps', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        db.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction(['projects', 'project-stamps', 'blobs'], 'readwrite');
      tx.objectStore('projects').put({ id: 'p1', name: 'Old', createdAt: 1, updatedAt: 1, thumbnailRef: null });
      tx.objectStore('blobs').put(new Blob(['x']), 'ref1');
      tx.objectStore('project-stamps').put({ id: 's1', projectId: 'p1', blobRef: 'ref1', createdAt: 1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    old.close();

    const backend = new IndexedDBBackend({ dbName: name });
    await backend.init();
    expect((await indexedDB.databases()).find(d => d.name === name)?.version).toBe(8);
    expect((await backend.projects.list()).map(p => p.name)).toEqual(['Old']);
    expect((await backend.stamps.list('p1')).map(s => s.id)).toEqual(['s1']);
    expect(await backend.brushes!.list()).toEqual({ tips: [], presets: [] });
    await backend.brushes!.putBatch({ tips: [{ meta: meta('t'), mask: solid(2, 2, 9) }], presets: [preset('a', 't')] });
    expect((await backend.brushes!.list()).presets).toHaveLength(1);
    await backend.dispose();
  });

  it('fails with a typed error once storage is closed', async () => {
    const backend = new IndexedDBBackend({ dbName: `brushes-closed-${Math.random()}` });
    await backend.init();
    const store = backend.brushes!;
    await backend.dispose();
    await expect(store.list()).rejects.toMatchObject({ name: 'StorageClosedError' });
  });
});

describe('BrushLibrary', () => {
  it('adds brushes in one step, loads their masks for use, and lists them as presets', async () => {
    const backend = new MemoryBackend();
    const changed = vi.fn();
    const library = new BrushLibrary(backend.brushes, changed);
    const added = await library.add([
      { name: 'A', mask: solid(8, 4) },
      { name: 'B', mask: solid(4, 8), spacing: 0.5, descriptor: { size: 33 } },
    ]);
    expect(added.map(p => p.name)).toEqual(['A', 'B']);
    expect(library.tips.map(t => t.name)).toEqual(['A', 'B']);
    expect(hasTipMask(library.tips[0].id)).toBe(true);
    expect(added[1].descriptor.size).toBe(33);
    expect(added[1].descriptor.spacing).toBe(0.5);
    expect(added[1].descriptor.tip).toMatchObject({ shape: 'image', imageId: library.tips[1].id });
    expect((await backend.brushes.list()).presets).toHaveLength(2);
    expect(changed).toHaveBeenCalled();
  });

  it('loads a stored tip on demand, and says so when it is gone', async () => {
    const backend = new MemoryBackend();
    const first = new BrushLibrary(backend.brushes);
    await first.add([{ name: 'A', mask: solid(8, 4) }]);
    const id = first.tips[0].id;
    clearTipMasks();
    const second = new BrushLibrary(backend.brushes);
    await second.load();
    expect(hasTipMask(id)).toBe(false);
    const [a, b] = await Promise.all([second.ensureTip(id), second.ensureTip(id)]);
    expect([a, b]).toEqual([true, true]);
    expect(hasTipMask(id)).toBe(true);
    expect(await second.ensureTip('gone')).toBe(false);
  });

  it('forgets a deleted tip and its presets', async () => {
    const library = new BrushLibrary(new MemoryBackend().brushes);
    const [p] = await library.add([{ name: 'A', mask: solid(8, 4) }]);
    const id = library.tips[0].id;
    await library.removePreset(p.id);
    expect(library.tips).toEqual([]);
    expect(hasTipMask(id)).toBe(false);
    const [q] = await library.add([{ name: 'B', mask: solid(8, 4) }]);
    await library.removeTip(library.tips[0].id);
    expect(library.presets.find(x => x.id === q.id)).toBeUndefined();
  });

  it('refuses a malformed mask without storing anything', async () => {
    const library = new BrushLibrary(new MemoryBackend().brushes);
    await expect(library.add([{ name: 'ok', mask: solid(2, 2) }, { name: 'bad', mask: { width: 3, height: 3, alpha: new Uint8Array(2) } }])).rejects.toThrow();
    expect(library.tips).toEqual([]);
    expect(library.presets).toEqual([]);
  });

  it('does not bring a deleted tip back when its read was still under way', async () => {
    const backend = new MemoryBackend();
    const library = new BrushLibrary(backend.brushes);
    const [p] = await library.add([{ name: 'A', mask: solid(8, 4) }]);
    const id = library.tips[0].id;
    clearTipMasks();
    let release!: () => void;
    const real = backend.brushes.getMask.bind(backend.brushes);
    vi.spyOn(backend.brushes, 'getMask').mockImplementation(async tipId => {
      const mask = await real(tipId);
      await new Promise<void>(r => { release = r; });
      return mask;
    });
    const loading = library.ensureTip(id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await library.removePreset(p.id);
    release();
    expect(await loading).toBe(false);
    expect(hasTipMask(id)).toBe(false);
  });

  it('follows another tab: new brushes appear, deleted ones stop painting', async () => {
    const backend = new MemoryBackend();
    const mine = new BrushLibrary(backend.brushes);
    const theirs = new BrushLibrary(backend.brushes);
    await mine.load();
    await theirs.add([{ name: 'Theirs', mask: solid(8, 4) }]);
    expect(mine.tips).toEqual([]);
    await mine.reload();
    expect(mine.tips.map(t => t.name)).toEqual(['Theirs']);
    const id = mine.tips[0].id;
    expect(await mine.ensureTip(id)).toBe(true);
    await theirs.removeTip(id);
    await mine.reload();
    expect(mine.tips).toEqual([]);
    expect(hasTipMask(id)).toBe(false);
  });

  it('notifies after storing, for telling other tabs', async () => {
    const stored = vi.fn();
    const library = new BrushLibrary(new MemoryBackend().brushes, undefined, stored);
    const [p] = await library.add([{ name: 'A', mask: solid(8, 4) }]);
    await library.removePreset(p.id);
    expect(stored).toHaveBeenCalledTimes(2);
  });

  it('does not read a tip again that was found missing, until the lists are loaded anew', async () => {
    const backend = new MemoryBackend();
    const library = new BrushLibrary(backend.brushes);
    const read = vi.spyOn(backend.brushes, 'getMask');
    expect(await library.ensureTip('gone')).toBe(false);
    expect(await library.ensureTip('gone')).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    await library.load();
    await library.ensureTip('gone');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

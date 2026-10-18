import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { BrushLibrary } from '../src/engine/brush-library.ts';
import { clearTipMasks, hasTipMask } from '../src/engine/tip-images.ts';
import { MemoryBackend } from '../src/storage/memory/index.ts';
import { makeAppCanvasStub } from './helpers.ts';
import { writeV6, obj, text, unit, pct, bool, type V } from './abr-writer.ts';

function image(width: number, height: number, paint: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (paint(x, y)) data.set([0, 0, 0, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

function makeApp(getFloatImage: () => ImageData | null = () => null) {
  const app = new DrawingApp();
  const backend = new MemoryBackend();
  (app as any)._autosave = false;
  (app as any)._library = new BrushLibrary(backend.brushes, () => {});
  Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub({ getFloatImage }) });
  return { app, ctx: () => (app as any)._buildContextValue(), backend };
}

afterEach(() => {
  clearTipMasks();
  vi.restoreAllMocks();
});

describe('custom brushes in the app', () => {
  it('defines a brush from the selection, selects it and loads its tip', async () => {
    // A 10x6 selection with a 4x2 dark box inside it.
    const { app, ctx, backend } = makeApp(() => image(10, 6, (x, y) => x >= 3 && x < 7 && y >= 2 && y < 4));
    expect(await ctx().defineBrushFromSelection()).toBeNull();
    const state = (app as any)._state;
    const stored = (await backend.brushes.list()).presets;
    expect(stored).toHaveLength(1);
    expect(state.activePreset).toBe(stored[0].id);
    expect(state.isPresetModified).toBe(false);
    expect(state.brush.tip).toMatchObject({ shape: 'image', imageId: stored[0].tipId });
    expect(state.brush.spacing).toBe(0.25);
    expect(hasTipMask(stored[0].tipId)).toBe(true);
    const tip = (await backend.brushes.list()).tips[0];
    // Cropped to the dark box.
    expect([tip.width, tip.height]).toEqual([4, 2]);
    expect(ctx().userPresets.map((p: { name: string; category: string }) => [p.name, p.category])).toEqual([['Brush 1', 'custom']]);
  });

  it('says why when there is no selection or it paints nothing', async () => {
    const none = makeApp();
    expect(await none.ctx().defineBrushFromSelection()).toMatch(/Select/);
    const blank = makeApp(() => image(4, 4, () => false));
    expect(await blank.ctx().defineBrushFromSelection()).toMatch(/nothing to paint/);
    expect((await blank.backend.brushes.list()).tips).toEqual([]);
  });

  it('says so when the file is not an image', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('bad'); }));
    const { ctx } = makeApp();
    expect(await ctx().defineBrushFromFile(new Blob(['nope']), 'x.png')).toMatch(/could not be read/);
    vi.unstubAllGlobals();
  });

  it('loads the tip of a restored brush on demand, and paints round if it is gone', async () => {
    const { app, ctx, backend } = makeApp(() => image(6, 6, () => true));
    await ctx().defineBrushFromSelection();
    const tipId = (await backend.brushes.list()).tips[0].id;
    clearTipMasks();
    expect(hasTipMask(tipId)).toBe(false);
    (app as any)._syncTipImage();
    await vi.waitFor(() => expect(hasTipMask(tipId)).toBe(true));

    await backend.brushes.deleteTip(tipId);
    clearTipMasks();
    (app as any)._syncTipImage();
    await new Promise(r => setTimeout(r, 0));
    expect(hasTipMask(tipId)).toBe(false);
  });

  it('selecting a library tip keeps the rest of the brush', async () => {
    const { app, ctx } = makeApp(() => image(6, 6, () => true));
    await ctx().defineBrushFromSelection();
    ctx().selectPreset('round');
    ctx().setBrush({ size: 33 });
    const tipId = (app as any)._library.tips[0].id;
    ctx().selectUserTip(tipId);
    const state = (app as any)._state;
    expect(state.brush.tip).toMatchObject({ shape: 'image', imageId: tipId });
    expect(state.brush.size).toBe(33);
    expect(state.isPresetModified).toBe(true);
  });

  it('deletes a custom preset with its tip', async () => {
    const { app, ctx, backend } = makeApp(() => image(6, 6, () => true));
    await ctx().defineBrushFromSelection();
    const id = (app as any)._library.presets[0].id;
    vi.spyOn(app as any, '_confirm').mockResolvedValue(true);
    await ctx().deleteUserPreset(id);
    expect(ctx().userPresets).toEqual([]);
    expect(ctx().userTips).toEqual([]);
    expect(await backend.brushes.list()).toEqual({ tips: [], presets: [] });
  });

  it('has no custom brushes on a backend without a library', async () => {
    const app = new DrawingApp();
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub({ getFloatImage: () => image(4, 4, () => true) }) });
    const ctx = (app as any)._buildContextValue();
    expect(ctx.userTips).toEqual([]);
    expect(await ctx.defineBrushFromSelection()).toMatch(/not available/);
  });

  it('lets a brush being stored finish before storage closes for an upgrade', async () => {
    const { app, ctx, backend } = makeApp(() => image(6, 6, () => true));
    let release!: () => void;
    const real = backend.brushes.putBatch.bind(backend.brushes);
    vi.spyOn(backend.brushes, 'putBatch').mockImplementation(async batch => {
      await new Promise<void>(r => { release = r; });
      return real(batch);
    });
    const closed = vi.spyOn(app as any, '_enterStorageClosed').mockImplementation(() => {});
    const defining = ctx().defineBrushFromSelection();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const upgrading = (app as any)._onStorageVersionChange();
    await new Promise(r => setTimeout(r, 0));
    expect(closed).not.toHaveBeenCalled();
    release();
    await defining;
    await upgrading;
    expect(closed).toHaveBeenCalled();
    expect((await backend.brushes.list()).presets).toHaveLength(1);
  });

  it('defers a reload for an update while a brush is being stored', async () => {
    const { app, ctx, backend } = makeApp(() => image(6, 6, () => true));
    let release!: () => void;
    const real = backend.brushes.putBatch.bind(backend.brushes);
    vi.spyOn(backend.brushes, 'putBatch').mockImplementation(async batch => {
      await new Promise<void>(r => { release = r; });
      return real(batch);
    });
    const reload = vi.fn();
    (app as any)._reload = reload;
    (app as any)._updateReady = true;
    const defining = ctx().defineBrushFromSelection();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    (app as any)._reloadIfIdle();
    expect(reload).not.toHaveBeenCalled();
    release();
    await defining;
    // Selecting the new brush marked the (unattached) app dirty; nothing else is pending.
    (app as any)._dirty = false;
    clearTimeout((app as any)._saveTimer);
    (app as any)._saveTimer = null;
    (app as any)._reloadIfIdle();
    expect(reload).toHaveBeenCalled();
  });

  it('asks before deleting a preset whose tip goes with it, and keeps it on no', async () => {
    const { app, ctx } = makeApp(() => image(6, 6, () => true));
    await ctx().defineBrushFromSelection();
    const id = (app as any)._library.presets[0].id;
    const ask = vi.spyOn(app as any, '_confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await ctx().deleteUserPreset(id);
    expect(ask).toHaveBeenCalledTimes(1);
    expect((app as any)._library.presets).toHaveLength(1);
    await ctx().deleteUserPreset(id);
    expect((app as any)._library.presets).toHaveLength(0);
  });

  describe('importing a Photoshop brush file', () => {
    const sample = { id: 'S1', width: 4, height: 4, px: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 255 : 0)) };
    const shape = (id: string): V => obj('sampledBrush', { Dmtr: unit('#Pxl', 20), Angl: unit('#Ang', 0), Rndn: pct(100), Spcn: pct(25), Intr: bool(true), flipX: bool(false), flipY: bool(false), sampledData: text(id) });
    const file = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name);

    it('stores the brushes as a group named after the file and says how many were skipped', async () => {
      const { ctx, backend } = makeApp();
      const bytes = writeV6({
        samples: [sample],
        presets: [obj('null', { 'Nm  ': text('Dots'), Brsh: shape('S1') }), obj('null', { 'Nm  ': text('Lost'), Brsh: shape('missing') })],
      });
      const progress: number[] = [];
      const result = await ctx().importBrushFile(file('Chalk Set.abr', bytes), (f: number) => progress.push(f));
      expect(result).toEqual({ ok: true, message: 'Imported 1 brush, 1 skipped' });
      expect(progress.at(-1)).toBe(1);
      const stored = await backend.brushes.list();
      expect(stored.presets.map(p => [p.name, p.group])).toEqual([['Dots', 'Chalk Set']]);
      expect(ctx().userPresets[0].group).toBe('Chalk Set');
    });

    it('reports a file that is not a brush file without storing anything', async () => {
      const { ctx, backend } = makeApp();
      const result = await ctx().importBrushFile(file('photo.abr', new TextEncoder().encode('GIF89a-not-brushes')));
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/brush file/);
      expect(await backend.brushes.list()).toEqual({ tips: [], presets: [] });
    });

    it('deletes a group after asking', async () => {
      const { app, ctx, backend } = makeApp();
      await ctx().importBrushFile(file('G.abr', writeV6({ samples: [sample], presets: [obj('null', { 'Nm  ': text('A'), Brsh: shape('S1') })] })));
      const ask = vi.spyOn(app as any, '_confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await ctx().deleteUserGroup('G');
      expect((app as any)._library.presets).toHaveLength(1);
      await ctx().deleteUserGroup('G');
      expect(ask).toHaveBeenCalledTimes(2);
      expect(await backend.brushes.list()).toEqual({ tips: [], presets: [] });
    });

    it('loads the tips of the asked-for groups only', async () => {
      const { ctx, app } = makeApp();
      await ctx().importBrushFile(file('G.abr', writeV6({ samples: [sample], presets: [obj('null', { 'Nm  ': text('A'), Brsh: shape('S1') })] })));
      clearTipMasks();
      const tipId = (app as any)._library.tips[0].id;
      ctx().loadUserTips(['']);
      await new Promise(r => setTimeout(r, 0));
      expect(hasTipMask(tipId)).toBe(false);
      ctx().loadUserTips(['G']);
      await vi.waitFor(() => expect(hasTipMask(tipId)).toBe(true));
    });
  });

  it('holds the active brush\'s tip even when another editor loaded it, so that editor deleting it leaves this one painting', async () => {
    const { app, ctx, backend } = makeApp(() => image(6, 6, () => true));
    await ctx().defineBrushFromSelection();
    const original: BrushLibrary = (app as any)._library;
    const tipId = (await backend.brushes.list()).tips[0].id;
    // This editor restores the brush with a library of its own that never loaded the tip itself.
    const mine = new BrushLibrary(backend.brushes, () => {});
    await mine.load();
    (app as any)._library = mine;
    (app as any)._syncTipImage();
    await new Promise(r => setTimeout(r, 0));
    // The other editor (the original library) deletes it.
    await original.removeTip(tipId);
    expect(hasTipMask(tipId)).toBe(true);
    // Without the app asking for it the delete would have emptied the registry.
    mine.release();
    expect(hasTipMask(tipId)).toBe(false);
  });
});

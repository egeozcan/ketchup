// The sampled tips a brush can use, held in memory. The engine paints
// synchronously, so a stroke can only use a tip whose mask is already here:
// the app loads a tip from the brush library when a brush that names it
// becomes the active one, and a stroke that starts before then paints round
// (see `resolveTipForStroke`).
import { createOffscreenCanvas, get2dContext, type AnyCanvas } from './canvas-pool.js';
import type { TipDescriptor } from './types.js';
import { getDefaultTipDescriptor } from './brush-capabilities.js';
import type { TipMask } from './tip-mask.js';

interface Entry {
  mask: TipMask;
  /** Changes whenever an id is registered again, so a cache can tell a replaced mask from the old one. */
  revision: number;
  /** White with the mask as alpha, then halved repeatedly, built on first use. */
  levels: AnyCanvas[] | null;
}

const registry = new Map<string, Entry>();
/**
 * Who holds each tip (a brush library, say). The registry is shared by every
 * editor on the page, so a tip is dropped only when the last holder lets go;
 * a tip registered with no holder is nobody's and goes with any release.
 */
const holders = new Map<string, Set<object>>();
/**
 * Tips a stroke under way is painting with. Deleting one (another tab did, or
 * the editor left the page) takes it from the registry for later strokes, but
 * this one keeps its mask until it ends, so its shape doesn't change partway.
 */
const pinned = new Map<string, { entry: Entry; count: number }>();
let revisions = 0;

const lookup = (id: string | undefined): Entry | undefined => (id ? registry.get(id) ?? pinned.get(id)?.entry : undefined);

/** Keeps a loaded tip's mask for the caller until the returned function is called (once). No-op for a tip that isn't loaded. */
export function pinTipMask(id: string | undefined): () => void {
  const entry = id ? registry.get(id) : undefined;
  if (!id || !entry) return () => {};
  const p = pinned.get(id);
  if (p && p.entry === entry) p.count++;
  else pinned.set(id, { entry, count: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const q = pinned.get(id);
    if (q && --q.count <= 0) pinned.delete(id);
  };
}

/**
 * The mip canvases are four bytes a pixel and rebuilt on demand, so they are
 * what is kept in check: past this many bytes the least recently drawn
 * entries' canvases are dropped (the masks themselves stay, which a brush in
 * use needs).
 */
const MAX_LEVEL_BYTES = 64 * 1024 * 1024;
let levelBytes = 0;
const levelBytesOf = (levels: AnyCanvas[]) => levels.reduce((sum, c) => sum + c.width * c.height * 4, 0);

export function registerTipMask(id: string, mask: TipMask, holder?: object) {
  // Another holder's copy of the same id is the same tip: kept, so brushes and caches see no change.
  if (holder && registry.has(id)) {
    retainTipMask(id, holder);
    return;
  }
  dropTipMask(id);
  registry.set(id, { mask, revision: ++revisions, levels: null });
  if (holder) holders.set(id, new Set([holder]));
}

/** Makes `holder` one of the holders of a tip already registered. */
export function retainTipMask(id: string, holder: object) {
  if (!registry.has(id)) return;
  const set = holders.get(id);
  if (set) set.add(holder);
  else holders.set(id, new Set([holder]));
}

/** Lets go of a tip; with a `holder`, it stays registered while another holder keeps it. */
export function unregisterTipMask(id: string, holder?: object) {
  if (holder) {
    const set = holders.get(id);
    if (set) {
      set.delete(holder);
      if (set.size > 0) return;
    }
  }
  dropTipMask(id);
}

function dropTipMask(id: string) {
  const entry = registry.get(id);
  if (entry?.levels) levelBytes -= levelBytesOf(entry.levels);
  registry.delete(id);
  holders.delete(id);
}

export function hasTipMask(id: string | undefined): boolean {
  return !!id && registry.has(id);
}

/** 0 when the tip isn't loaded; otherwise a number that changes if it is loaded again. */
export function tipMaskRevision(id: string | undefined): number {
  return lookup(id)?.revision || 0;
}

export function getTipMask(id: string | undefined): TipMask | null {
  return lookup(id)?.mask ?? null;
}

/** For tests: forget every registered tip. */
export function clearTipMasks() {
  registry.clear();
  holders.clear();
  pinned.clear();
  levelBytes = 0;
}

/** Whether this tip is a sampled one whose mask isn't loaded: it paints round until it is. */
export function isTipMissing(tip: TipDescriptor): boolean {
  return tip.shape === 'image' && !hasTipMask(tip.imageId);
}

/**
 * The tip a stroke paints with, fixed when it starts: a sampled tip whose mask
 * is loaded stays as it is, one that is missing becomes round. A mask arriving
 * mid-stroke must not change the shape and spacing partway.
 */
export function resolveTipForStroke(tip: TipDescriptor): TipDescriptor {
  if (!isTipMissing(tip)) return tip;
  return { ...getDefaultTipDescriptor('round'), orientation: tip.orientation, angle: tip.angle };
}

/**
 * A sampled tip's footprint for a dab of `size`: the longer side is `size`,
 * the other follows the image's proportions. Round (a missing mask) when the
 * mask isn't loaded.
 */
export function imageTipFootprint(size: number, tip: TipDescriptor): { w: number; h: number } {
  const long = Math.max(1, size);
  const mask = getTipMask(tip.imageId);
  if (!mask) return { w: long, h: long };
  if (mask.width >= mask.height) return { w: long, h: Math.max(1, long * mask.height / mask.width) };
  return { w: Math.max(1, long * mask.width / mask.height), h: long };
}

function levelsFor(id: string, entry: Entry): AnyCanvas[] {
  if (entry.levels) {
    // Most recently drawn last, which is where eviction does not look.
    if (registry.get(id) === entry) {
      registry.delete(id);
      registry.set(id, entry);
    }
    return entry.levels;
  }
  const { mask } = entry;
  const base = createOffscreenCanvas(mask.width, mask.height);
  const bctx = get2dContext(base);
  const img = bctx.createImageData(mask.width, mask.height);
  for (let i = 0, p = 0; i < mask.alpha.length; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
    img.data[p + 3] = mask.alpha[i];
  }
  bctx.putImageData(img, 0, 0);
  const levels: AnyCanvas[] = [base];
  // Drawing a 1024px mask at 8px in one step skips most of its pixels and
  // sparkles; halving until the next step would be small keeps it averaged.
  let last = base;
  while (Math.max(last.width, last.height) > 16) {
    const w = Math.max(1, Math.ceil(last.width / 2));
    const h = Math.max(1, Math.ceil(last.height / 2));
    const next = createOffscreenCanvas(w, h);
    const nctx = get2dContext(next);
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(last as HTMLCanvasElement, 0, 0, w, h);
    levels.push(next);
    last = next;
  }
  entry.levels = levels;
  // A tip only a stroke still holds is no longer the registry's to count or evict.
  if (registry.get(id) !== entry) return levels;
  levelBytes += levelBytesOf(levels);
  for (const other of registry.values()) {
    if (levelBytes <= MAX_LEVEL_BYTES) break;
    if (other === entry || !other.levels) continue;
    levelBytes -= levelBytesOf(other.levels);
    other.levels = null;
  }
  return levels;
}

/**
 * The tip canvas for a sampled tip at `diameter` (its longer side): white
 * with the mask as alpha, so tinting, colour dynamics and texture treat it as
 * any other tip. A missing mask yields a hard round tip; the caller keeps it
 * out of the cache (BrushTipCache keys it as missing).
 */
export function generateImageTip(diameter: number, _hardness: number, tip: TipDescriptor): AnyCanvas {
  const entry = lookup(tip.imageId);
  const { w, h } = imageTipFootprint(Math.max(1, diameter), tip);
  const cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
  const canvas = createOffscreenCanvas(cw, ch);
  const ctx = get2dContext(canvas);
  if (!entry) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, cw / 2, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
  }
  // The smallest level still at least as large as the tip, so it is only ever reduced.
  const levels = levelsFor(tip.imageId!, entry);
  let src = levels[0];
  for (const level of levels) {
    if (Math.max(level.width, level.height) >= diameter) src = level;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as HTMLCanvasElement, 0, 0, cw, ch);
  return canvas;
}

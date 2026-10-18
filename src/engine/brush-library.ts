// The user's custom brushes held in memory, over the storage backend's
// BrushLibraryStore: sampled tips and the presets built on them. Item for item
// the lists a UI shows, plus the one place masks get into the tip registry.
import type { BrushLibraryStore, BrushTipMeta, UserBrushPreset } from '../storage/types.js';
import type { BrushDescriptor, BrushPreset } from './types.js';
import { generateUUID } from '../utils/uuid.js';
import { thumbnailMask, isTipMask, type TipMask } from './tip-mask.js';
import { registerTipMask, hasTipMask, unregisterTipMask } from './tip-images.js';
import { copyDescriptor, normalizeBrushDescriptor } from './brush-presets.js';
import { getDefaultTipDescriptor } from './brush-capabilities.js';

/** Photoshop's default spacing for a sampled tip. */
export const DEFAULT_TIP_SPACING = 0.25;

/** One brush to add to the library: a mask, a name, and optionally the rest of the brush. */
export interface NewUserBrush {
  name: string;
  mask: TipMask;
  /** The brush the tip goes into; defaults to the current default brush. Its tip is replaced by the sampled one. */
  descriptor?: Partial<BrushDescriptor>;
  /** Overrides `DEFAULT_TIP_SPACING` (and the descriptor's spacing). */
  spacing?: number;
}

/** A user preset as the preset picker shows it. */
export function toBrushPreset(p: UserBrushPreset): BrushPreset {
  return { id: p.id, name: p.name, category: 'custom', descriptor: normalizeBrushDescriptor(p.descriptor) };
}

export class BrushLibrary {
  tips: BrushTipMeta[] = [];
  presets: UserBrushPreset[] = [];
  private _loading = new Map<string, Promise<boolean>>();
  /** Bumped when a tip is deleted, so a read of it still under way can't register it again. */
  private _deleted = new Map<string, number>();
  /** Tips this library has put in the registry or listed, to tell which another tab deleted. */
  private _known = new Set<string>();
  /** Tips whose read failed or found nothing, not asked for again until the lists are loaded anew. */
  private _failed = new Set<string>();

  constructor(
    private _store: BrushLibraryStore,
    /** Called whenever the lists change or a tip finishes loading. */
    private _onChange: () => void = () => {},
    /** Called after this library stored a change, for telling other tabs. */
    private _onStored: () => void = () => {},
  ) {}

  async load(): Promise<void> {
    const { tips, presets } = await this._store.list();
    // What another tab deleted since is forgotten here too, masks included.
    const listed = new Set(tips.map(t => t.id));
    for (const id of this._known) if (!listed.has(id)) this._forgetTip(id);
    this._known = listed;
    this._failed.clear();
    this.tips = tips;
    this.presets = presets;
    this._onChange();
  }

  /** Looks the lists up again after another tab changed them. */
  reload(): Promise<void> {
    return this.load().catch(e => console.error('Could not reload custom brushes:', e));
  }

  /** The tip's metadata, if the library has it. */
  tipMeta(id: string | undefined): BrushTipMeta | undefined {
    return this.tips.find(t => t.id === id);
  }

  /**
   * Loads a tip's mask into the engine's registry, so strokes can use it.
   * Resolves false when the tip isn't in the library or can't be read (the
   * brush then paints round). Concurrent calls for one id share one read.
   */
  ensureTip(id: string): Promise<boolean> {
    if (hasTipMask(id)) return Promise.resolve(true);
    if (this._failed.has(id)) return Promise.resolve(false);
    const pending = this._loading.get(id);
    if (pending) return pending;
    const generation = this._deleted.get(id) ?? 0;
    const load = (async () => {
      try {
        const mask = await this._store.getMask(id);
        if (!mask || !isTipMask(mask)) {
          this._failed.add(id);
          return false;
        }
        // Deleted while it was being read: it stays deleted.
        if ((this._deleted.get(id) ?? 0) !== generation) return false;
        registerTipMask(id, mask);
        this._onChange();
        return true;
      } catch (e) {
        console.error('Could not load brush tip:', e);
        this._failed.add(id);
        return false;
      } finally {
        this._loading.delete(id);
      }
    })();
    this._loading.set(id, load);
    return load;
  }

  /**
   * Adds brushes in one stored step (all or none). Each becomes a tip and a
   * preset naming it; their masks are loaded for use at once. This is the
   * entry point for importing many brushes at a time.
   */
  async add(brushes: NewUserBrush[]): Promise<UserBrushPreset[]> {
    const now = Date.now();
    const tips: { meta: BrushTipMeta; mask: TipMask }[] = [];
    const presets: UserBrushPreset[] = [];
    brushes.forEach((b, i) => {
      if (!isTipMask(b.mask)) throw new RangeError('Not a valid tip mask');
      const id = generateUUID();
      const spacing = b.spacing ?? DEFAULT_TIP_SPACING;
      const meta: BrushTipMeta = {
        id, name: b.name, width: b.mask.width, height: b.mask.height, spacing,
        createdAt: now + i, thumb: thumbnailMask(b.mask),
      };
      const base = normalizeBrushDescriptor(b.descriptor);
      const descriptor = copyDescriptor({
        ...base,
        spacing,
        tip: { ...getDefaultTipDescriptor('image'), imageId: id },
      });
      tips.push({ meta, mask: b.mask });
      presets.push({ id: generateUUID(), name: b.name, descriptor, tipId: id, createdAt: now + i });
    });
    await this._store.putBatch({ tips, presets });
    for (const t of tips) {
      registerTipMask(t.meta.id, t.mask);
      this._known.add(t.meta.id);
    }
    this.tips = [...this.tips, ...tips.map(t => t.meta)];
    this.presets = [...this.presets, ...presets];
    this._onChange();
    this._onStored();
    return presets;
  }

  async removePreset(id: string): Promise<void> {
    const tipId = this.presets.find(p => p.id === id)?.tipId;
    await this._store.deletePreset(id);
    this.presets = this.presets.filter(p => p.id !== id);
    if (tipId && !this.presets.some(p => p.tipId === tipId)) this._forgetTip(tipId);
    this._onChange();
    this._onStored();
  }

  async removeTip(id: string): Promise<void> {
    await this._store.deleteTip(id);
    this.presets = this.presets.filter(p => p.tipId !== id);
    this._forgetTip(id);
    this._onChange();
    this._onStored();
  }

  private _forgetTip(id: string) {
    this.tips = this.tips.filter(t => t.id !== id);
    this._known.delete(id);
    this._deleted.set(id, (this._deleted.get(id) ?? 0) + 1);
    // Brushes in use that still name it paint round from now on.
    unregisterTipMask(id);
  }
}

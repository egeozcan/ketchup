import { type AnyCanvas } from './canvas-pool.js';
import type { TipDescriptor } from './types.js';
import { tipGenerators, generateFanTip, generateSplatterTip, TIP_VARIANT_COUNTS } from './tip-generators.js';

/**
 * Tips are cached by byte size rather than count: pressure-driven size on a
 * large fan or splatter brush cycles through hundreds of diameter/variant
 * combinations, which a small count limit would thrash on every dab.
 */
const MAX_BYTES = 32 * 1024 * 1024;

export class BrushTipCache {
  // Map iteration follows insertion order, so re-inserting on each hit keeps
  // the least recently used entry first and eviction is O(1).
  private _entries = new Map<string, AnyCanvas>();
  private _bytes = 0;

  private _buildKey(diameter: number, hardness: number, tip: TipDescriptor, variantIndex?: number): string {
    let key = `${tip.shape}-${diameter}-${hardness.toFixed(2)}-${tip.aspect.toFixed(1)}`;
    if (tip.bristles != null) key += `-b${tip.bristles}`;
    if (tip.spread != null) key += `-s${tip.spread.toFixed(2)}`;
    if (variantIndex != null) key += `-v${variantIndex}`;
    return key;
  }

  get(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
    const key = this._buildKey(diameter, hardness, tip);
    const existing = this._lookup(key);
    if (existing) return existing;

    const generator = tipGenerators[tip.shape];
    return this._insert(key, generator(diameter, hardness, tip));
  }

  getVariant(diameter: number, hardness: number, tip: TipDescriptor, variantIndex: number): AnyCanvas {
    const key = this._buildKey(diameter, hardness, tip, variantIndex);
    const existing = this._lookup(key);
    if (existing) return existing;

    let canvas: AnyCanvas;
    if (tip.shape === 'fan') {
      canvas = generateFanTip(diameter, hardness, tip, variantIndex);
    } else if (tip.shape === 'splatter') {
      canvas = generateSplatterTip(diameter, hardness, tip, variantIndex);
    } else {
      canvas = tipGenerators[tip.shape](diameter, hardness, tip);
    }

    return this._insert(key, canvas);
  }

  private _lookup(key: string): AnyCanvas | undefined {
    const canvas = this._entries.get(key);
    if (canvas) {
      this._entries.delete(key);
      this._entries.set(key, canvas);
    }
    return canvas;
  }

  private _insert(key: string, canvas: AnyCanvas): AnyCanvas {
    this._entries.set(key, canvas);
    this._bytes += canvas.width * canvas.height * 4;
    // Evict least recently used first, but always keep the tip just added.
    for (const [oldKey, old] of this._entries) {
      if (this._bytes <= MAX_BYTES || oldKey === key) break;
      this._entries.delete(oldKey);
      this._bytes -= old.width * old.height * 4;
    }
    return canvas;
  }

  clear() {
    this._entries.clear();
    this._bytes = 0;
  }
}

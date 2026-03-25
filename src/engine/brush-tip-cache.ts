import { type AnyCanvas } from './canvas-pool.js';
import type { TipDescriptor } from './types.js';
import { tipGenerators, generateFanTip, generateSplatterTip, TIP_VARIANT_COUNTS } from './tip-generators.js';

interface CacheEntry {
  canvas: AnyCanvas;
  key: string;
  lastUsed: number;
}

const MAX_ENTRIES = 128;

export class BrushTipCache {
  private _entries = new Map<string, CacheEntry>();
  private _accessCounter = 0;

  private _buildKey(diameter: number, hardness: number, tip: TipDescriptor, variantIndex?: number): string {
    let key = `${tip.shape}-${diameter}-${hardness.toFixed(2)}-${tip.aspect.toFixed(1)}`;
    if (tip.bristles != null) key += `-b${tip.bristles}`;
    if (tip.spread != null) key += `-s${tip.spread.toFixed(2)}`;
    if (variantIndex != null) key += `-v${variantIndex}`;
    return key;
  }

  get(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
    const key = this._buildKey(diameter, hardness, tip);
    const existing = this._entries.get(key);
    if (existing) {
      existing.lastUsed = ++this._accessCounter;
      return existing.canvas;
    }

    const generator = tipGenerators[tip.shape];
    const canvas = generator(diameter, hardness, tip);
    this._entries.set(key, { canvas, key, lastUsed: ++this._accessCounter });
    this._evictIfNeeded();
    return canvas;
  }

  getVariant(diameter: number, hardness: number, tip: TipDescriptor, variantIndex: number): AnyCanvas {
    const key = this._buildKey(diameter, hardness, tip, variantIndex);
    const existing = this._entries.get(key);
    if (existing) {
      existing.lastUsed = ++this._accessCounter;
      return existing.canvas;
    }

    let canvas: AnyCanvas;
    if (tip.shape === 'fan') {
      canvas = generateFanTip(diameter, hardness, tip, variantIndex);
    } else if (tip.shape === 'splatter') {
      canvas = generateSplatterTip(diameter, hardness, tip, variantIndex);
    } else {
      canvas = tipGenerators[tip.shape](diameter, hardness, tip);
    }

    this._entries.set(key, { canvas, key, lastUsed: ++this._accessCounter });
    this._evictIfNeeded();
    return canvas;
  }

  private _evictIfNeeded() {
    while (this._entries.size > MAX_ENTRIES) {
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._entries) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldest = key;
        }
      }
      if (oldest) this._entries.delete(oldest);
      else break;
    }
  }

  clear() {
    this._entries.clear();
    this._accessCounter = 0;
  }
}

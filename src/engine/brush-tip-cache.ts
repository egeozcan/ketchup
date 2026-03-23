import { createOffscreenCanvas, get2dContext } from './canvas-pool.js';

type TipCanvas = HTMLCanvasElement | OffscreenCanvas;

interface CacheEntry {
  canvas: TipCanvas;
  key: string;
  lastUsed: number;
}

const MAX_ENTRIES = 64;

export class BrushTipCache {
  private _entries = new Map<string, CacheEntry>();
  private _accessCounter = 0;

  /** Get or create an alpha-mask tip (white-on-transparent) for the given diameter and hardness. */
  get(diameter: number, hardness: number): TipCanvas {
    const key = `${diameter}-${hardness}`;
    const existing = this._entries.get(key);
    if (existing) {
      existing.lastUsed = ++this._accessCounter;
      return existing.canvas;
    }

    const canvas = this._render(diameter, hardness);
    this._entries.set(key, { canvas, key, lastUsed: ++this._accessCounter });

    if (this._entries.size > MAX_ENTRIES) {
      this._evict();
    }

    return canvas;
  }

  private _render(diameter: number, hardness: number): TipCanvas {
    const size = Math.max(1, diameter);
    const canvas = createOffscreenCanvas(size, size);
    const ctx = get2dContext(canvas);
    const r = size / 2;

    if (hardness >= 1) {
      // Hard circle
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Radial gradient — hardness controls where the solid core ends
      const grad = ctx.createRadialGradient(r, r, r * hardness, r, r, r);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fill();
    }

    return canvas;
  }

  private _evict() {
    // Remove the least recently used entry
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._entries) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldest = key;
      }
    }
    if (oldest) this._entries.delete(oldest);
  }

  clear() {
    this._entries.clear();
    this._accessCounter = 0;
  }
}

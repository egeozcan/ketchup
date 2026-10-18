import { Rng } from './rng.js';
import type { BrushTexture, TextureMode } from './types.js';

/**
 * Brush texture (Photoshop's "Texture"): a grain that holes a stroke's
 * coverage. A pattern is a tile of 8-bit heights, 255 for the paper's peaks
 * (where paint takes) down to 0 for its pits. The built-in ones are generated
 * on first use from fixed seeds and wrap around their edges, so they repeat
 * without a seam; `registerTexturePattern` adds others (an imported
 * pattern, say) under their own id.
 */
export interface TexturePattern {
  id: string;
  label: string;
  width: number;
  height: number;
  /** width × height heights, row by row. */
  data: Uint8Array;
}

/** A texture block that is switched on, with its pattern looked up. */
export interface Grain {
  pattern: TexturePattern;
  scale: number;
  depth: number;
  mode: TextureMode;
  invert: boolean;
  depthPressure: boolean;
  perTip: boolean;
}

const TILE = 256;

const registry = new Map<string, TexturePattern>();
/** Who registered each custom pattern (see `unregisterTexturePattern`). */
const holders = new Map<string, Set<object>>();
const builtinLabels: [string, string][] = [
  ['paper', 'Paper'],
  ['canvas', 'Canvas'],
  ['noise', 'Noise'],
  ['charcoal', 'Charcoal'],
];
const BUILTIN_IDS = new Set(builtinLabels.map(([id]) => id));
const builtinCache = new Map<string, TexturePattern>();

/** Longest pattern id a stored brush keeps (normalizeTexture), so registration refuses longer. */
export const MAX_PATTERN_ID_LENGTH = 100;

/** Add (or replace) a pattern, for a tile that isn't built in. Returns false for a tile that can't be used. */
export function registerTexturePattern(id: string, label: string, width: number, height: number, data: Uint8Array, holder?: object): boolean {
  if (!id || id.length > MAX_PATTERN_ID_LENGTH || id === 'none' || BUILTIN_IDS.has(id)) return false;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height) return false;
  registry.set(id, { id, label, width, height, data });
  if (holder) {
    const set = holders.get(id);
    if (set) set.add(holder);
    else holders.set(id, new Set([holder]));
  }
  return true;
}

/**
 * Drops a pattern. The registry is shared by every editor on the page, so with
 * a `holder` (a brush library) the pattern stays while another holder keeps it.
 */
export function unregisterTexturePattern(id: string, holder?: object) {
  if (holder) {
    const set = holders.get(id);
    if (set) {
      set.delete(holder);
      if (set.size > 0) return;
    }
  }
  holders.delete(id);
  registry.delete(id);
}

/** The pattern with this id, generating a built-in one the first time; null for 'none' and for ids nothing is registered under. */
export function getTexturePattern(id: string): TexturePattern | null {
  const custom = registry.get(id);
  if (custom) return custom;
  if (!BUILTIN_IDS.has(id)) return null;
  let p = builtinCache.get(id);
  if (!p) {
    p = { id, label: builtinLabels.find(([i]) => i === id)![1], width: TILE, height: TILE, data: generate(id) };
    builtinCache.set(id, p);
  }
  return p;
}

/** Every pattern a brush can pick, built-in first, as id and label ('none' is the caller's to add). */
export function texturePatternList(): { id: string; label: string }[] {
  return [...builtinLabels.map(([id, label]) => ({ id, label })), ...[...registry.values()].map(p => ({ id: p.id, label: p.label }))];
}

/** Whether this texture block changes the stroke: it names a pattern that exists and has depth. */
export function textureActive(t: BrushTexture | undefined): boolean {
  return !!t && t.depth > 0 && t.pattern !== 'none' && getTexturePattern(t.pattern) !== null;
}

/** The texture block as a grain, or null when it changes nothing. */
export function resolveGrain(t: BrushTexture | undefined): Grain | null {
  if (!t || !(t.depth > 0) || t.pattern === 'none') return null;
  const pattern = getTexturePattern(t.pattern);
  if (!pattern) return null;
  return { pattern, scale: t.scale > 0 ? t.scale : 1, depth: t.depth, mode: t.mode, invert: t.invert, depthPressure: t.depthPressure, perTip: t.perTip };
}

// ---------------------------------------------------------------------------
// Generation

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Adds value noise with `cx` × `cy` lattice cells across the tile; the lattice wraps, so the sum does too. */
function addNoise(f: Float32Array, cx: number, cy: number, seed: number, amp: number) {
  for (let y = 0; y < TILE; y++) {
    const v = y * cy / TILE;
    const iy = Math.floor(v);
    const ty = v - iy;
    const sy = ty * ty * (3 - 2 * ty);
    const y0 = iy % cy, y1 = (iy + 1) % cy;
    for (let x = 0; x < TILE; x++) {
      const u = x * cx / TILE;
      const ix = Math.floor(u);
      const tx = u - ix;
      const sx = tx * tx * (3 - 2 * tx);
      const x0 = ix % cx, x1 = (ix + 1) % cx;
      const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
      f[y * TILE + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
    }
  }
}

/** Spreads the values evenly over 0..255, so a depth means the same share of holes whatever the pattern. */
function equalize(f: Float32Array): Uint8Array {
  const BINS = 4096;
  let lo = Infinity, hi = -Infinity;
  for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const hist = new Uint32Array(BINS);
  const bin = (v: number) => Math.min(BINS - 1, Math.floor((v - lo) / span * BINS));
  for (const v of f) hist[bin(v)]++;
  const cdf = new Float32Array(BINS);
  let run = 0;
  for (let i = 0; i < BINS; i++) { cdf[i] = run + hist[i] / 2; run += hist[i]; }
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(cdf[bin(f[i])] / f.length * 255);
  return out;
}

/** A short line of height laid across the tile, wrapping at its edges. */
function addFibre(f: Float32Array, x: number, y: number, angle: number, len: number, amp: number) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  for (let i = 0; i < len; i++) {
    const px = ((Math.round(x + dx * i) % TILE) + TILE) % TILE;
    const py = ((Math.round(y + dy * i) % TILE) + TILE) % TILE;
    f[py * TILE + px] += amp;
  }
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** A built-in pattern's tile, generated afresh (the same every time). */
export function generate(id: string): Uint8Array {
  const f = new Float32Array(TILE * TILE);
  switch (id) {
    case 'noise':
      addNoise(f, 16, 16, 11, 0.5);
      addNoise(f, 32, 32, 12, 0.3);
      addNoise(f, 64, 64, 13, 0.15);
      addNoise(f, 128, 128, 14, 0.05);
      return equalize(f);
    case 'paper': {
      // Soft mottling, a fine tooth and short fibres lying every way.
      addNoise(f, 8, 8, 21, 0.2);
      addNoise(f, 32, 32, 22, 0.3);
      addNoise(f, 128, 128, 23, 0.3);
      addNoise(f, 256, 256, 24, 0.2);
      const rng = new Rng(0x9A9E12);
      for (let i = 0; i < 700; i++) {
        addFibre(f, rng.next() * TILE, rng.next() * TILE, rng.next() * Math.PI, 6 + rng.next() * 18, 0.22);
      }
      return equalize(f);
    }
    case 'canvas': {
      // A plain weave, threads 8px apart over and under in turn, with a little noise.
      const P = 8;
      addNoise(f, 128, 128, 31, 0.12);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const u = (x % P) / P, v = (y % P) / P;
          const su = Math.sin(Math.PI * u), sv = Math.sin(Math.PI * v);
          const over = (Math.floor(x / P) + Math.floor(y / P)) & 1;
          f[y * TILE + x] += over ? sv * (0.7 + 0.3 * su) : su * (0.7 + 0.3 * sv);
        }
      }
      return equalize(f);
    }
    case 'charcoal': {
      // Fine pits over broad blotches, then pushed apart so the paper shows through or not at all.
      addNoise(f, 128, 128, 41, 0.45);
      addNoise(f, 64, 64, 42, 0.2);
      addNoise(f, 16, 16, 43, 0.35);
      const e = equalize(f);
      for (let i = 0; i < e.length; i++) e[i] = Math.round(smoothstep(0.2, 0.8, e[i] / 255) * 255);
      return e;
    }
  }
  return new Uint8Array(TILE * TILE).fill(255);
}

// ---------------------------------------------------------------------------
// Applying

/**
 * Mask the alpha of `rgba` (as getImageData gives it, straight, so colour is
 * left as it is; `w` × `h` pixels whose top-left is
 * the document pixel (ox, oy)) by the grain. The grain is looked up at each
 * pixel's place in the document, so a stroke laid twice over a spot is
 * grained the same way, and it does not matter where the buffer starts.
 *
 * With the tile's value g (flipped by `invert`) the pit depth is
 * `depth × (1 - g)`: Multiply scales alpha by 1 minus that, Subtract takes it
 * off, and Height drops the alpha below it to nothing and stretches the rest
 * back to full, so a light touch only catches the peaks and a heavy one
 * fills the pits too (the pressure-like behaviour of Photoshop's Height).
 * `depth` defaults to the grain's own; a dab's pressure may pass less.
 */
export function applyGrain(rgba: Uint8ClampedArray, w: number, h: number, ox: number, oy: number, grain: Grain, depth = grain.depth) {
  if (!(depth > 0)) return;
  const { data, width: tw, height: th } = grain.pattern;
  const { scale, mode, invert } = grain;
  // Per-column tile positions, the same for every row.
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const t = (ox + x + 0.5) / scale - 0.5;
    const i = Math.floor(t);
    xf[x] = t - i;
    xi0[x] = ((i % tw) + tw) % tw;
    xi1[x] = (xi0[x] + 1) % tw;
  }
  for (let y = 0; y < h; y++) {
    const t = (oy + y + 0.5) / scale - 0.5;
    const i = Math.floor(t);
    const fy = t - i;
    const r0 = (((i % th) + th) % th) * tw;
    const r1 = ((((i + 1) % th) + th) % th) * tw;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const a = rgba[p + 3];
      if (a === 0) continue;
      const fx = xf[x];
      const top = data[r0 + xi0[x]] + (data[r0 + xi1[x]] - data[r0 + xi0[x]]) * fx;
      const bot = data[r1 + xi0[x]] + (data[r1 + xi1[x]] - data[r1 + xi0[x]]) * fx;
      let g = (top + (bot - top) * fy) / 255;
      if (invert) g = 1 - g;
      const hole = depth * (1 - g);
      let kept: number; // alpha afterwards, 0..255
      if (mode === 'multiply') kept = a * (1 - hole);
      else if (mode === 'subtract') kept = Math.max(0, a - hole * 255);
      else kept = hole >= 1 ? 0 : Math.max(0, (a / 255 - hole) / (1 - hole)) * 255;
      if (kept === a) continue;
      rgba[p + 3] = Math.round(kept);
    }
  }
}

/** For tests: forget every custom pattern. */
export function clearCustomTexturePatterns() {
  registry.clear();
  holders.clear();
}

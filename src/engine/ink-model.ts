import type { InkDescriptor, InkState } from './types.js';

// ── OKLab color space conversion ─────────────────────────────

interface OklabColor { L: number; a: number; b: number; }
interface RGBColor { r: number; g: number; b: number; }

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbToOklab(r: number, g: number, b: number): OklabColor {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

export function oklabToSrgb(L: number, a: number, b: number): RGBColor {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: Math.max(0, Math.min(1, linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))),
    g: Math.max(0, Math.min(1, linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))),
    b: Math.max(0, Math.min(1, linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))),
  };
}

/** Parse "#RRGGBB" to [0-1, 0-1, 0-1] */
function hexToRgb(hex: string): RGBColor {
  const n = parseInt(hex.slice(1, 7), 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

/** Convert [0-1, 0-1, 0-1] to "#RRGGBB" */
function rgbToHex(c: RGBColor): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Interpolate two hex colors in OKLab space. t=0 returns a, t=1 returns b. */
export function lerpOklab(hexA: string, hexB: string, t: number): string {
  if (t <= 0) return hexA;
  if (t >= 1) return hexB;
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const labA = srgbToOklab(a.r, a.g, a.b);
  const labB = srgbToOklab(b.r, b.g, b.b);
  const mixed = oklabToSrgb(
    labA.L + (labB.L - labA.L) * t,
    labA.a + (labB.a - labA.a) * t,
    labA.b + (labB.b - labA.b) * t,
  );
  return rgbToHex(mixed);
}

// ── Ink state management ─────────────────────────────────────

export function initInkState(color: string, snapshot: ImageData | null): InkState {
  return {
    distanceTraveled: 0,
    remainingPaint: 1,
    originalColor: color,
    currentColor: color,
    stampCount: 0,
    layerSnapshot: snapshot,
    prevRotation: 0,
  };
}

/** Apply depletion: returns adjusted alpha multiplier (0-1). */
export function applyDepletion(ink: InkDescriptor, state: InkState): number {
  if (ink.depletion <= 0) return 1;
  const remaining = Math.max(0, 1 - (state.distanceTraveled / Math.max(1, ink.depletionLength)) * ink.depletion);
  state.remainingPaint = remaining;
  return remaining;
}

/** Apply buildup: returns adjusted flow value. */
export function applyBuildup(ink: InkDescriptor, baseFlow: number, spacingPx: number, stampDeltaDist: number): number {
  if (ink.buildup <= 0) return baseFlow;
  // overlapDensity is 0 at normal spacing, positive only when stamps cluster
  // tighter than the configured spacing (slow movement)
  const ratio = stampDeltaDist > 0.01 ? spacingPx / stampDeltaDist : 4;
  const overlapDensity = Math.min(3, Math.max(0, ratio - 1));
  return Math.min(1, baseFlow * (1 + ink.buildup * overlapDensity));
}

/** Sample averaged canvas color from a region around (x, y). Radius scales with
 *  brush size to produce smooth color transitions instead of per-pixel noise. */
export function sampleSnapshot(snapshot: ImageData, x: number, y: number, radius = 6): { color: string; alpha: number } {
  const w = snapshot.width;
  const h = snapshot.height;
  const data = snapshot.data;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = Math.max(1, Math.round(radius));
  const r2 = r * r;

  let totalR = 0, totalG = 0, totalB = 0, totalA = 0, count = 0;

  const x0 = Math.max(0, cx - r);
  const x1 = Math.min(w - 1, cx + r);
  const y0 = Math.max(0, cy - r);
  const y1 = Math.min(h - 1, cy + r);

  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      if (dx * dx + dy * dy > r2) continue;
      const i = (py * w + px) * 4;
      const a = data[i + 3];
      if (a < 2) continue; // skip fully transparent
      // Alpha-weighted accumulation so opaque pixels dominate
      totalR += data[i] * a;
      totalG += data[i + 1] * a;
      totalB += data[i + 2] * a;
      totalA += a;
      count++;
    }
  }

  if (count === 0 || totalA === 0) return { color: '#000000', alpha: 0 };

  const avgR = Math.round(totalR / totalA);
  const avgG = Math.round(totalG / totalA);
  const avgB = Math.round(totalB / totalA);
  const avgA = Math.round(totalA / count);

  return {
    color: `#${((1 << 24) | (avgR << 16) | (avgG << 8) | avgB).toString(16).slice(1)}`,
    alpha: avgA,
  };
}

/** Apply color pickup: sets state.currentColor as a blend of the original brush
 *  color and the canvas color at (x, y). Wetness controls the mix ratio — the brush
 *  always retains (1 - wetness) of its original color, never drifting fully away. */
export function applyPickup(ink: InkDescriptor, state: InkState, x: number, y: number, brushRadius = 6): void {
  if (ink.wetness <= 0 || !state.layerSnapshot) return;
  const sampled = sampleSnapshot(state.layerSnapshot, x, y, Math.max(4, brushRadius));
  // Transparent pixels have nothing to pick up — paint with original color
  if (sampled.alpha < 10) {
    state.currentColor = state.originalColor;
    return;
  }
  // Blend from original brush color (not drifted currentColor) so wetness=0.4
  // always means "60% brush + 40% canvas", not exponential decay toward canvas
  const alphaWeight = sampled.alpha / 255;
  state.currentColor = lerpOklab(state.originalColor, sampled.color, ink.wetness * alphaWeight);
}

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
  const overlapDensity = stampDeltaDist > 0.01 ? Math.min(3, spacingPx / stampDeltaDist) : 3;
  return Math.min(1, baseFlow * (1 + ink.buildup * overlapDensity));
}

/** Sample canvas color from snapshot at given document coordinates. Returns "#RRGGBB" and alpha (0-255). */
export function sampleSnapshot(snapshot: ImageData, x: number, y: number): { color: string; alpha: number } {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= snapshot.width || py >= snapshot.height) return { color: '#000000', alpha: 0 };
  const i = (py * snapshot.width + px) * 4;
  const r = snapshot.data[i];
  const g = snapshot.data[i + 1];
  const b = snapshot.data[i + 2];
  const a = snapshot.data[i + 3];
  return { color: `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`, alpha: a };
}

/** Apply color pickup: sets state.currentColor as a blend of the original brush
 *  color and the canvas color at (x, y). Wetness controls the mix ratio — the brush
 *  always retains (1 - wetness) of its original color, never drifting fully away. */
export function applyPickup(ink: InkDescriptor, state: InkState, x: number, y: number): void {
  if (ink.wetness <= 0 || !state.layerSnapshot) return;
  const sampled = sampleSnapshot(state.layerSnapshot, x, y);
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

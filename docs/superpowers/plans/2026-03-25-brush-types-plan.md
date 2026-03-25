# Brush Types & Ink Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a brush type system with 6 tip shapes, orientation modes, ink retention behaviors, and a preset gallery with advanced editor.

**Architecture:** Data-driven brush descriptors (BrushDescriptor) with modular tip generator functions and ink model functions, replacing the flat BrushParams. Presets are static descriptor objects. State flows through Lit context as before.

**Tech Stack:** TypeScript 5 (strict), Lit 3 web components, @lit/context, Canvas 2D API

**Spec:** `docs/superpowers/specs/2026-03-25-brush-types-design.md`

**No test runner** is configured in this project. Verification uses `npx tsc --noEmit` for type checking and `npm run build` for production builds. Visual testing is manual.

---

### Task 1: Add new types to engine/types.ts

**Files:**
- Modify: `src/engine/types.ts`

- [ ] **Step 1: Add TipShape, OrientationMode, TipDescriptor, InkDescriptor, BrushDescriptor, BrushPreset types**

Add after the existing `BrushParams` interface (which stays for now — removed in Task 8):

```typescript
export type TipShape = 'round' | 'flat' | 'chisel' | 'calligraphy' | 'fan' | 'splatter';
export type OrientationMode = 'fixed' | 'direction';

export interface TipDescriptor {
  shape: TipShape;
  aspect: number;
  angle: number;
  orientation: OrientationMode;
  bristles?: number;
  spread?: number;
}

export interface InkDescriptor {
  depletion: number;
  depletionLength: number;
  buildup: number;
  wetness: number;
}

export interface BrushDescriptor {
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureCurve: PressureCurveName;
  tip: TipDescriptor;
  ink: InkDescriptor;
}

export interface BrushPreset {
  id: string;
  name: string;
  category: 'basic' | 'artistic' | 'effects';
  descriptor: BrushDescriptor;
}

export interface InkState {
  distanceTraveled: number;
  remainingPaint: number;
  currentColor: string;
  stampCount: number;
  layerSnapshot: ImageData | null;
  prevRotation: number;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (additive changes only)

- [ ] **Step 3: Commit**

```bash
git add src/engine/types.ts
git commit -m "feat(engine): add BrushDescriptor, TipDescriptor, InkDescriptor types"
```

---

### Task 2: Create tip generators

**Files:**
- Create: `src/engine/tip-generators.ts`
- Modify: `src/engine/brush-tip-cache.ts` (extract round tip logic)

- [ ] **Step 1: Create `src/engine/tip-generators.ts`**

This file contains 6 stateless generator functions and a dispatch map. Each produces an alpha-mask canvas (white on transparent).

Key implementation details:
- `generateRoundTip`: Extract the existing `_render` method body from `BrushTipCache` (lines 36-59 of `brush-tip-cache.ts`). Identical behavior.
- `generateFlatTip`: Rectangle `diameter x ceil(diameter / aspect)`. Use linear gradients on edges for hardness < 1. Hard edges when hardness >= 1.
- `generateChiselTip`: Parallelogram shape — use `ctx.beginPath()` with 4 points forming a sheared rectangle. The shear creates the bevel. Apply edge softness with a slight feathered stroke or gradient fill.
- `generateCalligraphyTip`: Use `ctx.ellipse()` with major = diameter/2, minor = (diameter / aspect) / 2. For hardness < 1, use a radial gradient mapped to the ellipse dimensions.
- `generateFanTip`: Loop `bristles` times, place small circles along an arc of `spread` degrees centered at top. Each bristle is a small round tip (diameter / 6 or so) with the given hardness. Generate `variants` count (3-5) with slightly jittered bristle positions per variant.
- `generateSplatterTip`: Loop `bristles` times, place small circles at seeded-random positions within a radius of diameter/2. `spread` controls scatter ratio. Generate `variants` count (5-8) with different PRNG seeds.

For fan/splatter, the function returns an array variant approach: the cache will store multiple variants keyed with `-v${i}` suffix.

```typescript
import { createOffscreenCanvas, get2dContext, type AnyCanvas } from './canvas-pool.js';
import type { TipDescriptor, TipShape } from './types.js';

export type TipGeneratorFn = (
  diameter: number,
  hardness: number,
  tip: TipDescriptor,
) => AnyCanvas;

export function generateRoundTip(diameter: number, hardness: number, _tip: TipDescriptor): AnyCanvas {
  const size = Math.max(1, diameter);
  const canvas = createOffscreenCanvas(size, size);
  const ctx = get2dContext(canvas);
  const r = size / 2;

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
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

export function generateFlatTip(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.ceil(diameter / Math.max(1, tip.aspect)));
  const canvas = createOffscreenCanvas(w, h);
  const ctx = get2dContext(canvas);

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  } else {
    // Soft edges: gradient falloff on all 4 edges
    // Draw full white rect, then multiply with edge gradients
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    const falloff = Math.max(1, (1 - hardness) * Math.min(w, h) * 0.5);
    ctx.globalCompositeOperation = 'destination-in';

    // Horizontal falloff (left/right)
    const hGrad = ctx.createLinearGradient(0, 0, w, 0);
    hGrad.addColorStop(0, 'rgba(255,255,255,0)');
    hGrad.addColorStop(Math.min(0.5, falloff / w), 'rgba(255,255,255,1)');
    hGrad.addColorStop(Math.max(0.5, 1 - falloff / w), 'rgba(255,255,255,1)');
    hGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hGrad;
    ctx.fillRect(0, 0, w, h);

    // Vertical falloff (top/bottom)
    const vGrad = ctx.createLinearGradient(0, 0, 0, h);
    vGrad.addColorStop(0, 'rgba(255,255,255,0)');
    vGrad.addColorStop(Math.min(0.5, falloff / h), 'rgba(255,255,255,1)');
    vGrad.addColorStop(Math.max(0.5, 1 - falloff / h), 'rgba(255,255,255,1)');
    vGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = vGrad;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'source-over';
  }

  return canvas;
}

export function generateChiselTip(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.ceil(diameter / Math.max(1, tip.aspect)));
  const canvas = createOffscreenCanvas(w, h);
  const ctx = get2dContext(canvas);

  // Parallelogram: shear by h/3
  const shear = h / 3;
  ctx.beginPath();
  ctx.moveTo(shear, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w - shear, h);
  ctx.lineTo(0, h);
  ctx.closePath();

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.fill();
  } else {
    // Fill solid, then apply softness by blurring edges
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Apply radial-style softness from center
    const cx = w / 2, cy = h / 2;
    const maxR = Math.sqrt(cx * cx + cy * cy);
    ctx.globalCompositeOperation = 'destination-in';
    const grad = ctx.createRadialGradient(cx, cy, maxR * hardness, cx, cy, maxR);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  return canvas;
}

export function generateCalligraphyTip(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
  const rx = Math.max(1, diameter / 2);
  const ry = Math.max(1, (diameter / Math.max(1, tip.aspect)) / 2);
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.ceil(ry * 2));
  const canvas = createOffscreenCanvas(w, h);
  const ctx = get2dContext(canvas);
  const cx = w / 2, cy = h / 2;

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Elliptical gradient: scale context to make radial gradient elliptical
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, rx * hardness, 0, 0, rx);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return canvas;
}

/** Seeded PRNG (mulberry32) for deterministic scatter */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFanTip(diameter: number, hardness: number, tip: TipDescriptor, variantIndex = 0): AnyCanvas {
  const bristleCount = tip.bristles ?? 8;
  const spreadDeg = tip.spread ?? 120;
  const spreadRad = (spreadDeg * Math.PI) / 180;
  const radius = diameter / 2;
  const bristleR = Math.max(1, diameter / 8);
  const canvas = createOffscreenCanvas(diameter, diameter);
  const ctx = get2dContext(canvas);
  const cx = diameter / 2, cy = diameter / 2;
  const startAngle = -Math.PI / 2 - spreadRad / 2;
  const rng = seededRandom(42 + variantIndex * 7);

  for (let i = 0; i < bristleCount; i++) {
    const t = bristleCount > 1 ? i / (bristleCount - 1) : 0.5;
    const a = startAngle + spreadRad * t;
    // Jitter position slightly per variant
    const jitterR = radius * 0.08 * (rng() - 0.5);
    const jitterA = 0.05 * (rng() - 0.5);
    const bx = cx + Math.cos(a + jitterA) * (radius - bristleR + jitterR);
    const by = cy + Math.sin(a + jitterA) * (radius - bristleR + jitterR);

    if (hardness >= 1) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bx, by, bristleR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(bx, by, bristleR * hardness, bx, by, bristleR);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, bristleR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
}

export function generateSplatterTip(diameter: number, hardness: number, tip: TipDescriptor, variantIndex = 0): AnyCanvas {
  const dotCount = tip.bristles ?? 12;
  const spreadRatio = tip.spread ?? 0.8;
  const maxRadius = (diameter / 2) * spreadRatio;
  const dotR = Math.max(1, diameter / 10);
  const canvas = createOffscreenCanvas(diameter, diameter);
  const ctx = get2dContext(canvas);
  const cx = diameter / 2, cy = diameter / 2;
  const rng = seededRandom(137 + variantIndex * 13);

  for (let i = 0; i < dotCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = rng() * maxRadius;
    const bx = cx + Math.cos(angle) * dist;
    const by = cy + Math.sin(angle) * dist;
    const r = dotR * (0.5 + rng() * 0.5);

    if (hardness >= 1) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(bx, by, r * hardness, bx, by, r);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
}

export const tipGenerators: Record<TipShape, TipGeneratorFn> = {
  round: generateRoundTip,
  flat: generateFlatTip,
  chisel: generateChiselTip,
  calligraphy: generateCalligraphyTip,
  fan: generateFanTip,
  splatter: generateSplatterTip,
};

/** Number of cached variants per shape (for visual variety) */
export const TIP_VARIANT_COUNTS: Partial<Record<TipShape, number>> = {
  fan: 4,
  splatter: 6,
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/engine/tip-generators.ts
git commit -m "feat(engine): add tip generator functions for 6 brush shapes"
```

---

### Task 3: Create ink model

**Files:**
- Create: `src/engine/ink-model.ts`

- [ ] **Step 1: Create `src/engine/ink-model.ts`**

Contains InkState initialization, depletion, buildup, color pickup, and OKLab color math.

```typescript
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
  // overlapDensity: how many stamps overlap at this point.
  // When stampDeltaDist is small relative to spacing, density is high.
  const overlapDensity = stampDeltaDist > 0.01 ? Math.min(3, spacingPx / stampDeltaDist) : 3;
  return Math.min(1, baseFlow * (1 + ink.buildup * overlapDensity));
}

/** Sample canvas color from snapshot at given document coordinates. Returns "#RRGGBB". */
export function sampleSnapshot(snapshot: ImageData, x: number, y: number): string {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= snapshot.width || py >= snapshot.height) return '#000000';
  const i = (py * snapshot.width + px) * 4;
  const r = snapshot.data[i];
  const g = snapshot.data[i + 1];
  const b = snapshot.data[i + 2];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Apply color pickup: mutates state.currentColor toward the canvas color at (x, y). */
export function applyPickup(ink: InkDescriptor, state: InkState, x: number, y: number): void {
  if (ink.wetness <= 0 || !state.layerSnapshot) return;
  const sampled = sampleSnapshot(state.layerSnapshot, x, y);
  state.currentColor = lerpOklab(state.currentColor, sampled, ink.wetness);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/engine/ink-model.ts
git commit -m "feat(engine): add ink model with depletion, buildup, OKLab color pickup"
```

---

### Task 4: Create brush presets

**Files:**
- Create: `src/engine/brush-presets.ts`

- [ ] **Step 1: Create `src/engine/brush-presets.ts`**

Defines the 9 built-in presets and a helper to get the default descriptor.

```typescript
import type { BrushDescriptor, BrushPreset } from './types.js';

const DEFAULT_TIP = { shape: 'round' as const, aspect: 1, angle: 0, orientation: 'fixed' as const };
const NO_INK = { depletion: 0, depletionLength: 500, buildup: 0, wetness: 0 };

export const BRUSH_PRESETS: BrushPreset[] = [
  {
    id: 'round',
    name: 'Round',
    category: 'basic',
    descriptor: {
      size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 0.15,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: { ...DEFAULT_TIP },
      ink: { ...NO_INK },
    },
  },
  {
    id: 'soft-round',
    name: 'Soft Round',
    category: 'basic',
    descriptor: {
      size: 20, opacity: 1, flow: 0.6, hardness: 0.3, spacing: 0.12,
      pressureSize: true, pressureOpacity: true, pressureCurve: 'light',
      tip: { ...DEFAULT_TIP },
      ink: { ...NO_INK },
    },
  },
  {
    id: 'flat',
    name: 'Flat',
    category: 'artistic',
    descriptor: {
      size: 30, opacity: 1, flow: 0.8, hardness: 0.9, spacing: 0.1,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: { shape: 'flat', aspect: 3, angle: 0, orientation: 'direction' },
      ink: { depletion: 0.3, depletionLength: 800, buildup: 0, wetness: 0 },
    },
  },
  {
    id: 'chisel',
    name: 'Chisel',
    category: 'artistic',
    descriptor: {
      size: 24, opacity: 1, flow: 0.9, hardness: 0.95, spacing: 0.1,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: { shape: 'chisel', aspect: 2.5, angle: 0, orientation: 'direction' },
      ink: { depletion: 0.2, depletionLength: 600, buildup: 0.3, wetness: 0 },
    },
  },
  {
    id: 'calligraphy',
    name: 'Calligraphy',
    category: 'artistic',
    descriptor: {
      size: 20, opacity: 1, flow: 1, hardness: 1, spacing: 0.08,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: { shape: 'calligraphy', aspect: 4, angle: 45, orientation: 'fixed' },
      ink: { ...NO_INK },
    },
  },
  {
    id: 'fan',
    name: 'Fan',
    category: 'artistic',
    descriptor: {
      size: 40, opacity: 1, flow: 0.7, hardness: 0.8, spacing: 0.15,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: { shape: 'fan', aspect: 1, angle: 0, orientation: 'direction', bristles: 8, spread: 120 },
      ink: { depletion: 0.5, depletionLength: 600, buildup: 0, wetness: 0 },
    },
  },
  {
    id: 'splatter',
    name: 'Splatter',
    category: 'effects',
    descriptor: {
      size: 50, opacity: 0.8, flow: 0.6, hardness: 0.7, spacing: 0.25,
      pressureSize: false, pressureOpacity: true, pressureCurve: 'linear',
      tip: { shape: 'splatter', aspect: 1, angle: 0, orientation: 'fixed', bristles: 12, spread: 0.8 },
      ink: { depletion: 0.7, depletionLength: 400, buildup: 0, wetness: 0 },
    },
  },
  {
    id: 'dry-brush',
    name: 'Dry Brush',
    category: 'artistic',
    descriptor: {
      size: 25, opacity: 1, flow: 0.5, hardness: 0.8, spacing: 0.12,
      pressureSize: true, pressureOpacity: true, pressureCurve: 'heavy',
      tip: { ...DEFAULT_TIP },
      ink: { depletion: 0.8, depletionLength: 300, buildup: 0.4, wetness: 0 },
    },
  },
  {
    id: 'wet-brush',
    name: 'Wet Brush',
    category: 'artistic',
    descriptor: {
      size: 20, opacity: 0.8, flow: 0.7, hardness: 0.5, spacing: 0.1,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: { ...DEFAULT_TIP },
      ink: { depletion: 0, depletionLength: 500, buildup: 0.2, wetness: 0.4 },
    },
  },
];

export function getPresetById(id: string): BrushPreset | undefined {
  return BRUSH_PRESETS.find(p => p.id === id);
}

export function getDefaultDescriptor(): BrushDescriptor {
  return { ...BRUSH_PRESETS[0].descriptor, tip: { ...BRUSH_PRESETS[0].descriptor.tip }, ink: { ...BRUSH_PRESETS[0].descriptor.ink } };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/engine/brush-presets.ts
git commit -m "feat(engine): add 9 built-in brush presets"
```

---

### Task 5: Update brush tip cache

**Files:**
- Modify: `src/engine/brush-tip-cache.ts`

- [ ] **Step 1: Update `BrushTipCache.get()` to accept TipDescriptor and delegate to generators**

The cache now builds keys from the full tip descriptor and delegates tip creation to the appropriate generator function from `tip-generators.ts`.

Replace the entire file. Key changes:
- `get(diameter, hardness)` becomes `get(diameter, hardness, tip: TipDescriptor)`
- Cache key: `"${tip.shape}-${diameter}-${hardness.toFixed(2)}-${tip.aspect}"` (plus bristles/spread/variant for fan/splatter)
- The `_render` method is removed — generation delegated to `tipGenerators[tip.shape]`
- For fan/splatter, `getVariant(diameter, hardness, tip, variantIndex)` is added
- A legacy `get(diameter, hardness)` overload stays temporarily for backward compat during migration (uses round defaults)

Full replacement:

```typescript
import { type AnyCanvas } from './canvas-pool.js';
import type { TipDescriptor } from './types.js';
import { tipGenerators, generateFanTip, generateSplatterTip, TIP_VARIANT_COUNTS } from './tip-generators.js';

interface CacheEntry {
  canvas: AnyCanvas;
  key: string;
  lastUsed: number;
}

const MAX_ENTRIES = 128; // Increased — more tip variations now

export class BrushTipCache {
  private _entries = new Map<string, CacheEntry>();
  private _accessCounter = 0;

  private _buildKey(diameter: number, hardness: number, tip: TipDescriptor, variantIndex?: number): string {
    let key = `${tip.shape}-${diameter}-${hardness.toFixed(2)}-${tip.aspect.toFixed(1)}`;
    if (tip.bristles != null) key += `-b${tip.bristles}`;
    if (tip.spread != null) key += `-s${tip.spread}`;
    if (variantIndex != null) key += `-v${variantIndex}`;
    return key;
  }

  /** Get or create an alpha-mask tip for the given parameters. */
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

  /** Get a specific variant for multi-variant tips (fan/splatter). */
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: FAIL — `stamp-stroke.ts` still calls `get(diam, hardness)` with 2 args. This is expected; we fix it in Task 7.

- [ ] **Step 3: Commit (allow type errors temporarily — resolved in Task 7)**

```bash
git add src/engine/brush-tip-cache.ts
git commit -m "feat(engine): update tip cache to accept TipDescriptor, delegate to generators"
```

---

### Task 6: Update stroke buffer pool

**Files:**
- Modify: `src/engine/stroke-buffer-pool.ts`

- [ ] **Step 1: Add `colorMode` parameter to `commit()` and update compositing logic**

When `colorMode` is true (wetness > 0), skip tinting and composite the buffer directly.

Replace the `commit` method:

```typescript
/** Tint and composite the buffer onto the target layer. */
commit(
  target: CanvasRenderingContext2D,
  color: string,
  strokeOpacity: number,
  eraser: boolean,
  docWidth: number,
  docHeight: number,
  colorMode = false,
) {
  if (!this._canvas) return;

  if (eraser) {
    target.save();
    target.globalAlpha = strokeOpacity;
    target.globalCompositeOperation = 'destination-out';
    drawImageSafe(target, this._canvas, 0, 0);
    target.restore();
  } else if (colorMode) {
    // Color mode: buffer already contains tinted RGBA — composite directly
    target.save();
    target.globalAlpha = strokeOpacity;
    target.globalCompositeOperation = 'source-over';
    drawImageSafe(target, this._canvas, 0, 0);
    target.restore();
  } else {
    // Alpha-mask mode: tint then composite
    const ctx = get2dContext(this._canvas);
    tintAlphaMask(ctx, color, docWidth, docHeight);
    target.save();
    target.globalAlpha = strokeOpacity;
    target.globalCompositeOperation = 'source-over';
    drawImageSafe(target, this._canvas, 0, 0);
    target.restore();
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (new parameter has default value, existing callers unaffected)

- [ ] **Step 3: Commit**

```bash
git add src/engine/stroke-buffer-pool.ts
git commit -m "feat(engine): add colorMode branch to stroke buffer commit"
```

---

### Task 7: Rewrite StampStroke engine

**Files:**
- Modify: `src/engine/stamp-stroke.ts`

This is the largest single change. The engine switches from `BrushParams` to `BrushDescriptor`, adds ink state tracking, per-stamp rotation, dual buffer mode, and multi-variant tip cycling.

- [ ] **Step 1: Rewrite `src/engine/stamp-stroke.ts`**

Complete replacement. Key changes from current code:
- `begin()` takes `(descriptor: BrushDescriptor, color: string, eraser: boolean, docWidth, docHeight)` instead of `(params: BrushParams, docWidth, docHeight)`
- Initializes `InkState` with optional layer snapshot
- `stroke()` adds `layerCtx?` parameter for snapshot capture on first call
- Per-stamp loop gains: tip generator dispatch, rotation computation, depletion, buildup, pickup, per-stamp tinting when wet
- `getStrokePreview()` returns `color: null` when in color mode
- `commit()` passes `colorMode` flag to buffer pool
- `computeStampRotation()` with jitter threshold as specified in spec

```typescript
import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { get2dContext, drawImageSafe, tintAlphaMask, createOffscreenCanvas, type AnyCanvas } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushDescriptor, type TipDescriptor, type StampPoint } from './types.js';
import { TIP_VARIANT_COUNTS } from './tip-generators.js';
import { initInkState, applyDepletion, applyBuildup, applyPickup } from './ink-model.js';
import type { InkState } from './types.js';

const MIN_DIRECTION_DIST_SQ = 0.25;

function computeStampRotation(
  stamp: StampPoint,
  prevStamp: StampPoint | null,
  prevRotation: number,
  tip: TipDescriptor,
): number {
  if (tip.orientation === 'fixed') {
    return tip.angle * Math.PI / 180;
  }
  if (!prevStamp) return tip.angle * Math.PI / 180;
  const dx = stamp.x - prevStamp.x;
  const dy = stamp.y - prevStamp.y;
  const distSq = dx * dx + dy * dy;
  if (distSq < MIN_DIRECTION_DIST_SQ) {
    return prevRotation;
  }
  return Math.atan2(dy, dx) + tip.angle * Math.PI / 180;
}

export class StampStrokeEngine {
  private _tipCache = new BrushTipCache();
  private _bufferPool = new StrokeBufferPool();
  private _smoother = new PathSmoother();
  private _descriptor: BrushDescriptor | null = null;
  private _color = '';
  private _eraser = false;
  private _colorMode = false;
  private _docWidth = 0;
  private _docHeight = 0;
  private _lastMappedPressure = 0.5;
  private _inkState: InkState | null = null;
  private _prevStamp: StampPoint | null = null;
  private _variantCounter = 0;
  private _snapshotCaptured = false;

  begin(descriptor: BrushDescriptor, color: string, eraser: boolean, docWidth: number, docHeight: number) {
    this._descriptor = descriptor;
    this._color = eraser ? '' : (color.length === 9 ? color.slice(0, 7) : color);
    this._eraser = eraser;
    this._colorMode = !eraser && descriptor.ink.wetness > 0;
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    this._bufferPool.acquire(docWidth, docHeight);
    this._smoother.reset();
    this._prevStamp = null;
    this._variantCounter = 0;
    this._snapshotCaptured = false;
    // InkState initialized without snapshot — snapshot captured on first stroke() call if wet
    this._inkState = initInkState(this._color, null);
  }

  stroke(x: number, y: number, pressure: number, layerCtx?: CanvasRenderingContext2D) {
    if (!this._descriptor || !this._inkState) return;
    const d = this._descriptor;

    // Capture layer snapshot on first stroke call if wet (deferred from begin to avoid
    // requiring layerCtx in begin)
    if (this._colorMode && !this._snapshotCaptured && layerCtx) {
      this._inkState.layerSnapshot = layerCtx.getImageData(0, 0, this._docWidth, this._docHeight);
      this._snapshotCaptured = true;
    }

    const curveFn = PRESSURE_CURVES[d.pressureCurve];
    const mappedPressure = curveFn(pressure);
    this._lastMappedPressure = mappedPressure;

    const effectiveSize = d.pressureSize ? Math.max(1, d.size * mappedPressure) : d.size;
    const effectiveSpacing = Math.max(1, d.spacing * effectiveSize);
    const stamps = this._smoother.addPoint(x, y, mappedPressure, effectiveSpacing);

    this._stampPoints(stamps, effectiveSpacing);
  }

  private _stampPoints(stamps: StampPoint[], spacingPx: number) {
    if (!this._descriptor || !this._inkState) return;
    const d = this._descriptor;
    const ink = d.ink;
    const state = this._inkState;

    const buf = this._bufferPool.current;
    if (!buf) return;
    const ctx = get2dContext(buf);

    const variantCount = TIP_VARIANT_COUNTS[d.tip.shape] ?? 0;

    for (const stamp of stamps) {
      // Distance from previous stamp (for ink state)
      let stampDist = 0;
      if (this._prevStamp) {
        const dx = stamp.x - this._prevStamp.x;
        const dy = stamp.y - this._prevStamp.y;
        stampDist = Math.sqrt(dx * dx + dy * dy);
        state.distanceTraveled += stampDist;
      }
      state.stampCount++;

      // Depletion
      const depletionMult = applyDepletion(ink, state);
      if (depletionMult <= 0) {
        this._prevStamp = stamp;
        continue; // brush is dry, skip stamp
      }

      // Buildup
      const baseFlow = d.pressureOpacity ? d.flow * stamp.pressure : d.flow;
      const effectiveFlow = applyBuildup(ink, baseFlow, spacingPx, stampDist);

      // Color pickup
      applyPickup(ink, state, stamp.x, stamp.y);

      // Stamp size
      const stampSize = d.pressureSize ? Math.max(1, d.size * stamp.pressure) : d.size;
      const diam = quantizeDiameter(stampSize);

      // Get tip (with variant cycling for fan/splatter)
      let tip: AnyCanvas;
      if (variantCount > 0) {
        const vi = this._variantCounter % variantCount;
        tip = this._tipCache.getVariant(diam, d.hardness, d.tip, vi);
        this._variantCounter++;
      } else {
        tip = this._tipCache.get(diam, d.hardness, d.tip);
      }

      // Rotation
      const rotation = computeStampRotation(stamp, this._prevStamp, state.prevRotation, d.tip);
      state.prevRotation = rotation;

      // Compute stamp alpha
      const stampAlpha = Math.min(1, effectiveFlow * depletionMult);

      const tipW = (tip as HTMLCanvasElement).width ?? diam;
      const tipH = (tip as HTMLCanvasElement).height ?? diam;

      if (this._colorMode) {
        // Color mode: tint per stamp, draw RGBA into buffer
        // Create a temp tinted copy of the tip
        const tinted = createOffscreenCanvas(tipW, tipH);
        const tCtx = get2dContext(tinted);
        drawImageSafe(tCtx, tip, 0, 0);
        tintAlphaMask(tCtx, state.currentColor, tipW, tipH);

        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(Math.round(stamp.x), Math.round(stamp.y));
          ctx.rotate(rotation);
          drawImageSafe(ctx, tinted, -tipW / 2, -tipH / 2, tipW, tipH);
          ctx.restore();
        } else {
          drawImageSafe(ctx, tinted, Math.round(stamp.x - tipW / 2), Math.round(stamp.y - tipH / 2), tipW, tipH);
        }
      } else {
        // Alpha-mask mode: draw tip as alpha into buffer (tinted at commit)
        ctx.globalAlpha = stampAlpha;
        ctx.globalCompositeOperation = 'source-over';
        if (rotation !== 0) {
          ctx.save();
          ctx.translate(Math.round(stamp.x), Math.round(stamp.y));
          ctx.rotate(rotation);
          drawImageSafe(ctx, tip, -tipW / 2, -tipH / 2, tipW, tipH);
          ctx.restore();
        } else {
          drawImageSafe(ctx, tip, Math.round(stamp.x - tipW / 2), Math.round(stamp.y - tipH / 2), tipW, tipH);
        }
      }

      this._prevStamp = stamp;
    }
    ctx.globalAlpha = 1;
  }

  commit(target: CanvasRenderingContext2D) {
    if (!this._descriptor) return;

    // Flush remaining path
    const lastSize = this._descriptor.pressureSize
      ? Math.max(1, this._descriptor.size * this._lastMappedPressure)
      : this._descriptor.size;
    const flushSpacing = Math.max(1, this._descriptor.spacing * lastSize);
    const remaining = this._smoother.flush(flushSpacing);
    if (remaining.length > 0) {
      this._stampPoints(remaining, flushSpacing);
    }

    this._bufferPool.commit(
      target,
      this._color,
      this._descriptor.opacity,
      this._eraser,
      this._docWidth,
      this._docHeight,
      this._colorMode,
    );
    this._descriptor = null;
    this._inkState = null;
  }

  cancel() {
    this._descriptor = null;
    this._inkState = null;
    this._smoother.reset();
  }

  getStrokePreview(): { canvas: AnyCanvas; eraser: boolean; opacity: number; color: string | null } | null {
    if (!this._descriptor || !this._bufferPool.current) return null;
    return {
      canvas: this._bufferPool.current,
      eraser: this._eraser,
      opacity: this._descriptor.opacity,
      color: this._colorMode ? null : this._color,
    };
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: FAIL — `drawing-canvas.ts` still calls `begin(BrushParams, ...)` and `getStrokePreview()` expects `color: string`. Fixed in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/engine/stamp-stroke.ts
git commit -m "feat(engine): rewrite StampStroke for BrushDescriptor, ink state, rotation, dual buffer"
```

---

### Task 8: Migrate DrawingState and context

**Files:**
- Modify: `src/types.ts`
- Modify: `src/contexts/drawing-context.ts`
- Modify: `src/engine/types.ts` (remove `BrushParams`)

This task updates the state shape. After this task, the type checker will fail until Tasks 9-10 update the consumers.

- [ ] **Step 1: Update `src/types.ts`**

Import `BrushDescriptor` and replace individual brush fields in `DrawingState`:

```typescript
// Add import at top:
import type { BlendMode, PressureCurveName, BrushDescriptor } from './engine/types.js';

// In DrawingState, replace these fields:
//   brushSize, opacity, flow, hardness, spacing,
//   pressureSize, pressureOpacity, pressureCurve
// With:
//   brush: BrushDescriptor;
//   activePreset: string;
//   isPresetModified: boolean;
```

The full updated `DrawingState`:

```typescript
export interface DrawingState {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brush: BrushDescriptor;
  activePreset: string;
  isPresetModified: boolean;
  stampImage: HTMLImageElement | null;
  layers: Layer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
  documentWidth: number;
  documentHeight: number;
  cropAspectRatio: string;
  fontFamily: string;
  fontSize: number;
  fontBold: boolean;
  fontItalic: boolean;
  eyedropperSampleAll: boolean;
}
```

Note: `brushSize` is replaced by `brush.size`, `opacity` by `brush.opacity`, etc.

- [ ] **Step 2: Update `src/contexts/drawing-context.ts`**

Replace individual brush setters with a unified `setBrush` and preset-related methods:

```typescript
// Remove: setBrushSize, setOpacity, setFlow, setHardness, setSpacing,
//         setPressureSize, setPressureOpacity, setPressureCurve
// Add:
setBrush: (brush: Partial<BrushDescriptor>) => void;
setBrushTip: (tip: Partial<TipDescriptor>) => void;
setBrushInk: (ink: Partial<InkDescriptor>) => void;
selectPreset: (presetId: string) => void;
```

Import `BrushDescriptor`, `TipDescriptor`, `InkDescriptor` from engine types.

Keep `setBrushSize` as a convenience alias that calls `setBrush({ size })` — shapes/tools reference it.

- [ ] **Step 3: Remove `BrushParams` from `src/engine/types.ts`**

Delete the `BrushParams` interface (lines 3-14). All consumers now use `BrushDescriptor`.

- [ ] **Step 4: Commit (build will fail until Tasks 9-10)**

```bash
git add src/types.ts src/contexts/drawing-context.ts src/engine/types.ts
git commit -m "refactor: migrate DrawingState from flat brush fields to BrushDescriptor"
```

---

### Task 9: Update drawing-app.ts (state provider)

**Files:**
- Modify: `src/components/drawing-app.ts`

- [ ] **Step 1: Update state initialization**

In the constructor (~line 159), replace the flat brush fields with:

```typescript
brush: getDefaultDescriptor(),
activePreset: 'round',
isPresetModified: false,
```

Import `getDefaultDescriptor` from `../engine/brush-presets.js` and `BrushDescriptor`, `TipDescriptor`, `InkDescriptor` from `../engine/types.js`.

- [ ] **Step 2: Update `_buildContextValue` setters**

Replace the individual setters (`setOpacity`, `setFlow`, `setHardness`, `setSpacing`, `setPressureSize`, `setPressureOpacity`, `setPressureCurve`, and `setBrushSize`) with:

```typescript
setBrushSize: (size: number) => {
  const safe = Number.isFinite(size) ? size : 4;
  this._updateBrush({ size: Math.max(1, Math.min(200, safe)) });
},
setBrush: (partial: Partial<BrushDescriptor>) => {
  this._updateBrush(partial);
},
setBrushTip: (partial: Partial<TipDescriptor>) => {
  const tip = { ...this._state.brush.tip, ...partial };
  this._updateBrush({ tip });
},
setBrushInk: (partial: Partial<InkDescriptor>) => {
  const ink = { ...this._state.brush.ink, ...partial };
  this._updateBrush({ ink });
},
selectPreset: (presetId: string) => {
  const preset = getPresetById(presetId);
  if (!preset) return;
  this._state = {
    ...this._state,
    brush: { ...preset.descriptor, tip: { ...preset.descriptor.tip }, ink: { ...preset.descriptor.ink } },
    activePreset: presetId,
    isPresetModified: false,
  };
  this._markDirty();
},
```

Add a private helper:

```typescript
private _updateBrush(partial: Partial<BrushDescriptor>) {
  this._state = {
    ...this._state,
    brush: { ...this._state.brush, ...partial },
    isPresetModified: true,
  };
  this._markDirty();
}
```

- [ ] **Step 3: Update snapshot/persistence for tool settings**

In the save snapshot (~line 309), update to use `this._state.brush.*` fields. Map them to the existing persistence format for backward compat:

```typescript
const snapshotToolSettings = {
  activeTool: this._state.activeTool,
  strokeColor: this._state.strokeColor,
  fillColor: this._state.fillColor,
  useFill: this._state.useFill,
  brushSize: this._state.brush.size,
  opacity: this._state.brush.opacity,
  flow: this._state.brush.flow,
  hardness: this._state.brush.hardness,
  spacing: this._state.brush.spacing,
  pressureSize: this._state.brush.pressureSize,
  pressureOpacity: this._state.brush.pressureOpacity,
  pressureCurve: this._state.brush.pressureCurve,
  eyedropperSampleAll: this._state.eyedropperSampleAll,
};
```

- [ ] **Step 4: Update project restore**

When restoring from a saved project (~line 770-791), map the flat fields back into `brush`:

```typescript
brush: {
  ...getDefaultDescriptor(),
  size: record.toolSettings.brushSize ?? 4,
  opacity: record.toolSettings.opacity ?? 1,
  flow: record.toolSettings.flow ?? 1,
  hardness: record.toolSettings.hardness ?? 1,
  spacing: record.toolSettings.spacing ?? 0.15,
  pressureSize: record.toolSettings.pressureSize ?? true,
  pressureOpacity: record.toolSettings.pressureOpacity ?? false,
  pressureCurve: record.toolSettings.pressureCurve ?? 'linear',
},
activePreset: 'round',
isPresetModified: false,
```

- [ ] **Step 5: Update keyboard shortcuts for brush size/hardness**

The `[` / `]` and `{` / `}` shortcuts (~line 651-668) now reference `this._state.brush.size` and `this._state.brush.hardness`:

```typescript
const current = this._state.brush.size;
// ... same logic but update via:
this._updateBrush({ size: newSize });
```

- [ ] **Step 6: Update `_buildContextValue` to remove stale `state.opacity` references**

Any code in drawing-app.ts that reads `this._state.opacity`, `this._state.flow`, `this._state.hardness`, `this._state.spacing`, `this._state.brushSize`, `this._state.pressureSize`, `this._state.pressureOpacity`, `this._state.pressureCurve` must be updated to read from `this._state.brush.*`.

- [ ] **Step 7: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "refactor(app): update drawing-app state to use BrushDescriptor"
```

---

### Task 10: Update drawing-canvas.ts

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Update `_buildBrushParams` → use `BrushDescriptor` directly**

Replace the `_buildBrushParams()` method (~line 169-183). The engine now takes `BrushDescriptor` + `color` + `eraser` separately:

```typescript
private get _brushDescriptor(): BrushDescriptor {
  return this.ctx.state.brush;
}
```

- [ ] **Step 2: Update `_onPointerDown` brush engine call**

At ~line 1470-1473, change:

```typescript
// Old:
const params = this._buildBrushParams();
this._engine.begin(params, this._docWidth, this._docHeight);
this._engine.stroke(p.x, p.y, e.pressure || 0.5);

// New:
const desc = this._brushDescriptor;
const color = this.ctx.state.strokeColor;
const eraser = this.ctx.state.activeTool === 'eraser';
this._engine.begin(desc, color, eraser, this._docWidth, this._docHeight);
const layerCtx = desc.ink.wetness > 0 ? this._getActiveLayerCtx() ?? undefined : undefined;
this._engine.stroke(p.x, p.y, e.pressure || 0.5, layerCtx);
```

- [ ] **Step 3: Update `_onPointerMove` stroke call**

At ~line 1579-1582, change to pass `layerCtx` when wet:

```typescript
const desc = this._brushDescriptor;
const layerCtx = desc.ink.wetness > 0 ? this._getActiveLayerCtx() ?? undefined : undefined;
this._engine.stroke(p.x, p.y, e.pressure || 0.5, layerCtx);
```

- [ ] **Step 4: Update `composite()` preview handling**

At ~line 231-269, update for the new `getStrokePreview()` return type where `color` can be `null`:

```typescript
const preview = this._engine.getStrokePreview();
if (preview) {
  // ... setup tintPreviewCanvas as before ...

  if (preview.eraser) {
    // Eraser path unchanged
    tintCtx.globalAlpha = preview.opacity;
    tintCtx.globalCompositeOperation = 'destination-out';
    tintCtx.drawImage(preview.canvas as HTMLCanvasElement, 0, 0);
  } else if (preview.color === null) {
    // Color mode (wet brush): buffer already RGBA, composite directly
    tintCtx.globalAlpha = preview.opacity;
    tintCtx.globalCompositeOperation = 'source-over';
    tintCtx.drawImage(preview.canvas as HTMLCanvasElement, 0, 0);
  } else {
    // Alpha-mask mode: tint then composite (existing code)
    // ... existing strokeTintCanvas logic ...
    strokeCtx.drawImage(preview.canvas as HTMLCanvasElement, 0, 0);
    tintAlphaMask(strokeCtx, preview.color, w, h);
    tintCtx.globalAlpha = preview.opacity;
    tintCtx.globalCompositeOperation = 'source-over';
    tintCtx.drawImage(this._strokeTintCanvas!, 0, 0);
  }
}
```

- [ ] **Step 5: Update imports**

Remove `import type { BrushParams } from '../engine/types.js';` and add `import type { BrushDescriptor } from '../engine/types.js';` if needed. Also update any remaining references to `state.brushSize` (e.g., in shape preview at ~line 1603) to `state.brush.size`.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: FAIL on `tool-settings.ts` (still reads old state fields). Fixed in Task 11.

- [ ] **Step 7: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "refactor(canvas): update drawing-canvas for BrushDescriptor engine API"
```

---

### Task 11: Update tool-settings.ts — preset gallery + advanced editor

**Files:**
- Modify: `src/components/tool-settings.ts`

This is the UI task. The tool-settings panel gains a preset gallery at top and a collapsible advanced section.

- [ ] **Step 1: Update all state.brushSize / state.opacity / etc. reads**

All references to flat brush state fields must read from `state.brush.*`:
- `state.brushSize` → `state.brush.size`
- `state.opacity` → `state.brush.opacity`
- `state.flow` → `state.brush.flow`
- `state.hardness` → `state.brush.hardness`
- `state.spacing` → `state.brush.spacing`
- `state.pressureSize` → `state.brush.pressureSize`
- `state.pressureOpacity` → `state.brush.pressureOpacity`
- `state.pressureCurve` → `state.brush.pressureCurve`

All setter calls update accordingly:
- `ctx.setBrushSize(v)` stays (convenience alias)
- `ctx.setOpacity(v)` → `ctx.setBrush({ opacity: v })`
- `ctx.setFlow(v)` → `ctx.setBrush({ flow: v })`
- `ctx.setHardness(v)` → `ctx.setBrush({ hardness: v })`
- `ctx.setSpacing(v)` → `ctx.setBrush({ spacing: v })`
- `ctx.setPressureSize(v)` → `ctx.setBrush({ pressureSize: v })`
- `ctx.setPressureOpacity(v)` → `ctx.setBrush({ pressureOpacity: v })`
- `ctx.setPressureCurve(v)` → `ctx.setBrush({ pressureCurve: v })`

- [ ] **Step 2: Add preset gallery rendering**

Add a new private method `_renderPresetGallery()` that renders the 5-column grid of preset buttons. Each button is a 42x42 div with a canvas thumbnail. Import `BRUSH_PRESETS` from `../engine/brush-presets.js`.

Add `@state() private _advancedOpen = false;` for the advanced section toggle.

Render the gallery at the top of the pencil/eraser tool section, before the existing sliders.

- [ ] **Step 3: Add advanced section rendering**

Add `_renderAdvancedSection()` that renders:
- **Tip Shape** subsection: pill buttons for each `TipShape`, aspect ratio slider (dimmed for round), angle/offset slider, orientation toggle, bristle count slider (fan/splatter only), spread slider (fan/splatter only)
- **Ink Behavior** subsection: depletion slider, depletion length slider (hidden when depletion=0), buildup slider, wetness slider

All tip controls call `ctx.setBrushTip({ ... })`. All ink controls call `ctx.setBrushInk({ ... })`.

Wrap in a collapsible container toggled by `this._advancedOpen`.

- [ ] **Step 4: Add CSS for preset gallery and advanced section**

Add styles for:
- `.preset-grid` — 5-column grid, gap 6px
- `.preset-btn` — 42x42 with border, rounded corners, cursor pointer
- `.preset-btn.active` — blue border
- `.preset-btn.modified` — subtle dot indicator
- `.advanced-toggle` — clickable header with arrow
- `.advanced-content` — collapsible body
- `.tip-pills` — flex wrap row of pill buttons
- `.tip-pill` / `.tip-pill.active` — pill button styles
- Conditional dimming via `.dimmed` class

- [ ] **Step 5: Add preset thumbnail rendering**

Add a method that draws a mini stroke preview or tip shape onto each preset button's canvas element. This can be done in `firstUpdated()` or via a reactive update. Use the tip generator to render a small version of each preset's tip shape.

- [ ] **Step 6: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/tool-settings.ts
git commit -m "feat(ui): add preset gallery and advanced brush editor"
```

---

### Task 12: Final verification and cleanup

**Files:**
- Possibly: `src/components/app-toolbar.ts`, `src/components/tool-icons.ts` (minor updates if needed)

- [ ] **Step 1: Full type-check and production build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS with zero errors

- [ ] **Step 2: Dev server smoke test**

Run: `npm run dev`

Manual testing checklist:
1. App loads without console errors
2. Default "Round" preset selected, draws identically to before
3. Click each preset — parameters populate, drawing behavior changes
4. Flat brush follows stroke direction
5. Calligraphy nib produces thick/thin strokes based on angle
6. Fan and splatter produce multi-dot patterns without visible repetition
7. Dry Brush fades out along the stroke
8. Wet Brush picks up canvas color when painting over existing strokes
9. Advanced section expands/collapses
10. Changing any parameter shows "modified" on preset
11. Re-clicking preset resets to defaults
12. Pressure sensitivity works with all presets
13. Eraser still works with all tip shapes
14. Undo/redo works correctly after brush type strokes
15. Layer compositing and export are unaffected

- [ ] **Step 3: Fix any issues found during testing**

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: brush types and ink retention system"
```

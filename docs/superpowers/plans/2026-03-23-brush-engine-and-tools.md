# Brush Engine, Blending Modes, Eyedropper & Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the line-segment brush with a stamp-based engine (pressure, smoothing, hardness), add layer blend modes, an eyedropper tool, and brush size/hardness keyboard shortcuts.

**Architecture:** New `src/engine/` module houses the brush engine (tip cache, stroke buffer, path smoother, stamp loop). Blending modes add a `blendMode` field to layers and update composite loops. Eyedropper is a new tool with Alt-hold modifier and GPU-accelerated preview. Shortcuts wire into the existing `_onKeyDown` handler.

**Tech Stack:** Lit 3, TypeScript 5 (strict, experimental decorators), Canvas2D, OffscreenCanvas (with fallback), @lit/context

**Spec:** `docs/superpowers/specs/2026-03-23-brush-engine-and-tools-design.md`

---

## File Map

### New files

| File | Responsibility |
|---|---|
| `src/engine/types.ts` | `BrushParams`, `PressureCurve`, `StampPoint`, `BlendMode` types |
| `src/engine/brush-tip-cache.ts` | Alpha-mask tip generation + LRU cache |
| `src/engine/stroke-buffer-pool.ts` | Pooled OffscreenCanvas (with fallback) for stroke accumulation |
| `src/engine/path-smoother.ts` | Catmull-Rom spline interpolation + pressure lerp |
| `src/engine/stamp-stroke.ts` | Stamp loop, pressure curves, commit/tint with eraser branch |
| `src/engine/canvas-pool.ts` | `createCanvas()` helper — OffscreenCanvas with `createElement('canvas')` fallback |

### Modified files

| File | Changes |
|---|---|
| `src/types.ts` | Add `'eyedropper'` to `ToolType`, `blendMode` to `Layer`/`LayerSnapshot`, brush params to `DrawingState`, `'blend-mode'` to `HistoryEntry` |
| `src/storage/types.ts` | Brush params + `eyedropperSampleAll` in `ToolSettings`, `blendMode` in `SerializedLayer`/`SerializedLayerSnapshot`, `'blend-mode'` in `SerializedHistoryEntry` |
| `src/contexts/drawing-context.ts` | Add `setOpacity`, `setFlow`, `setHardness`, `setSpacing`, `setPressureSize`, `setPressureOpacity`, `setPressureCurve`, `setLayerBlendMode`, `setEyedropperSampleAll` to `DrawingContextValue` |
| `src/components/drawing-app.ts` | Wire new context methods, brush shortcuts in `_onKeyDown`, blend mode in `_compositeLayers`, `setLayerBlendMode` with history |
| `src/components/drawing-canvas.ts` | Replace `_drawBrushAt` with stamp engine, eyedropper sampling/preview, `_renderPreview()` dispatcher, `_renderBrushCursor()`, `_clientToDoc()`, blend mode in `composite()`/`saveCanvas()`, Alt-hold logic, `pointerenter`/`pointerleave` |
| `src/components/tool-settings.ts` | Brush engine sliders (opacity, flow, hardness, spacing), pressure toggles, pressure curve selector, eyedropper checkbox |
| `src/components/tool-icons.ts` | Eyedropper icon, label, shortcut |
| `src/components/app-toolbar.ts` | Add eyedropper to utility tool group |
| `src/components/layers-panel.ts` | Blend mode dropdown for active layer |

---

## Task 1: Canvas Pool Helper + Engine Types

**Files:**
- Create: `src/engine/canvas-pool.ts`
- Create: `src/engine/types.ts`

- [ ] **Step 1: Create `src/engine/canvas-pool.ts`**

```ts
/**
 * Creates an offscreen canvas, preferring OffscreenCanvas when available.
 * Falls back to document.createElement('canvas') for older browsers.
 */
export function createOffscreenCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Get a 2D context from either canvas type. */
export function get2dContext(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  return canvas.getContext('2d', options)! as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}
```

- [ ] **Step 2: Create `src/engine/types.ts`**

```ts
export type PressureCurveName = 'linear' | 'light' | 'heavy';

export interface BrushParams {
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureCurve: PressureCurveName;
  color: string;
  eraser: boolean;
}

export interface StampPoint {
  x: number;
  y: number;
  pressure: number;
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'soft-light';

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  'normal': 'Normal',
  'multiply': 'Multiply',
  'screen': 'Screen',
  'overlay': 'Overlay',
  'darken': 'Darken',
  'lighten': 'Lighten',
  'soft-light': 'Soft Light',
};

export function blendModeToCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  if (mode === 'normal') return 'source-over';
  return mode as GlobalCompositeOperation;
}

export const PRESSURE_CURVES: Record<PressureCurveName, (p: number) => number> = {
  linear: (p) => p,
  light: (p) => Math.pow(p, 0.5),
  heavy: (p) => Math.pow(p, 2.0),
};

/** Quantize diameter to nearest even pixel for cache stability under pressure variation. */
export function quantizeDiameter(d: number): number {
  return Math.max(2, Math.round(d / 2) * 2);
}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/engine/canvas-pool.ts src/engine/types.ts
git commit -m "feat(engine): add canvas pool helper and brush engine types"
```

---

## Task 2: Brush Tip Cache

**Files:**
- Create: `src/engine/brush-tip-cache.ts`

- [ ] **Step 1: Create `src/engine/brush-tip-cache.ts`**

```ts
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
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/engine/brush-tip-cache.ts
git commit -m "feat(engine): add alpha-mask brush tip cache with LRU eviction"
```

---

## Task 3: Stroke Buffer Pool

**Files:**
- Create: `src/engine/stroke-buffer-pool.ts`

- [ ] **Step 1: Create `src/engine/stroke-buffer-pool.ts`**

```ts
import { createOffscreenCanvas, get2dContext } from './canvas-pool.js';

type BufferCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Singleton pool managing one reusable stroke buffer canvas.
 * Never shrinks — only grows when the document exceeds the current size.
 * Zero allocation during painting.
 */
export class StrokeBufferPool {
  private _canvas: BufferCanvas | null = null;
  private _width = 0;
  private _height = 0;

  /** Acquire the buffer for a new stroke. Resizes if needed, then clears. */
  acquire(docWidth: number, docHeight: number): BufferCanvas {
    if (!this._canvas || docWidth > this._width || docHeight > this._height) {
      this._width = Math.max(this._width, docWidth);
      this._height = Math.max(this._height, docHeight);
      this._canvas = createOffscreenCanvas(this._width, this._height);
    }
    const ctx = get2dContext(this._canvas);
    ctx.clearRect(0, 0, this._width, this._height);
    return this._canvas;
  }

  /** Tint the accumulated alpha mask with the given color, then composite onto the target layer. */
  commit(
    target: CanvasRenderingContext2D,
    color: string,
    strokeOpacity: number,
    eraser: boolean,
    docWidth: number,
    docHeight: number,
  ) {
    if (!this._canvas) return;
    const ctx = get2dContext(this._canvas);

    if (!eraser) {
      // Tint: fill with color using source-in to multiply color × accumulated alpha
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, docWidth, docHeight);
      ctx.globalCompositeOperation = 'source-over';

      // Composite onto layer
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'source-over';
      target.drawImage(this._canvas as any, 0, 0);
      target.restore();
    } else {
      // Eraser: composite the alpha mask with destination-out
      target.save();
      target.globalAlpha = strokeOpacity;
      target.globalCompositeOperation = 'destination-out';
      target.drawImage(this._canvas as any, 0, 0);
      target.restore();
    }
  }

  /** Get the current buffer canvas (for stamping onto during a stroke). */
  get current(): BufferCanvas | null {
    return this._canvas;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/engine/stroke-buffer-pool.ts
git commit -m "feat(engine): add stroke buffer pool with tint/eraser commit paths"
```

---

## Task 4: Path Smoother (Catmull-Rom)

**Files:**
- Create: `src/engine/path-smoother.ts`

- [ ] **Step 1: Create `src/engine/path-smoother.ts`**

```ts
import type { StampPoint } from './types.js';

interface RawPoint {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Catmull-Rom spline interpolator for pointer events.
 * Subdivides curves by arc-length spacing, never by timestamp.
 * Lerps pressure between bracketing raw samples.
 */
export class PathSmoother {
  private _points: RawPoint[] = [];
  private _remainder = 0; // leftover distance from last subdivision

  reset() {
    this._points = [];
    this._remainder = 0;
  }

  /**
   * Feed a new raw pointer sample. Returns stamp positions along the
   * smoothed path spaced at `spacing` pixel intervals.
   */
  addPoint(x: number, y: number, pressure: number, spacing: number): StampPoint[] {
    this._points.push({ x, y, pressure });
    const n = this._points.length;

    // Single point (stroke start dot)
    if (n === 1) {
      // Set remainder to spacing so _walkLinear won't re-emit at this position
      this._remainder = spacing;
      return [{ x, y, pressure }];
    }

    // Fewer than 4 points: linear interpolation between last two
    if (n < 4) {
      const from = this._points[n - 2];
      const to = this._points[n - 1];
      return this._walkLinear(from, to, spacing);
    }

    // 4+ points: Catmull-Rom between P1 and P2 using P0 and P3 as control
    const p0 = this._points[n - 4];
    const p1 = this._points[n - 3];
    const p2 = this._points[n - 2];
    const p3 = this._points[n - 1];
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  /** Flush: emit stamps for any remaining segment at stroke end. */
  flush(spacing: number): StampPoint[] {
    const n = this._points.length;
    if (n < 2) return [];

    // Emit remaining segment from second-to-last to last point
    if (n < 4) {
      const from = this._points[n - 2];
      const to = this._points[n - 1];
      return this._walkLinear(from, to, spacing);
    }

    // For 4+ points, the last Catmull-Rom segment is P[-3]→P[-2] with
    // P[-4] and P[-1] as control points. But we already emitted that in
    // addPoint. We need the segment P[-2]→P[-1]:
    const p0 = this._points[n - 3];
    const p1 = this._points[n - 2];
    const p2 = this._points[n - 1];
    // Mirror p2 past p1 for the final control point
    const p3 = { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y), pressure: p2.pressure };
    return this._walkCatmullRom(p0, p1, p2, p3, spacing);
  }

  private _walkLinear(from: RawPoint, to: RawPoint, spacing: number): StampPoint[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.001) return [];

    const stamps: StampPoint[] = [];
    let d = this._remainder;

    while (d <= dist) {
      const t = d / dist;
      stamps.push({
        x: from.x + dx * t,
        y: from.y + dy * t,
        pressure: from.pressure + (to.pressure - from.pressure) * t,
      });
      d += spacing;
    }

    this._remainder = d - dist;
    return stamps;
  }

  private _walkCatmullRom(p0: RawPoint, p1: RawPoint, p2: RawPoint, p3: RawPoint, spacing: number): StampPoint[] {
    // Estimate total arc length with 20 subdivisions
    const SUBDIV = 20;
    let totalLen = 0;
    let prevX = p1.x;
    let prevY = p1.y;
    const lengths: number[] = [0];

    for (let i = 1; i <= SUBDIV; i++) {
      const t = i / SUBDIV;
      const cx = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const cy = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      const segLen = Math.sqrt((cx - prevX) ** 2 + (cy - prevY) ** 2);
      totalLen += segLen;
      lengths.push(totalLen);
      prevX = cx;
      prevY = cy;
    }

    if (totalLen < 0.001) return [];

    const stamps: StampPoint[] = [];
    let d = this._remainder;

    while (d <= totalLen) {
      // Find the subdivision segment containing distance d
      let segIdx = 0;
      for (let i = 1; i < lengths.length; i++) {
        if (lengths[i] >= d) { segIdx = i - 1; break; }
      }

      // Interpolate t within this subdivision segment
      const segStart = lengths[segIdx];
      const segEnd = lengths[segIdx + 1];
      const segFrac = segEnd > segStart ? (d - segStart) / (segEnd - segStart) : 0;
      const t = (segIdx + segFrac) / SUBDIV;

      stamps.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
        pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
      });
      d += spacing;
    }

    this._remainder = d - totalLen;
    return stamps;
  }
}

/** Catmull-Rom spline interpolation for a single axis. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/engine/path-smoother.ts
git commit -m "feat(engine): add Catmull-Rom path smoother with arc-length spacing"
```

---

## Task 5: Stamp Stroke Orchestrator

**Files:**
- Create: `src/engine/stamp-stroke.ts`

- [ ] **Step 1: Create `src/engine/stamp-stroke.ts`**

```ts
import { BrushTipCache } from './brush-tip-cache.js';
import { StrokeBufferPool } from './stroke-buffer-pool.js';
import { PathSmoother } from './path-smoother.js';
import { get2dContext } from './canvas-pool.js';
import { PRESSURE_CURVES, quantizeDiameter, type BrushParams, type PressureCurveName } from './types.js';

/** Singleton brush engine — create once, reuse across strokes. */
export class StampStrokeEngine {
  private _tipCache = new BrushTipCache();
  private _bufferPool = new StrokeBufferPool();
  private _smoother = new PathSmoother();
  private _params: BrushParams | null = null;
  private _docWidth = 0;
  private _docHeight = 0;

  /** Begin a new stroke. Acquires the buffer and resets the smoother. */
  begin(params: BrushParams, docWidth: number, docHeight: number) {
    this._params = { ...params };
    // Force stroke color to fully opaque for the source-in tint step
    if (!params.eraser && this._params.color.length === 9) {
      // Strip #RRGGBBAA → #RRGGBB
      this._params.color = this._params.color.slice(0, 7);
    }
    this._docWidth = docWidth;
    this._docHeight = docHeight;
    this._bufferPool.acquire(docWidth, docHeight);
    this._smoother.reset();
  }

  /** Feed a pointer event. Stamps onto the buffer. */
  stroke(x: number, y: number, pressure: number) {
    if (!this._params) return;
    const p = this._params;
    const curveFn = PRESSURE_CURVES[p.pressureCurve];
    const mappedPressure = curveFn(pressure);

    const effectiveSpacing = Math.max(1, p.spacing * p.size);
    const stamps = this._smoother.addPoint(x, y, mappedPressure, effectiveSpacing);

    const buf = this._bufferPool.current;
    if (!buf) return;
    const ctx = get2dContext(buf);

    for (const stamp of stamps) {
      const effectiveSize = p.pressureSize
        ? Math.max(1, p.size * stamp.pressure)
        : p.size;
      const effectiveOpacity = p.pressureOpacity
        ? p.flow * stamp.pressure
        : p.flow;

      const diam = quantizeDiameter(effectiveSize);
      const tip = this._tipCache.get(diam, p.hardness);

      ctx.globalAlpha = effectiveOpacity;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(
        tip as any,
        Math.round(stamp.x - diam / 2),
        Math.round(stamp.y - diam / 2),
        diam,
        diam,
      );
    }
    ctx.globalAlpha = 1;
  }

  /** Commit the stroke to the target layer context. */
  commit(target: CanvasRenderingContext2D) {
    if (!this._params) return;

    // Flush any remaining path segment
    const effectiveSpacing = Math.max(1, this._params.spacing * this._params.size);
    const remaining = this._smoother.flush(effectiveSpacing);
    if (remaining.length > 0) {
      // Stamp remaining points — pressure is already curve-mapped from stroke(),
      // so use stamp.pressure directly (do NOT re-apply the curve)
      const buf = this._bufferPool.current;
      if (buf) {
        const ctx = get2dContext(buf);
        const p = this._params;
        for (const stamp of remaining) {
          const effectiveSize = p.pressureSize ? Math.max(1, p.size * stamp.pressure) : p.size;
          const effectiveOpacity = p.pressureOpacity ? p.flow * stamp.pressure : p.flow;
          const diam = quantizeDiameter(effectiveSize);
          const tip = this._tipCache.get(diam, p.hardness);
          ctx.globalAlpha = effectiveOpacity;
          ctx.drawImage(tip as any, Math.round(stamp.x - diam / 2), Math.round(stamp.y - diam / 2), diam, diam);
        }
        ctx.globalAlpha = 1;
      }
    }

    this._bufferPool.commit(
      target,
      this._params.color,
      this._params.opacity,
      this._params.eraser,
      this._docWidth,
      this._docHeight,
    );
    this._params = null;
  }

  /** Abort a stroke without committing. */
  cancel() {
    this._params = null;
    this._smoother.reset();
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/engine/stamp-stroke.ts
git commit -m "feat(engine): add stamp stroke orchestrator with pressure curves"
```

---

## Task 6: Update Types and State for Brush Params + Blend Modes

**Files:**
- Modify: `src/types.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/contexts/drawing-context.ts`

- [ ] **Step 1: Update `src/types.ts`**

Add `'eyedropper'` to `ToolType` union (after `'crop'`):

```ts
  | 'eyedropper';
```

Add `blendMode` to `Layer` interface (after `opacity`):

```ts
  blendMode: BlendMode;
```

Add `blendMode` to `LayerSnapshot` interface (after `opacity`):

```ts
  blendMode: BlendMode;
```

Add brush params and eyedropper setting to `DrawingState` (after `fontItalic`):

```ts
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureCurve: PressureCurveName;
  eyedropperSampleAll: boolean;
```

Add `'blend-mode'` variant to `HistoryEntry` (before the closing semicolon):

```ts
  | { type: 'blend-mode'; layerId: string; before: BlendMode; after: BlendMode }
```

Add import at top of file:

```ts
import type { BlendMode } from './engine/types.js';
import type { PressureCurveName } from './engine/types.js';
```

- [ ] **Step 2: Update `src/storage/types.ts`**

Add brush params to `ToolSettings` (after `brushSize`):

```ts
  opacity?: number;
  flow?: number;
  hardness?: number;
  spacing?: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  pressureCurve?: PressureCurveName;
  eyedropperSampleAll?: boolean;
```

(Optional fields for backwards compat with old saves.)

Add `blendMode?: string` to `SerializedLayer` (after `opacity`).

Add `blendMode?: string` to `SerializedLayerSnapshot` (after `opacity`).

Add `'blend-mode'` variant to `SerializedHistoryEntry`:

```ts
  | { type: 'blend-mode'; layerId: string; before: string; after: string }
```

Add import:

```ts
import type { PressureCurveName } from '../engine/types.js';
```

- [ ] **Step 3: Update `src/contexts/drawing-context.ts`**

Add to `DrawingContextValue` interface (after `setFontItalic`):

```ts
  setOpacity: (v: number) => void;
  setFlow: (v: number) => void;
  setHardness: (v: number) => void;
  setSpacing: (v: number) => void;
  setPressureSize: (v: boolean) => void;
  setPressureOpacity: (v: boolean) => void;
  setPressureCurve: (v: PressureCurveName) => void;
  setLayerBlendMode: (id: string, mode: BlendMode) => void;
  setEyedropperSampleAll: (v: boolean) => void;
```

Add imports:

```ts
import type { BlendMode } from '../engine/types.js';
import type { PressureCurveName } from '../engine/types.js';
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: Type errors in `drawing-app.ts` (missing implementations of new context methods) — this is expected and fixed in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/storage/types.ts src/contexts/drawing-context.ts
git commit -m "feat(types): add brush params, blend mode, and eyedropper to types"
```

---

## Task 7: Wire State + Context in drawing-app.ts

**Files:**
- Modify: `src/components/drawing-app.ts`

- [ ] **Step 1: Update `_resetToFreshProject` defaults**

In `_resetToFreshProject()` (around line 636), add the new DrawingState fields to the initial state:

```ts
  opacity: 1,
  flow: 1,
  hardness: 1,
  spacing: 0.25,
  pressureSize: true,
  pressureOpacity: false,
  pressureCurve: 'linear' as const,
  eyedropperSampleAll: true,
```

- [ ] **Step 2: Add `blendMode: 'normal' as BlendMode` to `_createLayer`**

Find `_createLayer` method — wherever it creates a `Layer` object, add `blendMode: 'normal'`.

- [ ] **Step 2b: Add `blendMode` to ALL Layer construction sites**

Adding `blendMode: BlendMode` as a required field on `Layer` will cause compile errors everywhere a `Layer` literal is constructed. Update ALL of these sites:

1. `_createLayer` — already covered in Step 2
2. `_onLayerUndo` handler, `'restore-layer'` case (around line 1142-1148) — add `blendMode: snap.blendMode ?? 'normal'` when constructing the Layer from a LayerSnapshot
3. `_onLayerUndo` handler, `'stack-replace'` case (around line 1196-1202) — add `blendMode: snap.blendMode ?? 'normal'` when constructing Layer objects from LayerSnapshot array
4. `_onLayerUndo` handler, `'crop-restore'` case (around line 1182) — the existing spread `{ ...layer, canvas, ... }` will preserve `blendMode` IF the layer already has it. But when restoring from a snapshot, use `blendMode: snap.blendMode ?? layer.blendMode ?? 'normal'`
5. Layer deserialization in the project load path — add `blendMode: (savedLayer.blendMode as BlendMode) ?? 'normal'`
6. `mergeLayerDown` (around line 890) — the spread `{ ...l, canvas: mergedCanvas, opacity: 1 }` will carry the old `blendMode`. Add `blendMode: 'normal' as BlendMode` to reset it. A merged layer contains baked-in composite results; keeping the old blend mode would apply it a second time.
7. `mergeVisibleLayers` — same treatment as #6
8. `flattenImage` `flatLayer` literal (around line 955) — add `blendMode: 'normal' as BlendMode`
9. Any other site found by `npx tsc --noEmit` after Task 6

Run `npx tsc --noEmit` after this step and fix any remaining Layer construction errors before proceeding.

- [ ] **Step 3: Update `_compositeLayers` to accept background + blend modes**

Replace the `_compositeLayers` method (line 200-213):

```ts
  private _compositeLayers(layers: Layer[], background: string | null = '#ffffff'): HTMLCanvasElement {
    const w = this._state.documentWidth;
    const h = this._state.documentHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    for (const layer of layers) {
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    return canvas;
  }
```

Add import: `import { blendModeToCompositeOp } from '../engine/types.js';`

- [ ] **Step 4: Add `setLayerBlendMode` with history to the context value**

In the context value builder (where `setLayerOpacity`, `renameLayer`, etc. are), add:

```ts
  setLayerBlendMode: (id: string, mode: BlendMode) => {
    const layer = this._state.layers.find(l => l.id === id);
    if (!layer || layer.blendMode === mode) return;
    const before = layer.blendMode;
    const newLayers = this._state.layers.map(l =>
      l.id === id ? { ...l, blendMode: mode } : l
    );
    this._state = { ...this._state, layers: newLayers };
    this.canvas?.pushLayerOperation({ type: 'blend-mode', layerId: id, before, after: mode });
    this._markDirty();
  },
```

- [ ] **Step 5: Add setters for brush params**

In the context value builder, add:

```ts
  setOpacity: (v: number) => { this._state = { ...this._state, opacity: Math.max(0, Math.min(1, v)) }; },
  setFlow: (v: number) => { this._state = { ...this._state, flow: Math.max(0, Math.min(1, v)) }; },
  setHardness: (v: number) => { this._state = { ...this._state, hardness: Math.round(Math.max(0, Math.min(1, v)) * 10) / 10 }; },
  setSpacing: (v: number) => { this._state = { ...this._state, spacing: Math.max(0.05, Math.min(1, v)) }; },
  setPressureSize: (v: boolean) => { this._state = { ...this._state, pressureSize: v }; },
  setPressureOpacity: (v: boolean) => { this._state = { ...this._state, pressureOpacity: v }; },
  setPressureCurve: (v: PressureCurveName) => { this._state = { ...this._state, pressureCurve: v }; },
  setEyedropperSampleAll: (v: boolean) => { this._state = { ...this._state, eyedropperSampleAll: v }; },
```

- [ ] **Step 6: Add brush shortcuts to `_onKeyDown`**

Insert before the existing tool shortcut block (before line 624's `} else if (!ctrl && !e.altKey && !e.shiftKey && key.length === 1)`):

```ts
    } else if (!ctrl && !e.altKey && (key === '[' || key === ']')) {
      e.preventDefault();
      const current = this._state.brushSize;
      const maxSize = 200;
      const minSize = 1;
      if (key === ']') {
        const newSize = Math.min(maxSize, Math.max(current + 1, Math.round(current * 1.1)));
        this._state = { ...this._state, brushSize: newSize };
      } else {
        const newSize = Math.max(minSize, Math.min(current - 1, Math.round(current / 1.1)));
        this._state = { ...this._state, brushSize: newSize };
      }
    } else if (!ctrl && !e.altKey && (e.key === '{' || e.key === '}')) {
      e.preventDefault();
      const current = this._state.hardness;
      if (e.key === '}') {
        this._state = { ...this._state, hardness: Math.round(Math.min(1, current + 0.1) * 10) / 10 };
      } else {
        this._state = { ...this._state, hardness: Math.round(Math.max(0, current - 0.1) * 10) / 10 };
      }
```

- [ ] **Step 7: Handle `'blend-mode'` undo/redo in the layer-undo event handler**

Find where `'visibility'`, `'opacity'`, `'rename'` cases are handled in the `layer-undo` / `layer-redo` custom event listener. Add:

```ts
  case 'blend-mode': {
    const newLayers = this._state.layers.map(l =>
      l.id === entry.layerId ? { ...l, blendMode: entry.before as BlendMode } : l
    );
    this._state = { ...this._state, layers: newLayers };
    break;
  }
```

And the corresponding redo case with `entry.after`.

- [ ] **Step 8: Update save/load to persist new fields**

In the save path (where `ToolSettings` is built), add the new fields:

```ts
  opacity: this._state.opacity,
  flow: this._state.flow,
  hardness: this._state.hardness,
  spacing: this._state.spacing,
  pressureSize: this._state.pressureSize,
  pressureOpacity: this._state.pressureOpacity,
  pressureCurve: this._state.pressureCurve,
  eyedropperSampleAll: this._state.eyedropperSampleAll,
```

In the load path, read them with defaults:

```ts
  opacity: saved.toolSettings.opacity ?? 1,
  flow: saved.toolSettings.flow ?? 1,
  hardness: saved.toolSettings.hardness ?? 1,
  spacing: saved.toolSettings.spacing ?? 0.25,
  pressureSize: saved.toolSettings.pressureSize ?? true,
  pressureOpacity: saved.toolSettings.pressureOpacity ?? false,
  pressureCurve: saved.toolSettings.pressureCurve ?? 'linear',
  eyedropperSampleAll: saved.toolSettings.eyedropperSampleAll ?? true,
```

In layer serialization/deserialization, add `blendMode` with default `'normal'`.

In `_snapshotAllLayers`, include `blendMode`.

- [ ] **Step 9: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: Errors in `drawing-canvas.ts` (not yet updated) — expected.

- [ ] **Step 10: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat(app): wire brush params, blend mode state, and keyboard shortcuts"
```

---

## Task 8: Integrate Stamp Engine into drawing-canvas.ts

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Add engine import and instance**

At the top of `drawing-canvas.ts`, add:

```ts
import { StampStrokeEngine } from '../engine/stamp-stroke.js';
import { blendModeToCompositeOp } from '../engine/types.js';
import type { BrushParams } from '../engine/types.js';
```

Add a private field in the class:

```ts
  private _engine = new StampStrokeEngine();
```

- [ ] **Step 2: Replace brush tool pointer-down logic**

In `_onPointerDown` (around line 1093-1101), replace:

```ts
    this._drawing = true;
    this._lastPoint = p;
    this._startPoint = p;

    // For brushes, capture before draw and draw a dot at start
    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
      this._captureBeforeDraw();
      this._drawBrushAt(p, p);
    }
```

With:

```ts
    this._drawing = true;
    this._lastPoint = p;
    this._startPoint = p;

    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
      this._captureBeforeDraw();
      const params = this._buildBrushParams();
      this._engine.begin(params, this._docWidth, this._docHeight);
      this._engine.stroke(p.x, p.y, (e as PointerEvent).pressure || 0.5);
      this.composite();
    }
```

Add helper method:

```ts
  private _buildBrushParams(): BrushParams {
    const s = this.ctx.state;
    return {
      size: s.brushSize,
      opacity: s.opacity,
      flow: s.flow,
      hardness: s.hardness,
      spacing: s.spacing,
      pressureSize: s.pressureSize,
      pressureOpacity: s.pressureOpacity,
      pressureCurve: s.pressureCurve,
      color: s.strokeColor,
      eraser: s.activeTool === 'eraser',
    };
  }
```

- [ ] **Step 3: Replace brush tool pointer-move logic**

In `_onPointerMove` (around line 1177-1179), replace:

```ts
      this._drawBrushAt(this._lastPoint, p);
      this._lastPoint = p;
```

With:

```ts
      this._engine.stroke(p.x, p.y, (e as PointerEvent).pressure || 0.5);
      this._lastPoint = p;
      this.composite();
```

- [ ] **Step 4: Replace brush tool pointer-up logic**

In `_onPointerUp`, after the brush/shape `_drawing` check completes (around line 1319-1323), the engine must commit before pushing history. Replace the brush commit section:

In the block where `activeTool` is `pencil`/`marker`/`eraser` and `_drawing` is true, before `this._pushDrawHistory()`, add:

```ts
    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        this._engine.commit(layerCtx);
      }
    }
```

- [ ] **Step 5: Update `composite()` to apply blend modes + show in-progress stroke**

In the `composite()` method (around line 188-214), in the layer loop, add blend mode support AND display the in-progress stroke buffer:

```ts
    // Check if any visible layer uses a non-normal blend mode
    const hasBlend = layers.some(l => l.visible && l.blendMode !== 'normal');
```

Then in the per-layer draw:

```ts
      if (hasBlend) {
        displayCtx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
      }
      displayCtx.drawImage(layer.canvas, 0, 0);

      // Show in-progress stroke buffer on the active layer during painting.
      // The engine draws to a temp buffer, so without this the stroke is
      // invisible until pointer-up commit.
      if (this._drawing && layer.id === activeLayerId && this._engine) {
        const strokeBuf = this._engine.getStrokePreview();
        if (strokeBuf) {
          // For paint tools: tint a temp copy and overlay at stroke opacity
          // For eraser: overlay the alpha mask with destination-out
          displayCtx.save();
          displayCtx.globalCompositeOperation = 'source-over';
          displayCtx.drawImage(strokeBuf.canvas as any, 0, 0);
          displayCtx.restore();
        }
      }

      // Float rendering (existing code)...
      if (hasBlend) {
        displayCtx.globalCompositeOperation = 'source-over';
      }
      displayCtx.globalAlpha = 1.0;
```

This requires a new method on `StampStrokeEngine` — see step 5b.

Also, at the end of `composite()`, after the `composited` event dispatch, add:

```ts
    this.invalidateSamplingBuffer();
```

This ensures the eyedropper sampling buffer is rebuilt on the next sample after any visual change.

- [ ] **Step 5b: Add `getStrokePreview()` to StampStrokeEngine**

In `src/engine/stamp-stroke.ts`, add a method that returns a tinted preview of the in-progress stroke for display during painting:

```ts
  /** Get a tinted preview of the in-progress stroke for display compositing. */
  getStrokePreview(): { canvas: HTMLCanvasElement | OffscreenCanvas; eraser: boolean; opacity: number } | null {
    if (!this._params || !this._bufferPool.current) return null;
    // Return the raw buffer + metadata so composite() can display it.
    // For paint tools: the caller tints and overlays at stroke opacity.
    // For eraser: the caller overlays with destination-out.
    return {
      canvas: this._bufferPool.current,
      eraser: this._params.eraser,
      opacity: this._params.opacity,
    };
  }
```

Then update the `composite()` in-progress stroke rendering (Step 5) to use this properly:

```ts
      if (this._drawing && layer.id === activeLayerId && this._engine) {
        const preview = this._engine.getStrokePreview();
        if (preview) {
          displayCtx.save();
          if (preview.eraser) {
            displayCtx.globalAlpha = preview.opacity;
            displayCtx.globalCompositeOperation = 'destination-out';
            displayCtx.drawImage(preview.canvas as any, 0, 0);
          } else {
            // Tint a temporary copy for display (do not mutate the stroke buffer)
            const tintCanvas = document.createElement('canvas');
            tintCanvas.width = this._docWidth;
            tintCanvas.height = this._docHeight;
            const tintCtx = tintCanvas.getContext('2d')!;
            tintCtx.drawImage(preview.canvas as any, 0, 0);
            tintCtx.globalCompositeOperation = 'source-in';
            tintCtx.fillStyle = this.ctx.state.strokeColor;
            tintCtx.fillRect(0, 0, this._docWidth, this._docHeight);
            displayCtx.globalAlpha = preview.opacity;
            displayCtx.drawImage(tintCanvas, 0, 0);
          }
          displayCtx.restore();
        }
      }
```

**Performance note:** The tint canvas allocation on every composite during painting is expensive. Optimize by caching a single tint canvas (same pattern as stroke buffer — reuse, never shrink). Add a `_tintPreviewCanvas` field to drawing-canvas that persists between frames.

- [ ] **Step 6: Update `saveCanvas()` to apply blend modes**

In `saveCanvas()` (around line 738-774), in the layer loop, add:

```ts
      exportCtx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
```

Before `exportCtx.drawImage(layer.canvas, 0, 0)`. Reset to `'source-over'` after each layer.

Also add white background fill at the start:

```ts
    exportCtx.fillStyle = '#ffffff';
    exportCtx.fillRect(0, 0, this._docWidth, this._docHeight);
```

- [ ] **Step 6b: Wire engine to orphaned stroke handler and pointer cancel**

In `_onPointerUp`, the orphaned stroke handler (around line 1242-1250) finalizes strokes when the tool switches mid-draw. Add engine commit before `_pushDrawHistory`:

```ts
    if (this._drawing && activeTool !== 'pencil' && activeTool !== 'marker' &&
        activeTool !== 'eraser' && ...) {
      // Commit the engine's stroke buffer before pushing history
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) this._engine.commit(layerCtx);
      this._drawing = false;
      // ... existing code
    }
```

In `_cancelCurrentTool` (around line 1358), add:

```ts
    this._engine.cancel();
```

This ensures a pointer cancel (e.g., two-finger gesture interrupting a stroke) properly discards the engine state without committing garbage.

- [ ] **Step 7: Remove old `_drawBrushAt` method and tool imports**

Delete the `_drawBrushAt` method (around line 1486-1503). Remove imports of `drawPencilSegment`, `drawMarkerSegment`, `drawEraserSegment` from the top of the file. The old tool files (`src/tools/pencil.ts`, `src/tools/marker.ts`, `src/tools/eraser.ts`) can remain for now (other code may reference them) but are no longer called from drawing-canvas.

- [ ] **Step 8: Add `_clientToDoc` helper**

Add near `_getDocPoint` (around line 779):

```ts
  /** Convert raw client coordinates to document space (no PointerEvent needed). */
  private _clientToDoc(clientX: number, clientY: number): Point {
    const rect = this.mainCanvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this._panX) / this._zoom,
      y: (clientY - rect.top - this._panY) / this._zoom,
    };
  }
```

- [ ] **Step 9: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors (or only errors related to Tasks 9-11 features not yet added)

- [ ] **Step 10: Verify dev server**

Run: `cd /Users/egecan/Code/ketchup && npm run dev` and test drawing with pencil, marker, eraser in browser.

- [ ] **Step 11: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(canvas): integrate stamp engine, blend modes in composite/export"
```

---

## Task 9: Eyedropper Tool Registration + Sampling

**Files:**
- Modify: `src/components/tool-icons.ts`
- Modify: `src/components/app-toolbar.ts`
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Add eyedropper to `tool-icons.ts`**

Add to `toolIcons` (after `crop`):

```ts
  eyedropper: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m2 22 1-1h3l9-9"/>
      <path d="M3 21v-3l9-9"/>
      <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9"/>
      <path d="m15 6 3 3"/>
    </svg>`,
```

Add to `toolShortcuts`: `eyedropper: 'I',`

Add to `toolLabels`: `eyedropper: 'Eyedropper',`

- [ ] **Step 2: Add eyedropper to toolbar**

In `app-toolbar.ts` (line 13), add `'eyedropper'` to the utility group:

```ts
  ['fill', 'stamp', 'text', 'eyedropper'],
```

- [ ] **Step 3: Add eyedropper sampling to `drawing-canvas.ts`**

Add a private method for color sampling:

```ts
  // Cached sampling buffer for composite eyedropper sampling.
  // Rebuilt only when _samplingDirty is true (set on composite/layer changes).
  private _samplingBuffer: HTMLCanvasElement | null = null;
  private _samplingDirty = true;

  /** Mark the sampling buffer as dirty (call from composite() and layer changes). */
  public invalidateSamplingBuffer() { this._samplingDirty = true; }

  private _ensureSamplingBuffer(): CanvasRenderingContext2D {
    if (!this._samplingBuffer || this._samplingBuffer.width !== this._docWidth || this._samplingBuffer.height !== this._docHeight) {
      this._samplingBuffer = document.createElement('canvas');
      this._samplingBuffer.width = this._docWidth;
      this._samplingBuffer.height = this._docHeight;
      this._samplingDirty = true;
    }
    const ctx = this._samplingBuffer.getContext('2d', { willReadFrequently: true })!;
    if (this._samplingDirty) {
      ctx.clearRect(0, 0, this._docWidth, this._docHeight);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this._docWidth, this._docHeight);
      const layers = this._ctx.value?.state.layers ?? [];
      for (const layer of layers) {
        if (!layer.visible) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
        ctx.drawImage(layer.canvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
      this._samplingDirty = false;
    }
    return ctx;
  }

  /** Sample a color from the canvas at document coordinates. */
  private _sampleColor(docX: number, docY: number): string | null {
    const x = Math.round(docX);
    const y = Math.round(docY);
    if (x < 0 || y < 0 || x >= this._docWidth || y >= this._docHeight) return null;

    const sampleAll = this.ctx.state.eyedropperSampleAll;

    if (sampleAll) {
      const ctx = this._ensureSamplingBuffer();
      const data = ctx.getImageData(x, y, 1, 1).data;
      return `#${data[0].toString(16).padStart(2, '0')}${data[1].toString(16).padStart(2, '0')}${data[2].toString(16).padStart(2, '0')}`;
    } else {
      // Sample from active layer only
      const layerCtx = this._getActiveLayerCtx();
      if (!layerCtx) return null;
      const data = layerCtx.getImageData(x, y, 1, 1).data;
      if (data[3] === 0) return null; // Ignore fully transparent
      if (data[3] < 255) {
        // Composite against white
        const a = data[3] / 255;
        const r = Math.round(data[0] * a + 255 * (1 - a));
        const g = Math.round(data[1] * a + 255 * (1 - a));
        const b = Math.round(data[2] * a + 255 * (1 - a));
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      }
      return `#${data[0].toString(16).padStart(2, '0')}${data[1].toString(16).padStart(2, '0')}${data[2].toString(16).padStart(2, '0')}`;
    }
  }
```

- [ ] **Step 4: Wire eyedropper into `_onPointerDown`**

Add before the invisible layer check (around line 991):

```ts
    if (activeTool === 'eyedropper') {
      const p = this._getDocPoint(e);
      const color = this._sampleColor(p.x, p.y);
      if (color) this.ctx.setStrokeColor(color);
      return;
    }
```

- [ ] **Step 5: Add Alt-hold modifier logic**

In `_onPointerDown`, right after the `e.button !== 0` check (line 974), add:

```ts
    // Alt-hold eyedropper modifier for brush tools
    if (e.altKey && (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser')) {
      const p = this._getDocPoint(e);
      const color = this._sampleColor(p.x, p.y);
      if (color) this.ctx.setStrokeColor(color);
      return;
    }
```

Add a `_altSampling` flag for pointer-move preview:

```ts
  private _altSampling = false;
```

Set it in the Alt-hold block above: `this._altSampling = true;`

In `_onPointerMove`, add early checks for both dedicated eyedropper tool AND Alt-hold:

```ts
    // Dedicated eyedropper tool — show preview on hover
    if (activeTool === 'eyedropper') {
      this._renderEyedropperPreview(e);
      return;
    }

    // Alt-hold eyedropper modifier for brush tools
    if (this._altSampling || (e.altKey && (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser'))) {
      this._altSampling = e.altKey;
      if (!e.altKey) {
        // Alt released — clear preview
        this._clearEyedropperPreview();
        return;
      }
      this._renderEyedropperPreview(e);
      return;
    }
```

- [ ] **Step 6: Add blur listener for sticky key prevention**

In `connectedCallback`, add:

```ts
    window.addEventListener('blur', this._onWindowBlur);
```

In `disconnectedCallback`, add:

```ts
    window.removeEventListener('blur', this._onWindowBlur);
```

Add method:

```ts
  private _onWindowBlur = () => {
    this._altSampling = false;
    this._clearEyedropperPreview();
  };
```

- [ ] **Step 7: Verify build**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add src/components/tool-icons.ts src/components/app-toolbar.ts src/components/drawing-canvas.ts
git commit -m "feat(eyedropper): add tool with sampling, alt-hold modifier, blur guard"
```

---

## Task 10: Eyedropper Zoomed Preview

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Add eyedropper preview rendering**

```ts
  private _renderEyedropperPreview(e: PointerEvent) {
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);

    const docPoint = this._getDocPoint(e);
    const color = this._sampleColor(docPoint.x, docPoint.y);

    // Determine source canvas for the visual grid
    const sampleAll = this.ctx.state.eyedropperSampleAll;
    const sourceCanvas = sampleAll ? this.mainCanvas : (this._getActiveLayerCtx()?.canvas ?? this.mainCanvas);

    // Position the preview box with edge collision handling
    const GRID_SIZE = 88;
    const SWATCH_HEIGHT = 24;
    const TOTAL_HEIGHT = GRID_SIZE + SWATCH_HEIGHT + 4;
    const OFFSET = 20;

    let destX = e.clientX - this.mainCanvas.getBoundingClientRect().left + OFFSET;
    let destY = e.clientY - this.mainCanvas.getBoundingClientRect().top - OFFSET - TOTAL_HEIGHT;

    if (destX + GRID_SIZE > this._vw) destX = destX - GRID_SIZE - 2 * OFFSET;
    if (destY < 0) destY = destY + TOTAL_HEIGHT + 2 * OFFSET;

    // Draw magnified 11x11 pixel grid using GPU-accelerated drawImage
    previewCtx.save();
    previewCtx.imageSmoothingEnabled = false;

    if (sampleAll) {
      // Source is the display canvas — use viewport coordinates directly
      const srcX = e.clientX - this.mainCanvas.getBoundingClientRect().left;
      const srcY = e.clientY - this.mainCanvas.getBoundingClientRect().top;
      previewCtx.drawImage(this.mainCanvas, srcX - 5, srcY - 5, 11, 11, destX, destY, GRID_SIZE, GRID_SIZE);
    } else {
      // Source is the active layer — use document coordinates
      const srcX = Math.round(docPoint.x);
      const srcY = Math.round(docPoint.y);
      previewCtx.drawImage(sourceCanvas, srcX - 5, srcY - 5, 11, 11, destX, destY, GRID_SIZE, GRID_SIZE);
    }

    previewCtx.restore();

    // Draw grid lines
    previewCtx.strokeStyle = 'rgba(255,255,255,0.3)';
    previewCtx.lineWidth = 0.5;
    const cellSize = GRID_SIZE / 11;
    for (let i = 0; i <= 11; i++) {
      const x = destX + i * cellSize;
      const y = destY + i * cellSize;
      previewCtx.beginPath();
      previewCtx.moveTo(x, destY);
      previewCtx.lineTo(x, destY + GRID_SIZE);
      previewCtx.stroke();
      previewCtx.beginPath();
      previewCtx.moveTo(destX, y);
      previewCtx.lineTo(destX + GRID_SIZE, y);
      previewCtx.stroke();
    }

    // Draw center crosshair
    const cx = destX + 5 * cellSize;
    const cy = destY + 5 * cellSize;
    previewCtx.strokeStyle = '#fff';
    previewCtx.lineWidth = 1.5;
    previewCtx.strokeRect(cx, cy, cellSize, cellSize);

    // Draw border
    previewCtx.strokeStyle = '#555';
    previewCtx.lineWidth = 1;
    previewCtx.strokeRect(destX - 0.5, destY - 0.5, GRID_SIZE + 1, TOTAL_HEIGHT + 1);

    // Draw color swatch and hex label
    if (color) {
      previewCtx.fillStyle = color;
      previewCtx.fillRect(destX, destY + GRID_SIZE + 2, SWATCH_HEIGHT, SWATCH_HEIGHT);
      previewCtx.fillStyle = '#fff';
      previewCtx.font = '11px monospace';
      previewCtx.fillText(color.toUpperCase(), destX + SWATCH_HEIGHT + 6, destY + GRID_SIZE + 16);
    }
  }

  private _clearEyedropperPreview() {
    const previewCtx = this.previewCanvas?.getContext('2d');
    if (previewCtx) previewCtx.clearRect(0, 0, this._vw, this._vh);
  }
```

- [ ] **Step 2: Verify build and test**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Test in browser: select eyedropper tool, move over canvas — zoomed preview should appear.

- [ ] **Step 3: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(eyedropper): add GPU-accelerated zoomed pixel grid preview"
```

---

## Task 11: Brush Cursor Overlay + Preview Dispatcher

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Add `_renderBrushCursor` method**

```ts
  private _lastPointerScreenX = 0;
  private _lastPointerScreenY = 0;
  private _pointerOnCanvas = false;

  private _renderBrushCursor() {
    if (!this._pointerOnCanvas) return;
    if (this._altSampling) return;
    const { activeTool, brushSize, hardness } = this.ctx.state;
    if (activeTool !== 'pencil' && activeTool !== 'marker' && activeTool !== 'eraser') return;

    const previewCtx = this.previewCanvas.getContext('2d')!;
    // Don't clear — the dispatcher clears before calling

    const cx = this._lastPointerScreenX;
    const cy = this._lastPointerScreenY;
    const outerRadius = (brushSize / 2) * this._zoom;

    // Outer ring: 1px black + 1px white (inverted outline)
    previewCtx.beginPath();
    previewCtx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    previewCtx.strokeStyle = 'rgba(0,0,0,0.7)';
    previewCtx.lineWidth = 1.5;
    previewCtx.stroke();
    previewCtx.beginPath();
    previewCtx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    previewCtx.strokeStyle = 'rgba(255,255,255,0.7)';
    previewCtx.lineWidth = 0.75;
    previewCtx.stroke();

    // Inner dashed ring for hardness
    if (hardness < 1) {
      const innerRadius = outerRadius * hardness;
      previewCtx.beginPath();
      previewCtx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
      previewCtx.setLineDash([3, 3]);
      previewCtx.strokeStyle = 'rgba(255,255,255,0.5)';
      previewCtx.lineWidth = 0.75;
      previewCtx.stroke();
      previewCtx.setLineDash([]);
    }
  }
```

- [ ] **Step 2: Add `_renderPreview` dispatcher**

```ts
  private _renderPreview() {
    const previewCtx = this.previewCanvas?.getContext('2d');
    if (!previewCtx) return;

    const { activeTool } = this.ctx.state;

    // Don't clear if other tools have active previews they manage themselves
    // (shapes clear in their own pointermove, selection has its own anim loop)
    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser' || activeTool === 'eyedropper') {
      previewCtx.clearRect(0, 0, this._vw, this._vh);

      if (this._altSampling || activeTool === 'eyedropper') {
        // Eyedropper preview handled in _renderEyedropperPreview via pointermove
        return;
      }

      if (!this._drawing) {
        this._renderBrushCursor();
      }
    }
  }
```

- [ ] **Step 3: Wire pointer enter/leave for brush cursor**

Update `_onPointerLeave` to track pointer presence:

In the existing `_onPointerLeave` method, add before the early returns:

```ts
    this._pointerOnCanvas = false;
    this._renderPreview();
```

Add a `pointerenter` handler:

```ts
  private _onPointerEnter = (e: PointerEvent) => {
    this._pointerOnCanvas = true;
    const rect = this.mainCanvas.getBoundingClientRect();
    this._lastPointerScreenX = e.clientX - rect.left;
    this._lastPointerScreenY = e.clientY - rect.top;
    this._renderPreview();
  };
```

Register it in `firstUpdated` or `connectedCallback` alongside the existing event listeners.

- [ ] **Step 4: Update pointermove to track screen position and render cursor**

In `_onPointerMove`, early in the method, add:

```ts
    const rect = this.mainCanvas.getBoundingClientRect();
    this._lastPointerScreenX = e.clientX - rect.left;
    this._lastPointerScreenY = e.clientY - rect.top;
```

At the end of `_onPointerMove`, after all tool-specific handling, if no early return was taken and a brush tool is active and we're not drawing:

```ts
    // Render brush cursor when hovering (not drawing)
    if (!this._drawing && (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser')) {
      this._renderPreview();
    }
```

- [ ] **Step 5: Trigger cursor redraw on context changes**

In `willUpdate()` or the context subscription callback, call `this._renderPreview()` so brush size/hardness/zoom changes update the cursor without pointer movement.

- [ ] **Step 6: Verify build and test**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Test in browser: hover over canvas with pencil tool — dual-ring cursor should appear. Press `[`/`]` — cursor should resize. Press `{`/`}` — inner ring should change.

- [ ] **Step 7: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(canvas): add brush cursor overlay with dual-ring hardness preview"
```

---

## Task 12: Tool Settings UI — Brush Engine Controls

**Files:**
- Modify: `src/components/tool-settings.ts`

- [ ] **Step 1: Add brush engine controls to the render method**

In the `render()` method, find where the brush size slider is rendered for pencil/marker/eraser tools. After the existing brush size section, add:

```ts
  ${(activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') ? html`
    <div class="separator"></div>
    <div class="section">
      <label>Opacity</label>
      <input type="range" min="0" max="100" .value=${String(Math.round(state.opacity * 100))}
        @input=${(e: Event) => this.ctx.setOpacity(Number((e.target as HTMLInputElement).value) / 100)} />
      <span class="size-value">${Math.round(state.opacity * 100)}%</span>
    </div>
    <div class="section">
      <label>Flow</label>
      <input type="range" min="1" max="100" .value=${String(Math.round(state.flow * 100))}
        @input=${(e: Event) => this.ctx.setFlow(Number((e.target as HTMLInputElement).value) / 100)} />
      <span class="size-value">${Math.round(state.flow * 100)}%</span>
    </div>
    <div class="section">
      <label>Hardness</label>
      <input type="range" min="0" max="100" .value=${String(Math.round(state.hardness * 100))}
        @input=${(e: Event) => this.ctx.setHardness(Number((e.target as HTMLInputElement).value) / 100)} />
      <span class="size-value">${Math.round(state.hardness * 100)}%</span>
    </div>
    <div class="separator"></div>
    <div class="section">
      <label class="checkbox-label">
        <input type="checkbox" .checked=${state.pressureSize}
          @change=${(e: Event) => this.ctx.setPressureSize((e.target as HTMLInputElement).checked)} />
        Pressure → Size
      </label>
    </div>
    <div class="section">
      <label class="checkbox-label">
        <input type="checkbox" .checked=${state.pressureOpacity}
          @change=${(e: Event) => this.ctx.setPressureOpacity((e.target as HTMLInputElement).checked)} />
        Pressure → Opacity
      </label>
    </div>
    <div class="section">
      <label>Curve</label>
      <select class="font-select" .value=${state.pressureCurve}
        @change=${(e: Event) => this.ctx.setPressureCurve((e.target as HTMLSelectElement).value as any)}>
        <option value="linear">Linear</option>
        <option value="light">Light</option>
        <option value="heavy">Heavy</option>
      </select>
    </div>
  ` : nothing}
```

- [ ] **Step 2: Add eyedropper settings**

When eyedropper is the active tool:

```ts
  ${activeTool === 'eyedropper' ? html`
    <div class="section">
      <label class="checkbox-label">
        <input type="checkbox" .checked=${state.eyedropperSampleAll}
          @change=${(e: Event) => this.ctx.setEyedropperSampleAll((e.target as HTMLInputElement).checked)} />
        Sample all layers
      </label>
    </div>
  ` : nothing}
```

- [ ] **Step 3: Verify build and test**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Test in browser: select pencil — opacity, flow, hardness, pressure controls should appear.

- [ ] **Step 4: Commit**

```bash
git add src/components/tool-settings.ts
git commit -m "feat(ui): add brush engine and eyedropper controls to tool settings"
```

---

## Task 13: Layers Panel — Blend Mode Dropdown

**Files:**
- Modify: `src/components/layers-panel.ts`

- [ ] **Step 1: Add blend mode dropdown for active layer**

Find the opacity slider section for the active layer (around line 1102-1117). Add a blend mode dropdown just before it:

```ts
  ${isActive ? html`
    <div class="opacity-row">
      <select class="blend-mode-select"
        .value=${layer.blendMode}
        @change=${(e: Event) => this.ctx.setLayerBlendMode(layer.id, (e.target as HTMLSelectElement).value as any)}>
        ${Object.entries(BLEND_MODE_LABELS).map(([value, label]) => html`
          <option value=${value}>${label}</option>
        `)}
      </select>
    </div>
  ` : nothing}
```

Add import at top of file:

```ts
import { BLEND_MODE_LABELS } from '../engine/types.js';
```

- [ ] **Step 2: Add CSS for the blend mode dropdown**

In the static styles, add:

```css
  .blend-mode-select {
    width: 100%;
    background: #444;
    color: #ddd;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 0.75rem;
    cursor: pointer;
  }
```

- [ ] **Step 3: Verify build and test**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Test: open layers panel, select a layer — blend mode dropdown should appear above opacity slider. Change blend mode, draw content — blending should be visible.

- [ ] **Step 4: Commit**

```bash
git add src/components/layers-panel.ts
git commit -m "feat(layers): add blend mode dropdown for active layer"
```

---

## Task 14: Final Integration Verification

**Files:** None (testing only)

- [ ] **Step 1: Full type check**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Production build**

Run: `cd /Users/egecan/Code/ketchup && npm run build`
Expected: Build succeeds

- [ ] **Step 3: Manual integration test checklist**

Run `npm run dev` and verify:

Brush engine:
- [ ] Pencil draws with configurable opacity/flow/hardness
- [ ] Marker uses soft brush defaults
- [ ] Eraser removes content with hardness/opacity
- [ ] Painting over same area in single stroke = uniform opacity (no accumulation)
- [ ] Fast curves are smooth (Catmull-Rom working)
- [ ] Click without drag = single dot

Blending modes:
- [ ] Change layer blend mode to Multiply — colors darken against lower layers
- [ ] Screen mode — colors lighten
- [ ] Blend modes work correctly over transparent areas (no disappearing)
- [ ] Export PNG has correct blending
- [ ] Merge/flatten respects blend modes
- [ ] Undo/redo of blend mode changes works

Eyedropper:
- [ ] Click eyedropper tool, click canvas — stroke color updates
- [ ] Alt-hold while pencil is active — samples color
- [ ] Release Alt — back to pencil
- [ ] Zoomed preview grid shows near cursor
- [ ] Preview flips when near canvas edge
- [ ] "Sample all layers" checkbox toggles behavior
- [ ] Alt-Tab and return — eyedropper not stuck

Shortcuts:
- [ ] `[` / `]` change brush size proportionally
- [ ] `{` / `}` change hardness by 0.1
- [ ] 1px brush increases to 2px (not stuck)
- [ ] Brush cursor dual-ring updates on size/hardness change
- [ ] Cursor disappears when pointer leaves canvas
- [ ] `I` activates eyedropper tool

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: integration test fixes for brush engine and tools"
```

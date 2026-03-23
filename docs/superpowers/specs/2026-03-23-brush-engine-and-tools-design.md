# Brush Engine, Blending Modes, Eyedropper & Shortcuts Design

**Date:** 2026-03-23
**Status:** Approved

## Overview

Four features that collectively upgrade Ketchup from a basic drawing app to a capable painting tool:

1. **Full brush engine** with pressure sensitivity, path smoothing, and OffscreenCanvas pooling
2. **Layer blending modes** (6 + normal, extensible)
3. **Eyedropper tool** with Alt-hold modifier and zoomed pixel grid preview
4. **Brush size/hardness keyboard shortcuts** with proportional stepping and cursor overlay

---

## Section 1: Brush Engine

### 1.1 New Brush Parameters

Added to `DrawingState`:

| Property | Type | Default | Description |
|---|---|---|---|
| `opacity` | `number` | `1.0` | Stroke-level transparency (0–1). Applied when the stroke buffer composites onto the layer. |
| `flow` | `number` | `1.0` | Per-stamp deposit amount (0–1). Applied at each stamp in the stamp loop. |
| `hardness` | `number` | `1.0` | Brush tip falloff (0 = full gaussian, 1 = hard edge). |
| `spacing` | `number` | `0.25` | Fraction of brush diameter between stamps (0.05–1.0). |
| `pressureSize` | `boolean` | `true` | Whether tablet pressure modulates brush size. |
| `pressureOpacity` | `boolean` | `false` | Whether tablet pressure modulates stamp opacity. |
| `pressureCurve` | `'linear' \| 'light' \| 'heavy'` | `'linear'` | Remapping function for pressure input. |

### 1.2 Brush Tip Cache

A `BrushTipCache` class manages pre-rendered brush tip textures.

**Alpha mask approach:** All tips are rendered as white-on-transparent alpha masks. The cache key is `${diameter}-${hardness}` only — completely color-independent. A user can drag a color picker freely without causing a single cache miss.

- Hardness 1.0: solid white filled circle
- Hardness 0.0: radial gradient from white center to transparent edge
- Values between: gradient stop position is interpolated
- Tilt: elliptical tips keyed by `${diameter}-${hardness}-${quantizedTiltAngle}` (5-degree buckets)
- LRU eviction at 32 entries
- All tips rendered on `OffscreenCanvas`

**Color application at composite time:** The stroke buffer accumulates alpha-only stamp data. When committing the stroke to the layer:
1. Set `fillStyle = strokeColor` on the stroke buffer context
2. Fill a rect with `globalCompositeOperation = 'source-in'` to tint the entire buffer
3. Draw the tinted buffer onto the active layer with `globalAlpha = opacity`

### 1.3 Stroke Buffer Pool

A singleton `StrokeBufferPool` manages one reusable `OffscreenCanvas`:

- **Acquire** on pointer down: resize only if the document is larger than the current buffer (never shrinks). Clear the buffer.
- **Stamp** during pointer move: stamp tips onto the buffer along the smoothed path.
- **Commit** on pointer up: tint the buffer with stroke color via `'source-in'`, composite onto the active layer with `globalAlpha = opacity`. Push to history (ImageData before/after, same as existing draw history).
- The buffer persists between strokes and is never freed. Zero allocation during painting.

This eliminates the accumulation problem: since the entire stroke is drawn to a temp buffer and composited once, painting over the same area within a single stroke produces uniform opacity.

### 1.4 Path Smoothing (Catmull-Rom)

Raw pointer events fire at the browser polling rate (60–120Hz). Fast curves produce widely spaced points. Drawing straight line segments between them results in jagged polygonal strokes.

**Solution:** A Catmull-Rom spline interpolator processes all incoming pointer events before the stamp loop:

- Maintains a rolling window of the last 4 pointer samples (with timestamps and pressure values).
- On each new pointer event, computes a Catmull-Rom segment between points P1 and P2 (using P0 and P3 as control points).
- Subdivides the spline into steps of `spacing * diameter` pixels.
- At each subdivision point, **lerps pressure** between the two bracketing raw samples based on arc-length position along the spline.
- Edge case: fewer than 4 points accumulated (stroke start) — falls back to linear interpolation until the window fills.

### 1.5 Stamp Loop

1. Feed new pointer event into the Catmull-Rom interpolator.
2. Receive a list of stamp positions with interpolated pressure values.
3. For each stamp point: apply the selected pressure curve to compute effective size and opacity.
4. Look up the cached alpha mask at that effective diameter + hardness.
5. Draw the mask onto the stroke buffer with `globalAlpha = flow * effectivePressureOpacity`.

### 1.6 Pressure Curves

Three built-in presets, all `(pressure: number) => number` mapping 0–1 to 0–1:

- **Linear:** `p => p`
- **Light:** `p => Math.pow(p, 0.5)` — more responsive at light pressure
- **Heavy:** `p => Math.pow(p, 2.0)` — more responsive at heavy pressure

No custom bezier curve editor — these three cover the practical range.

### 1.7 Impact on Existing Tools

The stamp-based engine replaces the current `_drawBrushAt` line-segment approach in `drawing-canvas.ts`. The pencil, marker, and eraser tools all route through the new stamp loop. The marker tool's existing hardcoded `globalAlpha: 0.3` and `size * 3` multiplier become default brush parameter presets rather than special cases.

### 1.8 File Layout

| File | Responsibility |
|---|---|
| `src/engine/types.ts` | `BrushParams`, `PressureCurve`, `StampPoint` types |
| `src/engine/brush-tip-cache.ts` | Alpha mask generation + LRU cache on OffscreenCanvas |
| `src/engine/stroke-buffer-pool.ts` | Pooled OffscreenCanvas lifecycle |
| `src/engine/path-smoother.ts` | Catmull-Rom interpolation + pressure lerp |
| `src/engine/stamp-stroke.ts` | Stamp loop, pressure curve application, commit/tint |

---

## Section 2: Blending Modes

### 2.1 BlendMode Type

```ts
type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'soft-light';
```

Six modes plus normal. All map directly to Canvas2D `globalCompositeOperation` values (`'normal'` maps to `'source-over'`). No pixel-level math required. Adding a new mode later: add the string to the union, done.

### 2.2 Layer Type Change

Add `blendMode: BlendMode` to the `Layer` interface (default `'normal'`). Add the same field to `LayerSnapshot` for undo/redo correctness.

### 2.3 Composite Loop — Display (Screen Render)

Blend modes like Multiply, Screen, and Overlay rely on math between the top pixel and the bottom pixel. If the bottom pixel is fully transparent `rgba(0,0,0,0)`, the math produces incorrect results (e.g., Multiply over transparency shows nothing).

**Solution:** The composite loop guarantees an opaque base. For display rendering, the checkerboard pattern serves as the opaque base — it is already opaque and does double duty as both the transparency visual indicator and the blend math foundation.

Revised `composite()` flow:
1. Draw checkerboard into a compositing buffer (pooled `OffscreenCanvas`). This is the opaque base.
2. Iterate layers bottom-to-top: set `globalCompositeOperation = blendModeToCompositeOp(layer.blendMode)` and `globalAlpha = layer.opacity`. Draw the layer. Reset `globalCompositeOperation` to `'source-over'` after each layer.
3. Draw the compositing buffer onto the display canvas.

### 2.4 Composite Loop — Export / Flatten / Merge

For export (PNG/JPEG), flatten, and merge operations, the opaque base is white (not checkerboard). The `_compositeLayers` helper in `drawing-app.ts` accepts a background color parameter. Export paths pass white (or a user-chosen background color if added later). Display paths pass `null` to use the checkerboard.

### 2.5 History

New history entry variant:

```ts
{ type: 'blend-mode'; layerId: string; before: BlendMode; after: BlendMode }
```

Pushed by `drawing-app.ts` when the user changes blend mode, same pattern as the existing `'opacity'` entry.

### 2.6 Context API

Add to `DrawingContextValue`:

```ts
setLayerBlendMode: (id: string, mode: BlendMode) => void;
```

### 2.7 Layers Panel UI

A dropdown for the active layer's blend mode, placed near the opacity slider. Lists all available modes. Selecting a mode dispatches `setLayerBlendMode` through context.

### 2.8 Persistence

The `blendMode` string is serialized/deserialized alongside other layer properties in the project save/load path. Default `'normal'` for backwards compatibility with existing saved projects that lack the field.

### 2.9 Future: Brush-Level Blending

Not implemented now. The architecture supports it later by applying `globalCompositeOperation` at the stroke buffer → layer composite step (Section 1.3) rather than only at the layer → display composite step. Noted here for future reference.

---

## Section 3: Eyedropper Tool

### 3.1 Tool Registration

- Add `'eyedropper'` to the `ToolType` union in `types.ts`
- Shortcut key: `I`
- SVG icon: pipette
- Placed in the utility tool group: fill, stamp, text, eyedropper

### 3.2 Sampling Modes

Two modes controlled by a checkbox in tool-settings ("Sample all layers"):

- **Composite (default):** `getImageData(x, y, 1, 1)` from the compositing buffer (the same buffer used by the blend-mode composite loop in Section 2).
- **Active layer only:** `getImageData(x, y, 1, 1)` from the active layer's offscreen canvas directly.

**Alpha guard:** If the sampled pixel's alpha is 0, the sample is ignored — `strokeColor` is not updated. If alpha is between 1 and 254 (semi-transparent), the color is composited against white to produce an opaque hex value matching what the user sees against the checkerboard. This prevents the "sampled transparent = invisible black" problem.

### 3.3 Alt-Hold Modifier

When a brush-class tool is active (pencil, marker, eraser) and `e.altKey` is true:

- `_onPointerDown`: runs sample logic instead of the normal tool dispatch. Sets `strokeColor` via context.
- `_onPointerMove`: shows the zoomed preview (below) instead of drawing.
- Cursor changes to eyedropper.
- No `activeTool` state change — purely an input modifier in the pointer handlers.

**Sticky key prevention:** A `window.addEventListener('blur', ...)` handler clears the eyedropper modifier state (hides preview, reverts cursor) when the window loses focus. This prevents the Alt-Tab sticky key bug where Alt is released in another window and the eyedropper gets permanently stuck on.

### 3.4 Zoomed Pixel Grid Preview

An 11x11 magnified pixel region around the cursor, with center crosshair, hex value, and color swatch.

**GPU-accelerated rendering — no getImageData for the grid:**

`getImageData` forces a GPU→CPU pipeline stall. Calling it for an 11x11 block on every pointer move would cause noticeable lag.

Instead, use `drawImage` with `imageSmoothingEnabled = false`:
```
previewCtx.imageSmoothingEnabled = false;
previewCtx.drawImage(sourceCanvas, docX - 5, docY - 5, 11, 11, destX, destY, 88, 88);
```
The browser's GPU handles the nearest-neighbor upscaling. Then draw grid lines (1px lines every 8px) and a crosshair highlight on the center cell. Draw hex label and color swatch below the grid.

The only `getImageData` call is the single-pixel sample for the actual color value.

**Coordinate space separation:** The `drawImage` source crop (`docX`, `docY`) uses document-space coordinates (pointer position run through the inverse pan/zoom transform via the existing `_viewportToDoc` method). The preview box position (`destX`, `destY`) uses raw screen-space pointer coordinates on the `#preview` overlay. These are two different coordinate systems and must not be mixed.

**Edge collision handling:** Preview is offset 20px right, 20px up from cursor by default. Before rendering, check bounds:
- If `cursorX + offset + previewWidth > viewportWidth` → flip to left of cursor
- If `cursorY - offset - previewHeight < 0` → flip to below cursor

**Performance:** Renders on `pointermove` throttled to `requestAnimationFrame`. Drawn onto the existing `#preview` canvas overlay. No per-move allocations.

### 3.5 What Changes

| File | Change |
|---|---|
| `types.ts` | Add `'eyedropper'` to `ToolType` |
| `tool-icons.ts` | Add icon, label, shortcut for eyedropper |
| `app-toolbar.ts` | Add eyedropper to utility tool group |
| `tool-settings.ts` | "Sample all layers" checkbox when eyedropper active |
| `drawing-canvas.ts` | Alt-hold logic, sample method with alpha guard, `drawImage`-based preview, blur listener |
| `drawing-app.ts` | `I` shortcut mapping |

---

## Section 4: Brush Size & Hardness Shortcuts

### 4.1 Keybindings

| Key | Action |
|---|---|
| `[` | Decrease brush size (proportional) |
| `]` | Increase brush size (proportional) |
| `{` (Shift+`[`) | Decrease hardness by 0.1 |
| `}` (Shift+`]`) | Increase hardness by 0.1 |

### 4.2 Size Step — Proportional with Minimum Delta

```ts
// Increase: guaranteed at least +1px
newSize = Math.min(maxSize, Math.max(current + 1, Math.round(current * 1.1)));

// Decrease: guaranteed at least -1px
newSize = Math.max(minSize, Math.min(current - 1, Math.round(current / 1.1)));
```

Without the `Math.max(current + 1, ...)` guard, a 1px brush computes `1 * 1.1 = 1.1`, rounds to 1, and gets permanently stuck.

**Hardness:** Fixed step ±0.1, clamped 0.0–1.0, rounded to one decimal to avoid floating point drift.

### 4.3 Implementation Location

All handled in the existing `_onKeyDown` handler in `drawing-app.ts`. The `[` and `]` checks go in the `!ctrl && !altKey` branch. Since `e.key` gives `{` and `}` when Shift is held, these are simple string comparisons.

`setBrushSize` already exists in the context API. `setHardness` is new, added alongside the other brush engine params from Section 1.

### 4.4 Brush Cursor Overlay

A circle rendered on the `#preview` canvas showing the current brush diameter at the pointer position. This is needed not just for shortcuts but for any brush size change.

**Dual-ring display:**
- **Outer ring** (solid): full brush diameter. 1px black stroke + 1px white stroke (inverted outline, visible on any background).
- **Inner ring** (dashed): `diameter * hardness` — shows where the solid core ends and the gradient falloff begins. At hardness 1.0 the rings overlap. At hardness 0.0 the inner ring collapses to center.

**Radius calculation:** `brushSize / 2 * zoom` (viewport-scaled).

**Update triggers:**
- Pointer move
- Brush size change (via shortcut or slider) — context subscription in `willUpdate` triggers redraw without requiring mouse movement
- Zoom change
- Hardness change

**Only shown** when a brush-class tool is active (pencil, marker, eraser).

**Pointer leave/enter handling:**
- `pointerleave` on the canvas: clear the brush cursor from the `#preview` canvas. Prevents ghost cursor artifact when the pointer exits.
- `pointerenter`: resume cursor rendering at the entry position.

### 4.5 Performance Under Key Repeat

When a user holds `[` or `]`, the browser fires keydown events at the OS key-repeat rate (30+ events/sec). Lit's context system batches updates through `willUpdate` so consumers re-render at most once per animation frame. Verify under testing that held-key repeat does not cause stutter in the settings panel or cursor overlay.

### 4.6 What Changes

| File | Change |
|---|---|
| `drawing-app.ts` | Four new key checks in `_onKeyDown`, `setHardness` method + context exposure |
| `drawing-context.ts` | Add `setHardness` to `DrawingContextValue` |
| `drawing-canvas.ts` | `_renderBrushCursor()` method, `pointerleave`/`pointerenter` handlers |

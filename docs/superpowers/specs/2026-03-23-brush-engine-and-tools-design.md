# Brush Engine, Blending Modes, Eyedropper & Shortcuts Design

**Date:** 2026-03-23
**Status:** Approved

## Overview

Four features that collectively upgrade Ketchup from a basic drawing app to a capable painting tool:

1. **Full brush engine** with pressure sensitivity, path smoothing, and canvas pooling
2. **Layer blending modes** (6 + normal, extensible)
3. **Eyedropper tool** with Alt-hold modifier and zoomed pixel grid preview
4. **Brush size/hardness keyboard shortcuts** with proportional stepping and cursor overlay

### Browser Compatibility

The engine uses `OffscreenCanvas` for the brush tip cache and stroke buffer pool. `OffscreenCanvas` with 2D context support requires Safari 16.4+ (March 2023), Chrome 69+, Firefox 105+. If `OffscreenCanvas` is unavailable at runtime, fall back to `document.createElement('canvas')` — the API surface is identical for our use (we do not use workers). The fallback check is a single `typeof OffscreenCanvas !== 'undefined'` gate in the pool/cache constructors.

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

**Persistence:** All seven parameters are added to the `ToolSettings` type in `src/storage/types.ts` and serialized/deserialized in the project save/load path. Missing fields in old project files default to the values above.

### 1.2 Brush Tip Cache

A `BrushTipCache` class manages pre-rendered brush tip textures.

**Alpha mask approach:** All tips are rendered as white-on-transparent alpha masks. The cache key is `${diameter}-${hardness}` only — completely color-independent. A user can drag a color picker freely without causing a single cache miss.

- Hardness 1.0: solid white filled circle
- Hardness 0.0: radial gradient from white center to transparent edge
- Values between: gradient stop position is interpolated
- Tilt: elliptical tips keyed by `${diameter}-${hardness}-${quantizedTiltAngle}` (5-degree buckets)
- LRU eviction at 64 entries
- All tips rendered on `OffscreenCanvas` (with `createElement('canvas')` fallback)

**Diameter quantization for pressure:** When `pressureSize` is enabled, continuous pressure produces many distinct effective diameters. To prevent cache thrashing, pressure-derived diameters are quantized to the nearest even pixel (e.g., 13.7 → 14, 15.2 → 16). This caps the effective key cardinality while keeping visual quality — a 1px rounding error at typical brush sizes is imperceptible.

**Color application at composite time:** The stroke buffer accumulates alpha-only stamp data. When committing the stroke to the layer:
1. Set `fillStyle = strokeColor` on the stroke buffer context
2. Fill a rect with `globalCompositeOperation = 'source-in'` to tint the entire buffer
3. Draw the tinted buffer onto the active layer with `globalAlpha = opacity`

**Semi-transparent stroke colors:** The `strokeColor` used for tinting is always treated as fully opaque (alpha forced to 1.0 before the `source-in` step). The stroke's transparency is controlled exclusively by the `opacity` parameter. If `strokeColor` has an alpha channel from the color picker, it is stripped at tint time.

### 1.3 Stroke Buffer Pool

A singleton `StrokeBufferPool` manages one reusable `OffscreenCanvas` (with `createElement('canvas')` fallback):

- **Acquire** on pointer down: resize only if the document is larger than the current buffer (never shrinks). Clear the buffer.
- **Stamp** during pointer move: stamp tips onto the buffer along the smoothed path.
- **Commit** on pointer up: tint the buffer with stroke color via `'source-in'`, composite onto the active layer with `globalAlpha = opacity` and `globalCompositeOperation = 'source-over'`. Push to history (ImageData before/after, same as existing draw history).
- The buffer persists between strokes and is never freed. Zero allocation during painting.

This eliminates the accumulation problem: since the entire stroke is drawn to a temp buffer and composited once, painting over the same area within a single stroke produces uniform opacity.

**Document resize guard:** If the document is resized while a stroke is in progress (e.g., via the resize dialog), the in-progress stroke is committed immediately before the resize takes effect. The resize dialog should be disabled while `_drawing` is true, but the guard provides defense in depth.

### 1.4 Path Smoothing (Catmull-Rom)

Raw pointer events fire at the browser polling rate (60–120Hz). Fast curves produce widely spaced points. Drawing straight line segments between them results in jagged polygonal strokes.

**Solution:** A Catmull-Rom spline interpolator processes all incoming pointer events before the stamp loop:

- Maintains a rolling window of the last 4 pointer samples (with timestamps and pressure values).
- On each new pointer event, computes a Catmull-Rom segment between points P1 and P2 (using P0 and P3 as control points).
- Subdivides the spline into steps of `spacing * diameter` pixels.
- At each subdivision point, **lerps pressure** between the two bracketing raw samples based on arc-length position along the spline.
- Edge case: fewer than 4 points accumulated (stroke start) — falls back to linear interpolation until the window fills.

**Arc-length interpolation (not time-based):** The spline subdivision must be based on spatial distance (arc length) between points, not timestamps. Browser pointer events can cluster with identical timestamps, which causes division-by-zero errors or bunched-up stamps if the math relies on time deltas. Timestamps are stored for pressure lerping reference but are not used for subdivision stepping.

**Single-point strokes (click without drag):** When only 1 point is received (pointer down + pointer up at same position, no pointer move), the interpolator emits a single stamp at the click position with the pressure from that event. This matches the existing behavior where `_drawBrushAt(p, p)` draws a single dot.

### 1.5 Stamp Loop

1. Feed new pointer event into the Catmull-Rom interpolator.
2. Receive a list of stamp positions with interpolated pressure values.
3. For each stamp point: apply the selected pressure curve to compute effective size and opacity.
4. Look up the cached alpha mask at that effective diameter (quantized) + hardness.
5. Draw the mask onto the stroke buffer with `globalAlpha = flow * effectivePressureOpacity`.

### 1.6 Pressure Curves

Three built-in presets, all `(pressure: number) => number` mapping 0–1 to 0–1:

- **Linear:** `p => p`
- **Light:** `p => Math.pow(p, 0.5)` — more responsive at light pressure
- **Heavy:** `p => Math.pow(p, 2.0)` — more responsive at heavy pressure

No custom bezier curve editor — these three cover the practical range.

### 1.7 Impact on Existing Tools

The stamp-based engine replaces the current `_drawBrushAt` line-segment approach in `drawing-canvas.ts`. The pencil and marker tools route through the new stamp loop. The marker tool's existing hardcoded `globalAlpha: 0.3` and `size * 3` multiplier become default brush parameter presets rather than special cases.

**Eraser: separate commit path.** The eraser cannot use the alpha-mask-then-tint pipeline because it needs `globalCompositeOperation = 'destination-out'` (removing pixels, not adding color). The eraser uses the stroke buffer for accumulation (preventing double-erase artifacts), but skips the `source-in` tinting step. On commit, the stroke buffer composites onto the active layer with `globalCompositeOperation = 'destination-out'` and `globalAlpha = opacity`. The `flow` parameter controls per-stamp erase intensity (how much alpha each stamp deposits into the buffer). The `hardness` parameter controls the softness of the erase edge, same as for painting tools.

### 1.8 File Layout

| File | Responsibility |
|---|---|
| `src/engine/types.ts` | `BrushParams`, `PressureCurve`, `StampPoint` types |
| `src/engine/brush-tip-cache.ts` | Alpha mask generation + LRU cache |
| `src/engine/stroke-buffer-pool.ts` | Pooled canvas lifecycle (OffscreenCanvas with fallback) |
| `src/engine/path-smoother.ts` | Catmull-Rom interpolation + pressure lerp |
| `src/engine/stamp-stroke.ts` | Stamp loop, pressure curve application, commit/tint (with eraser branch) |

---

## Section 2: Blending Modes

### 2.1 BlendMode Type

```ts
type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'soft-light';
```

Six modes plus normal. All map directly to Canvas2D `globalCompositeOperation` values (`'normal'` maps to `'source-over'`). No pixel-level math required. Adding a new mode later: add the string to the union, done.

### 2.2 Layer Type Change

Add `blendMode: BlendMode` to the `Layer` interface (default `'normal'`). Add the same field to `LayerSnapshot` for undo/redo correctness.

**Persistence:** Add `blendMode` to `SerializedLayer` and `SerializedLayerSnapshot` in `src/storage/types.ts`. Add `'blend-mode'` variant to `SerializedHistoryEntry`. Missing fields in old project files default to `'normal'`.

### 2.3 Composite Loop — Display (Screen Render)

Blend modes like Multiply, Screen, and Overlay rely on math between the top pixel and the bottom pixel. If the bottom pixel is fully transparent `rgba(0,0,0,0)`, the math produces incorrect results (e.g., Multiply over transparency shows nothing).

**Solution:** The composite loop guarantees an opaque base. The approach differs based on whether any visible layer uses a non-normal blend mode:

**Fast path (all layers normal):** No change from the current `composite()` — draw checkerboard, then layers with `globalAlpha` directly onto the display canvas with pan/zoom transforms. No intermediate buffer. This avoids the performance cost of an extra full-document canvas blit for the common case.

**Blend path (any visible layer has non-normal blend mode):** The existing `composite()` method is modified in-place — no separate compositing buffer. The key change:
1. Clear the display canvas with the workspace background.
2. Apply pan/zoom transform (existing behavior).
3. Draw the checkerboard within document bounds (existing behavior). The checkerboard is now the opaque base for blend math.
4. Iterate layers bottom-to-top: set `globalCompositeOperation = blendModeToCompositeOp(layer.blendMode)` and `globalAlpha = layer.opacity`. Draw the layer. Reset to `'source-over'` after each.
5. Draw the floating selection inline after its owning layer (existing behavior) — the float always composites with `'source-over'` regardless of the layer's blend mode.
6. Draw document border (existing behavior).
7. Restore transform.

This avoids introducing an intermediate document-sized buffer for display rendering. The checkerboard already provides the opaque base directly on the display canvas. The floating selection logic and pan/zoom transforms are preserved without modification.

### 2.4 Composite Loop — Export / Flatten / Merge

For export (PNG/JPEG), flatten, and merge operations, the opaque base is white (not checkerboard). The `_compositeLayers` helper in `drawing-app.ts` is updated to:
1. Accept an optional `background: string | null` parameter (default `'#ffffff'`).
2. Fill the target canvas with the background color before iterating layers.
3. Apply `globalCompositeOperation = blendModeToCompositeOp(layer.blendMode)` per layer during iteration.

This ensures merge/flatten/export produce correct results for layers with non-normal blend modes.

**`saveCanvas()` in `drawing-canvas.ts`:** This method has its own inline composite loop (separate from `_compositeLayers`) with float-handling logic. It must also apply `globalCompositeOperation` per layer. Either update the inline loop to match, or refactor `saveCanvas()` to delegate to the updated `_compositeLayers` helper (passing the float state for correct z-order compositing).

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

Add `blendMode` to `SerializedLayer`, `SerializedLayerSnapshot`, and as a `'blend-mode'` variant in `SerializedHistoryEntry` in `src/storage/types.ts`. Default `'normal'` for backwards compatibility with existing saved projects.

### 2.9 Future: Brush-Level Blending

Not implemented now. The architecture supports it later by applying `globalCompositeOperation` at the stroke buffer → layer composite step (Section 1.3) rather than only at the layer → display composite step. Noted here for future reference.

---

## Section 3: Eyedropper Tool

### 3.1 Tool Registration

- Add `'eyedropper'` to the `ToolType` union in `types.ts`
- Shortcut key: `I`
- SVG icon: pipette
- Placed in the utility tool group: fill, stamp, text, eyedropper

The `I` shortcut routes through the existing single-character dispatch in `_onKeyDown` (the `!ctrl && !e.altKey && !e.shiftKey && key.length === 1` branch at line 624 of `drawing-app.ts`). Added to `toolShortcuts` in `tool-icons.ts`.

### 3.2 Sampling Modes

Two modes controlled by a checkbox in tool-settings ("Sample all layers"):

- **Composite:** Samples the composited result of all visible layers. Uses a dedicated **sampling buffer** — a document-sized canvas that composites all visible layers with their blend modes over an opaque white background (not the checkerboard). This is distinct from the display composite to avoid sampling checkerboard pixels. The sampling buffer is rebuilt on demand (only when the eyedropper samples, not every frame).
- **Active layer only:** `getImageData(x, y, 1, 1)` from the active layer's offscreen canvas directly.

Default: composite.

**`willReadFrequently` hint:** The sampling buffer and any canvas used for `getImageData` calls (including active layer canvases in eyedropper mode) should have their 2D context initialized with `{ willReadFrequently: true }`. On Chromium, this keeps canvas memory on the CPU rather than the GPU, preventing the pipeline stall that `getImageData` normally triggers. This hint should be applied at context creation time for the sampling buffer. For active layer canvases, evaluate whether the tradeoff is worthwhile (CPU-backed canvases are slower for `drawImage` operations).

**Alpha guard:** In active-layer mode, if the sampled pixel's alpha is 0, the sample is ignored — `strokeColor` is not updated. If alpha is between 1 and 254 (semi-transparent), the color is composited against white to produce an opaque hex value matching what the user sees. In composite mode, the sampling buffer already has a white base, so all pixels are opaque and no guard is needed.

**Persistence:** The "Sample all layers" checkbox state is stored as `eyedropperSampleAll: boolean` in `DrawingState` (default `true`). Added to `ToolSettings` in the persistence schema.

### 3.3 Alt-Hold Modifier

When a brush-class tool is active (pencil, marker, eraser) and `e.altKey` is true:

- `_onPointerDown`: runs sample logic instead of the normal tool dispatch. Sets `strokeColor` via context.
- `_onPointerMove`: shows the zoomed preview (below) instead of drawing.
- Cursor changes to eyedropper.
- No `activeTool` state change — purely an input modifier in the pointer handlers.

**Sticky key prevention:** A `window.addEventListener('blur', ...)` handler (registered in `connectedCallback`, removed in `disconnectedCallback`) clears the eyedropper modifier state (hides preview, reverts cursor) when the window loses focus. This prevents the Alt-Tab sticky key bug where Alt is released in another window and the eyedropper gets permanently stuck on.

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

The source canvas for the preview grid is:
- Composite mode: the display canvas (which includes the checkerboard — this is intentional for the visual preview, showing the user exactly what they see)
- Active layer mode: the active layer's offscreen canvas

The only `getImageData` call is the single-pixel sample for the actual color value (from the sampling buffer or active layer, not the display canvas).

**Coordinate space separation:** The `drawImage` source crop (`docX`, `docY`) uses document-space coordinates (pointer position run through the inverse pan/zoom transform). The existing `_getDocPoint(e)` method takes a `PointerEvent` — extract its coordinate math into a standalone `_clientToDoc(clientX, clientY)` helper so the eyedropper preview can convert raw coordinates without a `PointerEvent`. The formula is `(clientX - rect.left - _panX) / _zoom`. The preview box position (`destX`, `destY`) uses raw screen-space pointer coordinates on the `#preview` overlay. These are two different coordinate systems and must not be mixed.

**Edge collision handling:** Preview is offset 20px right, 20px up from cursor by default. Before rendering, check bounds:
- If `cursorX + offset + previewWidth > viewportWidth` → flip to left of cursor
- If `cursorY - offset - previewHeight < 0` → flip to below cursor

**Performance:** Renders on `pointermove` throttled to `requestAnimationFrame`. Drawn onto the existing `#preview` canvas overlay. No per-move allocations.

### 3.5 Preview Canvas Contention

The `#preview` canvas is shared by multiple consumers: shape drawing previews, selection marquee with marching ants, text editing, crop overlay, and now the brush cursor overlay (Section 4.4) and eyedropper preview (this section).

**Precedence rules:** The preview canvas is cleared and redrawn each frame. Only one "mode" draws at a time, determined by active tool and modifier state:

| State | What draws on `#preview` |
|---|---|
| Eyedropper tool active, or Alt-hold active | Eyedropper zoomed grid (no brush cursor) |
| Brush tool active, pointer on canvas, not Alt-held | Brush cursor overlay (dual ring) |
| Shape tool active, drawing in progress | Shape preview (existing) |
| Select tool active, selection exists | Marching ants + handles (existing) |
| Crop tool active | Crop overlay (existing) |
| Text tool active | Text cursor (existing) |

The brush cursor and eyedropper preview are mutually exclusive (Alt toggles between them). No two consumers need to composite together. The precedence is enforced in a single `_renderPreview()` dispatcher method that checks state and delegates.

### 3.6 What Changes

| File | Change |
|---|---|
| `types.ts` | Add `'eyedropper'` to `ToolType` |
| `tool-icons.ts` | Add icon, label, shortcut for eyedropper |
| `app-toolbar.ts` | Add eyedropper to utility tool group |
| `tool-settings.ts` | "Sample all layers" checkbox when eyedropper active |
| `drawing-canvas.ts` | Alt-hold logic, sample method with alpha guard, `drawImage`-based preview, blur listener, `_renderPreview()` dispatcher |
| `drawing-app.ts` | `I` shortcut mapping |
| `storage/types.ts` | `eyedropperSampleAll` in `ToolSettings` |

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

Handled in the existing `_onKeyDown` handler in `drawing-app.ts`. **Important routing detail:** The current single-character tool shortcut dispatch is gated by `!ctrl && !e.altKey && !e.shiftKey && key.length === 1` (line 624). The `[` and `]` shortcuts fit this gate, but `{` and `}` require Shift, so they would be filtered out.

**Fix:** Add a new branch *before* the tool shortcut block that handles `[`, `]`, `{`, `}`:

```
} else if (!ctrl && !e.altKey && (key === '[' || key === ']')) {
  // brush size — no shift required
} else if (!ctrl && !e.altKey && (e.key === '{' || e.key === '}')) {
  // hardness — shift is held, e.key gives '{' or '}'
} else if (!ctrl && !e.altKey && !e.shiftKey && key.length === 1) {
  // existing tool shortcuts
}
```

This ensures the bracket/brace keys are caught before the `!e.shiftKey` filter rejects them.

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

**Only shown** when a brush-class tool is active (pencil, marker, eraser) and the eyedropper Alt-hold modifier is not active. See Section 3.5 for preview canvas precedence rules.

**Pointer leave/enter handling:**
- `pointerleave` on the canvas: clear the brush cursor from the `#preview` canvas. Prevents ghost cursor artifact when the pointer exits.
- `pointerenter`: resume cursor rendering at the entry position.

### 4.5 Performance Under Key Repeat

When a user holds `[` or `]`, the browser fires keydown events at the OS key-repeat rate (30+ events/sec). Lit's context system batches updates through `willUpdate` so consumers re-render at most once per animation frame. Verify under testing that held-key repeat does not cause stutter in the settings panel or cursor overlay.

### 4.6 What Changes

| File | Change |
|---|---|
| `drawing-app.ts` | Four new key checks in `_onKeyDown` (before tool shortcut block), `setHardness` method + context exposure |
| `drawing-context.ts` | Add `setHardness` to `DrawingContextValue` |
| `drawing-canvas.ts` | `_renderBrushCursor()` method, `pointerleave`/`pointerenter` handlers, integrated into `_renderPreview()` dispatcher |

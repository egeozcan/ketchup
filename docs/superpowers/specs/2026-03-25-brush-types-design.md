# Brush Types & Ink Retention — Design Spec

## Overview

Add a brush type system with different tip shapes, orientation modes, and ink retention behaviors. Brushes are defined as data-driven descriptors — presets are predefined descriptor objects, and users can customize any parameter via an advanced editor. The current round brush behavior is preserved as the default preset.

## Scope

**In scope:**
- 6 tip shapes: round, flat, chisel, calligraphy, fan, splatter
- 2 orientation modes: fixed angle, direction-following (per-brush option)
- 3 ink behaviors: paint depletion, paint buildup, color pickup (sample-and-blend)
- ~9 built-in presets with collapsible advanced editor
- Current brush preserved as "Round" preset with default parameters

**Out of scope:**
- Wet media simulation (watercolor bleeding, oil impasto)
- Texture-masked tips / canvas grain interaction
- User-imported custom tip images
- Per-pixel color mixing / smearing
- Preset save/load/share (future work)

## Data Model

### TipDescriptor

Describes the shape and orientation of the brush tip.

```typescript
type TipShape = 'round' | 'flat' | 'chisel' | 'calligraphy' | 'fan' | 'splatter';
type OrientationMode = 'fixed' | 'direction';

interface TipDescriptor {
  shape: TipShape;
  aspect: number;            // width:height ratio. 1.0 = circle/square, 3.0 = wide
  angle: number;             // degrees. For fixed: absolute rotation. For direction: offset from stroke direction
  orientation: OrientationMode;
  bristles?: number;         // dot count for fan/splatter (e.g. 5-20)
  spread?: number;           // arc angle in degrees for fan, scatter radius 0-1 for splatter
}
```

### InkDescriptor

Describes how ink behaves during a stroke.

```typescript
interface InkDescriptor {
  depletion: number;         // 0 = never depletes, 1 = depletes quickly
  depletionLength: number;   // px of stroke travel before fully dry
  buildup: number;           // 0 = normal flow accumulation, 1 = heavy saturation on overlap
  wetness: number;           // 0 = no color pickup, 1 = fully absorbs canvas color
}
```

### BrushDescriptor

Replaces the current flat `BrushParams`. Contains core parameters plus structured tip and ink sub-objects.

```typescript
interface BrushDescriptor {
  size: number;              // 1-150 px
  opacity: number;           // 0-1, stroke-level opacity
  flow: number;              // 0-1, per-stamp opacity multiplier
  hardness: number;          // 0-1, edge softness (applies to all tip shapes)
  spacing: number;           // 0.05-1.0, normalized stamp spacing
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureCurve: PressureCurveName;
  tip: TipDescriptor;
  ink: InkDescriptor;
}
```

Color and eraser are **not** part of BrushDescriptor — they are tool-level state, passed separately to the engine at stroke begin. This makes presets color-independent.

### BrushPreset

```typescript
interface BrushPreset {
  id: string;
  name: string;
  category: 'basic' | 'artistic' | 'effects';
  descriptor: BrushDescriptor;
}
```

### DrawingState changes

Replace individual brush fields (`brushSize`, `opacity`, `flow`, `hardness`, `spacing`, `pressureSize`, `pressureOpacity`, `pressureCurve`) with:

```typescript
interface DrawingState {
  brush: BrushDescriptor;
  activePreset: string;      // preset id
  // ... all other fields unchanged
}
```

## Tip Generation

### Architecture

Tip generators are **stateless functions** in a new file `src/engine/tip-generators.ts`. Each function produces an alpha-mask canvas (white on transparent) given diameter, hardness, and tip descriptor.

```typescript
type TipGeneratorFn = (
  diameter: number,
  hardness: number,
  tip: TipDescriptor
) => PoolCanvas;

const tipGenerators: Record<TipShape, TipGeneratorFn> = {
  round: generateRoundTip,
  flat: generateFlatTip,
  chisel: generateChiselTip,
  calligraphy: generateCalligraphyTip,
  fan: generateFanTip,
  splatter: generateSplatterTip,
};
```

The existing circle generation code in `brush-tip-cache.ts` moves into `generateRoundTip()` with no behavior change.

### Tip shapes

- **Round**: Current behavior. Radial gradient from solid core (hardness-controlled) to transparent edge.
- **Flat**: Rectangle, width = diameter, height = diameter / aspect. Hardness controls edge softness via gradient falloff on all edges.
- **Chisel**: Beveled rectangle — full width with angled/tapered ends (parallelogram shape). Hardness controls edge softness.
- **Calligraphy**: Ellipse, major axis = diameter, minor axis = diameter / aspect. Hardness controls radial gradient falloff.
- **Fan**: N bristle dots arranged in an arc. Each bristle is a small hardness-controlled circle. `bristles` controls count, `spread` controls arc angle.
- **Splatter**: N bristle dots scattered randomly within a radius. `bristles` controls count, `spread` controls scatter radius. Uses seeded PRNG keyed on tip parameters for cache stability.

### Cache

The existing LRU cache in `brush-tip-cache.ts` is reused. The cache key expands to:

```
"${shape}-${diameter}-${hardness}-${aspect}-${bristles}-${spread}"
```

Orientation (rotation) is **not** baked into the cached tip. It is applied at stamp time via canvas transforms. This means one cached tip serves all rotation angles.

### Tip canvas sizing

Elongated tips produce non-square canvases. The tip canvas dimensions are:
- Round: `diameter x diameter`
- Flat/Chisel/Calligraphy: `diameter x ceil(diameter / aspect)` (or vice versa depending on orientation baseline)
- Fan/Splatter: bounding box of all bristle positions plus individual bristle radii

The stamp engine accounts for the rotated bounding box when positioning stamps.

## Ink Modeling

### InkState (runtime, per-stroke)

```typescript
interface InkState {
  distanceTraveled: number;    // cumulative arc length in px
  remainingPaint: number;      // 1.0 → 0.0 as brush dries
  currentColor: string;        // may drift from brush color via pickup
  stampCount: number;           // for buildup density calculation
}
```

Initialized in `begin()`, updated per stamp in `stroke()`, discarded at stroke end. Lives on the `StampStroke` instance.

### Depletion

```
remainingPaint = max(0, 1 - (distanceTraveled / depletionLength) * depletion)
stampAlpha *= remainingPaint
```

- `depletion = 0`: stamp alpha unaffected (current behavior)
- `depletion = 1, depletionLength = 500`: brush is dry after 500px of stroke travel
- When `remainingPaint <= 0`, stamps are skipped entirely
- Resets to 1.0 on each new stroke (brush "reloads")

### Buildup

```
effectiveFlow = flow * (1 + buildup * overlapDensity)
```

Where `overlapDensity` is derived from the local stamp overlap (inversely proportional to pointer velocity — slower movement = more stamps per pixel = higher density).

- `buildup = 0`: flow is used as-is (current behavior)
- `buildup = 1`: slow-moving areas deposit significantly more paint
- Interacts with spacing: tight spacing + high buildup = thick, saturated strokes

### Color Pickup (sample-and-blend)

```
sampledColor = sampleCanvasAt(layerCtx, stampX, stampY)
currentColor = lerp(currentColor, sampledColor, wetness)
```

- `wetness = 0`: brush color never changes (current behavior)
- `wetness = 0.5`: gradual drift toward canvas color
- `wetness = 1`: immediately takes on canvas color
- `currentColor` is tracked in InkState across the entire stroke
- Sampling reads from the target layer canvas (pre-commit state)

Ink model functions live in a new file `src/engine/ink-model.ts` as stateless pure functions that take and return InkState.

## Engine Modifications

### StampStroke changes

**`begin(descriptor, color, eraser, docWidth, docHeight)`**
- Receives `BrushDescriptor` instead of flat `BrushParams`
- Initializes `InkState` with `remainingPaint: 1, currentColor: color, distanceTraveled: 0, stampCount: 0`
- Resolves the tip generator function for `descriptor.tip.shape`
- Determines buffer mode: alpha-mask (wetness = 0) or color (wetness > 0)

**`stroke(x, y, pressure, layerCtx?)`**
- `layerCtx` is optional, only provided when `wetness > 0`
- Per stamp, the loop now:
  1. Calls resolved tip generator via cache (instead of hardcoded circle)
  2. Computes rotation via `computeStampRotation()`
  3. Calls `applyDepletion()` → modifies stamp alpha, may skip stamp
  4. Calls `applyPickup()` → modifies current color (if wet)
  5. If wet: tints tip with current color before drawing to buffer
  6. Draws with `ctx.save(); ctx.translate(); ctx.rotate(); ctx.drawImage(); ctx.restore()`
  7. Updates `InkState.distanceTraveled` and `stampCount`

**`commit(targetCtx)`**
- Branches on buffer mode:
  - Alpha-mask mode (wetness = 0): tint entire buffer → composite (unchanged path)
  - Color mode (wetness > 0): composite buffer directly (stamps already tinted)

### Rotation computation

```typescript
function computeStampRotation(
  stamp: StampPoint,
  prevStamp: StampPoint | null,
  tip: TipDescriptor
): number {
  if (tip.orientation === 'fixed') {
    return tip.angle * Math.PI / 180;
  }
  // direction-following
  if (!prevStamp) return tip.angle * Math.PI / 180; // first stamp uses fixed angle
  const dx = stamp.x - prevStamp.x;
  const dy = stamp.y - prevStamp.y;
  return Math.atan2(dy, dx) + tip.angle * Math.PI / 180;
}
```

`tip.angle` serves double duty: absolute angle for fixed mode, offset from direction for direction-following mode.

### Stroke buffer pool changes

`stroke-buffer-pool.ts` `commit()` method branches on whether the buffer contains alpha-only or RGBA data:
- Alpha-only: existing `tintAlphaMask()` → `source-over` composite path
- RGBA (color pickup): skip tint, composite buffer directly with stroke opacity

### Drawing canvas changes

`drawing-canvas.ts` pointer event handlers:
- `_onPointerDown`: builds `BrushDescriptor` from `DrawingState.brush`, passes `color` and `eraser` from tool state to `engine.begin()`
- `_onPointerMove`: passes `layerCtx` to `engine.stroke()` when `brush.ink.wetness > 0`
- Preview compositing: unchanged for alpha-mask mode; for color mode, the preview buffer is already RGBA so it composites directly

### Unchanged systems

- Path smoother (geometry, not tip/ink concern)
- Canvas pool
- Layer compositing
- History system (still captures before/after ImageData)
- Checkerboard rendering

## Preset System

### Built-in presets

| ID | Name | Category | Tip | Orientation | Ink | Notes |
|----|------|----------|-----|-------------|-----|-------|
| `round` | Round | basic | round, aspect 1 | fixed | none | Current default, exact same behavior |
| `soft-round` | Soft Round | basic | round, aspect 1, hardness 0.3 | fixed | none | Airbrush-like soft edges |
| `flat` | Flat | artistic | flat, aspect 3 | direction | depletion 0.3, length 800 | House-painting flat brush |
| `chisel` | Chisel | artistic | chisel, aspect 2.5 | direction | depletion 0.2, buildup 0.3 | Marker/chisel tip |
| `calligraphy` | Calligraphy | artistic | calligraphy, aspect 4 | fixed 45° | none | Classic nib at fixed angle |
| `fan` | Fan | artistic | fan, 8 bristles, 120° | direction | depletion 0.5, length 600 | Textured strokes, runs dry |
| `splatter` | Splatter | effects | splatter, 12 dots, 0.8 | fixed | depletion 0.7, length 400 | Spray/speckle effect |
| `dry-brush` | Dry Brush | artistic | round, hardness 0.8 | fixed | depletion 0.8, length 300, buildup 0.4 | Runs out fast, builds on slow |
| `wet-brush` | Wet Brush | artistic | round, hardness 0.5 | fixed | wetness 0.4, buildup 0.2 | Picks up and blends canvas color |

### Preset behavior

- Selecting a preset populates all `BrushDescriptor` fields from the preset's descriptor
- Users can immediately tweak any parameter — no lock to the preset
- Active preset indicator shows preset name; appends "modified" if any parameter differs from preset defaults
- Re-selecting the same preset resets to its defaults
- Presets are defined in `src/engine/brush-presets.ts` as a static `BrushPreset[]` array

## UI Design

### Tool settings panel layout

Three zones, top to bottom:

1. **Preset gallery** — 5-column grid of 42x42px thumbnail buttons. Each shows a mini tip/stroke preview rendered on a canvas. Blue border on active preset. Preset name displayed below the grid.

2. **Core controls** — identical to current panel: size, opacity, flow, hardness, spacing sliders + pressure toggles + curve selector. No changes for existing users.

3. **Advanced section** — collapsed by default via a toggle. Two sub-sections:
   - **Tip Shape**: pill-button selector for 6 shapes, aspect ratio slider, angle slider, orientation toggle (fixed/direction), bristle count and spread sliders
   - **Ink Behavior**: depletion slider, depletion length slider, buildup slider, wetness slider

### Conditional visibility

Controls are hidden or dimmed when not applicable:
- Aspect ratio: dimmed for round tips
- Angle: shown only in fixed orientation mode
- Bristles and spread: shown only for fan and splatter shapes
- Depletion length: hidden when depletion = 0
- Pressure curve: hidden when neither pressure toggle is on (existing behavior)

## File Impact

### New files

| File | Purpose |
|------|---------|
| `src/engine/tip-generators.ts` | 6 tip generator functions + `tipGenerators` dispatch map |
| `src/engine/ink-model.ts` | `InkState` interface, `applyDepletion()`, `applyBuildup()`, `applyPickup()` |
| `src/engine/brush-presets.ts` | `BrushPreset[]` with ~9 built-in presets |

### Modified files

| File | Changes |
|------|---------|
| `src/engine/types.ts` | Add `TipDescriptor`, `InkDescriptor`, `BrushDescriptor`, `BrushPreset` types |
| `src/engine/stamp-stroke.ts` | Accept `BrushDescriptor`, add `InkState`, rotation per stamp, dual buffer mode |
| `src/engine/brush-tip-cache.ts` | Expanded cache key, delegate tip creation to `tip-generators.ts` |
| `src/engine/stroke-buffer-pool.ts` | `commit()` branches on wetness for tint strategy |
| `src/types.ts` | `DrawingState`: replace flat brush fields with `brush: BrushDescriptor` + `activePreset: string` |
| `src/components/drawing-canvas.ts` | Build `BrushDescriptor` from state, pass `layerCtx` to `stroke()` when wet |
| `src/components/drawing-app.ts` | State shape change, preset selection handlers, context value rebuild |
| `src/components/tool-settings.ts` | Preset gallery UI, advanced editor with tip/ink controls |
| `src/components/app-toolbar.ts` | Minor: preset name/indicator in toolbar area |
| `src/components/tool-icons.ts` | Preset thumbnail rendering |

### Unchanged files

- `src/engine/path-smoother.ts` — geometry, unaffected
- `src/engine/canvas-pool.ts` — utility, unaffected
- `src/components/layers-panel.ts` — layer management, unaffected
- `src/components/navigator-panel.ts` — unaffected
- `src/tools/*.ts` — legacy tool functions, unaffected (brush strokes use the engine, not tool functions)

## Migration

The `DrawingState` shape changes from flat brush fields to `brush: BrushDescriptor`. All components that read brush state (primarily `tool-settings.ts` and `drawing-canvas.ts`) need to read from `state.brush.*` instead of `state.brushSize`, `state.opacity`, etc.

The default state initializes `brush` with the Round preset descriptor and `activePreset: 'round'`, producing identical behavior to the current app on first load.

No data migration is needed — there is no persisted brush state (stamps are in IndexedDB but brush params are ephemeral).

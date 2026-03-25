# Free Transform — Design Spec

## Overview

Add Photoshop-style free transform to the Ketchup drawing app. Users can scale, rotate, skew, perspective-warp, flip, and move selections or entire layers via direct manipulation with handles, keyboard modifiers, and a numeric input panel.

## Architecture

### TransformManager Class

A new class at `src/transform/transform-manager.ts`. Not a web component — a plain TypeScript class that `drawing-canvas` instantiates when entering transform mode.

**Responsibilities:**
- Owns transform state: source image, current `DOMMatrix`, individual transform parameters (scaleX, scaleY, rotation, skewX, skewY, translateX, translateY), and flip flags
- Hit-tests the 8 resize handles, rotation handle, and bounding box interior
- Processes pointer events during transform (move, resize, rotate, skew, perspective)
- Renders the transformed image and handles/marching ants onto the preview canvas
- Executes commit (apply transform to layer canvas) and cancel (restore original)

**Interface with drawing-canvas:**

```
TransformManager {
  constructor(source: ImageData, sourceRect: Rect, previewCanvas: HTMLCanvasElement, zoom: number, pan: Point)

  // Pointer delegation
  onPointerDown(docPoint: Point, modifiers: { shift: boolean, ctrl: boolean, alt: boolean }): boolean
  onPointerMove(docPoint: Point, modifiers: { shift: boolean, ctrl: boolean, alt: boolean }): void
  onPointerUp(docPoint: Point): void

  // Rendering
  renderPreview(): void                    // Draw handles + marching ants to preview canvas
  renderTransformed(ctx: CanvasRenderingContext2D): void  // Draw transformed image to a target context

  // State for numeric panel (two-way binding via getters/setters)
  x, y, width, height, rotation, skewX, skewY, flipH, flipV: number/boolean

  // Lifecycle
  commit(): ImageData    // Returns the final transformed image data
  cancel(): ImageData    // Returns the original image data
  hasChanged(): boolean  // True if any transform was applied

  // Viewport updates
  updateViewport(zoom: number, pan: Point): void
  getCursor(docPoint: Point): string  // Returns CSS cursor for current hover position
}
```

**What migrates out of drawing-canvas.ts:**
- All `_float*` state fields (~15 private fields)
- `_liftToFloat()`, `_commitFloat()`, `_clearFloatState()`
- `_applyResize()`, `_rebuildTempCanvas()`
- `_toFloatLocal()`, `_hitTestHandle()`, `_hitTestRotationHandle()`, `_isInsideFloat()`
- `_redrawFloatPreview()`
- Float rendering logic within `composite()`

**What stays in drawing-canvas.ts:**
- Deciding when to enter transform mode (Cmd/Ctrl+T, toolbar button)
- Forwarding pointer events to the manager
- Integrating `renderTransformed()` into the composite pipeline
- History capture (beforeImageData on enter, afterImageData on commit)

### File Structure

```
src/transform/
  transform-manager.ts    # Core class
  transform-math.ts       # Matrix composition, perspective mesh warp utilities
  transform-handles.ts    # Handle hit-testing, drawing, layout calculations
  transform-types.ts      # Interfaces: TransformState, HandleType, TransformMode
```

## Transform Math

### Matrix Composition

All transforms except perspective are represented as a composed `DOMMatrix`. Parameters are stored individually and composed in this order:

1. Translate to transform origin (center of bounding box)
2. Rotate (radians)
3. Scale (scaleX, scaleY — negative values represent flips)
4. Skew (skewX, skewY in degrees)
5. Translate back from origin
6. Translate to position (x, y)

Recomposing the matrix from parameters happens on every change. The `DOMMatrix` is applied to the Canvas 2D context via `setTransform()` for rendering.

### Skew

- Stored as `skewX` and `skewY` angles in degrees (range: -89 to 89)
- Applied via `DOMMatrix.skewXSelf()` / `skewYSelf()`
- Canvas 2D's `setTransform()` supports this natively — no manual pixel work

### Perspective

Canvas 2D does not support projective (perspective) transforms natively. Implementation:

- User drags individual corner handles (Ctrl + corner drag) to arbitrary positions
- The 4 source corners and 4 destination corners define a homography
- Rendering approach: subdivide the source image into a triangle mesh, apply per-triangle affine approximation via `drawImage()` with clipping
- Adaptive subdivision: coarser grid during drag (performance), finer grid on commit (quality)
- Mesh density: 8x8 during interaction, 32x32 on commit

### Flip

- Flip horizontal: `scaleX = -scaleX`
- Flip vertical: `scaleY = -scaleY`
- Applied through the same matrix composition — no special case

## Interaction Model

### Entry Points

| Trigger | What gets transformed |
|---|---|
| Cmd/Ctrl+T with active selection | Selected region is lifted to float |
| Cmd/Ctrl+T with no selection | Entire active layer (auto-detected content bounding box) |
| Select tool → make selection → Cmd/Ctrl+T | The selection region |
| Toolbar "Transform" action button | Same as Cmd/Ctrl+T based on current selection state |

### Handle Behavior with Modifier Keys

| Action | No modifier | Shift | Ctrl/Cmd |
|---|---|---|---|
| Corner handle drag | Free scale | Proportional scale | Perspective (independent corner) |
| Edge handle drag | Scale on that axis | Scale constrained | Skew along that edge |
| Outside bounding box drag | Rotate | Snap rotate 15 degrees | — |
| Inside bounding box drag | Move | Constrain to axis | — |

### Click Outside vs. Drag Outside (Rotate)

Both "click outside to commit" and "drag outside to rotate" start with a pointerdown outside the bounding box. Disambiguation:

- On pointerdown outside the bounding box, do nothing yet — just record the start position.
- If the pointer moves more than 3px from the start position before pointerup, it's a **rotate gesture**.
- If pointerup fires within 3px of the start position, it's a **click outside** → commit the transform.

This matches standard drag-detection thresholds used elsewhere in the app.

### Commit and Cancel

- **Enter** or **checkmark button**: commits the transform
- **Escape** or **X button**: cancels, restores original
- **Click outside bounding box**: commits (see disambiguation above)
- **Switching to another tool**: commits
- If no change was made (`hasChanged() === false`), commit is a no-op — no history entry

Floating mini-toolbar rendered near the top-right of the bounding box with checkmark and X icon buttons.

### Mobile / Touch

Handle sizes adapt based on input type:

- **Desktop (pointer: fine):** 8px square handles, current behavior
- **Touch (pointer: coarse):** 20px circular handles with 40px invisible hit area
- Detection via `pointerType === 'touch'` on first pointer event, or CSS media query `(pointer: coarse)` at startup
- Rotation handle stem is longer on touch to provide more grab room

## Numeric Input Panel

When transform mode is active, `tool-settings.ts` renders transform-specific controls instead of the normal tool settings.

### Fields

| Field | Type | Notes |
|---|---|---|
| X, Y | Number inputs (paired on one row) | Position of top-left corner in document pixels |
| W, H | Number inputs (paired on one row) | Size in pixels |
| Lock aspect ratio | Toggle icon button (chain link) | Between W/H row; when on, changing W auto-updates H and vice versa |
| Rotation | Number input + ° label | Range: -360 to 360, wraps |
| Skew X, Skew Y | Number inputs + ° label (paired) | Range: -89 to 89 |
| Flip H, Flip V | Icon buttons (paired) | Toggle; visually indicate current flip state |

### Behavior

- Two-way binding: dragging handles updates numeric fields; typing values updates the transform
- Typing a value and pressing Enter applies it immediately
- Tab between fields for keyboard-driven input
- All values are in document-space pixels and degrees (not screen pixels)
- Layout follows existing tool-settings panel style: label above input, grouped pairs on shared rows

## History Integration

### New History Entry Type

```typescript
{ type: 'transform', layerId: string, before: ImageData, after: ImageData }
```

Added to the existing `HistoryEntry` discriminated union in `types.ts`.

### When History is Captured

- `before` ImageData is captured when entering transform mode (original layer state before the content is lifted)
- `after` ImageData is captured on commit (layer state after the transformed content is drawn back)
- Cancel restores `before` ImageData directly — no history entry is pushed
- If `hasChanged() === false` on commit, no history entry is pushed

### Undo Behavior

- Transform is one atomic undo step. Intermediate handle drags are not individually undoable.
- Undo during active transform mode cancels the entire transform (equivalent to pressing Escape).
- After commit, undo restores the layer to its pre-transform state.

## Layer Transform (No Selection)

When Cmd/Ctrl+T is pressed with no active selection:

1. **Detect content bounds:** Scan the active layer's canvas pixel data to find the tight bounding box of non-transparent pixels (alpha > 0). If the layer is empty, do nothing.
2. **Lift content:** The detected bounding box region is lifted into the TransformManager as the source image. The layer canvas is cleared.
3. **Transform:** User manipulates as normal — all transform types available.
4. **Commit (clip to canvas):** Transformed content is drawn onto the layer canvas. Anything extending beyond canvas bounds is clipped. Before/after ImageData is pushed to history.
5. **Cancel:** Original layer content is restored from the captured beforeImageData.

## UI Additions

### Toolbar

- Add a "Transform" button to the first toolbar group (alongside select, move, crop, hand)
- This is **not** a selectable tool in the `ToolType` union — it's an action button. Clicking it fires the same logic as Cmd/Ctrl+T: enters transform mode on the current selection or active layer. The `activeTool` does not change.
- No new `ToolType` value is needed. Transform mode is a modal overlay managed by `drawing-canvas` via the presence/absence of an active `TransformManager` instance.
- When transform mode is active, `drawing-canvas` routes pointer events to the manager regardless of `activeTool`. When transform mode ends (commit/cancel), pointer dispatch returns to normal tool handling.
- Icon: a bounding box with corner handles and a rotation arc (standard transform icon)
- Keyboard shortcut: Cmd/Ctrl+T (global shortcut)

### Right-Click Context Menu (Deferred)

A canvas-level right-click context menu does not exist in the app today. Building one is a separate UI feature (positioning, dismiss behavior, styling, other menu items). The "Free Transform" entry will be added to it once the canvas context menu is built. For now, transform is accessible via Cmd/Ctrl+T and the toolbar button.

This is explicitly **out of scope** for this spec — noted in the Out of Scope section.

### Floating Commit/Cancel Toolbar

- Rendered on the preview canvas, positioned near top-right outside the bounding box
- Two buttons: checkmark (commit) and X (cancel)
- Follows the bounding box as it moves
- Styled semi-transparent with backdrop blur to not obscure content

## Migration Path

The existing float system in drawing-canvas.ts (move, resize, rotate on selections) is migrated into TransformManager rather than maintained in parallel. After migration:

- The select tool's "lift and manipulate" behavior delegates to TransformManager
- All existing selection-based move/resize/rotate continues to work through the new system
- Skew, perspective, flip, numeric input, and layer transform are new capabilities added on the same foundation

This means the refactor and the feature are coupled — the TransformManager replaces the old float code, and new transform types are added in the same pass. The old `_float*` fields and methods are removed from drawing-canvas.ts.

## Out of Scope

- Warp/mesh deformation (Photoshop's Warp mode)
- Content-aware scaling
- Transform presets or saved transforms
- Multi-layer simultaneous transform
- Per-step undo within an active transform session
- Canvas-level right-click context menu (separate UI feature; "Free Transform" entry will be added once it exists)

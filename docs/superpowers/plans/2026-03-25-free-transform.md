# Free Transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Photoshop-style free transform (scale, rotate, skew, perspective, flip, move) to selections and layers via a dedicated TransformManager class.

**Architecture:** Extract existing float move/resize/rotate code from `drawing-canvas.ts` into a new `TransformManager` class in `src/transform/`. The manager owns a `DOMMatrix`, hit-tests handles, processes pointer events, and renders previews. New transform types (skew, perspective, flip) are added on the same foundation. UI additions: toolbar action button, numeric input panel in tool-settings, floating commit/cancel buttons.

**Tech Stack:** TypeScript 5 (strict, experimental decorators), Lit 3 web components, Canvas 2D API, DOMMatrix

**Spec:** `docs/superpowers/specs/2026-03-25-free-transform-design.md`

**Verification:** No test runner configured. Use `npx tsc --noEmit` for type-checking and `npm run dev` + manual browser testing for visual/interaction verification.

---

## File Structure

```
src/transform/                    (NEW directory)
  transform-types.ts              (NEW) Interfaces and type aliases
  transform-math.ts               (NEW) Matrix composition, perspective mesh warp
  transform-handles.ts            (NEW) Handle hit-testing, drawing, layout
  transform-manager.ts            (NEW) Core TransformManager class

src/types.ts                      (MODIFY) Add 'transform' HistoryEntry variant
src/contexts/drawing-context.ts   (MODIFY) Add transformActive boolean + enterTransform callback
src/components/drawing-canvas.ts  (MODIFY) Replace float code with TransformManager delegation
src/components/drawing-app.ts     (MODIFY) Add Cmd/Ctrl+T shortcut, transform context wiring
src/components/tool-settings.ts   (MODIFY) Add transform numeric panel
src/components/app-toolbar.ts     (MODIFY) Add Transform action button
src/components/tool-icons.ts      (MODIFY) Add transform icon
```

---

### Task 1: Create Transform Types

**Files:**
- Create: `src/transform/transform-types.ts`

This defines all interfaces used across the transform module. No dependencies on existing code except `Point` from `types.ts`.

- [ ] **Step 1: Create `src/transform/transform-types.ts`**

```typescript
import type { Point } from '../types.js';

/** Which handle the user is dragging */
export type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Current interaction mode within the transform */
export type TransformInteraction =
  | { type: 'idle' }
  | { type: 'moving'; startPoint: Point; startX: number; startY: number }
  | { type: 'resizing'; handle: HandleType; origin: { rect: TransformRect; point: Point } }
  | { type: 'rotating'; startAngle: number; startRotation: number }
  | { type: 'skewing'; edge: 'n' | 'e' | 's' | 'w'; startPoint: Point; startSkewX: number; startSkewY: number }
  | { type: 'perspective'; corner: 'nw' | 'ne' | 'se' | 'sw'; startPoint: Point }
  | { type: 'outside-pending'; startPoint: Point };  // Click-outside vs rotate disambiguation

/** Bounding rect in document space */
export interface TransformRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Individual transform parameters — composed into a DOMMatrix on every change */
export interface TransformState {
  /** Position of top-left corner in document pixels */
  x: number;
  y: number;
  /** Size in document pixels */
  width: number;
  height: number;
  /** Rotation in radians (clockwise) */
  rotation: number;
  /** Skew angles in degrees */
  skewX: number;
  skewY: number;
  /** Scale factors (negative = flipped) */
  scaleX: number;
  scaleY: number;
}

/** Per-corner offsets for perspective warp (relative to affine-transformed corners) */
export interface PerspectiveCorners {
  nw: Point;
  ne: Point;
  se: Point;
  sw: Point;
}

/** Handle visual configuration (adapts for touch) */
export interface HandleConfig {
  /** Visual size of handle in viewport pixels */
  size: number;
  /** Hit area radius in viewport pixels */
  hitRadius: number;
  /** Whether to draw as circle (touch) or square (desktop) */
  shape: 'square' | 'circle';
  /** Rotation handle stem length in viewport pixels */
  rotationStemLength: number;
}

export const HANDLE_CONFIG_DESKTOP: HandleConfig = {
  size: 8,
  hitRadius: 6,
  shape: 'square',
  rotationStemLength: 30,
};

export const HANDLE_CONFIG_TOUCH: HandleConfig = {
  size: 20,
  hitRadius: 20,
  shape: 'circle',
  rotationStemLength: 50,
};

/** Minimum size in document pixels (before zoom) during resize */
export const MIN_TRANSFORM_SIZE = 4;

/** Distance threshold for click-outside vs drag-outside in viewport pixels */
export const OUTSIDE_DRAG_THRESHOLD = 3;
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/transform/transform-types.ts
git commit -m "feat(transform): add type definitions for transform system"
```

---

### Task 2: Create Transform Math Utilities

**Files:**
- Create: `src/transform/transform-math.ts`

Matrix composition from individual parameters, inverse point mapping, and perspective mesh warp utilities.

- [ ] **Step 1: Create `src/transform/transform-math.ts`**

```typescript
import type { Point } from '../types.js';
import type { TransformState, TransformRect, PerspectiveCorners } from './transform-types.js';

/**
 * Compose a DOMMatrix from individual transform parameters.
 * Order: translate to origin → rotate → scale → skew → translate back → translate to position.
 */
export function composeMatrix(state: TransformState): DOMMatrix {
  const cx = state.width / 2;
  const cy = state.height / 2;

  const m = new DOMMatrix();
  // Translate to final position
  m.translateSelf(state.x + cx, state.y + cy);
  // Rotate
  m.rotateSelf((state.rotation * 180) / Math.PI);
  // Skew
  m.skewXSelf(state.skewX);
  m.skewYSelf(state.skewY);
  // Scale (negative = flip)
  m.scaleSelf(state.scaleX, state.scaleY);
  // Translate back from center
  m.translateSelf(-cx, -cy);

  return m;
}

/**
 * Transform a point from document space to the local (untransformed) coordinate
 * system of the float. Used for hit-testing handles on a rotated/skewed selection.
 */
export function docToLocal(p: Point, state: TransformState): Point {
  const matrix = composeMatrix(state);
  const inv = matrix.inverse();
  const dp = new DOMPoint(p.x, p.y);
  const lp = inv.transformPoint(dp);
  return { x: lp.x, y: lp.y };
}

/**
 * Transform a point from local (untransformed) float space to document space.
 * Used for drawing handles at their screen positions.
 */
export function localToDoc(p: Point, state: TransformState): Point {
  const matrix = composeMatrix(state);
  const dp = new DOMPoint(p.x, p.y);
  const tp = matrix.transformPoint(dp);
  return { x: tp.x, y: tp.y };
}

/**
 * Get the 4 corners of the transform bounding box in document space.
 * Returns [topLeft, topRight, bottomRight, bottomLeft].
 */
export function getTransformedCorners(state: TransformState): [Point, Point, Point, Point] {
  const { width, height } = state;
  return [
    localToDoc({ x: 0, y: 0 }, state),
    localToDoc({ x: width, y: 0 }, state),
    localToDoc({ x: width, y: height }, state),
    localToDoc({ x: 0, y: height }, state),
  ];
}

/**
 * Get the center of the transform in document space.
 */
export function getTransformCenter(state: TransformState): Point {
  return localToDoc({ x: state.width / 2, y: state.height / 2 }, state);
}

/**
 * Snap an angle to the nearest increment (in radians).
 */
export function snapAngle(angle: number, increment: number): number {
  return Math.round(angle / increment) * increment;
}

/**
 * Constrain a point to move only along one axis from an origin.
 * Locks to whichever axis has the larger delta.
 */
export function constrainToAxis(point: Point, origin: Point): Point {
  const dx = Math.abs(point.x - origin.x);
  const dy = Math.abs(point.y - origin.y);
  if (dx > dy) {
    return { x: point.x, y: origin.y };
  }
  return { x: origin.x, y: point.y };
}

/**
 * Detect tight bounding box of non-transparent pixels in an ImageData.
 * Returns null if the image is fully transparent.
 */
export function detectContentBounds(imageData: ImageData): TransformRect | null {
  const { data, width, height } = imageData;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null; // fully transparent
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// --- Perspective mesh warp ---

/**
 * Compute the 4 destination corners for perspective warp.
 * Each corner is the affine-transformed position plus a per-corner offset.
 */
export function getPerspectiveDestCorners(
  state: TransformState,
  offsets: PerspectiveCorners,
): [Point, Point, Point, Point] {
  const [tl, tr, br, bl] = getTransformedCorners(state);
  return [
    { x: tl.x + offsets.nw.x, y: tl.y + offsets.nw.y },
    { x: tr.x + offsets.ne.x, y: tr.y + offsets.ne.y },
    { x: br.x + offsets.se.x, y: br.y + offsets.se.y },
    { x: bl.x + offsets.sw.x, y: bl.y + offsets.sw.y },
  ];
}

/**
 * Draw a perspective-warped image using triangle mesh subdivision.
 * Subdivides the source image into a grid of triangles and draws each
 * with an affine approximation.
 *
 * @param ctx - Target rendering context
 * @param sourceCanvas - Source image to warp
 * @param srcCorners - Source quad corners [TL, TR, BR, BL] in source image space
 * @param dstCorners - Destination quad corners [TL, TR, BR, BL] in document space
 * @param gridSize - Subdivision density (e.g., 8 for interactive, 32 for commit)
 */
export function drawPerspectiveMesh(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  srcCorners: [Point, Point, Point, Point],
  dstCorners: [Point, Point, Point, Point],
  gridSize: number,
): void {
  const [sTL, sTR, sBR, sBL] = srcCorners;
  const [dTL, dTR, dBR, dBL] = dstCorners;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const u0 = col / gridSize;
      const u1 = (col + 1) / gridSize;
      const v0 = row / gridSize;
      const v1 = (row + 1) / gridSize;

      // Bilinear interpolation for source and destination quad
      const sP00 = bilinear(sTL, sTR, sBR, sBL, u0, v0);
      const sP10 = bilinear(sTL, sTR, sBR, sBL, u1, v0);
      const sP01 = bilinear(sTL, sTR, sBR, sBL, u0, v1);
      const sP11 = bilinear(sTL, sTR, sBR, sBL, u1, v1);

      const dP00 = bilinear(dTL, dTR, dBR, dBL, u0, v0);
      const dP10 = bilinear(dTL, dTR, dBR, dBL, u1, v0);
      const dP01 = bilinear(dTL, dTR, dBR, dBL, u0, v1);
      const dP11 = bilinear(dTL, dTR, dBR, dBL, u1, v1);

      // Draw two triangles per cell
      drawTexturedTriangle(ctx, sourceCanvas, sP00, sP10, sP01, dP00, dP10, dP01);
      drawTexturedTriangle(ctx, sourceCanvas, sP10, sP11, sP01, dP10, dP11, dP01);
    }
  }
}

/** Bilinear interpolation across a quad. */
function bilinear(tl: Point, tr: Point, br: Point, bl: Point, u: number, v: number): Point {
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/**
 * Draw a single textured triangle using affine transform.
 * Maps source triangle (s0,s1,s2) onto destination triangle (d0,d1,d2).
 */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  s0: Point, s1: Point, s2: Point,
  d0: Point, d1: Point, d2: Point,
): void {
  // Source triangle edges
  const sx0 = s1.x - s0.x, sy0 = s1.y - s0.y;
  const sx1 = s2.x - s0.x, sy1 = s2.y - s0.y;
  // Destination triangle edges
  const dx0 = d1.x - d0.x, dy0 = d1.y - d0.y;
  const dx1 = d2.x - d0.x, dy1 = d2.y - d0.y;

  const det = sx0 * sy1 - sx1 * sy0;
  if (Math.abs(det) < 1e-10) return; // degenerate triangle

  // Inverse of source matrix
  const idet = 1 / det;
  const a = sy1 * idet, b = -sx1 * idet;
  const c = -sy0 * idet, d = sx0 * idet;

  // Affine transform: src → dst
  const ma = a * dx0 + c * dx1;
  const mb = b * dx0 + d * dx1;
  const mc = a * dy0 + c * dy1;
  const md = b * dy0 + d * dy1;
  const me = d0.x - ma * s0.x - mb * s0.y;
  const mf = d0.y - mc * s0.x - md * s0.y;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(ma, mc, mb, md, me, mf);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/transform/transform-math.ts
git commit -m "feat(transform): add matrix composition and perspective mesh warp math"
```

---

### Task 3: Create Transform Handles Utilities

**Files:**
- Create: `src/transform/transform-handles.ts`

Handle positioning, hit-testing, and drawing. Extracted so the manager itself stays focused on state and pointer logic.

- [ ] **Step 1: Create `src/transform/transform-handles.ts`**

```typescript
import type { Point } from '../types.js';
import type { HandleType, HandleConfig, TransformState } from './transform-types.js';
import { localToDoc, docToLocal, getTransformCenter } from './transform-math.js';

/** Positions of 8 resize handles in local (untransformed) space. */
function getLocalHandlePositions(w: number, h: number): Record<HandleType, Point> {
  return {
    nw: { x: 0, y: 0 },
    n:  { x: w / 2, y: 0 },
    ne: { x: w, y: 0 },
    e:  { x: w, y: h / 2 },
    se: { x: w, y: h },
    s:  { x: w / 2, y: h },
    sw: { x: 0, y: h },
    w:  { x: 0, y: h / 2 },
  };
}

/**
 * Get handle positions in document space (after transform).
 */
export function getDocHandlePositions(state: TransformState): Record<HandleType, Point> {
  const local = getLocalHandlePositions(state.width, state.height);
  const result = {} as Record<HandleType, Point>;
  for (const [key, lp] of Object.entries(local)) {
    result[key as HandleType] = localToDoc(lp, state);
  }
  return result;
}

/**
 * Get the rotation handle position in document space.
 */
export function getRotationHandlePos(
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): Point {
  const topCenter = localToDoc({ x: state.width / 2, y: 0 }, state);
  const center = getTransformCenter(state);
  const dx = topCenter.x - center.x;
  const dy = topCenter.y - center.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return topCenter;
  const offsetPx = config.rotationStemLength / zoom;
  return {
    x: topCenter.x + (dx / len) * offsetPx,
    y: topCenter.y + (dy / len) * offsetPx,
  };
}

/**
 * Hit-test the 8 resize handles. Returns the handle type or null.
 */
export function hitTestHandle(
  docPoint: Point,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): HandleType | null {
  const positions = getDocHandlePositions(state);
  const hitDist = config.hitRadius / zoom;

  for (const [key, hp] of Object.entries(positions)) {
    const dx = docPoint.x - hp.x;
    const dy = docPoint.y - hp.y;
    if (dx * dx + dy * dy <= hitDist * hitDist) {
      return key as HandleType;
    }
  }
  return null;
}

/**
 * Hit-test the rotation handle.
 */
export function hitTestRotationHandle(
  docPoint: Point,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): boolean {
  const hp = getRotationHandlePos(state, config, zoom);
  const hitDist = config.hitRadius / zoom;
  const dx = docPoint.x - hp.x;
  const dy = docPoint.y - hp.y;
  return dx * dx + dy * dy <= hitDist * hitDist;
}

/**
 * Test if a document-space point is inside the transformed bounding box.
 */
export function isInsideTransform(docPoint: Point, state: TransformState): boolean {
  const local = docToLocal(docPoint, state);
  return local.x >= 0 && local.x <= state.width && local.y >= 0 && local.y <= state.height;
}

/**
 * Draw all 8 resize handles on a viewport-space canvas context.
 * The context should already have viewport transforms applied (pan + zoom).
 */
export function drawHandles(
  ctx: CanvasRenderingContext2D,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): void {
  const positions = getDocHandlePositions(state);
  const halfSize = config.size / 2 / zoom;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / zoom;

  for (const hp of Object.values(positions)) {
    if (config.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, halfSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(hp.x - halfSize, hp.y - halfSize, halfSize * 2, halfSize * 2);
      ctx.strokeRect(hp.x - halfSize, hp.y - halfSize, halfSize * 2, halfSize * 2);
    }
  }
  ctx.restore();
}

/**
 * Draw the rotation handle (stem line + circle) on a viewport-space context.
 */
export function drawRotationHandle(
  ctx: CanvasRenderingContext2D,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): void {
  const topCenter = localToDoc({ x: state.width / 2, y: 0 }, state);
  const handlePos = getRotationHandlePos(state, config, zoom);
  const radius = (config.shape === 'circle' ? 8 : 6) / zoom;

  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 / zoom;
  ctx.fillStyle = '#ffffff';

  // Stem line
  ctx.beginPath();
  ctx.moveTo(topCenter.x, topCenter.y);
  ctx.lineTo(handlePos.x, handlePos.y);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(handlePos.x, handlePos.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Draw the commit/cancel floating toolbar on the preview canvas.
 * Positioned near top-right of the bounding box.
 * @param ctx - Preview canvas context (viewport space, already has pan+zoom applied)
 * @param onCommit - Callback when commit button is clicked (hit-test only, caller handles)
 * @param onCancel - Callback when cancel button is clicked (hit-test only, caller handles)
 * @returns { commitRect, cancelRect } in document space for hit-testing
 */
export function getCommitCancelPositions(
  state: TransformState,
  zoom: number,
): { commitCenter: Point; cancelCenter: Point; buttonRadius: number } {
  // Position near top-right corner, offset outside the bounding box
  const tr = localToDoc({ x: state.width, y: 0 }, state);
  const center = getTransformCenter(state);
  // Offset direction: away from center, toward top-right
  const dx = tr.x - center.x;
  const dy = tr.y - center.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const offsetPx = 30 / zoom;
  const buttonRadius = 12 / zoom;
  const gap = 28 / zoom;

  const baseX = len > 1 ? tr.x + (dx / len) * offsetPx : tr.x + offsetPx;
  const baseY = len > 1 ? tr.y + (dy / len) * offsetPx : tr.y - offsetPx;

  return {
    commitCenter: { x: baseX, y: baseY },
    cancelCenter: { x: baseX + gap, y: baseY },
    buttonRadius,
  };
}

/**
 * Draw commit (checkmark) and cancel (X) buttons.
 */
export function drawCommitCancelButtons(
  ctx: CanvasRenderingContext2D,
  state: TransformState,
  zoom: number,
): void {
  const { commitCenter, cancelCenter, buttonRadius } = getCommitCancelPositions(state, zoom);

  ctx.save();

  // Commit button (green circle + checkmark)
  ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
  ctx.beginPath();
  ctx.arc(commitCenter.x, commitCenter.y, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / zoom;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const cs = buttonRadius * 0.45;
  ctx.moveTo(commitCenter.x - cs, commitCenter.y);
  ctx.lineTo(commitCenter.x - cs * 0.2, commitCenter.y + cs * 0.7);
  ctx.lineTo(commitCenter.x + cs, commitCenter.y - cs * 0.5);
  ctx.stroke();

  // Cancel button (red circle + X)
  ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
  ctx.beginPath();
  ctx.arc(cancelCenter.x, cancelCenter.y, buttonRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  const xs = buttonRadius * 0.35;
  ctx.moveTo(cancelCenter.x - xs, cancelCenter.y - xs);
  ctx.lineTo(cancelCenter.x + xs, cancelCenter.y + xs);
  ctx.moveTo(cancelCenter.x + xs, cancelCenter.y - xs);
  ctx.lineTo(cancelCenter.x - xs, cancelCenter.y + xs);
  ctx.stroke();

  ctx.restore();
}

/**
 * Get the CSS cursor for a given document-space point.
 */
export function getCursorForPoint(
  docPoint: Point,
  state: TransformState,
  config: HandleConfig,
  zoom: number,
): string {
  // Check rotation handle first
  if (hitTestRotationHandle(docPoint, state, config, zoom)) {
    return 'grab';
  }

  // Check resize handles
  const handle = hitTestHandle(docPoint, state, config, zoom);
  if (handle) {
    // Rotate the cursor direction by the transform rotation
    const cursors: Record<HandleType, string> = {
      nw: 'nwse-resize', ne: 'nesw-resize', se: 'nwse-resize', sw: 'nesw-resize',
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    };
    return cursors[handle];
  }

  // Check inside transform
  if (isInsideTransform(docPoint, state)) {
    return 'move';
  }

  // Outside — rotation cursor
  return 'crosshair';
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/transform/transform-handles.ts
git commit -m "feat(transform): add handle hit-testing, drawing, and cursor utilities"
```

---

### Task 4: Create TransformManager — Core State and Move/Resize/Rotate

**Files:**
- Create: `src/transform/transform-manager.ts`

The core class. This task implements the constructor, state management, matrix composition, and the three migrated interactions: move, resize, and rotate. Skew and perspective come in Task 7.

- [ ] **Step 1: Create `src/transform/transform-manager.ts`**

This is a large file. Structure:
1. Constructor: takes source ImageData, source rect, preview canvas, viewport params
2. State: TransformState, original source canvas, temp canvas for resampled output
3. `onPointerDown/Move/Up`: dispatch to interaction handlers based on hit-test
4. Move: translate x/y, shift constrains to axis
5. Resize: 8 handles, shift = proportional for corners, min size enforcement
6. Rotate: angle from center, shift snaps to 15deg
7. `renderPreview()`: draw marching ants + handles + rotation handle + commit/cancel buttons
8. `renderTransformed()`: draw the transformed image to a context
9. `commit()` / `cancel()` / `hasChanged()`
10. Getters/setters for numeric panel binding

```typescript
import type { Point } from '../types.js';
import {
  type HandleType, type HandleConfig, type TransformState, type TransformInteraction,
  type PerspectiveCorners, type TransformRect,
  HANDLE_CONFIG_DESKTOP, HANDLE_CONFIG_TOUCH, MIN_TRANSFORM_SIZE, OUTSIDE_DRAG_THRESHOLD,
} from './transform-types.js';
import {
  composeMatrix, docToLocal, localToDoc, getTransformCenter,
  snapAngle, constrainToAxis, drawPerspectiveMesh, getPerspectiveDestCorners,
} from './transform-math.js';
import {
  hitTestHandle, hitTestRotationHandle, isInsideTransform,
  getDocHandlePositions, getRotationHandlePos, getCommitCancelPositions,
  drawHandles, drawRotationHandle, drawCommitCancelButtons, getCursorForPoint,
} from './transform-handles.js';
import { drawSelectionRect } from '../tools/select.js';

export class TransformManager {
  // --- Source data ---
  private _sourceImageData: ImageData;
  private _sourceRect: TransformRect;
  private _sourceCanvas: HTMLCanvasElement; // Full-res source for quality resampling
  private _tempCanvas: HTMLCanvasElement;   // Resampled at current transform size

  // --- Transform state ---
  private _state: TransformState;
  private _initialState: TransformState; // Snapshot for hasChanged() comparison

  // --- Perspective ---
  private _perspectiveCorners: PerspectiveCorners = {
    nw: { x: 0, y: 0 }, ne: { x: 0, y: 0 }, se: { x: 0, y: 0 }, sw: { x: 0, y: 0 },
  };
  private _perspectiveActive = false;

  // --- Interaction ---
  private _interaction: TransformInteraction = { type: 'idle' };
  private _handleConfig: HandleConfig = HANDLE_CONFIG_DESKTOP;

  // --- Rendering ---
  private _previewCanvas: HTMLCanvasElement;
  private _zoom: number;
  private _pan: Point;
  private _dashOffset = 0;
  private _animFrame: number | null = null;

  constructor(
    source: ImageData,
    sourceRect: TransformRect,
    previewCanvas: HTMLCanvasElement,
    zoom: number,
    pan: Point,
  ) {
    this._sourceImageData = source;
    this._sourceRect = sourceRect;
    this._previewCanvas = previewCanvas;
    this._zoom = zoom;
    this._pan = pan;

    // Create source canvas at original resolution
    this._sourceCanvas = document.createElement('canvas');
    this._sourceCanvas.width = source.width;
    this._sourceCanvas.height = source.height;
    this._sourceCanvas.getContext('2d')!.putImageData(source, 0, 0);

    // Create temp canvas (initially same size as source)
    this._tempCanvas = document.createElement('canvas');
    this._tempCanvas.width = source.width;
    this._tempCanvas.height = source.height;
    this._tempCanvas.getContext('2d')!.drawImage(this._sourceCanvas, 0, 0);

    // Initialize transform state
    this._state = {
      x: sourceRect.x,
      y: sourceRect.y,
      width: sourceRect.w,
      height: sourceRect.h,
      rotation: 0,
      skewX: 0,
      skewY: 0,
      scaleX: 1,
      scaleY: 1,
    };
    this._initialState = { ...this._state };

    this._startAnimation();
  }

  // --- Public getters/setters for numeric panel ---

  get x(): number { return this._state.x; }
  set x(v: number) { this._state.x = v; this._onChange(); }

  get y(): number { return this._state.y; }
  set y(v: number) { this._state.y = v; this._onChange(); }

  get width(): number { return Math.abs(this._state.width * this._state.scaleX); }
  set width(v: number) {
    if (v <= 0) return;
    this._state.scaleX = (this._state.scaleX < 0 ? -1 : 1) * v / this._state.width;
    this._rebuildTempCanvas();
    this._onChange();
  }

  get height(): number { return Math.abs(this._state.height * this._state.scaleY); }
  set height(v: number) {
    if (v <= 0) return;
    this._state.scaleY = (this._state.scaleY < 0 ? -1 : 1) * v / this._state.height;
    this._rebuildTempCanvas();
    this._onChange();
  }

  /** Rotation in degrees for the numeric panel */
  get rotation(): number { return (this._state.rotation * 180) / Math.PI; }
  set rotation(deg: number) {
    this._state.rotation = (deg * Math.PI) / 180;
    this._onChange();
  }

  get skewX(): number { return this._state.skewX; }
  set skewX(v: number) { this._state.skewX = Math.max(-89, Math.min(89, v)); this._onChange(); }

  get skewY(): number { return this._state.skewY; }
  set skewY(v: number) { this._state.skewY = Math.max(-89, Math.min(89, v)); this._onChange(); }

  get flipH(): boolean { return this._state.scaleX < 0; }
  set flipH(v: boolean) {
    const shouldBeNeg = v;
    const isNeg = this._state.scaleX < 0;
    if (shouldBeNeg !== isNeg) {
      this._state.scaleX = -this._state.scaleX;
      this._rebuildTempCanvas();
      this._onChange();
    }
  }

  get flipV(): boolean { return this._state.scaleY < 0; }
  set flipV(v: boolean) {
    const shouldBeNeg = v;
    const isNeg = this._state.scaleY < 0;
    if (shouldBeNeg !== isNeg) {
      this._state.scaleY = -this._state.scaleY;
      this._rebuildTempCanvas();
      this._onChange();
    }
  }

  /** Whether perspective mode has been activated */
  get perspectiveActive(): boolean { return this._perspectiveActive; }

  // --- Touch detection ---

  setTouchMode(touch: boolean): void {
    this._handleConfig = touch ? HANDLE_CONFIG_TOUCH : HANDLE_CONFIG_DESKTOP;
  }

  // --- Pointer event handlers ---

  /**
   * Handle pointer down. Returns true if the event was consumed (hit a handle,
   * inside bounds, or outside for potential rotate/commit).
   */
  onPointerDown(docPoint: Point, modifiers: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    // Check commit/cancel buttons first
    const buttons = getCommitCancelPositions(this._state, this._zoom);
    const commitDist = Math.hypot(docPoint.x - buttons.commitCenter.x, docPoint.y - buttons.commitCenter.y);
    if (commitDist <= buttons.buttonRadius) {
      return true; // Signal: commit (caller checks via isCommitClick/isCancelClick)
    }
    const cancelDist = Math.hypot(docPoint.x - buttons.cancelCenter.x, docPoint.y - buttons.cancelCenter.y);
    if (cancelDist <= buttons.buttonRadius) {
      return true; // Signal: cancel
    }

    // Rotation handle
    if (hitTestRotationHandle(docPoint, this._state, this._handleConfig, this._zoom)) {
      const center = getTransformCenter(this._state);
      const startAngle = Math.atan2(docPoint.y - center.y, docPoint.x - center.x);
      this._interaction = {
        type: 'rotating',
        startAngle,
        startRotation: this._state.rotation,
      };
      return true;
    }

    // Resize handles
    const handle = hitTestHandle(docPoint, this._state, this._handleConfig, this._zoom);
    if (handle) {
      if (modifiers.ctrl && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
        // Perspective mode: independent corner drag
        this._perspectiveActive = true;
        this._interaction = { type: 'perspective', corner: handle, startPoint: docPoint };
      } else if (modifiers.ctrl && (handle === 'n' || handle === 'e' || handle === 's' || handle === 'w')) {
        // Skew mode: drag edge
        this._interaction = {
          type: 'skewing',
          edge: handle,
          startPoint: docPoint,
          startSkewX: this._state.skewX,
          startSkewY: this._state.skewY,
        };
      } else {
        // Normal resize
        this._interaction = {
          type: 'resizing',
          handle,
          origin: {
            rect: { x: this._state.x, y: this._state.y, w: this._state.width, h: this._state.height },
            point: docPoint,
          },
        };
      }
      return true;
    }

    // Inside bounds — move
    if (isInsideTransform(docPoint, this._state)) {
      this._interaction = {
        type: 'moving',
        startPoint: docPoint,
        startX: this._state.x,
        startY: this._state.y,
      };
      return true;
    }

    // Outside bounds — record for click-vs-drag disambiguation
    this._interaction = { type: 'outside-pending', startPoint: docPoint };
    return true;
  }

  onPointerMove(docPoint: Point, modifiers: { shift: boolean; ctrl: boolean; alt: boolean }): void {
    switch (this._interaction.type) {
      case 'moving':
        this._handleMove(docPoint, modifiers);
        break;
      case 'resizing':
        this._handleResize(docPoint, modifiers);
        break;
      case 'rotating':
        this._handleRotate(docPoint, modifiers);
        break;
      case 'skewing':
        this._handleSkew(docPoint);
        break;
      case 'perspective':
        this._handlePerspective(docPoint);
        break;
      case 'outside-pending': {
        // Check if moved past threshold — switch to rotating
        const dx = docPoint.x - this._interaction.startPoint.x;
        const dy = docPoint.y - this._interaction.startPoint.y;
        const distVp = Math.sqrt(dx * dx + dy * dy) * this._zoom;
        if (distVp > OUTSIDE_DRAG_THRESHOLD) {
          const center = getTransformCenter(this._state);
          const startAngle = Math.atan2(
            this._interaction.startPoint.y - center.y,
            this._interaction.startPoint.x - center.x,
          );
          this._interaction = {
            type: 'rotating',
            startAngle,
            startRotation: this._state.rotation,
          };
          this._handleRotate(docPoint, modifiers);
        }
        break;
      }
    }
  }

  /**
   * Handle pointer up. Returns 'commit' if user clicked outside (within threshold),
   * 'commit-button' / 'cancel-button' if they clicked a button, or null otherwise.
   */
  onPointerUp(docPoint: Point): 'commit' | 'cancel-button' | 'commit-button' | null {
    // Check button clicks
    const buttons = getCommitCancelPositions(this._state, this._zoom);
    const commitDist = Math.hypot(docPoint.x - buttons.commitCenter.x, docPoint.y - buttons.commitCenter.y);
    if (commitDist <= buttons.buttonRadius) {
      this._interaction = { type: 'idle' };
      return 'commit-button';
    }
    const cancelDist = Math.hypot(docPoint.x - buttons.cancelCenter.x, docPoint.y - buttons.cancelCenter.y);
    if (cancelDist <= buttons.buttonRadius) {
      this._interaction = { type: 'idle' };
      return 'cancel-button';
    }

    const result: 'commit' | null =
      this._interaction.type === 'outside-pending' ? 'commit' : null;

    this._interaction = { type: 'idle' };
    return result;
  }

  // --- Private interaction handlers ---

  private _handleMove(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'moving') return;

    let dx = docPoint.x - inter.startPoint.x;
    let dy = docPoint.y - inter.startPoint.y;

    if (modifiers.shift) {
      // Constrain to axis
      if (Math.abs(dx) > Math.abs(dy)) {
        dy = 0;
      } else {
        dx = 0;
      }
    }

    this._state.x = inter.startX + dx;
    this._state.y = inter.startY + dy;
    this._onChange();
  }

  private _handleResize(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'resizing') return;

    const { handle, origin } = inter;
    const { rect, point: startPoint } = origin;

    // Work in local (unrotated) space for the delta
    const localCurrent = docToLocal(docPoint, this._state);
    const localStart = docToLocal(startPoint, this._state);
    const dx = localCurrent.x - localStart.x;
    const dy = localCurrent.y - localStart.y;

    let newX = rect.x, newY = rect.y, newW = rect.w, newH = rect.h;

    // Apply resize based on handle
    if (handle.includes('e')) { newW = rect.w + dx; }
    if (handle.includes('w')) { newX = rect.x + dx; newW = rect.w - dx; }
    if (handle.includes('s')) { newH = rect.h + dy; }
    if (handle.includes('n')) { newY = rect.y + dy; newH = rect.h - dy; }

    // Proportional resize for corners with Shift
    if (modifiers.shift && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
      const aspect = rect.w / rect.h;
      if (Math.abs(newW / newH) > aspect) {
        newH = newW / aspect;
      } else {
        newW = newH * aspect;
      }
    }

    // Enforce minimum size
    const minSize = MIN_TRANSFORM_SIZE / this._zoom;
    if (Math.abs(newW) < minSize) newW = newW < 0 ? -minSize : minSize;
    if (Math.abs(newH) < minSize) newH = newH < 0 ? -minSize : minSize;

    this._state.x = newX;
    this._state.y = newY;
    this._state.width = Math.abs(newW);
    this._state.height = Math.abs(newH);

    // Handle flips from dragging past opposite edge
    if (newW < 0) this._state.scaleX = -Math.abs(this._state.scaleX);
    if (newH < 0) this._state.scaleY = -Math.abs(this._state.scaleY);

    this._rebuildTempCanvas();
    this._onChange();
  }

  private _handleRotate(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'rotating') return;

    const center = getTransformCenter(this._state);
    const currentAngle = Math.atan2(docPoint.y - center.y, docPoint.x - center.x);
    let newRotation = inter.startRotation + (currentAngle - inter.startAngle);

    if (modifiers.shift) {
      newRotation = snapAngle(newRotation, Math.PI / 12); // 15 degrees
    }

    this._state.rotation = newRotation;
    this._onChange();
  }

  private _handleSkew(docPoint: Point): void {
    const inter = this._interaction;
    if (inter.type !== 'skewing') return;

    const dx = docPoint.x - inter.startPoint.x;
    const dy = docPoint.y - inter.startPoint.y;

    // Horizontal edges (n, s) → skewX, vertical edges (e, w) → skewY
    if (inter.edge === 'n' || inter.edge === 's') {
      const sign = inter.edge === 'n' ? -1 : 1;
      this._state.skewX = Math.max(-89, Math.min(89, inter.startSkewX + sign * dx * 0.5));
    } else {
      const sign = inter.edge === 'w' ? -1 : 1;
      this._state.skewY = Math.max(-89, Math.min(89, inter.startSkewY + sign * dy * 0.5));
    }
    this._onChange();
  }

  private _handlePerspective(docPoint: Point): void {
    const inter = this._interaction;
    if (inter.type !== 'perspective') return;

    const dx = docPoint.x - inter.startPoint.x;
    const dy = docPoint.y - inter.startPoint.y;

    this._perspectiveCorners[inter.corner] = { x: dx, y: dy };
    this._onChange();
  }

  // --- Rendering ---

  /** Render handles, marching ants, and buttons onto the preview canvas. */
  renderPreview(): void {
    const ctx = this._previewCanvas.getContext('2d')!;
    const w = this._previewCanvas.width;
    const h = this._previewCanvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this._pan.x, this._pan.y);
    ctx.scale(this._zoom, this._zoom);

    // Draw selection rect (marching ants) along transformed edges
    const corners = this._perspectiveActive
      ? getPerspectiveDestCorners(this._state, this._perspectiveCorners)
      : [
          localToDoc({ x: 0, y: 0 }, this._state),
          localToDoc({ x: this._state.width, y: 0 }, this._state),
          localToDoc({ x: this._state.width, y: this._state.height }, this._state),
          localToDoc({ x: 0, y: this._state.height }, this._state),
        ];

    // Draw marching ants border
    ctx.save();
    ctx.lineWidth = 1 / this._zoom;
    ctx.setLineDash([6 / this._zoom, 6 / this._zoom]);

    // White base
    ctx.strokeStyle = '#ffffff';
    ctx.lineDashOffset = 0;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();

    // Blue overlay with animation
    ctx.strokeStyle = '#3b82f6';
    ctx.lineDashOffset = this._dashOffset / this._zoom;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Draw resize handles
    drawHandles(ctx, this._state, this._handleConfig, this._zoom);

    // Draw rotation handle
    drawRotationHandle(ctx, this._state, this._handleConfig, this._zoom);

    // Draw commit/cancel buttons
    drawCommitCancelButtons(ctx, this._state, this._zoom);

    ctx.restore();
  }

  /**
   * Draw the transformed image onto a target context (used by composite()).
   * The context may already have pan/zoom transforms applied, so we use
   * ctx.transform() (multiplies with existing matrix) NOT ctx.setTransform()
   * (which would replace it and clobber pan/zoom).
   */
  renderTransformed(ctx: CanvasRenderingContext2D): void {
    if (this._perspectiveActive) {
      // Perspective mesh: drawPerspectiveMesh uses setTransform() per triangle
      // internally, which would clobber the caller's pan/zoom matrix. To avoid
      // coordinate space mismatches, render perspective to an intermediate
      // offscreen canvas in pure document space (identity transform), then
      // draw that canvas onto ctx where the existing pan/zoom handles placement.
      const srcCorners: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: this._sourceCanvas.width, y: 0 },
        { x: this._sourceCanvas.width, y: this._sourceCanvas.height },
        { x: 0, y: this._sourceCanvas.height },
      ];
      const dstCorners = getPerspectiveDestCorners(this._state, this._perspectiveCorners);
      const gridSize = 8; // Interactive quality

      // Compute bounding box of destination corners for offscreen canvas size
      const xs = dstCorners.map(c => c.x), ys = dstCorners.map(c => c.y);
      const minX = Math.floor(Math.min(...xs)), minY = Math.floor(Math.min(...ys));
      const maxX = Math.ceil(Math.max(...xs)), maxY = Math.ceil(Math.max(...ys));
      const offW = maxX - minX, offH = maxY - minY;

      if (offW > 0 && offH > 0) {
        const offscreen = document.createElement('canvas');
        offscreen.width = offW;
        offscreen.height = offH;
        const offCtx = offscreen.getContext('2d')!;
        // Translate so the mesh draws relative to the offscreen canvas origin
        offCtx.translate(-minX, -minY);
        drawPerspectiveMesh(offCtx, this._sourceCanvas, srcCorners, dstCorners, gridSize);
        // Draw the offscreen canvas onto the target context at the correct position
        // ctx already has pan/zoom applied, so drawImage coordinates are in doc space
        ctx.drawImage(offscreen, minX, minY);
      }
    } else {
      // Use DOMMatrix for affine transforms.
      // IMPORTANT: use ctx.transform() to multiply with existing matrix,
      // not ctx.setTransform() which would clobber the caller's pan/zoom.
      const matrix = composeMatrix(this._state);
      ctx.save();
      ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.drawImage(this._sourceCanvas, 0, 0, this._state.width, this._state.height);
      ctx.restore();
    }
  }

  // --- Lifecycle ---

  /**
   * Commit the transform by drawing onto the layer canvas.
   * For perspective, uses high-quality mesh (32x32).
   *
   * NOTE: This method correctly uses setTransform() (absolute) because the
   * layer canvas has an identity transform (no pan/zoom). This differs from
   * renderTransformed() which uses ctx.transform() (relative) because the
   * display canvas already has pan/zoom applied. Do not "fix" one to match
   * the other — they serve different contexts.
   */
  commit(layerCanvas: HTMLCanvasElement): void {
    const ctx = layerCanvas.getContext('2d')!;

    if (this._perspectiveActive) {
      const srcCorners: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: this._sourceCanvas.width, y: 0 },
        { x: this._sourceCanvas.width, y: this._sourceCanvas.height },
        { x: 0, y: this._sourceCanvas.height },
      ];
      const dstCorners = getPerspectiveDestCorners(this._state, this._perspectiveCorners);
      drawPerspectiveMesh(ctx, this._sourceCanvas, srcCorners, dstCorners, 32);
    } else {
      const matrix = composeMatrix(this._state);
      ctx.save();
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.drawImage(this._sourceCanvas, 0, 0, this._state.width, this._state.height);
      ctx.restore();
    }

    this._stopAnimation();
  }

  /** Cancel the transform. Returns the original source ImageData. */
  cancel(): ImageData {
    this._stopAnimation();
    return this._sourceImageData;
  }

  /** True if any transform parameter has changed from the initial state. */
  hasChanged(): boolean {
    const s = this._state;
    const i = this._initialState;
    return s.x !== i.x || s.y !== i.y || s.width !== i.width || s.height !== i.height ||
      s.rotation !== i.rotation || s.skewX !== i.skewX || s.skewY !== i.skewY ||
      s.scaleX !== i.scaleX || s.scaleY !== i.scaleY || this._perspectiveActive;
  }

  /** Get the current transform state (read-only snapshot for numeric panel). */
  getState(): Readonly<TransformState> {
    return this._state;
  }

  /** Get the original source rect (position before any transforms). Used by cancel. */
  getSourceRect(): Readonly<TransformRect> {
    return this._sourceRect;
  }

  // --- Viewport ---

  updateViewport(zoom: number, pan: Point): void {
    this._zoom = zoom;
    this._pan = pan;
  }

  getCursor(docPoint: Point): string {
    // Check buttons first
    const buttons = getCommitCancelPositions(this._state, this._zoom);
    const commitDist = Math.hypot(docPoint.x - buttons.commitCenter.x, docPoint.y - buttons.commitCenter.y);
    if (commitDist <= buttons.buttonRadius) return 'pointer';
    const cancelDist = Math.hypot(docPoint.x - buttons.cancelCenter.x, docPoint.y - buttons.cancelCenter.y);
    if (cancelDist <= buttons.buttonRadius) return 'pointer';

    return getCursorForPoint(docPoint, this._state, this._handleConfig, this._zoom);
  }

  // --- Private helpers ---

  private _rebuildTempCanvas(): void {
    const w = Math.max(1, Math.round(Math.abs(this._state.width * this._state.scaleX)));
    const h = Math.max(1, Math.round(Math.abs(this._state.height * this._state.scaleY)));
    this._tempCanvas.width = w;
    this._tempCanvas.height = h;
    this._tempCanvas.getContext('2d')!.drawImage(this._sourceCanvas, 0, 0, w, h);
  }

  private _onChange(): void {
    // Trigger re-render of preview and composite
    this.renderPreview();
  }

  private _startAnimation(): void {
    const animate = () => {
      this._dashOffset = (this._dashOffset + 0.5) % 12;
      this.renderPreview();
      this._animFrame = requestAnimationFrame(animate);
    };
    this._animFrame = requestAnimationFrame(animate);
  }

  private _stopAnimation(): void {
    if (this._animFrame !== null) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }

  dispose(): void {
    this._stopAnimation();
  }
}
```

**Note:** This file contains all the logic. The implementer should type this out following the interfaces from transform-types.ts and import the math/handle utilities. The exact resize math for handle dragging may need refinement during integration testing — the existing `_applyResize` in drawing-canvas.ts (lines 2646-2729) is the reference implementation.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/transform/transform-manager.ts
git commit -m "feat(transform): add TransformManager with move, resize, rotate, skew, perspective"
```

---

### Task 5: Add 'transform' History Entry Type

**Files:**
- Modify: `src/types.ts:75-99` — Add `transform` variant to `HistoryEntry` union

- [ ] **Step 1: Add the transform history entry variant**

In `src/types.ts`, add to the `HistoryEntry` union (after the existing `blend-mode` entry around line 99):

```typescript
  | { type: 'transform'; layerId: string; before: ImageData; after: ImageData }
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(transform): add 'transform' history entry type"
```

---

### Task 6: Add Transform State to Context

**Files:**
- Modify: `src/contexts/drawing-context.ts:6-58` — Add `transformActive` and `enterTransform` to `DrawingContextValue`
- Modify: `src/components/drawing-app.ts` — Wire the new context fields

The `tool-settings` panel needs to know when transform mode is active (since `activeTool` doesn't change). We add a `transformActive` boolean and an `enterTransform` callback to the context.

- [ ] **Step 1: Add to `DrawingContextValue` interface**

In `src/contexts/drawing-context.ts`, add these fields to the interface:

```typescript
  /** True when the TransformManager is active */
  transformActive: boolean;
  /** Enter free transform mode on current selection or active layer */
  enterTransform: () => void;
```

- [ ] **Step 2: Wire in drawing-app.ts**

In `drawing-app.ts` `_buildContextValue()` method (around line 826-1177), add:

```typescript
  transformActive: this.canvas?.isTransformActive() ?? false,
  enterTransform: () => this.canvas?.enterTransformMode(),
```

This requires `drawing-canvas` to expose two new public methods: `isTransformActive()` and `enterTransformMode()`. These will be implemented in Task 7.

- [ ] **Step 3: Set defaults in the initial context value**

In `drawing-app.ts`, wherever the initial/default context value is created (constructor around line 183), add:

```typescript
  transformActive: false,
  enterTransform: () => {},
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: May have errors from missing `isTransformActive`/`enterTransformMode` methods — that's expected, will be resolved in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/drawing-context.ts src/components/drawing-app.ts
git commit -m "feat(transform): add transformActive and enterTransform to context"
```

---

### Task 7: Integrate TransformManager into drawing-canvas

**Files:**
- Modify: `src/components/drawing-canvas.ts` — Replace float code with TransformManager

This is the largest and riskiest task. It replaces the existing float state and methods with delegation to `TransformManager`.

**Strategy:** Do this in sub-steps. First add the manager field and new public methods. Then rewire pointer events. Then rewire composite(). Then remove old float code.

- [ ] **Step 1: Add TransformManager field and public methods**

At the top of the `DrawingCanvas` class in `drawing-canvas.ts`:

```typescript
import { TransformManager } from '../transform/transform-manager.js';
```

Add a new private field (near the existing `_float` field around line 95):

```typescript
private _transformManager: TransformManager | null = null;
```

Add public methods:

```typescript
/** Whether transform mode is currently active */
isTransformActive(): boolean {
  return this._transformManager !== null;
}

/** Enter transform mode on current selection or active layer */
enterTransformMode(): void {
  if (this._transformManager) return; // Already in transform mode

  const layer = this._getActiveLayer();
  if (!layer) return;

  const ctx = layer.canvas.getContext('2d')!;

  if (this._float) {
    // Already have a floating selection — wrap it in a TransformManager
    // (This handles the case where user makes selection, then hits Cmd+T)
    //
    // IMPORTANT: Only capture before-draw state if not already set.
    // When entering from a float, _beforeDrawData was already captured by
    // _liftToFloat() and holds the full layer BEFORE the selection hole was
    // cut. Overwriting it would capture the layer-with-hole state, breaking
    // both cancel (restores hole) and undo (restores hole). Guard matches
    // the pattern in _commitFloat (line 2574) and pasteSelection (line 2867).
    if (!this._beforeDrawData) this._captureBeforeDraw();

    this._transformManager = new TransformManager(
      this._float.originalImageData,
      this._float.currentRect,
      this._previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    // Transfer rotation if any
    if (this._float.rotation) {
      this._transformManager.rotation = (this._float.rotation * 180) / Math.PI;
    }
    this._clearFloatState();
  } else {
    // No selection — transform entire layer
    const imageData = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    const bounds = detectContentBounds(imageData);
    if (!bounds) return; // Empty layer

    // Capture before-draw state
    this._captureBeforeDraw();

    // Extract the content region
    const regionData = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);

    // Clear the layer
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);

    this._transformManager = new TransformManager(
      regionData,
      bounds,
      this._previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
  }

  // Detect touch
  // (Will be set on first pointer event via pointerType check)

  this.composite();
  this.requestUpdate();
}
```

Also add `import { detectContentBounds } from '../transform/transform-math.js';` at top.

- [ ] **Step 2: Wire pointer events to TransformManager**

In `_onPointerDown()` (around line 1381), add before the existing tool dispatch:

```typescript
// If transform mode is active, delegate to manager
if (this._transformManager) {
  const p = this._getDocPoint(e);
  if (e.pointerType === 'touch') this._transformManager.setTouchMode(true);
  const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  this._transformManager.onPointerDown(p, modifiers);
  this.setPointerCapture(e.pointerId);
  return;
}
```

In `_onPointerMove()` (around line 2057), add before existing float handling:

```typescript
if (this._transformManager) {
  const p = this._getDocPoint(e);
  const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
  this._transformManager.onPointerMove(p, modifiers);
  this.composite();
  return;
}
```

In `_onPointerUp()` (around line 2129), add before existing float handling:

```typescript
if (this._transformManager) {
  const p = this._getDocPoint(e);
  const result = this._transformManager.onPointerUp(p);
  if (result === 'commit' || result === 'commit-button') {
    this._commitTransform();
  } else if (result === 'cancel-button') {
    this._cancelTransform();
  }
  this.composite();
  return;
}
```

- [ ] **Step 3: Add commit/cancel transform methods**

```typescript
private _commitTransform(): void {
  if (!this._transformManager) return;
  const layer = this._getActiveLayer();
  if (!layer) return;

  if (this._transformManager.hasChanged()) {
    this._transformManager.commit(layer.canvas);
    // Push a 'transform' history entry explicitly (not _pushDrawHistory which
    // creates a 'draw' type). This uses the 'transform' variant added in Task 5.
    const after = layer.canvas.getContext('2d')!.getImageData(
      0, 0, layer.canvas.width, layer.canvas.height,
    );
    if (this._beforeDrawData) {
      this._pushHistory({
        type: 'transform',
        layerId: layer.id,
        before: this._beforeDrawData,
        after,
      });
    }
    this._beforeDrawData = null;
  }

  this._transformManager.dispose();
  this._transformManager = null;
  this._previewCanvas.getContext('2d')!.clearRect(
    0, 0, this._previewCanvas.width, this._previewCanvas.height,
  );
  this.composite();
  this.requestUpdate();
}

private _cancelTransform(): void {
  if (!this._transformManager) return;
  const layer = this._getActiveLayer();
  if (!layer) return;

  const originalData = this._transformManager.cancel();
  const ctx = layer.canvas.getContext('2d')!;

  // IMPORTANT: Restore at the ORIGINAL source rect position, not the current
  // (potentially moved) position. getSourceRect() returns where the content
  // was lifted from. For layer transforms, we can also just restore from
  // _beforeDrawData which has the full layer state.
  if (this._beforeDrawData) {
    // Layer transform case: restore full layer from before-draw capture
    ctx.putImageData(this._beforeDrawData, 0, 0);
  } else {
    // Selection float case: restore region at original position
    const srcRect = this._transformManager.getSourceRect();
    ctx.putImageData(originalData, srcRect.x, srcRect.y);
  }

  this._transformManager.dispose();
  this._transformManager = null;
  this._beforeDrawData = null; // Discard the before-draw capture
  this._previewCanvas.getContext('2d')!.clearRect(
    0, 0, this._previewCanvas.width, this._previewCanvas.height,
  );
  this.composite();
  this.requestUpdate();
}
```

- [ ] **Step 4: Wire into composite()**

In the `composite()` method (around lines 277-295 where float is currently rendered), add TransformManager rendering:

```typescript
// Draw transform manager content (replaces float rendering)
if (this._transformManager && layer.id === activeLayerId) {
  this._transformManager.renderTransformed(displayCtx);
}
```

Keep the existing float rendering code for now (it'll be removed in a later step after verifying the manager works).

- [ ] **Step 5: Wire keyboard shortcuts**

In `drawing-canvas.ts`, add handler for Enter and Escape during transform:

In the existing keyboard handler (or add one), when `this._transformManager` is active:
- **Enter**: call `this._commitTransform()`
- **Escape**: call `this._cancelTransform()`

Also in `drawing-app.ts` keyboard handler (around line 580), add Cmd/Ctrl+T:

```typescript
if ((e.ctrlKey || e.metaKey) && e.key === 't') {
  e.preventDefault();
  this.canvas?.enterTransformMode();
  return;
}
```

And wire Escape/Enter when transform is active:

```typescript
if (e.key === 'Escape' && this.canvas?.isTransformActive()) {
  e.preventDefault();
  this.canvas?.cancelTransform(); // Need to expose this as public
  return;
}
if (e.key === 'Enter' && this.canvas?.isTransformActive()) {
  e.preventDefault();
  this.canvas?.commitTransform(); // Need to expose this as public
  return;
}
```

Make `_commitTransform` and `_cancelTransform` public (rename to `commitTransform` and `cancelTransform`).

- [ ] **Step 6: Update viewport on zoom/pan changes**

Wherever `_zoom` or `_panX`/`_panY` are updated in drawing-canvas, add:

```typescript
this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
```

- [ ] **Step 7: Update cursor**

In the cursor update logic of drawing-canvas, when transform manager is active:

```typescript
if (this._transformManager) {
  const p = this._getDocPoint(e);
  this.style.cursor = this._transformManager.getCursor(p);
  return;
}
```

- [ ] **Step 8: Type-check and manual test**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Manual test:
1. Draw something on a layer
2. Press Cmd/Ctrl+T — should enter transform mode with handles
3. Drag inside to move
4. Drag corner to resize
5. Drag outside to rotate
6. Press Enter to commit
7. Press Cmd/Ctrl+Z to undo — should restore pre-transform state
8. Repeat with Escape to cancel — should restore original

- [ ] **Step 9: Commit**

```bash
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(transform): integrate TransformManager into drawing-canvas"
```

---

### Task 8: Remove Old Float Code

**Files:**
- Modify: `src/components/drawing-canvas.ts` — Remove migrated float fields and methods

After verifying Task 7 works, remove the old float code that has been superseded by TransformManager. This includes:

- [ ] **Step 1: Remove old float fields**

Remove these private fields (lines ~95-131):
- `_float`, `_floatSrcCanvas`, `_floatIsExternalImage`
- `_floatMoving`, `_floatResizing`, `_floatResizeHandle`
- `_floatDragOffset`, `_floatResizeOrigin`
- `_floatRotating`, `_floatRotateStartAngle`, `_floatRotateStartRotation`
- `_selectionDashOffset`, `_selectionAnimFrame`

Keep `_clipboard*` fields — those are for copy/paste, not transform.

- [ ] **Step 2: Remove old float methods**

Remove these methods:
- `_toFloatLocal()` (lines 1919-1930)
- `_hitTestHandle()` (lines 1932-1956)
- `_hitTestRotationHandle()` (lines 1959-1979)
- `_isInsideFloat()` (lines 1981-1986)
- `_liftToFloat()` (lines 2437-2469)
- `_commitFloat()` (lines 2569-2597)
- `_clearFloatState()` (lines 2616-2632)
- `_applyResize()` (lines 2646-2729)
- `_rebuildTempCanvas()` (lines 2634-2644)
- `_redrawFloatPreview()` (lines 2731-2759)
- `_startSelectionAnimation()` (lines 2813-2823)
- `_stopSelectionAnimation()`

- [ ] **Step 3: Remove old float rendering from composite()**

Remove the float rendering block in `composite()` (lines 277-295) — it's now handled by the `_transformManager` rendering added in Task 7.

- [ ] **Step 4: Update any remaining references**

Search for `_float` references throughout drawing-canvas.ts and update each one:

**`_handleSelectPointerDown()`** — This is the core select-tool interaction. After removing `_float`, the select tool's "lift and manipulate" flow should delegate to TransformManager:
- When the user completes a selection drag (in `_onPointerUp` for select tool), instead of calling `_liftToFloat()`, call `enterTransformMode()` which creates a TransformManager from the selection rect.
- The existing pointer-down checks for rotation/resize/move inside a float should be removed — those are now handled by the `_transformManager` pointer delegation added in Task 7 Step 2.

**Copy/paste methods** (`copySelection`, `cutSelection`, `paste`, `duplicateInPlace`) — these use `_float` to get current content. Update to check `_transformManager` instead:
- `copySelection`: if `_transformManager` is active, get source ImageData from it
- `cutSelection`: commit transform first, then cut
- `paste`: commit any active transform first, then paste as new transform

**`getFloatSnapshot()`** — used by save logic in drawing-app.ts. Update to return data from `_transformManager` if active (use `renderTransformed()` to a temp canvas).

**`selectAll()`, `selectAllCanvas()`** — these called `_liftToFloat`. Update to use `enterTransformMode()` flow.

**`undo()` method in drawing-canvas.ts** — The existing float-discard-on-undo logic (which checks `_float` and discards it) should be replaced with the equivalent `_transformManager` check: if transform is active, cancel it. This is where the undo-during-transform check belongs (not in drawing-app.ts), since drawing-canvas owns the transform lifecycle.

- [ ] **Step 5: Type-check and manual test**

Run: `npx tsc --noEmit`
Expected: No errors (all references to removed code have been updated)

Run: `npm run dev`
Manual test: Same as Task 7 step 8, plus:
- Make a selection, then Cmd+T — should work
- Copy/paste should still work
- Select all (Cmd+A) should still work
- Save should still work with active transform

- [ ] **Step 6: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "refactor(transform): remove old float code, fully replaced by TransformManager"
```

---

### Task 9: Add Transform Action Button to Toolbar

**Files:**
- Modify: `src/components/tool-icons.ts` — Add transform icon
- Modify: `src/components/app-toolbar.ts` — Add action button

- [ ] **Step 1: Add transform icon to tool-icons.ts**

Add a new exported SVG icon (not in the `toolIcons` dict since it's not a `ToolType`):

```typescript
export const transformIcon = svg`<svg viewBox="0 0 24 24" ...>
  <!-- Bounding box with corner handles and rotation arc -->
  <rect x="4" y="6" width="16" height="12" rx="0.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/>
  <rect x="2.5" y="4.5" width="3" height="3" rx="0.5" fill="currentColor"/>
  <rect x="18.5" y="4.5" width="3" height="3" rx="0.5" fill="currentColor"/>
  <rect x="2.5" y="16.5" width="3" height="3" rx="0.5" fill="currentColor"/>
  <rect x="18.5" y="16.5" width="3" height="3" rx="0.5" fill="currentColor"/>
  <path d="M12 4.5 A3 3 0 0 1 15 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;
```

(The exact SVG paths should be refined to match the existing icon style — this is a starting point.)

- [ ] **Step 2: Add action button to app-toolbar.ts**

In `app-toolbar.ts`, in the first tool group section (around lines 273-283), add a transform action button **after** the tool group buttons. Since it's an action button (not a tool selector), add it to the `.action-group` section or create a new group:

```typescript
<button
  title="Free Transform (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+T)"
  @click=${() => this._ctx.value?.enterTransform()}
>
  ${transformIcon}
</button>
```

Import `transformIcon` from `tool-icons.ts`.

- [ ] **Step 3: Type-check and manual test**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Manual test: Click the transform button — should enter transform mode same as Cmd+T.

- [ ] **Step 4: Commit**

```bash
git add src/components/tool-icons.ts src/components/app-toolbar.ts
git commit -m "feat(transform): add Transform action button to toolbar"
```

---

### Task 10: Add Numeric Input Panel to Tool Settings

**Files:**
- Modify: `src/components/tool-settings.ts` — Add transform controls when transform is active

- [ ] **Step 1: Add transform panel rendering**

In `tool-settings.ts`, in the render method where it switches on `activeTool`, add a check at the **top** (before the tool switch) for `transformActive`:

```typescript
if (this._ctx.value?.transformActive) {
  return this._renderTransformSettings();
}
```

Then add `_renderTransformSettings()` method. This reads from the TransformManager via a new context method `getTransformState()` and writes back via context callbacks.

The panel should contain:
- X, Y number inputs (paired row)
- W, H number inputs (paired row) with aspect ratio lock toggle
- Rotation number input with ° label
- Skew X, Skew Y number inputs (paired row) with ° labels
- Flip H, Flip V toggle buttons

Use the existing `.section`, `.size-value`, and input styling from the component.

- [ ] **Step 2: Add context methods for transform state access**

In `drawing-context.ts`, add to `DrawingContextValue`:

```typescript
  getTransformValues: () => { x: number; y: number; width: number; height: number; rotation: number; skewX: number; skewY: number; flipH: boolean; flipV: boolean } | null;
  setTransformValue: (key: string, value: number | boolean) => void;
```

Wire these in `drawing-app.ts` `_buildContextValue()` to delegate to `drawing-canvas` methods that read/write from `_transformManager`.

- [ ] **Step 3: Type-check and manual test**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Manual test:
1. Enter transform mode (Cmd+T on content)
2. Tool settings panel should show transform controls
3. Drag a handle — numeric values should update
4. Type a value in a field, press Enter — transform should update
5. Click Flip H — content should flip
6. Exit transform mode — settings panel returns to normal tool settings

- [ ] **Step 4: Commit**

```bash
git add src/components/tool-settings.ts src/contexts/drawing-context.ts src/components/drawing-app.ts
git commit -m "feat(transform): add numeric input panel to tool-settings"
```

---

### Task 11: Tool-Switch Commit and Remaining Integration

**Files:**
- Modify: `src/components/drawing-canvas.ts` — Commit on tool switch
- Modify: `src/components/drawing-app.ts` — Handle undo during transform

- [ ] **Step 1: Commit transform on tool switch**

In `drawing-app.ts`, in the `setTool` implementation (wherever `activeTool` is changed), add:

```typescript
// Commit active transform when switching tools
if (this.canvas?.isTransformActive()) {
  this.canvas.commitTransform();
}
```

- [ ] **Step 2: Handle undo during active transform**

**Note:** The primary undo-during-transform check should already be in `drawing-canvas.ts`'s `undo()` method (added in Task 8 Step 4, replacing the old `_float` discard logic). As a safety net, also add to `drawing-app.ts`'s undo wrapper:

```typescript
// Undo during transform mode = cancel the transform
if (this.canvas?.isTransformActive()) {
  this.canvas.cancelTransform();
  return;
}
```

Verify that `drawing-canvas.ts`'s own `undo()` method also has this check (it should from Task 8).

- [ ] **Step 3: Handle the 'transform' history entry in undo/redo**

In `drawing-canvas.ts`, wherever `HistoryEntry` types are handled for undo/redo (the switch statement in the undo/redo methods), add a case for `'transform'`:

```typescript
case 'transform': {
  const layer = layers.find(l => l.id === entry.layerId);
  if (layer) {
    layer.canvas.getContext('2d')!.putImageData(entry.before, 0, 0);
  }
  break;
}
```

And the corresponding redo case:

```typescript
case 'transform': {
  const layer = layers.find(l => l.id === entry.layerId);
  if (layer) {
    layer.canvas.getContext('2d')!.putImageData(entry.after, 0, 0);
  }
  break;
}
```

- [ ] **Step 4: Type-check and manual test**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npm run dev`
Manual test:
1. Enter transform mode, switch tool — should commit
2. Enter transform mode, Cmd+Z — should cancel
3. Transform and commit, then Cmd+Z — should undo the transform
4. Cmd+Shift+Z — should redo the transform

- [ ] **Step 5: Commit**

```bash
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(transform): add tool-switch commit, undo/redo integration"
```

---

### Task 12: End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Successful build with no errors

- [ ] **Step 3: Comprehensive manual testing**

Run: `npm run dev` and test all flows:

**Basic transform (selection):**
1. Use select tool to make a rectangular selection
2. Press Cmd/Ctrl+T — handles appear around selection
3. Move by dragging inside
4. Resize by dragging corner handles
5. Resize proportionally with Shift + corner drag
6. Rotate by dragging outside the bounds
7. Rotate with 15deg snaps using Shift
8. Enter to commit, verify content is transformed
9. Cmd+Z to undo, verify original restored
10. Repeat with Escape to cancel

**Layer transform (no selection):**
11. Draw content on a layer, deselect
12. Cmd+T — should detect content bounds and show handles
13. All transform operations should work
14. Commit and verify

**Skew:**
15. Enter transform mode, Ctrl+drag an edge handle
16. Verify content skews along that axis
17. Check numeric panel shows skew values

**Perspective:**
18. Enter transform mode, Ctrl+drag a corner handle
19. Verify corner moves independently
20. Commit — verify high-quality mesh rendering

**Flip:**
21. Enter transform mode
22. Click Flip H in settings — content flips horizontally
23. Click Flip V — flips vertically
24. Commit and verify

**Numeric panel:**
25. Enter transform mode
26. Type exact W value, press Enter — size changes
27. Type rotation value — rotation updates
28. Verify all fields update when dragging handles

**Mobile handles:**
29. Use browser dev tools to simulate touch device
30. Verify handles are larger and circular

**Commit/Cancel buttons:**
31. Verify floating buttons appear near bounding box
32. Click checkmark — commits
33. Click X — cancels

**Edge cases:**
34. Transform empty layer — should do nothing
35. Cmd+T when already in transform mode — should do nothing
36. Click outside bounds — should commit
37. Switch tool during transform — should commit

- [ ] **Step 4: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix(transform): address issues found in e2e testing"
```

(Only if fixes were needed.)

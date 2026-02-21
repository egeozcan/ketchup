# Floating (Detached) Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make selections and stamps produce floating, movable+resizable content that only commits on explicit deselect.

**Architecture:** Replace the current "lift → move → drop on pointerup" pattern with a persistent `FloatingSelection` state. Both select-lift and stamp-place populate the same floating state. The preview canvas renders the float with resize handles. Resize always re-renders from the original `ImageData` to preserve quality.

**Tech Stack:** Lit 3, TypeScript 5, Canvas2D API (no new dependencies)

---

### Task 1: Add `FloatingSelection` interface and refactor selection state

**Files:**
- Modify: `src/types.ts` (add interface after line 17)
- Modify: `src/components/drawing-canvas.ts:71-81` (replace selection state fields)

**Step 1: Add `FloatingSelection` interface to types.ts**

In `src/types.ts`, after the `Point` interface (line 17), add:

```typescript
export interface FloatingSelection {
  /** Original pixel content — never mutated, used as resize source */
  originalImageData: ImageData;
  /** Original position before any moves (for undo) */
  sourceRect: { x: number; y: number; w: number; h: number };
  /** Current position + size (updated on move/resize) */
  currentRect: { x: number; y: number; w: number; h: number };
  /** Cached render of originalImageData at currentRect size */
  tempCanvas: HTMLCanvasElement;
}
```

**Step 2: Replace selection state fields in drawing-canvas.ts**

Replace lines 71-81 (the selection state block) with:

```typescript
// --- Floating selection state ---
private _float: FloatingSelection | null = null;
private _clipboard: ImageData | null = null;
private _clipboardOrigin: Point | null = null;
private _selectionDashOffset = 0;
private _selectionAnimFrame: number | null = null;

// Interaction state
private _selectionDrawing = false;
private _floatMoving = false;
private _floatResizing = false;
private _floatResizeHandle: ResizeHandle | null = null;
private _floatDragOffset: Point | null = null;
private _floatResizeOrigin: { rect: { x: number; y: number; w: number; h: number }; point: Point } | null = null;
```

Add the `ResizeHandle` type at the top of the file (after imports):

```typescript
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
```

Update the import in drawing-canvas.ts to include `FloatingSelection`:

```typescript
import type { Point, HistoryEntry, Layer, FloatingSelection } from '../types.js';
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Errors about removed fields (expected at this point, will fix in subsequent tasks)

**Step 4: Commit**

```bash
git add src/types.ts src/components/drawing-canvas.ts
git commit -m "refactor: add FloatingSelection interface and new state fields"
```

---

### Task 2: Implement resize handle hit-testing and cursor logic

**Files:**
- Modify: `src/components/drawing-canvas.ts` (add helper methods after `_isInsideSelection`)

**Step 1: Replace `_isInsideSelection` with new hit-test helpers**

Replace the `_isInsideSelection` method (line 843-847) with these methods:

```typescript
private static readonly HANDLE_SIZE = 8; // CSS pixels (screen space)

/** Get the screen-space handle size in document coordinates */
private _handleSizeDoc(): number {
  return DrawingCanvas.HANDLE_SIZE / this._zoom;
}

/** Returns which resize handle the point hits, or null */
private _hitTestHandle(p: Point): ResizeHandle | null {
  if (!this._float) return null;
  const { x, y, w, h } = this._float.currentRect;
  const hs = this._handleSizeDoc();
  const half = hs / 2;

  const handles: { handle: ResizeHandle; cx: number; cy: number }[] = [
    { handle: 'nw', cx: x, cy: y },
    { handle: 'n',  cx: x + w / 2, cy: y },
    { handle: 'ne', cx: x + w, cy: y },
    { handle: 'e',  cx: x + w, cy: y + h / 2 },
    { handle: 'se', cx: x + w, cy: y + h },
    { handle: 's',  cx: x + w / 2, cy: y + h },
    { handle: 'sw', cx: x, cy: y + h },
    { handle: 'w',  cx: x, cy: y + h / 2 },
  ];

  for (const { handle, cx, cy } of handles) {
    if (p.x >= cx - half && p.x <= cx + half && p.y >= cy - half && p.y <= cy + half) {
      return handle;
    }
  }
  return null;
}

/** Returns true if point is inside the floating selection rect */
private _isInsideFloat(p: Point): boolean {
  if (!this._float) return false;
  const { x, y, w, h } = this._float.currentRect;
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
}

/** Returns the CSS cursor for a resize handle */
private _handleCursor(handle: ResizeHandle): string {
  const cursors: Record<ResizeHandle, string> = {
    nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
    se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
  };
  return cursors[handle];
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Still errors from old references — that's fine, fixing next.

**Step 3: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: add resize handle hit-testing and cursor helpers"
```

---

### Task 3: Rewrite select tool pointer handlers for floating behavior

**Files:**
- Modify: `src/components/drawing-canvas.ts` (rewrite `_handleSelectPointerDown`, `_handleSelectPointerMove`, `_handleSelectPointerUp`)

**Step 1: Rewrite `_handleSelectPointerDown`**

Replace the existing method (lines 849-867):

```typescript
private _handleSelectPointerDown(p: Point) {
  // Check handle hit first (resize takes priority over move)
  const handle = this._hitTestHandle(p);
  if (handle) {
    this._floatResizing = true;
    this._floatResizeHandle = handle;
    this._floatResizeOrigin = {
      rect: { ...this._float!.currentRect },
      point: { x: p.x, y: p.y },
    };
    this._stopSelectionAnimation();
    return;
  }

  // Click inside float → start moving
  if (this._float && this._isInsideFloat(p)) {
    this._floatMoving = true;
    this._floatDragOffset = {
      x: p.x - this._float.currentRect.x,
      y: p.y - this._float.currentRect.y,
    };
    this._stopSelectionAnimation();
    return;
  }

  // Click outside float → commit, then start drawing new selection
  this._commitFloat();
  this._selectionDrawing = true;
  this._startPoint = p;
}
```

**Step 2: Rewrite `_handleSelectPointerMove`**

Replace the existing method (lines 869-898):

```typescript
private _handleSelectPointerMove(e: PointerEvent) {
  const p = this._getDocPoint(e);

  // Update cursor based on what we'd hit
  if (this._floatResizing) {
    this.mainCanvas.style.cursor = this._handleCursor(this._floatResizeHandle!);
  } else if (this._floatMoving) {
    this.mainCanvas.style.cursor = 'move';
  } else {
    const handle = this._hitTestHandle(p);
    if (handle) {
      this.mainCanvas.style.cursor = this._handleCursor(handle);
    } else if (this._isInsideFloat(p)) {
      this.mainCanvas.style.cursor = 'move';
    } else {
      this.mainCanvas.style.cursor = 'crosshair';
    }
  }

  // Resizing
  if (this._floatResizing && this._float && this._floatResizeOrigin) {
    this._applyResize(p);
    this._redrawFloatPreview();
    return;
  }

  // Moving
  if (this._floatMoving && this._float && this._floatDragOffset) {
    this._float.currentRect.x = p.x - this._floatDragOffset.x;
    this._float.currentRect.y = p.y - this._floatDragOffset.y;
    this._redrawFloatPreview();
    return;
  }

  // Drawing new selection rect
  if (this._selectionDrawing && this._startPoint) {
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);
    const x = Math.min(this._startPoint.x, p.x);
    const y = Math.min(this._startPoint.y, p.y);
    const w = Math.abs(p.x - this._startPoint.x);
    const h = Math.abs(p.y - this._startPoint.y);
    previewCtx.save();
    previewCtx.translate(this._panX, this._panY);
    previewCtx.scale(this._zoom, this._zoom);
    drawSelectionRect(previewCtx, x, y, w, h, 0);
    previewCtx.restore();
  }
}
```

**Step 3: Rewrite `_handleSelectPointerUp`**

Replace the existing method (lines 901-928):

```typescript
private _handleSelectPointerUp(e: PointerEvent) {
  if (this._floatResizing) {
    this._floatResizing = false;
    this._floatResizeHandle = null;
    this._floatResizeOrigin = null;
    this._startSelectionAnimation();
    return;
  }

  if (this._floatMoving) {
    this._floatMoving = false;
    this._floatDragOffset = null;
    this._startSelectionAnimation();
    return;
  }

  if (this._selectionDrawing && this._startPoint) {
    this._selectionDrawing = false;
    const p = this._getDocPoint(e);
    const x = Math.min(this._startPoint.x, p.x);
    const y = Math.min(this._startPoint.y, p.y);
    const w = Math.abs(p.x - this._startPoint.x);
    const h = Math.abs(p.y - this._startPoint.y);
    this._startPoint = null;

    if (w < 2 || h < 2) {
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._vw, this._vh);
      return;
    }

    // Lift content into a new float
    const rx = Math.round(x);
    const ry = Math.round(y);
    const rw = Math.round(w);
    const rh = Math.round(h);
    this._liftToFloat(rx, ry, rw, rh);
  }
}
```

**Step 4: Verify types compile**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: rewrite select handlers for persistent floating selection"
```

---

### Task 4: Implement float lifecycle methods (lift, commit, resize, preview)

**Files:**
- Modify: `src/components/drawing-canvas.ts` (replace `_liftSelection`, `_dropSelection`, `_commitSelection`, `_clearSelectionState`, `_redrawSelectionPreview`)

**Step 1: Add `_liftToFloat` — replaces `_liftSelection`**

Remove `_liftSelection` and `_dropSelection` methods. Add:

```typescript
/** Lift pixels from active layer into a new floating selection */
private _liftToFloat(x: number, y: number, w: number, h: number) {
  const layerCtx = this._getActiveLayerCtx();
  if (!layerCtx) return;
  this._captureBeforeDraw();
  const imageData = layerCtx.getImageData(x, y, w, h);
  layerCtx.clearRect(x, y, w, h);
  this.composite();

  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')!.putImageData(imageData, 0, 0);

  this._float = {
    originalImageData: imageData,
    sourceRect: { x, y, w, h },
    currentRect: { x, y, w, h },
    tempCanvas: tmp,
  };
  this._startSelectionAnimation();
}

/** Create a float from an image (for stamp tool) */
private _createFloatFromImage(img: HTMLImageElement, centerX: number, centerY: number, size: number) {
  const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const x = Math.round(centerX - w / 2);
  const y = Math.round(centerY - h / 2);

  // Render stamp to a temp canvas to get imageData
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tmpCtx = tmp.getContext('2d')!;
  tmpCtx.drawImage(img, 0, 0, w, h);
  const imageData = tmpCtx.getImageData(0, 0, w, h);

  this._float = {
    originalImageData: imageData,
    sourceRect: { x, y, w, h },
    currentRect: { x, y, w, h },
    tempCanvas: tmp,
  };
  this._startSelectionAnimation();
}
```

**Step 2: Add `_commitFloat` — replaces `_commitSelection`**

Remove `_commitSelection` method. Add:

```typescript
/** Commit floating content to the active layer */
private _commitFloat() {
  if (!this._float) return;
  const layerCtx = this._getActiveLayerCtx();
  if (!layerCtx) return;

  const { currentRect, tempCanvas } = this._float;
  layerCtx.drawImage(tempCanvas, currentRect.x, currentRect.y, currentRect.w, currentRect.h);

  this._pushDrawHistory();
  this.composite();
  this._clearFloatState();
}
```

**Step 3: Add `_clearFloatState` — replaces `_clearSelectionState`**

Remove `_clearSelectionState`. Add:

```typescript
private _clearFloatState() {
  this._float = null;
  this._floatMoving = false;
  this._floatResizing = false;
  this._floatResizeHandle = null;
  this._floatDragOffset = null;
  this._floatResizeOrigin = null;
  this._selectionDrawing = false;
  this._stopSelectionAnimation();
  if (this.previewCanvas) {
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);
  }
}
```

**Step 4: Add `_rebuildTempCanvas` — used after resize**

```typescript
/** Rebuild the temp canvas from original imageData at the current rect size.
 *  Always renders from the original to avoid quality degradation. */
private _rebuildTempCanvas() {
  if (!this._float) return;
  const { originalImageData, currentRect } = this._float;

  // Render original to a source canvas at original size
  const src = document.createElement('canvas');
  src.width = originalImageData.width;
  src.height = originalImageData.height;
  src.getContext('2d')!.putImageData(originalImageData, 0, 0);

  // Scale to current size
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(currentRect.w));
  tmp.height = Math.max(1, Math.round(currentRect.h));
  tmp.getContext('2d')!.drawImage(src, 0, 0, tmp.width, tmp.height);

  this._float.tempCanvas = tmp;
}
```

**Step 5: Add `_applyResize`**

```typescript
private _applyResize(p: Point) {
  if (!this._float || !this._floatResizeOrigin) return;
  const { rect: orig, point: start } = this._floatResizeOrigin;
  const dx = p.x - start.x;
  const dy = p.y - start.y;
  const handle = this._floatResizeHandle!;
  const cur = this._float.currentRect;

  // Minimum size in doc coords
  const minSize = 4 / this._zoom;

  let newX = orig.x, newY = orig.y, newW = orig.w, newH = orig.h;

  // Horizontal component
  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    newX = orig.x + dx;
    newW = orig.w - dx;
  } else if (handle === 'ne' || handle === 'e' || handle === 'se') {
    newW = orig.w + dx;
  }

  // Vertical component
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    newY = orig.y + dy;
    newH = orig.h - dy;
  } else if (handle === 'sw' || handle === 's' || handle === 'se') {
    newH = orig.h + dy;
  }

  // Corner handles: maintain aspect ratio
  if (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw') {
    const aspect = orig.w / orig.h;
    // Use the larger delta to drive the resize
    if (Math.abs(newW - orig.w) / orig.w > Math.abs(newH - orig.h) / orig.h) {
      newH = newW / aspect;
    } else {
      newW = newH * aspect;
    }
    // Adjust position for top/left anchored handles
    if (handle === 'nw') {
      newX = orig.x + orig.w - newW;
      newY = orig.y + orig.h - newH;
    } else if (handle === 'ne') {
      newY = orig.y + orig.h - newH;
    } else if (handle === 'sw') {
      newX = orig.x + orig.w - newW;
    }
    // 'se' doesn't need position adjustment
  }

  // Enforce minimum size
  if (newW < minSize) { newW = minSize; }
  if (newH < minSize) { newH = minSize; }

  cur.x = newX;
  cur.y = newY;
  cur.w = newW;
  cur.h = newH;

  this._rebuildTempCanvas();
}
```

**Step 6: Replace `_redrawSelectionPreview` with `_redrawFloatPreview`**

Remove `_redrawSelectionPreview`. Add:

```typescript
private _redrawFloatPreview() {
  const previewCtx = this.previewCanvas.getContext('2d')!;
  previewCtx.clearRect(0, 0, this._vw, this._vh);

  if (!this._float) return;
  const { currentRect, tempCanvas } = this._float;

  previewCtx.save();
  previewCtx.translate(this._panX, this._panY);
  previewCtx.scale(this._zoom, this._zoom);

  // Draw the floating content
  previewCtx.drawImage(tempCanvas, currentRect.x, currentRect.y, currentRect.w, currentRect.h);

  // Draw marching ants
  drawSelectionRect(previewCtx, currentRect.x, currentRect.y, currentRect.w, currentRect.h, this._selectionDashOffset);

  previewCtx.restore();

  // Draw resize handles in screen space (not affected by zoom)
  this._drawResizeHandles(previewCtx);
}

private _drawResizeHandles(ctx: CanvasRenderingContext2D) {
  if (!this._float) return;
  const { x, y, w, h } = this._float.currentRect;
  const hs = DrawingCanvas.HANDLE_SIZE;
  const half = hs / 2;

  // Convert handle center positions to screen space
  const positions: [number, number][] = [
    [x, y], [x + w / 2, y], [x + w, y],
    [x + w, y + h / 2],
    [x + w, y + h], [x + w / 2, y + h], [x, y + h],
    [x, y + h / 2],
  ];

  ctx.save();
  for (const [cx, cy] of positions) {
    const sx = cx * this._zoom + this._panX;
    const sy = cy * this._zoom + this._panY;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(sx - half, sy - half, hs, hs);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(sx - half, sy - half, hs, hs);
  }
  ctx.restore();
}
```

**Step 7: Update animation method to call new preview**

In `_startSelectionAnimation`, replace `this._redrawSelectionPreview()` with `this._redrawFloatPreview()`:

```typescript
private _startSelectionAnimation() {
  this._stopSelectionAnimation();
  const animate = () => {
    this._selectionDashOffset = (this._selectionDashOffset + 0.5) % 12;
    this._redrawFloatPreview();
    this._selectionAnimFrame = requestAnimationFrame(animate);
  };
  this._selectionAnimFrame = requestAnimationFrame(animate);
}
```

**Step 8: Verify types compile**

Run: `npx tsc --noEmit`

**Step 9: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: implement float lifecycle — lift, commit, resize, preview with handles"
```

---

### Task 5: Rewire stamp tool to create floating selection

**Files:**
- Modify: `src/components/drawing-canvas.ts:697-708` (stamp handler in `_onPointerDown`)

**Step 1: Replace stamp handler**

In `_onPointerDown`, replace the stamp case (lines 697-708):

```typescript
if (activeTool === 'stamp') {
  if (this.ctx.state.stampImage) {
    // Commit any existing float first
    this._commitFloat();
    this._captureBeforeDraw();
    this._createFloatFromImage(this.ctx.state.stampImage, p.x, p.y, this.ctx.state.brushSize * 10);
  }
  return;
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: stamp tool creates floating selection instead of drawing directly"
```

---

### Task 6: Update all references from old selection API to new float API

**Files:**
- Modify: `src/components/drawing-canvas.ts` (public methods, undo/redo, pan/zoom callbacks)
- Modify: `src/components/drawing-app.ts` (anywhere calling `clearSelection`)

**Step 1: Update public selection methods**

Replace `copySelection`, `cutSelection`, `pasteSelection`, `deleteSelection`, `clearSelection`:

```typescript
public copySelection() {
  if (!this._float) return;
  this._clipboard = new ImageData(
    new Uint8ClampedArray(this._float.originalImageData.data),
    this._float.originalImageData.width,
    this._float.originalImageData.height,
  );
  this._clipboardOrigin = { x: this._float.currentRect.x, y: this._float.currentRect.y };
}

public cutSelection() {
  if (!this._float) return;
  this.copySelection();
  this.deleteSelection();
}

public pasteSelection() {
  if (!this._clipboard || !this._clipboardOrigin) return;
  this._commitFloat();
  this._captureBeforeDraw();

  // Create float from clipboard data
  const w = this._clipboard.width;
  const h = this._clipboard.height;
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')!.putImageData(this._clipboard, 0, 0);

  this._float = {
    originalImageData: new ImageData(
      new Uint8ClampedArray(this._clipboard.data),
      w, h,
    ),
    sourceRect: { x: this._clipboardOrigin.x, y: this._clipboardOrigin.y, w, h },
    currentRect: { x: this._clipboardOrigin.x, y: this._clipboardOrigin.y, w, h },
    tempCanvas: tmp,
  };
  this._startSelectionAnimation();
}

public deleteSelection() {
  if (!this._float) return;
  // Discard the float without committing — the layer area was already cleared on lift
  // Push history so undo restores the cleared area
  this._pushDrawHistory();
  this.composite();
  this._clearFloatState();
}

public clearSelection() {
  this._commitFloat();
}
```

**Step 2: Update undo/redo to clear float state**

In `undo()` and `redo()`, replace `this._clearSelectionState()` with `this._clearFloatState()`.

**Step 3: Update all `_redrawSelectionPreview` references**

Search for `_redrawSelectionPreview` and replace with `_redrawFloatPreview` throughout. Also search for `this._selection` references in zoom/pan code and replace with `this._float`:

- In `centerDocument()`: `if (this._float) this._redrawFloatPreview();`
- In `_resizeToFit()`: `if (this._float) this._redrawFloatPreview();`
- In `_updatePan()`: `if (this._float) this._redrawFloatPreview();`
- In `_onWheel()` (two occurrences): `if (this._float) this._redrawFloatPreview();`
- In `zoomToFit()`: `if (this._float) this._redrawFloatPreview();`
- In `_zoomToCenter()`: `if (this._float) this._redrawFloatPreview();`

**Step 4: Update stamp pointer move/up to handle float**

In `_onPointerMove`, add stamp tool float handling. After the select check (line 732-734), add:

```typescript
if (activeTool === 'stamp' && this._float) {
  // Delegate to select-like handling for stamp float
  this._handleSelectPointerMove(e);
  return;
}
```

In `_onPointerUp`, add similar for stamp:

```typescript
if (activeTool === 'stamp' && this._float) {
  this._handleSelectPointerUp(e);
  return;
}
```

In `_onPointerDown`, update the stamp block so clicking while a float exists commits and places a new one — this is already handled by `_commitFloat()` at the top of the stamp case from Task 5.

**Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Clean compilation, no errors.

**Step 6: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: update all selection API references to use float system"
```

---

### Task 7: Handle stamp tool cursor when floating

**Files:**
- Modify: `src/components/drawing-canvas.ts` (cursor logic in `willUpdate`)

**Step 1: Update cursor logic**

In `willUpdate()` (around line 180-188), update the cursor logic to account for the stamp tool having a float:

```typescript
if (this.mainCanvas && this._ctx.value) {
  const tool = this._ctx.value.state.activeTool;
  if (tool === 'hand') {
    this.mainCanvas.style.cursor = this._panning ? 'grabbing' : 'grab';
  } else if ((tool === 'select' || tool === 'stamp') && this._float && !this._floatMoving && !this._floatResizing) {
    // Let pointer move handler set the cursor dynamically
  } else {
    this.mainCanvas.style.cursor = 'crosshair';
  }
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat: dynamic cursor for floating selection in stamp tool"
```

---

### Task 8: Manual smoke test

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Test select tool floating behavior**

1. Select an area with content → verify it lifts and shows marching ants + handles
2. Move the float around → verify it stays floating (does NOT commit on pointerup)
3. Resize via corner handles → verify aspect ratio is maintained and quality stays sharp
4. Resize via edge handles → verify one-axis stretching
5. Click outside → verify it commits at current position
6. Press Escape → verify it commits
7. Switch tools → verify auto-commit

**Step 3: Test stamp tool floating behavior**

1. Select stamp tool, pick a stamp image
2. Click to place → verify stamp appears as float with handles (NOT drawn directly to layer)
3. Move the float → verify repositioning works
4. Resize the float → verify quality (renders from original)
5. Click again to place another stamp → verify first one commits, new one appears
6. Press Escape → verify commit

**Step 4: Test undo/redo**

1. Place a stamp, move it, commit → undo should revert the entire operation
2. Select area, resize, commit → undo should restore original layer state

**Step 5: Test copy/paste**

1. Select area → Ctrl+C → Ctrl+V → verify pasted content appears as float

**Step 6: Commit final state if any fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test issues"
```

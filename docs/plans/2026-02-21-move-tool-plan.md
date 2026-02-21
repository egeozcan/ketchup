# Move Tool Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a move tool that translates all pixels on the active layer by dragging, with Shift-constrained axis locking.

**Architecture:** New `'move'` tool type wired into the existing pointer event dispatch in `drawing-canvas.ts`. On drag start, snapshot the active layer to a temp canvas and capture history state. On each move, clear the layer and `drawImage` the snapshot at the computed offset. On drag end, push draw history. Shift constrains to the dominant axis.

**Tech Stack:** Lit 3, TypeScript 5, Canvas 2D API

---

### Task 1: Add `'move'` to the ToolType union

**Files:**
- Modify: `src/types.ts:1-12`

**Step 1: Add 'move' to the ToolType union**

In `src/types.ts`, add `| 'move'` after `'select'`:

```typescript
export type ToolType =
  | 'select'
  | 'move'
  | 'pencil'
  | 'marker'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'triangle'
  | 'fill'
  | 'stamp'
  | 'hand';
```

**Step 2: Verify TypeScript compiles**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: Errors in `tool-icons.ts` and `app-toolbar.ts` because `move` is missing from their `Record<ToolType, ...>` maps. This is expected — we fix those in the next tasks.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(move): add 'move' to ToolType union"
```

---

### Task 2: Add move tool icon and label

**Files:**
- Modify: `src/components/tool-icons.ts:8-87` (toolIcons record)
- Modify: `src/components/tool-icons.ts:117-129` (toolLabels record)

**Step 1: Add the move icon to `toolIcons`**

In `src/components/tool-icons.ts`, add a `move` entry after `select` in the `toolIcons` object (line ~13, after the select entry). Use a four-directional arrow icon:

```typescript
  // Move — four-directional arrow (move layer content)
  move: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="5 9 2 12 5 15"/>
      <polyline points="9 5 12 2 15 5"/>
      <polyline points="15 19 12 22 9 19"/>
      <polyline points="19 9 22 12 19 15"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <line x1="12" y1="2" x2="12" y2="22"/>
    </svg>`,
```

**Step 2: Add the move label to `toolLabels`**

In the `toolLabels` record, add after `select`:

```typescript
  move: 'Move',
```

**Step 3: Verify TypeScript compiles**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: Still errors from `drawing-canvas.ts` pointer dispatch (it doesn't handle `'move'` yet), but `tool-icons.ts` should be clean.

**Step 4: Commit**

```bash
git add src/components/tool-icons.ts
git commit -m "feat(move): add move tool icon and label"
```

---

### Task 3: Add move to toolbar group

**Files:**
- Modify: `src/components/app-toolbar.ts:8-13`

**Step 1: Add 'move' to the first toolbar group**

Change line 9 from:
```typescript
  ['select', 'hand'],
```
to:
```typescript
  ['select', 'move', 'hand'],
```

**Step 2: Verify TypeScript compiles**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: Should pass (or only remaining errors are in `drawing-canvas.ts` dispatch).

**Step 3: Commit**

```bash
git add src/components/app-toolbar.ts
git commit -m "feat(move): add move tool to toolbar"
```

---

### Task 4: Wire move tool in drawing-canvas.ts

**Files:**
- Modify: `src/components/drawing-canvas.ts`

This is the main task. Add move tool state, pointer handling, and cursor.

**Step 1: Add move tool state variables**

After the pan state block (around line 64, after `private _panPointerId = -1;`), add:

```typescript
  // --- Move tool state ---
  private _moveTempCanvas: HTMLCanvasElement | null = null;
  private _moveStartPoint: Point | null = null;
```

**Step 2: Update cursor logic in willUpdate()**

In the `willUpdate()` method (around line 186-196), add a cursor case for the move tool. Change the cursor logic to:

```typescript
    // Update cursor based on active tool
    if (this.mainCanvas && this._ctx.value) {
      const tool = this._ctx.value.state.activeTool;
      if (tool === 'hand') {
        this.mainCanvas.style.cursor = this._panning ? 'grabbing' : 'grab';
      } else if (tool === 'move') {
        this.mainCanvas.style.cursor = 'move';
      } else if ((tool === 'select' || tool === 'stamp') && this._float && !this._floatMoving && !this._floatResizing) {
        // Dynamic cursor set by pointer move handler
      } else {
        this.mainCanvas.style.cursor = 'crosshair';
      }
    }
```

**Step 3: Add move tool handling in _onPointerDown**

In `_onPointerDown` (line 667), after the hand tool check (line 685) and before `this.mainCanvas.setPointerCapture(e.pointerId);` (line 687), add the move tool handler:

```typescript
    // Move tool → translate active layer
    if (activeTool === 'move') {
      this.mainCanvas.setPointerCapture(e.pointerId);
      const p = this._getDocPoint(e);
      this._captureBeforeDraw();
      const layerCtx = this._getActiveLayerCtx();
      if (!layerCtx) return;
      // Snapshot the entire active layer to a temp canvas
      const tmp = document.createElement('canvas');
      tmp.width = this._docWidth;
      tmp.height = this._docHeight;
      tmp.getContext('2d')!.drawImage(layerCtx.canvas, 0, 0);
      this._moveTempCanvas = tmp;
      this._moveStartPoint = p;
      return;
    }
```

**Step 4: Add move tool handling in _onPointerMove**

In `_onPointerMove` (line 734), after the panning check (line 741) and before the select tool check (line 745), add:

```typescript
    if (activeTool === 'move' && this._moveTempCanvas && this._moveStartPoint) {
      const p = this._getDocPoint(e);
      let dx = p.x - this._moveStartPoint.x;
      let dy = p.y - this._moveStartPoint.y;
      // Shift constrains to dominant axis
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) {
          dy = 0;
        } else {
          dx = 0;
        }
      }
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        layerCtx.clearRect(0, 0, this._docWidth, this._docHeight);
        layerCtx.drawImage(this._moveTempCanvas, Math.round(dx), Math.round(dy));
        this.composite();
      }
      return;
    }
```

**Step 5: Add move tool handling in _onPointerUp**

In `_onPointerUp` (line 787), after the panning check (line 794) and before the select tool check (line 798), add:

```typescript
    if (activeTool === 'move' && this._moveTempCanvas) {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory();
      this.composite();
      return;
    }
```

**Step 6: Verify TypeScript compiles**

Run: `cd /Users/egecan/Code/ketchup && npx tsc --noEmit`
Expected: PASS — no errors.

**Step 7: Verify the app runs**

Run: `cd /Users/egecan/Code/ketchup && npm run dev`
Expected: Dev server starts. Open in browser, select the move tool, draw something on a layer, then drag to move it.

**Step 8: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(move): wire move tool pointer handling with shift-axis constraint"
```

---

### Task 5: Manual verification

**Files:** None (testing only)

**Step 1: Build check**

Run: `cd /Users/egecan/Code/ketchup && npm run build`
Expected: PASS — clean build.

**Step 2: Verify move tool works**

Open dev server (`npm run dev`), then:
1. Draw something with pencil on a layer
2. Select the move tool (second button in first toolbar group)
3. Drag — content should move, vacated area should be transparent (checkerboard visible)
4. Undo (Ctrl+Z) — content should snap back to original position
5. Redo (Ctrl+Shift+Z) — content should move again
6. Hold Shift while dragging — movement should lock to horizontal or vertical axis
7. Try on a different layer — only the active layer should move

**Step 3: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(move): address any issues found during verification"
```

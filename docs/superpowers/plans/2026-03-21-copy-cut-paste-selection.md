# Copy/Cut/Paste Selection Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add system clipboard integration, Select All, and Duplicate in Place to the existing selection system.

**Architecture:** All features build on the existing floating selection infrastructure in `drawing-canvas.ts`. The system clipboard is written via `navigator.clipboard.write()` and read via `navigator.clipboard.read()`, with a blob-size fingerprint to detect external clipboard changes. Keyboard shortcuts are dispatched from `drawing-app.ts` to public methods on the canvas via `@query` reference.

**Tech Stack:** Lit 3, TypeScript 5 (strict mode, experimental decorators), Canvas API, Clipboard API

**Note:** No test runner is configured. Each task includes manual verification steps.

---

## File Map

| File | Role | Changes |
|------|------|---------|
| `src/components/drawing-canvas.ts` | Canvas component — selection, clipboard, drawing | Add `_clipboardBlobSize` field; modify `copySelection()` to write system clipboard; add unified `paste()` method; add `selectAll()`, `selectAllCanvas()`, `duplicateInPlace()` |
| `src/components/drawing-app.ts` | Root component — keyboard shortcuts | Simplify Ctrl+V to `canvas.paste()`; add Ctrl+A, Ctrl+Shift+A, Ctrl+D handlers |

---

### Task 1: System Clipboard Write on Copy

Modify `copySelection()` to write the floating selection's content to the system clipboard as PNG, and store the blob size for change detection.

**Files:**
- Modify: `src/components/drawing-canvas.ts` — `copySelection()` method (line ~2274), add `_clipboardBlobSize` field (near line ~95)

- [ ] **Step 1: Add `_clipboardBlobSize` field**

In `src/components/drawing-canvas.ts`, add a new private field near the existing clipboard fields (after `_clipboardOrigin` around line 96):

```typescript
private _clipboardBlobSize: number | null = null;
```

- [ ] **Step 2: Add `_writeToSystemClipboard()` helper**

Add a private helper method after the existing `copySelection()` method. This encapsulates the async system clipboard write as fire-and-forget:

```typescript
private _writeToSystemClipboard(canvas: HTMLCanvasElement) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    this._clipboardBlobSize = blob.size;
    navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]).catch(() => {
      // Clipboard API denied or unavailable — internal clipboard still works
    });
  }, 'image/png');
}
```

- [ ] **Step 3: Modify `copySelection()` to call the helper**

Update `copySelection()` to also write to the system clipboard after storing internal data:

```typescript
public copySelection() {
  if (!this._float) return;
  const { tempCanvas, currentRect } = this._float;
  const ctx = tempCanvas.getContext('2d')!;
  this._clipboard = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  this._clipboardOrigin = { x: currentRect.x, y: currentRect.y };
  this._writeToSystemClipboard(tempCanvas);
}
```

The only change is adding the `_writeToSystemClipboard(tempCanvas)` call at the end. `cutSelection()` calls `copySelection()` internally, so it automatically gets system clipboard write too.

- [ ] **Step 4: Verify manually**

```
npm run dev
```

1. Open the app, draw something with the pencil
2. Use the select tool (V) to select a region
3. Press Ctrl+C
4. Open another app (e.g., Preview, Paint, browser image editor)
5. Press Ctrl+V — the copied selection should appear with transparency preserved
6. Repeat with Ctrl+X — should also copy to system clipboard before cutting

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc --noEmit
git add src/components/drawing-canvas.ts
git commit -m "feat(clipboard): write selection to system clipboard on copy/cut"
```

---

### Task 2: Unified Paste with Blob Size Detection

Replace the branching Ctrl+V handler with a single `paste()` method that reads the system clipboard, compares blob sizes to detect external content, and dispatches accordingly.

**Files:**
- Modify: `src/components/drawing-canvas.ts` — add `paste()` method (after `pasteSelection()` around line ~2324)
- Modify: `src/components/drawing-app.ts` — simplify Ctrl+V handler (line ~545)

- [ ] **Step 1: Add unified `paste()` method to `drawing-canvas.ts`**

Add after the existing `pasteSelection()` method:

```typescript
public async paste() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);

      // Blob size matches what we wrote — use fast internal clipboard
      if (this._clipboard && this._clipboardBlobSize === blob.size) {
        this.pasteSelection();
        return;
      }

      // External content — decode and handle
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('Image load failed'));
          el.src = url;
        });
        URL.revokeObjectURL(url);
        await this._handleExternalImage(img, 'Pasted Image');
      } catch {
        URL.revokeObjectURL(url);
      }
      return;
    }
  } catch {
    // Clipboard API denied — fall back to internal
  }

  // No system clipboard image available — try internal clipboard
  this.pasteSelection();
}
```

- [ ] **Step 2: Simplify Ctrl+V handler in `drawing-app.ts`**

In `_onKeyDown` (line ~545), replace:

```typescript
  } else if (ctrl && key === 'v') {
    e.preventDefault();
    if (this.canvas?.hasClipboardData) {
      this.canvas.pasteSelection();
    } else {
      this.canvas?.pasteExternalImage();
    }
```

With:

```typescript
  } else if (ctrl && key === 'v') {
    e.preventDefault();
    this.canvas?.paste();
```

- [ ] **Step 3: Verify manually**

```
npm run dev
```

1. **Internal round-trip:** Draw something, select it, Ctrl+C, Ctrl+V — should paste at original position (fast, internal path)
2. **External paste-in:** Copy an image from another app, switch to Ketchup, Ctrl+V — should create new layer with the image
3. **Clipboard change detection:** Copy a selection in Ketchup, then copy a different image in another app, come back and Ctrl+V — should paste the external image, not the stale internal one
4. **Fallback:** If clipboard permission is denied (e.g., open dev tools and revoke clipboard permission), internal copy+paste should still work

- [ ] **Step 4: Type-check and commit**

```bash
npx tsc --noEmit
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(clipboard): unified paste with system clipboard detection"
```

---

### Task 3: Select All (Auto-Trim)

Add `selectAll()` that scans the active layer's alpha channel to find the bounding box of non-transparent pixels and lifts it as a floating selection.

**Files:**
- Modify: `src/components/drawing-canvas.ts` — add `selectAll()` method
- Modify: `src/components/drawing-app.ts` — add Ctrl+A handler

- [ ] **Step 1: Add `selectAll()` method to `drawing-canvas.ts`**

Add as a public method (after the clipboard methods, around line ~2340). Tool switching is handled by `drawing-app.ts` (which owns `DrawingState`), not here — this method only does the selection logic:

```typescript
public selectAll() {
  const layerCtx = this._getActiveLayerCtx();
  if (!layerCtx) return;

  this._commitFloat();

  const w = this._docWidth;
  const h = this._docHeight;
  const imageData = layerCtx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // Find bounding box of non-transparent pixels
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Layer is empty — no-op
  if (maxX < 0) return;

  this._liftToFloat(minX, minY, maxX - minX + 1, maxY - minY + 1);
}
```

- [ ] **Step 2: Add Ctrl+A handler in `drawing-app.ts`**

In `_onKeyDown`, add before the Ctrl+0 zoom handler (before line ~569):

```typescript
  } else if (ctrl && key === 'a' && !e.shiftKey) {
    e.preventDefault();
    if (this._state.activeTool !== 'select') {
      this.canvas?.cancelCrop();
      this.canvas?.clearSelection();
      this._state = { ...this._state, activeTool: 'select' };
      this._markDirty();
    }
    this.canvas?.selectAll();
```

Remove the tool-switching from `selectAll()` in the canvas — it should only do the selection logic. The tool switch happens in `drawing-app.ts`.

Update `selectAll()` to remove the `this._state` line:

```typescript
public selectAll() {
  const layerCtx = this._getActiveLayerCtx();
  if (!layerCtx) return;

  this._commitFloat();

  const w = this._docWidth;
  const h = this._docHeight;
  const imageData = layerCtx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return;

  this._liftToFloat(minX, minY, maxX - minX + 1, maxY - minY + 1);
}
```

- [ ] **Step 3: Verify manually**

```
npm run dev
```

1. Draw some content in the center of the canvas (leave edges empty)
2. Press Ctrl+A — a floating selection should appear tightly cropped around the drawn content (marching ants, resize handles visible)
3. Move the selection — the original area should be cleared
4. Ctrl+Z — should undo the selection lift
5. On an empty layer, press Ctrl+A — nothing should happen
6. While using the pencil tool, press Ctrl+A — tool should switch to select, then select content

- [ ] **Step 4: Type-check and commit**

```bash
npx tsc --noEmit
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(selection): add Select All with auto-trim (Ctrl+A)"
```

---

### Task 4: Select All Full Canvas (Ctrl+Shift+A)

Add `selectAllCanvas()` that lifts the entire document bounds as a floating selection.

**Files:**
- Modify: `src/components/drawing-canvas.ts` — add `selectAllCanvas()` method
- Modify: `src/components/drawing-app.ts` — add Ctrl+Shift+A handler

- [ ] **Step 1: Add `selectAllCanvas()` method to `drawing-canvas.ts`**

Add right after `selectAll()`:

```typescript
public selectAllCanvas() {
  const layerCtx = this._getActiveLayerCtx();
  if (!layerCtx) return;

  this._commitFloat();
  this._liftToFloat(0, 0, this._docWidth, this._docHeight);
}
```

- [ ] **Step 2: Add Ctrl+Shift+A handler in `drawing-app.ts`**

The Ctrl+A handler from Task 3 checks `!e.shiftKey`. Add the Shift variant right after it:

```typescript
  } else if (ctrl && key === 'a' && e.shiftKey) {
    e.preventDefault();
    if (this._state.activeTool !== 'select') {
      this.canvas?.cancelCrop();
      this.canvas?.clearSelection();
      this._state = { ...this._state, activeTool: 'select' };
      this._markDirty();
    }
    this.canvas?.selectAllCanvas();
```

**Important:** The Ctrl+Shift+A handler must come **before** the Ctrl+A handler in the if/else chain, because `e.shiftKey` will be true and we need to check it first. Otherwise the `!e.shiftKey` branch would never match Ctrl+Shift+A anyway — actually it would correctly skip since we check `!e.shiftKey`. Either order works, but placing Shift+A first is more readable.

- [ ] **Step 3: Verify manually**

```
npm run dev
```

1. Draw some content in one corner of the canvas
2. Press Ctrl+Shift+A — the entire canvas should be selected (full document dimensions), not just the content area
3. Move the selection — entire canvas content moves as a block
4. Compare with Ctrl+A on the same content — Ctrl+A should give a tighter selection

- [ ] **Step 4: Type-check and commit**

```bash
npx tsc --noEmit
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(selection): add Select All Canvas (Ctrl+Shift+A)"
```

---

### Task 5: Duplicate in Place (Ctrl+D)

Add `duplicateInPlace()` that commits the current float and immediately creates a copy at the same position.

**Files:**
- Modify: `src/components/drawing-canvas.ts` — add `duplicateInPlace()` method
- Modify: `src/components/drawing-app.ts` — add Ctrl+D handler

- [ ] **Step 1: Add `duplicateInPlace()` method to `drawing-canvas.ts`**

Add after `selectAllCanvas()`:

```typescript
public duplicateInPlace() {
  if (this._float) {
    // Copy the current float's data before committing
    const { tempCanvas, currentRect } = this._float;
    const ctx = tempCanvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const origin = { x: currentRect.x, y: currentRect.y };
    const w = tempCanvas.width;
    const h = tempCanvas.height;

    // Store in clipboard (same as copy)
    this._clipboard = imageData;
    this._clipboardOrigin = origin;
    this._writeToSystemClipboard(tempCanvas);

    // Commit the current float to the layer
    this._commitFloat();

    // Create new float from the copied data at the same position
    if (!this._beforeDrawData) {
      this._captureBeforeDraw();
    }

    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    src.getContext('2d')!.putImageData(imageData, 0, 0);
    this._floatSrcCanvas = src;

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.drawImage(src, 0, 0);

    this._float = {
      originalImageData: new ImageData(new Uint8ClampedArray(imageData.data), w, h),
      currentRect: { x: origin.x, y: origin.y, w, h },
      tempCanvas: tmp,
    };
    this._startSelectionAnimation();
  } else {
    // No active float — paste from internal clipboard if available
    this.pasteSelection();
  }
}
```

- [ ] **Step 2: Add Ctrl+D handler in `drawing-app.ts`**

Add in `_onKeyDown`, after the Ctrl+V handler:

```typescript
  } else if (ctrl && key === 'd') {
    e.preventDefault();
    this.canvas?.duplicateInPlace();
```

The `e.preventDefault()` is critical — without it, the browser opens the bookmark dialog.

- [ ] **Step 3: Verify manually**

```
npm run dev
```

1. **With active float:** Draw something, select a region, press Ctrl+D — the selection should be committed to the layer and a new identical float should appear at the same position. Drag the new float to see the committed copy underneath.
2. **Undo:** Press Ctrl+Z — the new float disappears. Press Ctrl+Z again — the committed copy is undone.
3. **Without float, with clipboard:** Copy a selection (Ctrl+C), clear the selection (Escape), press Ctrl+D — should paste at the original position.
4. **Without float, no clipboard:** On a fresh session with no clipboard data, Ctrl+D — nothing should happen.

- [ ] **Step 4: Type-check and commit**

```bash
npx tsc --noEmit
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(selection): add Duplicate in Place (Ctrl+D)"
```

---

## Summary

| Task | Feature | Shortcut |
|------|---------|----------|
| 1 | System clipboard write on copy/cut | Ctrl+C / Ctrl+X (enhanced) |
| 2 | Unified paste with blob size detection | Ctrl+V (refactored) |
| 3 | Select All with auto-trim | Ctrl+A |
| 4 | Select All full canvas | Ctrl+Shift+A |
| 5 | Duplicate in Place | Ctrl+D |

Tasks are sequential — each builds on the previous. Total: 2 files modified, ~100 lines added.

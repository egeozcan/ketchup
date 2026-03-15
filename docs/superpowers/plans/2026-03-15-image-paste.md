# Image Paste & Drop Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable pasting images from the system clipboard and drag-and-dropping image files onto the canvas, each creating a new named layer with an interactive floating selection for repositioning/resizing before commit.

**Architecture:** Two entry points (clipboard paste via keyboard handler, drag-and-drop via DOM events) converge on a shared `_handleExternalImage` method in `drawing-canvas.ts`. This method optionally shows a `<resize-dialog>` for oversized images, creates a new layer via context, and places the image as a floating selection using an extended version of the existing float infrastructure. A `_floatIsExternalImage` flag enables a dedicated `cancelExternalFloat()` method for discard-on-Escape with layer cleanup, keeping `clearSelection()` (which is called from many places) always committing.

**Tech Stack:** Lit 3, TypeScript 5, Clipboard API (`navigator.clipboard.read()`), native `<dialog>` element, existing `FloatingSelection` infrastructure.

**Undo behavior:** Committing a pasted/dropped image produces two undo steps: (1) undo the draw (restores blank layer), (2) undo the add-layer (removes the layer). This is consistent with how other layer+draw operations work and is not collapsed into a single atomic undo.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/components/resize-dialog.ts` | Create | Modal dialog component — "Scale to fit" vs "Keep original size" |
| `src/contexts/drawing-context.ts` | Modify | Update `addLayer` signature to `(name?: string) => string` |
| `src/components/drawing-app.ts` | Modify | Extend `addLayer` impl, extend Ctrl+V handler, update Escape handler |
| `src/components/drawing-canvas.ts` | Modify | Add drag-and-drop, `pasteExternalImage()`, `_handleExternalImage()`, float variant, `cancelExternalFloat()` |

---

## Chunk 1: Resize Dialog Component

### Task 1: Create `<resize-dialog>` component

**Files:**
- Create: `src/components/resize-dialog.ts`

- [ ] **Step 1: Create the resize-dialog component**

```typescript
// src/components/resize-dialog.ts
import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('resize-dialog')
export class ResizeDialog extends LitElement {
  static override styles = css`
    dialog {
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #555;
      border-radius: 8px;
      padding: 24px;
      max-width: 400px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.5);
    }
    p {
      margin: 0 0 16px;
      line-height: 1.5;
    }
    .buttons {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    button {
      padding: 8px 16px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #3a3a3a;
      color: #e0e0e0;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover {
      background: #4a4a4a;
    }
    button.primary {
      background: #4a90d9;
      border-color: #4a90d9;
    }
    button.primary:hover {
      background: #5aa0e9;
    }
  `;

  private _dialog: HTMLDialogElement | null = null;
  private _resolve: ((scale: boolean) => void) | null = null;

  /**
   * Show the dialog and return a promise that resolves to true (scale) or false (keep).
   */
  show(imgW: number, imgH: number, canvasW: number, canvasH: number): Promise<boolean> {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._imgW = imgW;
      this._imgH = imgH;
      this._canvasW = canvasW;
      this._canvasH = canvasH;
      this.requestUpdate();
      this.updateComplete.then(() => {
        this._dialog = this.renderRoot.querySelector('dialog');
        this._dialog?.showModal();
      });
    });
  }

  private _imgW = 0;
  private _imgH = 0;
  private _canvasW = 0;
  private _canvasH = 0;

  private _onScale() {
    this._dialog?.close();
    this._resolve?.(true);
    this._resolve = null;
  }

  private _onKeep() {
    this._dialog?.close();
    this._resolve?.(false);
    this._resolve = null;
  }

  override render() {
    // Pressing Escape on the native <dialog> fires a 'cancel' event;
    // we treat it as "Keep original size" (the non-destructive default).
    return html`
      <dialog @cancel=${(e: Event) => { e.preventDefault(); this._onKeep(); }}>
        <p>
          This image (${this._imgW}&times;${this._imgH}) is larger than the canvas
          (${this._canvasW}&times;${this._canvasH}). Would you like to scale it to fit?
        </p>
        <div class="buttons">
          <button @click=${this._onKeep}>Keep original size</button>
          <button class="primary" @click=${this._onScale}>Scale to fit</button>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resize-dialog': ResizeDialog;
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors (component is standalone, not yet wired in)

- [ ] **Step 3: Commit**

```bash
git add src/components/resize-dialog.ts
git commit -m "feat(paste): add resize-dialog component for oversized images"
```

---

## Chunk 2: Extend `addLayer` Signature

### Task 2: Update `addLayer` to accept optional name and return layer ID

**Files:**
- Modify: `src/contexts/drawing-context.ts` (the `addLayer` type in `DrawingContextValue`)
- Modify: `src/components/drawing-app.ts` (the `addLayer` implementation in `_buildContextValue`)

- [ ] **Step 1: Update context interface**

In `src/contexts/drawing-context.ts`, change the `addLayer` line:

```typescript
// Before:
addLayer: () => void;
// After:
addLayer: (name?: string) => string;
```

- [ ] **Step 2: Update `addLayer` implementation in `drawing-app.ts`**

In `src/components/drawing-app.ts`, modify the `addLayer` method in `_buildContextValue()`:

```typescript
// Before:
addLayer: () => {
  this.canvas?.clearSelection();
  const layer = this._createLayer(this._state.documentWidth, this._state.documentHeight);
  const activeIdx = this._state.layers.findIndex(l => l.id === this._state.activeLayerId);
  const insertIdx = activeIdx + 1;
  const newLayers = [...this._state.layers];
  newLayers.splice(insertIdx, 0, layer);
  this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
  this.canvas?.pushLayerOperation({ type: 'add-layer', layer: this._snapshotLayer(layer), index: insertIdx });
  this._markDirty();
},

// After:
addLayer: (name?: string) => {
  this.canvas?.clearSelection();
  const layer = this._createLayer(this._state.documentWidth, this._state.documentHeight);
  if (name) layer.name = name;
  const activeIdx = this._state.layers.findIndex(l => l.id === this._state.activeLayerId);
  const insertIdx = activeIdx + 1;
  const newLayers = [...this._state.layers];
  newLayers.splice(insertIdx, 0, layer);
  this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
  this.canvas?.pushLayerOperation({ type: 'add-layer', layer: this._snapshotLayer(layer), index: insertIdx });
  this._markDirty();
  return layer.id;
},
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/contexts/drawing-context.ts src/components/drawing-app.ts
git commit -m "feat(paste): extend addLayer to accept optional name and return layer ID"
```

---

## Chunk 3: Core External Image Handling in `drawing-canvas.ts`

### Task 3: Add `_floatIsExternalImage` flag and extend `_createFloatFromImage`

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Add the `_floatIsExternalImage` flag**

After `private _floatSrcCanvas: HTMLCanvasElement | null = null;`, add:

```typescript
  /** True when the current float was created via paste/drop — Escape discards + deletes layer */
  private _floatIsExternalImage = false;
```

- [ ] **Step 2: Add `_createFloatFromImageDirect` method**

After the existing `_createFloatFromImage` method, add a new variant that accepts pre-computed width/height:

```typescript
  /**
   * Create a float from an image with explicit dimensions (no size-based scaling).
   * Used by external image paste/drop where dimensions are already resolved.
   */
  private _createFloatFromImageDirect(img: HTMLImageElement, w: number, h: number) {
    const cx = this._docWidth / 2;
    const cy = this._docHeight / 2;
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h / 2);

    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    src.getContext('2d')!.drawImage(img, 0, 0, w, h);
    const imageData = src.getContext('2d')!.getImageData(0, 0, w, h);
    this._floatSrcCanvas = src;

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.drawImage(src, 0, 0);

    this._float = {
      originalImageData: imageData,
      currentRect: { x, y, w, h },
      tempCanvas: tmp,
    };
    this._startSelectionAnimation();
  }
```

- [ ] **Step 3: Reset the flag in `_clearFloatState`**

In `_clearFloatState()`, add `this._floatIsExternalImage = false;` after `this._floatSrcCanvas = null;`:

```typescript
  private _clearFloatState() {
    this._float = null;
    this._floatSrcCanvas = null;
    this._floatIsExternalImage = false;  // <-- add this line
    this._floatMoving = false;
    // ... rest unchanged
  }
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(paste): add _floatIsExternalImage flag and _createFloatFromImageDirect method"
```

### Task 4: Add `_handleExternalImage` and `pasteExternalImage` methods

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Import resize-dialog**

At the top of `drawing-canvas.ts`, add the import after the existing imports:

```typescript
import './resize-dialog.js';
import type { ResizeDialog } from './resize-dialog.js';
```

- [ ] **Step 2: Add `_resizeDialog` element to render and query**

Add a query after the existing `@query('#preview')` line:

```typescript
  @query('resize-dialog') private _resizeDialog!: ResizeDialog;
```

Update the `render()` method to include the dialog:

```typescript
  override render() {
    return html`
      <canvas
        id="main"
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerUp}
      ></canvas>
      <canvas
        id="preview"
        style="position:absolute;top:0;left:0;pointer-events:none;"
      ></canvas>
      <resize-dialog></resize-dialog>
    `;
  }
```

- [ ] **Step 3: Add `hasClipboardData` getter and `hasExternalFloat` getter**

Add public getters:

```typescript
  /** Whether the internal clipboard has data (used by drawing-app to decide paste path) */
  public get hasClipboardData(): boolean {
    return this._clipboard !== null;
  }

  /** Whether an external image float is active (used by drawing-app for Escape handling) */
  public get hasExternalFloat(): boolean {
    return this._floatIsExternalImage && this._float !== null;
  }
```

- [ ] **Step 4: Add `_handleExternalImage` method**

Add after `_createFloatFromImageDirect`:

```typescript
  /**
   * Shared handler for external images from paste or drag-and-drop.
   * Creates a new layer, optionally shows resize dialog, places a float.
   * Note: calls _commitFloat() directly (not clearSelection) to commit any
   * prior float — clearSelection is the general-purpose public API that
   * many callers use and must always commit.
   */
  private async _handleExternalImage(img: HTMLImageElement, name: string) {
    // Commit any active float first
    this._commitFloat();

    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const canvasW = this._docWidth;
    const canvasH = this._docHeight;

    // Show resize dialog if image exceeds canvas
    if (w > canvasW || h > canvasH) {
      const shouldScale = await this._resizeDialog.show(w, h, canvasW, canvasH);
      if (shouldScale) {
        const scale = Math.min(canvasW / w, canvasH / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
    }

    // Create new layer via context
    this.ctx.addLayer(name);
    await this.updateComplete;

    // Capture before-draw state on the new empty layer (blank ImageData for undo)
    this._captureBeforeDraw();

    // Create the float
    this._floatIsExternalImage = true;
    this._createFloatFromImageDirect(img, w, h);
  }
```

- [ ] **Step 5: Add `pasteExternalImage` public method**

Add after `_handleExternalImage`:

```typescript
  /**
   * Read system clipboard for an image and handle it as a new layer.
   * Called by drawing-app when Ctrl+V is pressed and no internal clipboard data exists.
   */
  public async pasteExternalImage() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
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
        return; // Use first image found
      }
    } catch {
      // Clipboard API denied or unavailable — silently ignore
    }
  }
```

- [ ] **Step 6: Add `cancelExternalFloat` public method**

Add after `clearSelection`:

```typescript
  /**
   * Cancel an external image float: discard without drawing, delete the empty layer.
   * Called exclusively by the Escape handler in drawing-app for external image floats.
   * clearSelection() is NOT modified — it always commits, which is correct for
   * tool switches, layer switches, project switches, etc.
   */
  public cancelExternalFloat() {
    if (!this._floatIsExternalImage || !this._float) return;
    const layerId = this.ctx.state.activeLayerId;
    this._clearFloatState();
    this._beforeDrawData = null;
    this.composite();
    this.ctx.deleteLayer(layerId);
  }
```

- [ ] **Step 7: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(paste): add _handleExternalImage, pasteExternalImage, and cancelExternalFloat"
```

---

## Chunk 4: Ctrl+V Integration, Escape Handler, and Drag-and-Drop

### Task 5: Extend Ctrl+V and Escape handlers in `drawing-app.ts`

**Files:**
- Modify: `src/components/drawing-app.ts`

- [ ] **Step 1: Update the Ctrl+V handler**

In `_onKeyDown`, replace the Ctrl+V block:

```typescript
// Before:
    } else if (ctrl && key === 'v') {
      e.preventDefault();
      this.canvas?.pasteSelection();

// After:
    } else if (ctrl && key === 'v') {
      e.preventDefault();
      if (this.canvas?.hasClipboardData) {
        this.canvas.pasteSelection();
      } else {
        this.canvas?.pasteExternalImage();
      }
```

- [ ] **Step 2: Update the Escape handler**

In `_onKeyDown`, replace the Escape block:

```typescript
// Before:
    } else if (e.key === 'Escape') {
      this.canvas?.clearSelection();

// After:
    } else if (e.key === 'Escape') {
      if (this.canvas?.hasExternalFloat) {
        this.canvas.cancelExternalFloat();
      } else {
        this.canvas?.clearSelection();
      }
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat(paste): extend Ctrl+V and Escape handlers for external images"
```

### Task 6: Add drag-and-drop event handlers

**Files:**
- Modify: `src/components/drawing-canvas.ts`

- [ ] **Step 1: Add drag-and-drop CSS**

In the `static override styles`, add a drop-target style after the `#main` block:

```css
    :host(.drop-target) #main {
      outline: 3px dashed #4a90d9;
      outline-offset: -3px;
    }
```

- [ ] **Step 2: Add drag-and-drop event handlers**

Add these private methods to `DrawingCanvas`:

```typescript
  private _onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  private _onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    this.classList.add('drop-target');
  };

  private _onDragLeave = (e: DragEvent) => {
    // Only remove if leaving the host element (not entering a child)
    if (e.relatedTarget && this.contains(e.relatedTarget as Node)) return;
    this.classList.remove('drop-target');
  };

  private _onDrop = async (e: DragEvent) => {
    e.preventDefault();
    this.classList.remove('drop-target');
    if (!e.dataTransfer?.files.length) return;

    for (const file of Array.from(e.dataTransfer.files)) {
      if (!file.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(file);
      const name = file.name.replace(/\.[^.]+$/, '') || 'Dropped Image';
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('Image load failed'));
          el.src = url;
        });
        URL.revokeObjectURL(url);
        await this._handleExternalImage(img, name);
      } catch {
        URL.revokeObjectURL(url);
      }
      return; // Use first image file
    }
  };
```

- [ ] **Step 3: Register event listeners in `connectedCallback` and clean up in `disconnectedCallback`**

In `connectedCallback()`, after the existing `addEventListener('wheel', ...)`:

```typescript
    this.addEventListener('dragover', this._onDragOver);
    this.addEventListener('dragenter', this._onDragEnter);
    this.addEventListener('dragleave', this._onDragLeave);
    this.addEventListener('drop', this._onDrop);
```

In `disconnectedCallback()`, after `this.removeEventListener('wheel', this._onWheel);`:

```typescript
    this.removeEventListener('dragover', this._onDragOver);
    this.removeEventListener('dragenter', this._onDragEnter);
    this.removeEventListener('dragleave', this._onDragLeave);
    this.removeEventListener('drop', this._onDrop);
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(paste): add drag-and-drop support for image files"
```

---

## Chunk 5: Build Verification & Manual Testing

### Task 7: Build and manual test

**Files:** None (testing only)

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 2: Start dev server and test**

Run: `npm run dev`

Test cases:
1. Copy an image from browser/OS -> Ctrl+V in app -> new layer "Pasted Image" appears, image floats centered, can drag/resize, commit on click outside
2. Drag an image file from Finder/Explorer onto the canvas -> new layer named after file appears, image floats centered, drop-target highlight visible during drag
3. Paste a large image (bigger than 800x600) -> resize dialog appears, "Scale to fit" scales correctly, "Keep original size" preserves dimensions
4. Press Escape while external float is active -> float discarded, empty layer removed
5. Switch tools while external float is active -> float COMMITS (not discarded), layer kept
6. Existing Ctrl+C/Ctrl+V still works for internal clipboard (select area, copy, paste on same layer)
7. Drop a non-image file -> nothing happens (silently ignored)
8. Undo after committing a pasted image -> first undo removes draw from layer, second undo removes the layer itself
9. Paste/drop while an existing float is active -> existing float commits first, then new layer + float created

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(paste): address issues found during manual testing"
```

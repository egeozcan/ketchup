# Merge Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Photoshop-style Merge Down, Merge Visible, and Flatten Image operations to the layers panel.

**Architecture:** Three merge operations share a core compositing function. History uses a `beforeLayers`/`afterLayers` full-stack snapshot with a new `stack-replace` undo action. UI surfaces the operations via both a context menu on layer rows and a dropdown menu in the action bar.

**Tech Stack:** Lit 3, TypeScript, Canvas 2D API, @lit/context

**Spec:** `docs/superpowers/specs/2026-03-21-merge-layers-design.md`

---

### Task 1: Add `merge` type to HistoryEntry and SerializedHistoryEntry

**Files:**
- Modify: `src/types.ts:68-84`
- Modify: `src/storage/types.ts:44-60`

- [ ] **Step 1: Add merge variant to HistoryEntry**

In `src/types.ts`, add a new variant to the `HistoryEntry` union after the `crop` variant (after line 84):

```typescript
  | {
      type: 'merge';
      beforeLayers: LayerSnapshot[];
      afterLayers: LayerSnapshot[];
      previousActiveLayerId: string;
      afterActiveLayerId: string;
    };
```

- [ ] **Step 2: Add merge variant to SerializedHistoryEntry**

In `src/storage/types.ts`, add a new variant to the `SerializedHistoryEntry` union after the `crop` variant (after line 60):

```typescript
  | {
      type: 'merge';
      beforeLayers: SerializedLayerSnapshot[];
      afterLayers: SerializedLayerSnapshot[];
      previousActiveLayerId: string;
      afterActiveLayerId: string;
    };
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: Errors about non-exhaustive switches in `_getEntryLayerId`, `serializeHistoryEntry`, `deserializeHistoryEntry` (these are expected — we'll fix them in subsequent tasks).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/storage/types.ts
git commit -m "feat(layers): add merge variant to HistoryEntry types"
```

---

### Task 2: Add merge case to serialization and _getEntryLayerId

**Files:**
- Modify: `src/utils/storage-serialization.ts:80-148`
- Modify: `src/components/drawing-canvas.ts:441-456`

- [ ] **Step 1: Add merge case to serializeHistoryEntry**

In `src/utils/storage-serialization.ts`, add a `case 'merge'` block inside `serializeHistoryEntry` after the `crop` case (after line 106). Follow the exact same pattern as `crop`:

```typescript
    case 'merge': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => serializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => serializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'merge', beforeLayers, afterLayers,
        previousActiveLayerId: entry.previousActiveLayerId,
        afterActiveLayerId: entry.afterActiveLayerId,
      };
    }
```

- [ ] **Step 2: Add merge case to deserializeHistoryEntry**

In the same file, add a `case 'merge'` block inside `deserializeHistoryEntry` after the `crop` case (after line 141):

```typescript
    case 'merge': {
      const [beforeLayers, afterLayers] = await Promise.all([
        Promise.all(entry.beforeLayers.map((l) => deserializeSnapshot(l, blobs))),
        Promise.all(entry.afterLayers.map((l) => deserializeSnapshot(l, blobs))),
      ]);
      return {
        type: 'merge', beforeLayers, afterLayers,
        previousActiveLayerId: entry.previousActiveLayerId,
        afterActiveLayerId: entry.afterActiveLayerId,
      };
    }
```

- [ ] **Step 3: Add merge case to _getEntryLayerId**

In `src/components/drawing-canvas.ts`, add `case 'merge':` to the `_getEntryLayerId` switch alongside the existing `case 'crop': return null;` (around line 453):

```typescript
      case 'crop':
      case 'merge':
        return null;
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: Errors about unhandled `merge` case in `_applyUndo` and `_applyRedo` (expected — fixed in next task).

- [ ] **Step 5: Commit**

```bash
git add src/utils/storage-serialization.ts src/components/drawing-canvas.ts
git commit -m "feat(layers): add merge case to serialization and entry layer ID"
```

---

### Task 3: Add `stack-replace` undo handler and merge undo/redo dispatch

**Files:**
- Modify: `src/components/drawing-canvas.ts:541-695` (add merge cases to `_applyUndo` and `_applyRedo`)
- Modify: `src/components/drawing-app.ts:997-1066` (add `stack-replace` handler to `_onLayerUndo`)

- [ ] **Step 1: Add merge case to _applyUndo**

In `src/components/drawing-canvas.ts`, add a `case 'merge'` block inside `_applyUndo` after the `crop` case (after line 615):

```typescript
      case 'merge': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: {
            action: 'stack-replace',
            layers: entry.beforeLayers,
            activeLayerId: entry.previousActiveLayerId,
          },
        }));
        break;
      }
```

- [ ] **Step 2: Add merge case to _applyRedo**

In the same file, add a `case 'merge'` block inside `_applyRedo` after the `crop` case (after line 693):

```typescript
      case 'merge': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: {
            action: 'stack-replace',
            layers: entry.afterLayers,
            activeLayerId: entry.afterActiveLayerId,
          },
        }));
        break;
      }
```

- [ ] **Step 3: Add stack-replace handler to _onLayerUndo**

In `src/components/drawing-app.ts`, add a `case 'stack-replace'` block inside `_onLayerUndo` after the `crop-restore` case (after line 1063):

```typescript
      case 'stack-replace': {
        const snapshots = detail.layers as LayerSnapshot[];
        const activeLayerId = detail.activeLayerId as string;
        const newLayers: Layer[] = snapshots.map(snap => {
          const canvas = document.createElement('canvas');
          canvas.width = snap.imageData.width;
          canvas.height = snap.imageData.height;
          canvas.getContext('2d')!.putImageData(snap.imageData, 0, 0);
          return {
            id: snap.id,
            name: snap.name,
            visible: snap.visible,
            opacity: snap.opacity,
            canvas,
          };
        });
        this._state = { ...this._state, layers: newLayers, activeLayerId };
        break;
      }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors related to merge/stack-replace. May still have errors about missing context methods (fixed in next task).

- [ ] **Step 5: Commit**

```bash
git add src/components/drawing-canvas.ts src/components/drawing-app.ts
git commit -m "feat(layers): add stack-replace undo handler and merge undo/redo dispatch"
```

---

### Task 4: Add merge context methods and implement merge logic

**Files:**
- Modify: `src/contexts/drawing-context.ts:5-48` (add 3 methods to interface)
- Modify: `src/components/drawing-app.ts` (implement merge operations in context builder)

- [ ] **Step 1: Add merge methods to DrawingContextValue**

In `src/contexts/drawing-context.ts`, add three methods after the `renameLayer` line (after line 24):

```typescript
  mergeLayerDown: (id: string) => void;
  mergeVisibleLayers: () => void;
  flattenImage: () => void;
```

- [ ] **Step 2: Add _snapshotAllLayers helper to drawing-app.ts**

In `src/components/drawing-app.ts`, add a helper method after the existing `_snapshotLayer` method (after line 190):

```typescript
  private _snapshotAllLayers(): LayerSnapshot[] {
    return this._state.layers.map(l => this._snapshotLayer(l));
  }
```

- [ ] **Step 3: Add _compositeLayers helper to drawing-app.ts**

Add a private method that composites an array of layers onto a single canvas. Place it after the `_snapshotAllLayers` method:

```typescript
  /**
   * Composites the given layers (in order, bottom-to-top) onto a new
   * offscreen canvas, baking each layer's opacity into the result.
   */
  private _compositeLayers(layers: Layer[]): HTMLCanvasElement {
    const w = this._state.documentWidth;
    const h = this._state.documentHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    for (const layer of layers) {
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, 0, 0);
    }
    ctx.globalAlpha = 1;
    return canvas;
  }
```

- [ ] **Step 4: Implement mergeLayerDown in the context builder**

In `src/components/drawing-app.ts`, inside the `_buildContextValue()` method, add `mergeLayerDown` after the `renameLayer` method (after line 848). This goes inside the object literal that `_buildContextValue` returns:

```typescript
      mergeLayerDown: (id: string) => {
        const layers = this._state.layers;
        const idx = layers.findIndex(l => l.id === id);
        if (idx <= 0) return; // bottom layer or not found

        this.canvas?.clearSelection();
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;

        // Composite: bottom layer first, then active layer on top
        const bottomLayer = layers[idx - 1];
        const topLayer = layers[idx];
        const mergedCanvas = this._compositeLayers([bottomLayer, topLayer]);

        // Build new layers array: remove topLayer, replace bottomLayer's canvas
        const newLayers = layers
          .filter(l => l.id !== topLayer.id)
          .map(l => l.id === bottomLayer.id
            ? { ...l, canvas: mergedCanvas, opacity: 1 }
            : l);

        this._state = { ...this._state, layers: newLayers, activeLayerId: bottomLayer.id };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId: bottomLayer.id,
        });
        this._markDirty();
      },
```

- [ ] **Step 5: Implement mergeVisibleLayers**

Add `mergeVisibleLayers` after `mergeLayerDown`:

```typescript
      mergeVisibleLayers: () => {
        const layers = this._state.layers;
        const visibleLayers = layers.filter(l => l.visible);
        if (visibleLayers.length < 2) return;

        this.canvas?.clearSelection();
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;

        // Target is the bottom-most visible layer
        const target = visibleLayers[0];
        const mergedCanvas = this._compositeLayers(visibleLayers);

        // Remove all visible layers except target, replace target's canvas
        const visibleIds = new Set(visibleLayers.map(l => l.id));
        const newLayers = layers
          .filter(l => !visibleIds.has(l.id) || l.id === target.id)
          .map(l => l.id === target.id
            ? { ...l, canvas: mergedCanvas, opacity: 1 }
            : l);

        // If active layer was hidden, it survives the merge — keep it active.
        // Otherwise the merged result becomes active.
        const activeLayerSurvived = newLayers.some(l => l.id === previousActiveLayerId);
        const afterActiveLayerId = activeLayerSurvived ? previousActiveLayerId : target.id;

        this._state = { ...this._state, layers: newLayers, activeLayerId: afterActiveLayerId };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId,
        });
        this._markDirty();
      },
```

- [ ] **Step 6: Implement flattenImage**

Add `flattenImage` after `mergeVisibleLayers`:

```typescript
      flattenImage: () => {
        if (this._state.layers.length <= 1) return;

        this.canvas?.clearSelection();
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;

        // Composite only visible layers
        const visibleLayers = this._state.layers.filter(l => l.visible);
        const target = visibleLayers.length > 0 ? visibleLayers[0] : this._state.layers[0];
        const mergedCanvas = this._compositeLayers(visibleLayers);

        // Single layer remains
        const flatLayer: Layer = {
          id: target.id,
          name: target.name,
          visible: true,
          opacity: 1,
          canvas: mergedCanvas,
        };

        this._state = { ...this._state, layers: [flatLayer], activeLayerId: flatLayer.id };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId: flatLayer.id,
        });
        this._markDirty();
      },
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: No type errors. All three methods match the `DrawingContextValue` interface.

- [ ] **Step 8: Commit**

```bash
git add src/contexts/drawing-context.ts src/components/drawing-app.ts
git commit -m "feat(layers): implement merge down, merge visible, and flatten"
```

---

### Task 5: Add context menu to layers panel

**Files:**
- Modify: `src/components/layers-panel.ts`

- [ ] **Step 1: Add state properties for context menu**

In `src/components/layers-panel.ts`, add state properties for the context menu (after the existing `@state()` declarations, around line 8):

```typescript
  @state() private _contextMenuOpen = false;
  @state() private _contextMenuX = 0;
  @state() private _contextMenuY = 0;
```

- [ ] **Step 2: Add context menu CSS**

Add CSS styles for the context menu. Insert after the `.action-btn svg` rule (after line 331):

```css
    /* ── Context menu ──────────────────────────── */
    .context-menu {
      position: fixed;
      z-index: 300;
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 4px 0;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .context-menu-item {
      display: block;
      width: 100%;
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: #ddd;
      font-size: 0.8125rem;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
    }

    .context-menu-item:hover:not(:disabled) {
      background: #5b8cf7;
      color: #fff;
    }

    .context-menu-item:disabled {
      color: #666;
      cursor: default;
    }
```

- [ ] **Step 3: Add contextmenu event handler to layer rows**

In the `_renderLayerRow` method, add a `@contextmenu` handler to the `.layer-row` div (the one around line 877-878). Add it alongside the existing `@click` handler:

```typescript
        @contextmenu=${(e: MouseEvent) => this._onContextMenu(e)}
```

- [ ] **Step 4: Implement _onContextMenu and _closeContextMenu**

Add the handler methods:

```typescript
  private _onContextMenu(e: MouseEvent) {
    e.preventDefault();
    this._contextMenuX = e.clientX;
    this._contextMenuY = e.clientY;
    this._contextMenuOpen = true;
  }

  private _closeContextMenu() {
    this._contextMenuOpen = false;
  }
```

- [ ] **Step 5: Render the context menu**

In the `render()` method, add the context menu markup after the `.action-bar` div (before the closing template literal of the panel). The menu should render inside the panel template, conditionally when `_contextMenuOpen` is true:

```typescript
      ${this._contextMenuOpen ? html`
        <div
          class="context-menu"
          style="left:${this._contextMenuX}px;top:${this._contextMenuY}px"
        >
          <button
            class="context-menu-item"
            ?disabled=${layers.findIndex(l => l.id === activeLayerId) === 0}
            @click=${() => { this.ctx.mergeLayerDown(activeLayerId); this._closeContextMenu(); }}
          >Merge Down</button>
          <button
            class="context-menu-item"
            ?disabled=${layers.filter(l => l.visible).length < 2}
            @click=${() => { this.ctx.mergeVisibleLayers(); this._closeContextMenu(); }}
          >Merge Visible</button>
          <button
            class="context-menu-item"
            ?disabled=${layers.length <= 1}
            @click=${() => { this.ctx.flattenImage(); this._closeContextMenu(); }}
          >Flatten Image</button>
        </div>
      ` : nothing}
```

- [ ] **Step 6: Add click-outside and Escape dismissal**

Override `connectedCallback` and `disconnectedCallback` to listen for clicks and keydown on the document to close the context menu:

```typescript
  private _onDocClick = () => { this._closeContextMenu(); };
  private _onDocKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') this._closeContextMenu(); };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this._onDocClick);
    document.addEventListener('keydown', this._onDocKeyDown);
  }

  override disconnectedCallback() {
    document.removeEventListener('click', this._onDocClick);
    document.removeEventListener('keydown', this._onDocKeyDown);
    super.disconnectedCallback();
  }
```

Note: If `connectedCallback`/`disconnectedCallback` already exist in this component, merge the listeners into the existing methods rather than overriding again.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/layers-panel.ts
git commit -m "feat(layers): add context menu with merge operations"
```

---

### Task 6: Add dropdown menu to the action bar

**Files:**
- Modify: `src/components/layers-panel.ts`

- [ ] **Step 1: Add state property for dropdown**

Add a state property:

```typescript
  @state() private _dropdownOpen = false;
```

- [ ] **Step 2: Add dropdown CSS**

Add CSS after the context menu styles:

```css
    /* ── Dropdown menu ─────────────────────────── */
    .action-bar-wrapper {
      position: relative;
    }

    .dropdown-menu {
      position: absolute;
      bottom: 100%;
      right: 0;
      margin-bottom: 4px;
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 4px 0;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      z-index: 300;
    }

    .dropdown-menu button {
      display: block;
      width: 100%;
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: #ddd;
      font-size: 0.8125rem;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
    }

    .dropdown-menu button:hover:not(:disabled) {
      background: #5b8cf7;
      color: #fff;
    }

    .dropdown-menu button:disabled {
      color: #666;
      cursor: default;
    }
```

- [ ] **Step 3: Wrap action bar and add dropdown button + menu**

Modify the `.action-bar` template in `render()` (around lines 853-865). Wrap it in a `.action-bar-wrapper` div and add a "..." button with the dropdown menu:

```typescript
      <div class="action-bar-wrapper">
        ${this._dropdownOpen ? html`
          <div class="dropdown-menu" @click=${(e: Event) => e.stopPropagation()}>
            <button
              ?disabled=${layers.findIndex(l => l.id === activeLayerId) === 0}
              @click=${() => { this.ctx.mergeLayerDown(activeLayerId); this._dropdownOpen = false; }}
            >Merge Down</button>
            <button
              ?disabled=${layers.filter(l => l.visible).length < 2}
              @click=${() => { this.ctx.mergeVisibleLayers(); this._dropdownOpen = false; }}
            >Merge Visible</button>
            <button
              ?disabled=${layers.length <= 1}
              @click=${() => { this.ctx.flattenImage(); this._dropdownOpen = false; }}
            >Flatten Image</button>
          </div>
        ` : nothing}
        <div class="action-bar">
          <button
            class="action-btn"
            title="Add layer"
            @click=${() => this.ctx.addLayer()}
          >${this._plusIcon} Add</button>
          <button
            class="action-btn"
            title="Delete layer"
            ?disabled=${layers.length <= 1}
            @click=${() => this.ctx.deleteLayer(activeLayerId)}
          >${this._trashIcon} Delete</button>
          <button
            class="action-btn"
            title="More actions"
            @click=${(e: Event) => { e.stopPropagation(); this._dropdownOpen = !this._dropdownOpen; }}
          >&#8943;</button>
        </div>
      </div>
```

- [ ] **Step 4: Close dropdown on outside click / Escape**

Update the existing `_onDocClick` and `_onDocKeyDown` handlers (added in Task 5) to also close the dropdown:

```typescript
  private _onDocClick = () => {
    this._closeContextMenu();
    this._dropdownOpen = false;
  };
  private _onDocKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this._closeContextMenu();
      this._dropdownOpen = false;
    }
  };
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/layers-panel.ts
git commit -m "feat(layers): add dropdown menu with merge operations to action bar"
```

---

### Task 7: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Test Merge Down**

1. Create 3 layers, draw something on each
2. Select the top layer, set its opacity to 50%
3. Right-click the layer row — context menu should appear with "Merge Down", "Merge Visible", "Flatten Image"
4. Click "Merge Down" — top layer should merge into layer 2, result should show baked opacity
5. Verify the merged layer has the name of the lower layer and opacity 100%
6. Ctrl+Z — should undo perfectly, restoring all 3 layers with original content and opacity

- [ ] **Step 3: Test Merge Visible**

1. Start with 3 layers, hide the middle one
2. Use the "..." dropdown menu in the action bar
3. Click "Merge Visible" — visible layers should merge, hidden layer should remain
4. Verify the result is at the bottom-most visible position
5. Ctrl+Z — should restore all 3 layers

- [ ] **Step 4: Test Flatten**

1. Start with 3 layers (some hidden)
2. Click "Flatten Image" from context menu or dropdown
3. Verify only 1 layer remains with composited visible content
4. Ctrl+Z — should restore all original layers

- [ ] **Step 5: Test edge cases**

1. With 1 layer only — all three menu items should be disabled
2. With active layer at bottom — "Merge Down" should be disabled
3. With only 1 visible layer — "Merge Visible" should be disabled
4. With a floating selection active — it should auto-commit before merge

- [ ] **Step 6: Test the dropdown menu**

1. Click the "..." button — dropdown should appear above the action bar
2. Click outside — dropdown should close
3. Press Escape — dropdown should close

- [ ] **Step 7: Build check**

Run: `npm run build`
Expected: Successful production build with no errors.

- [ ] **Step 8: Commit (if any fixes needed)**

If any bugs were found and fixed during testing, commit them:

```bash
git add -u
git commit -m "fix(layers): fix issues found during merge smoke test"
```

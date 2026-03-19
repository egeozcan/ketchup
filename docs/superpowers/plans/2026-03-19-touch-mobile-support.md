# Touch & Mobile Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full touch screen and small screen (mobile) support with feature parity across phone, tablet, and desktop.

**Architecture:** CSS-first responsive strategy with a ResizeObserver-driven `isMobile` flag propagated via `@lit/context`. Below 768px, the UI switches to a bottom tab bar, contextual popovers, and a layers bottom sheet. Multi-touch (pinch-to-zoom, two-finger pan) is added to `drawing-canvas.ts` by tracking active pointer IDs.

**Tech Stack:** Lit 3, TypeScript 5, Vite 6, `@lit/context`, Pointer Events API

**Spec:** `docs/superpowers/specs/2026-03-19-touch-mobile-support-design.md`

---

## Chunk 1: Foundation — isMobile flag, viewport, desktop touch targets

### Task 1: Viewport meta & global CSS

**Files:**
- Modify: `index.html:5` (viewport meta tag)
- Modify: `index.html:8-9` (global styles)

- [ ] **Step 1: Update viewport meta tag**

In `index.html`, replace line 5:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

with:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
```

- [ ] **Step 2: Add overscroll-behavior to body**

In `index.html`, change line 9 from:

```css
html, body { width: 100%; height: 100%; overflow: hidden; }
```

to:

```css
html, body { width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
```

- [ ] **Step 3: Verify the app still loads**

Run: `npm run dev`

Open in browser, confirm app loads and functions normally. Ctrl+wheel zoom on canvas should still work. Browser pull-to-refresh should be suppressed.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(mobile): update viewport meta and prevent overscroll"
```

---

### Task 2: Add `isMobile` to context type and DrawingState

**Files:**
- Modify: `src/types.ts:47` (DrawingState interface — NOT modified, `isMobile` lives on context only)
- Modify: `src/contexts/drawing-context.ts:5-47` (DrawingContextValue interface)

- [ ] **Step 1: Add `isMobile` to `DrawingContextValue`**

In `src/contexts/drawing-context.ts`, add after line 42 (after `viewportHeight: number;`):

```typescript
  isMobile: boolean;
```

- [ ] **Step 2: Verify TypeScript catches the missing property**

Run: `npx tsc --noEmit`

Expected: FAIL — `drawing-app.ts` `_buildContextValue()` doesn't return `isMobile` yet. This confirms the type change is wired correctly.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/drawing-context.ts
git commit -m "feat(mobile): add isMobile to DrawingContextValue type"
```

---

### Task 3: Wire `isMobile` flag in `drawing-app.ts`

**Files:**
- Modify: `src/components/drawing-app.ts:23-62` (styles — add mobile CSS)
- Modify: `src/components/drawing-app.ts:80-91` (state declarations)
- Modify: `src/components/drawing-app.ts:690-740` (_buildContextValue)
- Modify: `src/components/drawing-app.ts:1017-1022` (connectedCallback)
- Modify: `src/components/drawing-app.ts:1071-1098` (disconnectedCallback)
- Modify: `src/components/drawing-app.ts:1100-1129` (render method)

- [ ] **Step 1: Add `_isMobile` state and ResizeObserver**

After the existing `@state()` declarations (around line 90), add:

```typescript
  @state() private _isMobile = false;
  private _mobileObserver: ResizeObserver | null = null;
```

- [ ] **Step 2: Set up ResizeObserver in connectedCallback**

In `connectedCallback()` (line 1017), after `this._initStorage();`, add:

```typescript
    this._mobileObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this._isMobile = entry.contentRect.width < 768;
      }
    });
    this._mobileObserver.observe(this);
```

- [ ] **Step 3: Clean up observer in disconnectedCallback**

In `disconnectedCallback()` (line 1071), after `super.disconnectedCallback();`, add:

```typescript
    this._mobileObserver?.disconnect();
    this._mobileObserver = null;
```

- [ ] **Step 4: Reflect `isMobile` as host attribute**

Add the `updated` lifecycle method (or add to existing `willUpdate`). In `willUpdate()` at line 906, after `this._provider.setValue(this._buildContextValue());`, add:

```typescript
    this.toggleAttribute('mobile', this._isMobile);
```

- [ ] **Step 5: Add `isMobile` to `_buildContextValue`**

In `_buildContextValue()` (line 690), add to the returned object after `viewportHeight`:

```typescript
      isMobile: this._isMobile,
```

- [ ] **Step 6: Add mobile layout CSS**

In the static styles (line 23), add after the existing `.right-sidebar layers-panel` rule:

```css
    /* ── Mobile layout ─────────────────────────── */
    :host([mobile]) {
      flex-direction: column;
    }

    :host([mobile]) tool-settings {
      display: none;
    }

    :host([mobile]) .main-area {
      flex-direction: column;
    }

    :host([mobile]) .right-sidebar {
      display: none;
    }
```

- [ ] **Step 7: Verify TypeScript passes**

Run: `npx tsc --noEmit`

Expected: PASS — all types now satisfied.

- [ ] **Step 8: Test in browser**

Run: `npm run dev`

- At full width: app should look identical to before (no `[mobile]` attribute)
- Resize browser window below 768px: toolbar and right sidebar should disappear, only canvas remains
- Resize back above 768px: layout restored

- [ ] **Step 9: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat(mobile): add isMobile ResizeObserver and mobile layout CSS"
```

---

### Task 4: Bump desktop touch targets

**Files:**
- Modify: `src/components/app-toolbar.ts:44-56` (button styles)
- Modify: `src/components/layers-panel.ts` (layer row styles)
- Modify: `src/components/tool-settings.ts:62-70` (color swatch styles)

- [ ] **Step 1: Bump toolbar button size from 36px to 44px**

In `src/components/app-toolbar.ts`, change the `button` CSS rule (line 48-49):

```css
      width: 36px;
      height: 36px;
```

to:

```css
      width: 44px;
      height: 44px;
```

And change `padding: 6px;` (line 55) to `padding: 10px;` so the 20px icon stays the same size.

Also change the `:host` width from `52px` (line 24) to `60px` to accommodate the larger buttons. And change `padding: 8px;` (line 22) to `padding: 8px;` (stays same).

- [ ] **Step 2: Bump color swatch size from 18px to 24px**

In `src/components/tool-settings.ts`, change the `.color-swatch` width and height (lines 63-64):

```css
      width: 1.125rem;
      height: 1.125rem;
```

to:

```css
      width: 1.5rem;
      height: 1.5rem;
```

- [ ] **Step 3: Bump layer row minimum height**

In `src/components/layers-panel.ts`, find the `.layer-row` CSS rule and ensure `min-height` is at least `44px`. Look for the existing height/min-height and update it.

- [ ] **Step 4: Update sidebar width to match new toolbar**

In `src/components/drawing-app.ts`, the toolbar is inside `.main-area` but the toolbar controls its own width. No change needed in drawing-app.ts since the toolbar sets its own width.

- [ ] **Step 5: Verify visually**

Run: `npm run dev`

Check: toolbar buttons are larger, color swatches are larger, layer rows have comfortable tap height. Layout should still feel clean at desktop width.

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/app-toolbar.ts src/components/tool-settings.ts src/components/layers-panel.ts
git commit -m "feat(mobile): bump touch targets to 44px for desktop and touch laptop"
```

---

### Task 5: Hide navigator panel on mobile

**Files:**
- Modify: `src/components/navigator-panel.ts:478-536` (render method)

- [ ] **Step 1: Consume isMobile from context and hide on mobile**

In `src/components/navigator-panel.ts`, the component already has a `_ctx` ContextConsumer. In the `render()` method (line 478), after the existing `if (!this.ctx.state.layersPanelOpen) return html\`\`;` check (line 482), add:

```typescript
    if (this.ctx.isMobile) return html``;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`

Expected: PASS

At full width, navigator renders. Below 768px, the right sidebar is already hidden by drawing-app.ts CSS, so this is defense-in-depth.

- [ ] **Step 3: Commit**

```bash
git add src/components/navigator-panel.ts
git commit -m "feat(mobile): hide navigator panel on mobile (pinch-to-zoom replaces it)"
```

---

## Chunk 2: Multi-touch — pinch-to-zoom and two-finger pan

### Task 6: Add pointer tracking map to drawing-canvas

**Files:**
- Modify: `src/components/drawing-canvas.ts:59-90` (state declarations)
- Modify: `src/components/drawing-canvas.ts:879-990` (_onPointerDown)
- Modify: `src/components/drawing-canvas.ts:1019-1108` (_onPointerMove)
- Modify: `src/components/drawing-canvas.ts:1110-1220` (_onPointerUp)

- [ ] **Step 1: Add multi-touch state**

In `src/components/drawing-canvas.ts`, after the zoom state declarations (around line 84), add:

```typescript
  // --- Multi-touch state ---
  private _pointers = new Map<number, { x: number; y: number }>();
  private _pinching = false;
  private _lastPinchDist = 0;
  private _lastPinchMidX = 0;
  private _lastPinchMidY = 0;
```

- [ ] **Step 2: Track pointers in _onPointerDown**

At the very top of `_onPointerDown` (line 879), before any other logic, add pointer tracking:

```typescript
    // Track all active pointers for multi-touch
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers → enter pinch/pan mode
    if (this._pointers.size === 2) {
      this._enterPinchMode(e);
      return;
    }

    // More than 2 fingers → ignore
    if (this._pointers.size > 2) return;
```

- [ ] **Step 3: Track pointers in _onPointerMove**

At the very top of `_onPointerMove` (line 1019), before any other logic, add:

```typescript
    // Update pointer position
    if (this._pointers.has(e.pointerId)) {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Handle pinch/pan gesture
    if (this._pinching) {
      this._updatePinch();
      return;
    }
```

- [ ] **Step 4: Track pointers in _onPointerUp**

At the very top of `_onPointerUp` (line 1110), before any other logic, add:

```typescript
    // Remove pointer from tracking
    this._pointers.delete(e.pointerId);

    // End pinch mode when fewer than 2 pointers
    if (this._pinching) {
      if (this._pointers.size < 2) {
        this._pinching = false;
      }
      return;
    }
```

- [ ] **Step 4b: Handle pointerleave and pointercancel**

The canvas template binds `@pointerleave=${this._onPointerUp}`. This is wrong during pinch mode — a finger near the edge fires `pointerleave` but the finger is still down. Add a separate `_onPointerLeave` handler:

```typescript
  private _onPointerLeave(e: PointerEvent) {
    // During pinch/pan, don't treat edge-exit as pointer up — the finger is still down.
    // Only clean up if the pointer is truly gone (not captured).
    if (this._pinching) {
      // Don't remove from map — pointermove with capture still fires
      return;
    }
    this._onPointerUp(e);
  }
```

In the render template, change `@pointerleave=${this._onPointerUp}` to `@pointerleave=${this._onPointerLeave}`.

Also add a `pointercancel` handler to clean up pinch state if the browser cancels a touch (e.g., palm rejection):

```typescript
  private _onPointerCancel(e: PointerEvent) {
    this._pointers.delete(e.pointerId);
    if (this._pinching && this._pointers.size < 2) {
      this._pinching = false;
    }
  }
```

In the render template, add `@pointercancel=${this._onPointerCancel}` to the main canvas.

- [ ] **Step 5: Add stub methods so TypeScript passes**

Add empty stubs so the code compiles (they'll be implemented in the next steps):

```typescript
  private _enterPinchMode(_e: PointerEvent) { /* implemented in next steps */ }
  private _updatePinch() { /* implemented in next steps */ }
```

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(mobile): add pointer tracking map for multi-touch"
```

---

### Task 7: Implement pinch-to-zoom and two-finger pan

**Files:**
- Modify: `src/components/drawing-canvas.ts` (add _enterPinchMode, _updatePinch, _cancelCurrentTool)

- [ ] **Step 1: Add _cancelCurrentTool method**

Add this method to `drawing-canvas.ts`, after the `_endPan()` method (around line 757):

```typescript
  /**
   * Cancel any in-progress tool operation and release pointer capture.
   * Called when a second pointer arrives (entering pinch/pan mode).
   */
  private _cancelCurrentTool(pointerId: number) {
    // Release pointer capture if held
    try { this.mainCanvas.releasePointerCapture(pointerId); } catch { /* not captured */ }

    // Cancel brush/shape strokes
    if (this._drawing) {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      // Restore layer to before the stroke
      if (this._beforeDrawData) {
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          layerCtx.putImageData(this._beforeDrawData, 0, 0);
        }
        this._beforeDrawData = null;
      }
      // Clear shape preview
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      this.composite();
    }

    // Cancel panning
    if (this._panning) {
      this._endPan();
    }

    // Cancel move tool drag
    if (this._moveTempCanvas) {
      if (this._beforeDrawData) {
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          layerCtx.putImageData(this._beforeDrawData, 0, 0);
        }
        this._beforeDrawData = null;
      }
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this.composite();
    }

    // Cancel selection drawing (but keep existing float)
    if (this._selectionDrawing) {
      this._selectionDrawing = false;
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    }

    // Cancel float move/resize (keep float at current position)
    this._floatMoving = false;
    this._floatResizing = false;
    this._floatDragOffset = null;
    this._floatResizeOrigin = null;
    this._floatResizeHandle = null;

    // Cancel crop drag (keep existing rect)
    this._cropDragging = false;
    this._cropHandle = null;
    this._cropDragOrigin = null;
    this._cropRectOrigin = null;
  }
```

- [ ] **Step 2: Add _enterPinchMode method**

Add after `_cancelCurrentTool`:

```typescript
  /** Enter pinch/pan mode: cancel current tool, initialize pinch tracking */
  private _enterPinchMode(e: PointerEvent) {
    // Cancel whatever the first finger was doing
    // Find the OTHER pointer (the one that was down first)
    for (const [id] of this._pointers) {
      if (id !== e.pointerId) {
        this._cancelCurrentTool(id);
        break;
      }
    }

    this._pinching = true;
    const pts = [...this._pointers.values()];
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    this._lastPinchDist = Math.hypot(dx, dy);
    this._lastPinchMidX = (pts[0].x + pts[1].x) / 2;
    this._lastPinchMidY = (pts[0].y + pts[1].y) / 2;
  }
```

- [ ] **Step 3: Add _updatePinch method**

Add after `_enterPinchMode`:

```typescript
  /** Process a pinch/pan gesture frame: update zoom and pan */
  private _updatePinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;

    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const dist = Math.hypot(dx, dy);
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;

    // Zoom: ratio of current distance to previous distance
    if (this._lastPinchDist > 0) {
      const scale = dist / this._lastPinchDist;
      const rect = this.mainCanvas.getBoundingClientRect();
      const viewportX = midX - rect.left;
      const viewportY = midY - rect.top;

      // Anchor zoom to the midpoint between the two fingers
      const docX = (viewportX - this._panX) / this._zoom;
      const docY = (viewportY - this._panY) / this._zoom;

      const newZoom = Math.min(
        DrawingCanvas.MAX_ZOOM,
        Math.max(DrawingCanvas.MIN_ZOOM, this._zoom * scale),
      );

      this._panX = viewportX - docX * newZoom;
      this._panY = viewportY - docY * newZoom;
      this._zoom = newZoom;
    }

    // Pan: delta of midpoint
    const panDx = midX - this._lastPinchMidX;
    const panDy = midY - this._lastPinchMidY;
    this._panX += panDx;
    this._panY += panDy;

    this._lastPinchDist = dist;
    this._lastPinchMidX = midX;
    this._lastPinchMidY = midY;

    this.composite();
    if (this._float) this._redrawFloatPreview();
    if (this._textEditing) this._renderTextPreview();
    this._dispatchZoomChange();
  }
```

- [ ] **Step 4: Verify TypeScript passes**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 5: Test in browser with touch device or DevTools**

Run: `npm run dev`

Open Chrome DevTools → toggle device toolbar → enable touch simulation. Test:
- Single finger drawing: works as before
- Two-finger pinch: zooms canvas
- Two-finger drag: pans canvas
- Start drawing, add second finger: stroke is cancelled, enters pinch mode
- Lift one finger, then draw: normal drawing resumes

- [ ] **Step 6: Commit**

```bash
git add src/components/drawing-canvas.ts
git commit -m "feat(mobile): implement pinch-to-zoom and two-finger pan"
```

---

## Chunk 3: Mobile bottom tab bar and undo/redo

### Task 8: Mobile bottom bar render branch in app-toolbar

**Files:**
- Modify: `src/components/app-toolbar.ts` (full file — add mobile render branch, styles, popover state)

- [ ] **Step 1: Add isMobile from context**

The component already has a `_ctx` ContextConsumer. Add a `_popoverGroup` state for tracking which tool group popover is open:

```typescript
  @state() private _popoverGroup: number | null = null;
```

(Add the `state` import to the existing decorators import at line 2.)

- [ ] **Step 2: Add mobile CSS**

Add to the static styles, after the existing `.action-group` rule (around line 89):

```css
    /* ── Mobile bottom bar ─────────────────────── */
    :host([mobile]) {
      flex-direction: row;
      width: 100%;
      height: 48px;
      padding: 4px 8px;
      padding-bottom: calc(4px + env(safe-area-inset-bottom));
      align-items: center;
      justify-content: space-between;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      border-top: 1px solid #444;
      touch-action: none;
    }

    :host([mobile])::-webkit-scrollbar {
      display: none;
    }

    :host([mobile]) .group {
      flex-direction: row;
    }

    :host([mobile]) .separator {
      width: 1px;
      height: 24px;
      margin: 0 4px;
    }

    :host([mobile]) .action-group {
      flex-direction: row;
      margin-top: 0;
      margin-left: auto;
    }

    .popover {
      display: none;
    }

    :host([mobile]) .popover {
      display: flex;
      flex-direction: column;
      position: absolute;
      bottom: calc(52px + env(safe-area-inset-bottom));
      left: 8px;
      right: 8px;
      background: #2c2c2c;
      border: 1px solid #555;
      border-radius: 12px;
      padding: 8px;
      gap: 8px;
      z-index: 100;
      touch-action: manipulation;
      box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
    }

    .popover-backdrop {
      display: none;
    }

    :host([mobile]) .popover-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 99;
    }

    .popover .sub-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding-bottom: 8px;
      border-bottom: 1px solid #444;
    }
```

- [ ] **Step 3: Reflect mobile attribute**

Add a `willUpdate` override (or add to existing) to reflect the mobile attribute:

```typescript
  override willUpdate() {
    super.willUpdate();
    this.toggleAttribute('mobile', this.ctx?.isMobile ?? false);
  }
```

- [ ] **Step 4: Add mobile render branch**

In `render()`, after `const { activeTool } = this.ctx.state;`, add:

```typescript
    if (this.ctx.isMobile) {
      return this._renderMobile(activeTool);
    }
```

- [ ] **Step 5: Add _renderMobile method**

```typescript
  private _renderMobile(activeTool: ToolType) {
    return html`
      <!-- Undo/Redo at left -->
      <button
        title="Undo"
        ?disabled=${!this.ctx.canUndo}
        @click=${() => this.ctx.undo()}
      >${actionIcons.undo}</button>
      <button
        title="Redo"
        ?disabled=${!this.ctx.canRedo}
        @click=${() => this.ctx.redo()}
      >${actionIcons.redo}</button>

      <div class="separator"></div>

      <!-- Tool groups: show one representative button per group -->
      ${toolGroups.map((group, i) => {
        // Show the active tool from this group, or the first tool
        const activeToolInGroup = group.find(t => t === activeTool);
        const displayTool = activeToolInGroup ?? group[0];
        const isActiveGroup = group.includes(activeTool);

        return html`
          <button
            class=${isActiveGroup ? 'active' : ''}
            title=${toolLabels[displayTool]}
            @click=${() => this._onMobileToolTap(group, i)}
          >${toolIcons[displayTool]}</button>
        `;
      })}

      <div class="separator"></div>

      <!-- Layers button -->
      <button
        title="Layers"
        @click=${() => { this._closePopover(); this.ctx.toggleLayersPanel(); }}
      >${html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`}</button>

      <!-- More actions -->
      <button
        title="More"
        @click=${() => this._onMobileMoreTap()}
      ><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>

      <!-- Popover -->
      ${this._popoverGroup !== null ? html`
        <div class="popover-backdrop" @click=${() => this._closePopover()}></div>
        <div class="popover">
          ${this._renderPopoverContent(activeTool)}
        </div>
      ` : ''}
    `;
  }
```

- [ ] **Step 6: Add popover interaction methods**

```typescript
  /** -1 = more actions popover, 0-3 = tool group index */
  private _onMobileToolTap(group: ToolType[], groupIndex: number) {
    const { activeTool } = this.ctx.state;
    const isActiveGroup = group.includes(activeTool);

    if (isActiveGroup) {
      // Tap on active group → toggle popover (sub-tools + settings)
      const newGroup = this._popoverGroup === groupIndex ? null : groupIndex;
      this._popoverGroup = newGroup;
      // Close layers sheet when opening a popover (mutual exclusion)
      if (newGroup !== null && this.ctx.state.layersPanelOpen) {
        this.ctx.toggleLayersPanel();
      }
    } else {
      // Tap on different group → switch to that group's first tool, close popover
      this.ctx.setTool(group[0]);
      this._popoverGroup = null;
    }
  }

  private _onMobileMoreTap() {
    this._popoverGroup = this._popoverGroup === -1 ? null : -1;
  }

  private _closePopover() {
    this._popoverGroup = null;
  }

  private _renderPopoverContent(activeTool: ToolType) {
    if (this._popoverGroup === -1) {
      // More actions
      return html`
        <button title="Save" @click=${() => { this.ctx.saveCanvas(); this._closePopover(); }}>${actionIcons.save} Save</button>
        <button title="Clear canvas" @click=${() => { this.ctx.clearCanvas(); this._closePopover(); }}>${actionIcons.clear} Clear</button>
      `;
    }

    const group = toolGroups[this._popoverGroup!];
    if (!group) return html``;

    return html`
      ${group.length > 1 ? html`
        <div class="sub-tools">
          ${group.map(tool => html`
            <button
              class=${activeTool === tool ? 'active' : ''}
              title=${toolLabels[tool]}
              @click=${() => { this.ctx.setTool(tool); }}
            >${toolIcons[tool]}</button>
          `)}
        </div>
      ` : ''}
      <tool-settings></tool-settings>
    `;
  }
```

- [ ] **Step 7: Add the `layers` action icon if missing**

Check `tool-icons.ts` for an `actionIcons.layers`. If not present, the inline SVG in the render method handles it. No change needed.

- [ ] **Step 8: Verify TypeScript passes**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 9: Test in browser**

Run: `npm run dev`

- Below 768px: bottom bar appears with undo/redo, tool groups (one button per group), layers, more
- Tap a tool: switches to it
- Tap active tool again: popover opens with sub-tools and settings
- Tap outside popover: closes
- More button: shows Save/Clear
- Above 768px: original vertical sidebar

- [ ] **Step 10: Commit**

```bash
git add src/components/app-toolbar.ts
git commit -m "feat(mobile): add bottom tab bar with tool groups and popover"
```

---

### Task 9: Mobile layout for tool-settings in popover

**Files:**
- Modify: `src/components/tool-settings.ts:28-42` (styles)

- [ ] **Step 1: Add mobile-aware CSS to tool-settings**

In `src/components/tool-settings.ts`, add to the static styles after the existing rules:

```css
    /* ── Inside mobile popover ─────────────────── */
    :host([mobile]) {
      flex-direction: column;
      align-items: flex-start;
      padding: 0;
      min-height: 0;
      background: transparent;
      touch-action: manipulation;
    }

    :host([mobile]) .section {
      width: 100%;
    }

    :host([mobile]) input[type="range"] {
      width: 100%;
    }
```

**Important:** `:host-context()` has poor cross-browser support — do NOT use it. Instead, toggle a `mobile` attribute on the element. Add a `willUpdate` override in `tool-settings.ts`:

```typescript
  override willUpdate() {
    this.toggleAttribute('mobile', this.ctx?.isMobile ?? false);
  }
```

The CSS above uses `:host([mobile])` which works in all browsers.

- [ ] **Step 2: Suppress keyboard shortcut hints on mobile**

In `src/components/app-toolbar.ts`, in the desktop render path (the existing `render()` method), the title attribute already shows shortcuts: `title=${toolLabels[tool]} (${toolShortcuts[tool]})`. In the mobile render, we already use just `title=${toolLabels[displayTool]}` without shortcuts. This is already handled.

- [ ] **Step 3: Verify TypeScript passes**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 4: Test in browser**

Run: `npm run dev`

Below 768px: open a tool popover → tool settings should display vertically, readable on narrow screen.

- [ ] **Step 5: Commit**

```bash
git add src/components/tool-settings.ts
git commit -m "feat(mobile): add vertical layout for tool-settings in popover"
```

---

## Chunk 4: Layers bottom sheet

### Task 10: Convert layer drag-reorder from DragEvent to pointer events

**Files:**
- Modify: `src/components/layers-panel.ts:436-545` (drag-and-drop section)
- Modify: `src/components/layers-panel.ts` (layer row template — remove draggable, add pointer handlers)

This is a prerequisite for mobile: the HTML Drag and Drop API doesn't work with touch.

- [ ] **Step 1: Replace drag state with pointer-based drag state**

Replace the existing drag state declarations:

```typescript
  @state() private _draggedLayerId: string | null = null;
```

with:

```typescript
  @state() private _draggedLayerId: string | null = null;
  private _dragPointerId: number | null = null;
  private _dragStartY = 0;
  private _dragCurrentY = 0;
  private _dragThreshold = 5; // px before drag activates
  private _dragActivated = false;
```

- [ ] **Step 2: Replace DragEvent handlers with pointer event handlers**

Remove the methods: `_onDragStart`, `_onDragOver`, `_onDragLeave`, `_onDrop`, `_onDragEnd`.

Add new pointer-based reorder methods:

```typescript
  private _onReorderPointerDown(layer: Layer, e: PointerEvent) {
    if (e.button !== 0) return;
    this._draggedLayerId = layer.id;
    this._dragPointerId = e.pointerId;
    this._dragStartY = e.clientY;
    this._dragCurrentY = e.clientY;
    this._dragActivated = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onReorderPointerMove(e: PointerEvent) {
    if (this._dragPointerId !== e.pointerId || !this._draggedLayerId) return;
    this._dragCurrentY = e.clientY;

    if (!this._dragActivated) {
      if (Math.abs(this._dragCurrentY - this._dragStartY) < this._dragThreshold) return;
      this._dragActivated = true;
    }

    // Find which row we're over and show drop indicator
    this._clearDropIndicators();
    const rows = this.shadowRoot?.querySelectorAll('.layer-row');
    if (!rows) return;

    for (const row of rows) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (this._dragCurrentY >= rect.top && this._dragCurrentY <= rect.bottom) {
        const midY = rect.top + rect.height / 2;
        if (this._dragCurrentY < midY) {
          row.classList.add('drop-above');
        } else {
          row.classList.add('drop-below');
        }
        break;
      }
    }
  }

  private _onReorderPointerUp(e: PointerEvent) {
    if (this._dragPointerId !== e.pointerId) return;

    const draggedId = this._draggedLayerId;
    if (!draggedId || !this._dragActivated) {
      this._clearDragState();
      return;
    }

    // Find the target row
    const rows = this.shadowRoot?.querySelectorAll('.layer-row');
    if (!rows) {
      this._clearDragState();
      return;
    }

    let targetId: string | null = null;
    let dropAbove = false;

    for (const row of rows) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (this._dragCurrentY >= rect.top && this._dragCurrentY <= rect.bottom) {
        targetId = (row as HTMLElement).dataset.layerId ?? null;
        const midY = rect.top + rect.height / 2;
        dropAbove = this._dragCurrentY < midY;
        break;
      }
    }

    if (targetId && targetId !== draggedId) {
      const layers = this.ctx.state.layers;
      const targetArrayIdx = layers.findIndex(l => l.id === targetId);
      if (targetArrayIdx !== -1) {
        let newArrayIdx = dropAbove ? targetArrayIdx + 1 : targetArrayIdx;
        const draggedArrayIdx = layers.findIndex(l => l.id === draggedId);
        if (draggedArrayIdx < newArrayIdx) newArrayIdx -= 1;
        newArrayIdx = Math.max(0, Math.min(layers.length - 1, newArrayIdx));
        if (draggedArrayIdx !== newArrayIdx) {
          this.ctx.reorderLayer(draggedId, newArrayIdx);
        }
      }
    }

    this._clearDragState();
  }
```

- [ ] **Step 3: Update layer row template**

Find the layer row template in the render method. Remove:
- `draggable="true"` attribute
- `@dragstart`, `@dragover`, `@dragleave`, `@drop`, `@dragend` handlers

Add to each `.layer-row`:
- `@pointerdown=${(e: PointerEvent) => this._onReorderPointerDown(layer, e)}`
- `@pointermove=${(e: PointerEvent) => this._onReorderPointerMove(e)}`
- `@pointerup=${(e: PointerEvent) => this._onReorderPointerUp(e)}`

- [ ] **Step 4: Update _clearDragState**

```typescript
  private _clearDragState() {
    this._draggedLayerId = null;
    this._dragPointerId = null;
    this._dragActivated = false;
    this._clearDropIndicators();
  }
```

- [ ] **Step 5: Verify TypeScript passes**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 6: Test drag reorder on desktop**

Run: `npm run dev`

At full width: drag layers up/down to reorder. Drop indicators should appear. Layer order should change correctly. Verify both single-click (no drag) and drag-to-reorder work.

- [ ] **Step 7: Commit**

```bash
git add src/components/layers-panel.ts
git commit -m "refactor(layers): convert drag-reorder from DragEvent to pointer events"
```

---

### Task 11: Layers bottom sheet on mobile

**Files:**
- Modify: `src/components/layers-panel.ts` (add mobile bottom sheet render + styles)
- Modify: `src/components/drawing-app.ts:1100-1129` (render — move layers-panel outside right-sidebar on mobile)

- [ ] **Step 1: Add bottom sheet state to layers-panel**

In `layers-panel.ts`, add state for the bottom sheet:

```typescript
  @state() private _sheetOpen = false;
  @state() private _sheetY = 0; // current translateY (0 = fully open at snap point)
  private _sheetDragging = false;
  private _sheetDragStartY = 0;
  private _sheetDragStartTranslate = 0;
  private _sheetSnapHalf = 0;
  private _sheetSnapFull = 0;
  private _sheetDragTimestamps: { y: number; t: number }[] = [];
```

- [ ] **Step 2: Add bottom sheet CSS**

Add to static styles:

```css
    /* ── Mobile bottom sheet ───────────────────── */
    .sheet-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 200;
    }

    .sheet-backdrop.open {
      display: block;
    }

    .sheet {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 90vh;
      background: #2c2c2c;
      border-radius: 16px 16px 0 0;
      z-index: 201;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease;
      transform: translateY(100vh);
      padding-bottom: env(safe-area-inset-bottom);
    }

    .sheet-handle {
      display: flex;
      justify-content: center;
      padding: 8px 0;
      cursor: grab;
      touch-action: none;
    }

    .sheet-handle-bar {
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: #666;
    }

    .sheet-content {
      flex: 1;
      overflow-y: auto;
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
    }
```

- [ ] **Step 3: Add sheet open/close/drag methods**

```typescript
The sheet uses `translateY()` to position itself. `_sheetY` represents translateY offset from the "fully open at full height" position:
- `_sheetY = 0` → sheet at full height (top of sheet at ~10% viewport)
- `_sheetY = halfOffset` → sheet at half height
- `_sheetY >= dismissThreshold` → dismiss

```typescript
  openSheet() {
    const vh = window.innerHeight;
    this._sheetSnapFull = 0; // translateY(0) = fully expanded
    this._sheetSnapHalf = vh * 0.4; // translateY(40vh) = half height visible
    this._sheetY = this._sheetSnapHalf; // open at half height
    this._sheetOpen = true;
  }

  closeSheet() {
    this._sheetOpen = false;
    this._sheetY = window.innerHeight; // off-screen
  }

  private _onSheetHandlePointerDown(e: PointerEvent) {
    this._sheetDragging = true;
    this._sheetDragStartY = e.clientY;
    this._sheetDragStartTranslate = this._sheetY;
    this._sheetDragTimestamps = [{ y: e.clientY, t: Date.now() }];
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onSheetHandlePointerMove(e: PointerEvent) {
    if (!this._sheetDragging) return;
    const dy = e.clientY - this._sheetDragStartY;
    // Positive dy = finger moved down = push sheet down = larger translateY
    const newY = Math.max(this._sheetSnapFull, this._sheetDragStartTranslate + dy);
    this._sheetY = newY;
    this._sheetDragTimestamps.push({ y: e.clientY, t: Date.now() });
    if (this._sheetDragTimestamps.length > 5) this._sheetDragTimestamps.shift();
  }

  private _onSheetHandlePointerUp(_e: PointerEvent) {
    if (!this._sheetDragging) return;
    this._sheetDragging = false;

    // Calculate velocity (px/ms, positive = downward)
    const samples = this._sheetDragTimestamps;
    let velocity = 0;
    if (samples.length >= 2) {
      const last = samples[samples.length - 1];
      const first = samples[0];
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.y - first.y) / dt;
    }

    // Dismiss: past 75% of viewport height or fast downward swipe
    const dismissThreshold = window.innerHeight * 0.75;
    if (this._sheetY > dismissThreshold || velocity > 0.5) {
      this.closeSheet();
      return;
    }

    // Snap to nearest snap point
    const distToHalf = Math.abs(this._sheetY - this._sheetSnapHalf);
    const distToFull = Math.abs(this._sheetY - this._sheetSnapFull);
    this._sheetY = distToHalf < distToFull ? this._sheetSnapHalf : this._sheetSnapFull;
  }
```
```

- [ ] **Step 4: Add mobile render branch**

In the `render()` method of `layers-panel.ts`, at the top, add mobile check:

```typescript
    if (this.ctx.isMobile) {
      return this._renderMobileSheet();
    }
```

Add the method:

```typescript
  private _renderMobileSheet() {
    // translateY positions the sheet: 0 = fully expanded, larger = further down
    const sheetStyle = this._sheetOpen
      ? `transform: translateY(${this._sheetY}px);${this._sheetDragging ? 'transition:none;' : ''}`
      : `transform: translateY(100vh);`;

    return html`
      <div
        class="sheet-backdrop ${this._sheetOpen ? 'open' : ''}"
        @click=${() => this.closeSheet()}
      ></div>
      <div
        class="sheet ${this._sheetOpen ? 'open' : ''}"
        style=${sheetStyle}
      >
        <div
          class="sheet-handle"
          @pointerdown=${(e: PointerEvent) => this._onSheetHandlePointerDown(e)}
          @pointermove=${(e: PointerEvent) => this._onSheetHandlePointerMove(e)}
          @pointerup=${(e: PointerEvent) => this._onSheetHandlePointerUp(e)}
        >
          <div class="sheet-handle-bar"></div>
        </div>
        <div class="sheet-content">
          ${this._renderLayersList()}
        </div>
      </div>
    `;
  }
```

- [ ] **Step 5: Extract _renderLayersList from existing render**

Refactor the existing render method to extract the layers list (header, layer rows, action buttons) into `_renderLayersList()` so both desktop and mobile can share it. The desktop render calls `_renderLayersList()` inside its existing panel/collapsed structure.

- [ ] **Step 6: Add rename button for mobile layer rows**

In the layer row template inside `_renderLayersList()`, add a rename button that shows on mobile:

```typescript
    ${this.ctx.isMobile ? html`
      <button
        class="rename-btn"
        title="Rename"
        @click=${(e: Event) => { e.stopPropagation(); this._startRename(layer.id, e); }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/>
        </svg>
      </button>
    ` : ''}
```

Add CSS for `.rename-btn` (small icon button, visible only on mobile rows).

- [ ] **Step 7: Wire bottom sheet trigger from drawing-app**

In `drawing-app.ts`, modify the render so `layers-panel` is accessible on mobile. The toolbar's layers button dispatches `toggleLayersPanel()`. We need to instead have it open the sheet.

Listen for a custom event from the toolbar, or have `layers-panel` listen for `layersPanelOpen` changes. The simplest approach: in `layers-panel.ts`, watch for `layersPanelOpen` changing to `true` when `isMobile` is true, and call `openSheet()`.

Add to `layers-panel.ts` an `updated` lifecycle:

```typescript
  override updated(changed: Map<string, unknown>) {
    super.updated(changed);
    // On mobile, sync sheet visibility with layersPanelOpen state
    if (this.ctx?.isMobile) {
      if (this.ctx.state.layersPanelOpen && !this._sheetOpen) {
        this.openSheet();
      } else if (!this.ctx.state.layersPanelOpen && this._sheetOpen) {
        this.closeSheet();
      }
    }
  }
```

In `drawing-app.ts` render, always render `<layers-panel>` outside of `.right-sidebar` (after the `.main-area` div). Remove it from inside `.right-sidebar`. This way the same element instance persists across mobile/desktop transitions, preserving its internal state:

```html
      <div class="main-area">
        <app-toolbar></app-toolbar>
        <drawing-canvas
          @history-change=${this._onHistoryChange}
          @layer-undo=${this._onLayerUndo}
          @crop-commit=${this._onCropCommit}
          @viewport-change=${this._onViewportChange}
        ></drawing-canvas>
        <div class="right-sidebar ${this._state.layersPanelOpen ? '' : 'collapsed'}">
          <navigator-panel
            @navigator-pan=${this._onNavigatorPan}
            @navigator-zoom=${this._onNavigatorZoom}
          ></navigator-panel>
        </div>
      </div>
      <layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>
```

On desktop, `layers-panel` renders its desktop sidebar content. Add CSS to position it within the right sidebar area on desktop:

```css
    layers-panel {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 200px;
      border-left: 1px solid #444;
      background: #2c2c2c;
    }

    :host([mobile]) layers-panel {
      position: static;
      width: auto;
      border-left: none;
    }
```

Adjust the `.right-sidebar` to only contain the navigator panel (update width to be the navigator's space, or keep it for the navigator only).

- [ ] **Step 8: Verify TypeScript passes**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 9: Test in browser**

Run: `npm run dev`

Below 768px:
- Tap layers button in bottom bar → bottom sheet slides up at half height
- Drag handle up → sheet expands to full height
- Drag handle down quickly → sheet dismisses
- Tap backdrop → sheet dismisses
- Layer rows: visibility toggle, opacity, rename button, drag-to-reorder all work
- Above 768px: right sidebar layers panel works as before

- [ ] **Step 10: Commit**

```bash
git add src/components/layers-panel.ts src/components/drawing-app.ts
git commit -m "feat(mobile): add layers bottom sheet with drag handle and snap points"
```

---

## Chunk 5: Final integration and polish

### Task 12: Mobile layout restructuring in drawing-app

**Files:**
- Modify: `src/components/drawing-app.ts` (render and styles for mobile layout order)

- [ ] **Step 1: Ensure correct mobile flex order**

On mobile, the layout should be: canvas takes all space, bottom bar (toolbar) sits at the bottom. The CSS from Task 3 already hides `tool-settings` and `.right-sidebar` on mobile, and changes flex-direction to column.

Verify the render order produces: canvas (flex: 1) then toolbar at bottom. Since `app-toolbar` is inside `.main-area` which is `flex-direction: column` on mobile, and the toolbar is rendered after `drawing-canvas`, it should naturally go below.

If the toolbar appears above the canvas, add CSS:

```css
    :host([mobile]) .main-area app-toolbar {
      order: 1;
    }
```

- [ ] **Step 2: Ensure safe area padding at top of canvas on mobile**

Add to `drawing-app.ts` styles:

```css
    :host([mobile]) {
      padding-top: env(safe-area-inset-top);
    }
```

- [ ] **Step 3: Verify layout in portrait and landscape**

Run: `npm run dev`

Use Chrome DevTools responsive mode:
- iPhone SE (375x667): toolbar at bottom, canvas fills remaining space
- iPhone 14 (390x844): same
- Rotate to landscape: layout adjusts, toolbar remains at bottom, more horizontal canvas space
- iPad (768px+): desktop layout kicks in

- [ ] **Step 4: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat(mobile): finalize mobile layout order and safe area padding"
```

---

### Task 13: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Run TypeScript check**

Run: `npx tsc --noEmit`

Expected: PASS with zero errors

- [ ] **Step 2: Run production build**

Run: `npm run build`

Expected: PASS — builds successfully

- [ ] **Step 3: Manual test matrix**

Test the following in Chrome DevTools responsive mode:

| Test | Phone (375px) | Tablet Portrait (768px) | Desktop (1200px) |
|------|---------------|------------------------|-------------------|
| Drawing with pencil | Bottom bar, single touch draws | Desktop sidebar | Desktop sidebar |
| Switch tools via toolbar | Tap tool group button | Click sidebar button | Click sidebar button |
| Sub-tool selection | Tap active tool → popover | Click in sidebar group | Click in sidebar group |
| Tool settings | In popover below sub-tools | Top settings bar | Top settings bar |
| Pinch-to-zoom | Two-finger pinch zooms | Same | Ctrl+wheel |
| Two-finger pan | Two-finger drag pans | Same | Wheel/middle mouse |
| Undo/redo | Buttons in bottom bar | Keyboard Ctrl+Z | Keyboard Ctrl+Z |
| Layers panel | Bottom sheet via layers button | Right sidebar | Right sidebar |
| Layer drag-reorder | Drag in bottom sheet | Drag in sidebar | Drag in sidebar |
| Save/Clear | More (overflow) button | Sidebar buttons | Sidebar buttons |
| Orientation change | Layout reflows correctly | N/A | N/A |
| Navigator | Hidden | Visible in sidebar | Visible in sidebar |

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(mobile): address issues found during end-to-end testing"
```

---

## Summary

| Task | Description | Key files |
|------|-------------|-----------|
| 1 | Viewport meta & global CSS | `index.html` |
| 2 | Add `isMobile` to context type | `drawing-context.ts` |
| 3 | Wire `isMobile` in drawing-app | `drawing-app.ts` |
| 4 | Bump desktop touch targets | `app-toolbar.ts`, `tool-settings.ts`, `layers-panel.ts` |
| 5 | Hide navigator on mobile | `navigator-panel.ts` |
| 6 | Pointer tracking map | `drawing-canvas.ts` |
| 7 | Pinch-to-zoom & two-finger pan | `drawing-canvas.ts` |
| 8 | Mobile bottom tab bar | `app-toolbar.ts` |
| 9 | Tool-settings mobile layout | `tool-settings.ts` |
| 10 | Convert layer drag to pointer events | `layers-panel.ts` |
| 11 | Layers bottom sheet | `layers-panel.ts`, `drawing-app.ts` |
| 12 | Mobile layout polish | `drawing-app.ts` |
| 13 | End-to-end verification | (testing only) |

# Navigator Panel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Photoshop-style navigator panel with minimap, logarithmic zoom slider, editable zoom input, and fullscreen toggle.

**Architecture:** New `navigator-panel.ts` Lit web component as a `ContextConsumer`. Sits at the top of the right sidebar above `layers-panel`. Communicates via custom events (`navigator-pan`, `navigator-zoom`) up to `drawing-app.ts`, which calls `canvas.setViewport()`. Minimap redraws on the existing `composited` event from `drawing-canvas.ts`.

**Tech Stack:** Lit 3, TypeScript, Canvas 2D API, Fullscreen API

---

## Chunk 1: Navigator Panel

### Task 1: Add viewport fields to context

**Files:**
- Modify: `src/contexts/drawing-context.ts:5-37` — add viewport fields to `DrawingContextValue`
- Modify: `src/components/drawing-app.ts:59` — add `_viewportState` tracking
- Modify: `src/components/drawing-app.ts:652-844` — add viewport fields to `_buildContextValue()`
- Modify: `src/components/drawing-app.ts:857-859` — update `_onViewportChange` to capture viewport state
- Modify: `src/components/drawing-canvas.ts:810-815` — add `_dispatchViewportChange()` to `setViewport()`

- [ ] **Step 1: Add viewport fields to `DrawingContextValue`**

In `src/contexts/drawing-context.ts`, add these fields to the `DrawingContextValue` interface after the `saving` field:

```typescript
  // Viewport state (read-only for consumers)
  zoom: number;
  panX: number;
  panY: number;
  viewportWidth: number;
  viewportHeight: number;
```

- [ ] **Step 2: Add viewport state tracking in `drawing-app.ts`**

In `src/components/drawing-app.ts`, add a private field after `_saving` (line ~62):

```typescript
  @state() private _viewportZoom = 1;
  @state() private _viewportPanX = 0;
  @state() private _viewportPanY = 0;
  @state() private _viewportWidth = 800;
  @state() private _viewportHeight = 600;
```

- [ ] **Step 3: Populate viewport fields in `_buildContextValue()`**

In `src/components/drawing-app.ts`, add viewport fields to the return object of `_buildContextValue()`, before the closing `};` (around line 844):

```typescript
      zoom: this._viewportZoom,
      panX: this._viewportPanX,
      panY: this._viewportPanY,
      viewportWidth: this._viewportWidth,
      viewportHeight: this._viewportHeight,
```

- [ ] **Step 4: Update `_onViewportChange` to capture viewport state**

Replace the `_onViewportChange` method in `src/components/drawing-app.ts`:

```typescript
  private _onViewportChange() {
    if (this.canvas) {
      const vp = this.canvas.getViewport();
      this._viewportZoom = vp.zoom;
      this._viewportPanX = vp.panX;
      this._viewportPanY = vp.panY;
      this._viewportWidth = this.canvas.clientWidth;
      this._viewportHeight = this.canvas.clientHeight;
    }
    this._markDirty();
  }
```

- [ ] **Step 5: Add `_dispatchViewportChange()` to `setViewport()` in `drawing-canvas.ts`**

In `src/components/drawing-canvas.ts`, modify `setViewport()` (line ~810) to dispatch the viewport change event so context stays in sync:

```typescript
  public setViewport(zoom: number, panX: number, panY: number) {
    this._zoom = Math.min(DrawingCanvas.MAX_ZOOM, Math.max(DrawingCanvas.MIN_ZOOM, zoom));
    this._panX = panX;
    this._panY = panY;
    this.composite();
    this._dispatchViewportChange();
  }
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 7: Manual verification**

Run: `npm run dev`
Open the app in a browser. Zoom and pan with Ctrl+wheel and middle-mouse. Verify nothing changed visually — the app should work exactly as before.

- [ ] **Step 8: Commit**

```bash
git add src/contexts/drawing-context.ts src/components/drawing-app.ts src/components/drawing-canvas.ts
git commit -m "feat: add viewport state fields to drawing context"
```

---

### Task 2: Create navigator panel — minimap rendering

**Files:**
- Create: `src/components/navigator-panel.ts`

This task creates the component shell with the minimap canvas that composites all visible layers at a reduced scale. No interaction yet — just the visual thumbnail.

- [ ] **Step 1: Create the component file with minimap rendering**

Create `src/components/navigator-panel.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';

@customElement('navigator-panel')
export class NavigatorPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 0.8125rem;
      color: #ddd;
      user-select: none;
    }

    .section {
      border-bottom: 1px solid #444;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-bottom: 1px solid #444;
    }

    .header-title {
      font-weight: 500;
      font-size: 0.75rem;
      color: #ccc;
    }

    .minimap-container {
      padding: 6px;
    }

    canvas {
      display: block;
      width: 100%;
      border-radius: 3px;
      background: #3a3a3a;
    }
  `;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private _minimapCanvas = document.createElement('canvas');

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  // --- Composited event listening (same pattern as layers-panel) ---

  private _onComposited = () => {
    this._renderMinimap();
  };

  override connectedCallback() {
    super.connectedCallback();
    (this.getRootNode() as ShadowRoot | Document).addEventListener(
      'composited',
      this._onComposited,
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    (this.getRootNode() as ShadowRoot | Document).removeEventListener(
      'composited',
      this._onComposited,
    );
  }

  // --- Minimap rendering ---

  /** Scale factor from document coords to minimap pixel coords */
  private _minimapScale = 1;

  /** Offset to center the document thumbnail within the minimap canvas */
  private _minimapOffsetX = 0;
  private _minimapOffsetY = 0;

  private _renderMinimap() {
    if (!this._ctx.value) return;
    const { state } = this.ctx;
    const { layers, documentWidth: docW, documentHeight: docH } = state;

    const canvas = this._minimapCanvas;
    const container = this.shadowRoot?.querySelector('.minimap-container');
    if (!container) return;

    // Size the minimap canvas to the container width, capped at 150px height
    const containerWidth = container.clientWidth - 12; // subtract padding
    const maxHeight = 150;
    const docAspect = docW / docH;
    let cw = containerWidth;
    let ch = cw / docAspect;
    if (ch > maxHeight) {
      ch = maxHeight;
      cw = ch * docAspect;
    }

    // Use device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const scale = Math.min(cw / docW, ch / docH);
    this._minimapScale = scale;

    const scaledW = docW * scale;
    const scaledH = docH * scale;
    this._minimapOffsetX = (cw - scaledW) / 2;
    this._minimapOffsetY = (ch - scaledH) / 2;

    // Clear with workspace background
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, cw, ch);

    // Draw document area (white background)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this._minimapOffsetX, this._minimapOffsetY, scaledW, scaledH);

    // Composite visible layers
    ctx.save();
    ctx.translate(this._minimapOffsetX, this._minimapOffsetY);
    for (const layer of layers) {
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, 0, 0, scaledW, scaledH);
      ctx.globalAlpha = 1.0;
    }
    ctx.restore();

    // Draw viewport rectangle
    this._drawViewportRect(ctx, scale, cw, ch);
  }

  private _drawViewportRect(
    ctx: CanvasRenderingContext2D,
    scale: number,
    canvasW: number,
    canvasH: number,
  ) {
    const { zoom, panX, panY, viewportWidth, viewportHeight } = this.ctx;

    const rectX = this._minimapOffsetX + (-panX / zoom) * scale;
    const rectY = this._minimapOffsetY + (-panY / zoom) * scale;
    const rectW = (viewportWidth / zoom) * scale;
    const rectH = (viewportHeight / zoom) * scale;

    // Clip to minimap bounds
    const clippedX = Math.max(0, rectX);
    const clippedY = Math.max(0, rectY);
    const clippedW = Math.min(canvasW - clippedX, rectW - (clippedX - rectX));
    const clippedH = Math.min(canvasH - clippedY, rectH - (clippedY - rectY));

    if (clippedW <= 0 || clippedH <= 0) return;

    ctx.fillStyle = 'rgba(255, 68, 68, 0.1)';
    ctx.fillRect(clippedX, clippedY, clippedW, clippedH);
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(clippedX, clippedY, clippedW, clippedH);
  }

  override render() {
    if (!this._ctx.value) return html``;

    return html`
      <div class="section">
        <div class="header">
          <span class="header-title">Navigator</span>
        </div>
        <div class="minimap-container">
          ${this._minimapCanvas}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'navigator-panel': NavigatorPanel;
  }
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/navigator-panel.ts
git commit -m "feat: create navigator panel with minimap rendering"
```

---

### Task 3: Wire navigator panel into the app layout

**Files:**
- Modify: `src/components/drawing-app.ts:15-18` — add import
- Modify: `src/components/drawing-app.ts:1022-1034` — add to render template

- [ ] **Step 1: Import the navigator panel**

In `src/components/drawing-app.ts`, add after the `'./layers-panel.js'` import (around line 18):

```typescript
import './navigator-panel.js';
```

- [ ] **Step 2: Add navigator-panel to the render template**

In `src/components/drawing-app.ts`, in the `render()` method, add `<navigator-panel>` before `<layers-panel>` inside `.main-area`, wrapped in a sidebar container div. Replace the current layers-panel + closing div section:

```typescript
        <div class="right-sidebar">
          <navigator-panel
            @navigator-pan=${this._onNavigatorPan}
            @navigator-zoom=${this._onNavigatorZoom}
          ></navigator-panel>
          <layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>
        </div>
```

- [ ] **Step 3: Add CSS for `.right-sidebar`**

In `src/components/drawing-app.ts`, add to the `static override styles` block. The sidebar takes its width from `layers-panel` (which already manages 200px expanded / 32px collapsed). `overflow: hidden` ensures the navigator doesn't overflow when layers-panel is collapsed:

```css
    .right-sidebar {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .right-sidebar layers-panel {
      flex: 1;
      min-height: 0;
    }
```

Layers-panel keeps its own `width`, `background`, and `border-left` unchanged — it continues to drive the sidebar width. Navigator-panel takes `width: 100%` from its parent (already block-level).

- [ ] **Step 4: Add navigator event handlers to `drawing-app.ts`**

Add these methods to `drawing-app.ts` after `_onViewportChange()`:

```typescript
  private _onNavigatorPan(e: CustomEvent<{ panX: number; panY: number }>) {
    if (!this.canvas) return;
    const { panX, panY } = e.detail;
    const vp = this.canvas.getViewport();
    this.canvas.setViewport(vp.zoom, panX, panY);
  }

  private _onNavigatorZoom(e: CustomEvent<{ zoom: number }>) {
    if (!this.canvas) return;
    const newZoom = e.detail.zoom;
    const vp = this.canvas.getViewport();
    // Center-anchored zoom: keep viewport center stable
    const cx = this.canvas.clientWidth / 2;
    const cy = this.canvas.clientHeight / 2;
    const docX = (cx - vp.panX) / vp.zoom;
    const docY = (cy - vp.panY) / vp.zoom;
    const newPanX = cx - docX * newZoom;
    const newPanY = cy - docY * newZoom;
    this.canvas.setViewport(newZoom, newPanX, newPanY);
  }
```

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Manual verification**

Run: `npm run dev`
Open the app. Verify the navigator panel appears at the top of the right sidebar with a minimap thumbnail. The minimap should show the document content and a red viewport rectangle. Zoom/pan with keyboard shortcuts or wheel and verify the minimap updates. The layers panel should appear below the navigator.

- [ ] **Step 7: Commit**

```bash
git add src/components/drawing-app.ts
git commit -m "feat: wire navigator panel into app layout"
```

---

### Task 4: Add minimap click-and-drag interaction

**Files:**
- Modify: `src/components/navigator-panel.ts` — add pointer event handlers for minimap interaction

- [ ] **Step 1: Add interaction state and pointer handlers**

In `src/components/navigator-panel.ts`, add these private fields after `_minimapOffsetY`:

```typescript
  // --- Minimap drag state ---
  private _dragging = false;
  private _dragOffsetX = 0;
  private _dragOffsetY = 0;
```

Add these methods after `_drawViewportRect()`:

```typescript
  // --- Minimap pointer interaction ---

  /** Convert a pointer event on the minimap canvas to minimap-local CSS coords */
  private _getMinimapPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this._minimapCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /** Get the current viewport rect in minimap CSS coords */
  private _getViewportRectInMinimap(): { x: number; y: number; w: number; h: number } {
    const { zoom, panX, panY, viewportWidth, viewportHeight } = this.ctx;
    const scale = this._minimapScale;
    return {
      x: this._minimapOffsetX + (-panX / zoom) * scale,
      y: this._minimapOffsetY + (-panY / zoom) * scale,
      w: (viewportWidth / zoom) * scale,
      h: (viewportHeight / zoom) * scale,
    };
  }

  private _isInsideViewportRect(px: number, py: number): boolean {
    const r = this._getViewportRectInMinimap();
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  private _panToMinimapPoint(px: number, py: number) {
    const { zoom, viewportWidth, viewportHeight } = this.ctx;
    const scale = this._minimapScale;
    const docX = (px - this._minimapOffsetX) / scale;
    const docY = (py - this._minimapOffsetY) / scale;
    const panX = viewportWidth / 2 - docX * zoom;
    const panY = viewportHeight / 2 - docY * zoom;
    this.dispatchEvent(new CustomEvent('navigator-pan', {
      bubbles: true, composed: true,
      detail: { panX, panY },
    }));
  }

  private _onMinimapPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const pt = this._getMinimapPoint(e);

    if (this._isInsideViewportRect(pt.x, pt.y)) {
      // Start dragging the viewport rectangle
      const r = this._getViewportRectInMinimap();
      this._dragging = true;
      this._dragOffsetX = pt.x - r.x;
      this._dragOffsetY = pt.y - r.y;
      this._minimapCanvas.setPointerCapture(e.pointerId);
    } else {
      // Click-to-pan: center viewport on click point
      this._panToMinimapPoint(pt.x, pt.y);
      // Then start dragging from center of viewport rect
      const r = this._getViewportRectInMinimap();
      this._dragging = true;
      this._dragOffsetX = r.w / 2;
      this._dragOffsetY = r.h / 2;
      this._minimapCanvas.setPointerCapture(e.pointerId);
    }
  };

  private _onMinimapPointerMove = (e: PointerEvent) => {
    if (!this._dragging) return;
    const pt = this._getMinimapPoint(e);
    // The new top-left of the viewport rect in minimap coords
    const newRectX = pt.x - this._dragOffsetX;
    const newRectY = pt.y - this._dragOffsetY;
    // Convert back to pan coordinates
    const { zoom } = this.ctx;
    const scale = this._minimapScale;
    const docX = (newRectX - this._minimapOffsetX) / scale;
    const docY = (newRectY - this._minimapOffsetY) / scale;
    const panX = -docX * zoom;
    const panY = -docY * zoom;
    this.dispatchEvent(new CustomEvent('navigator-pan', {
      bubbles: true, composed: true,
      detail: { panX, panY },
    }));
  };

  private _onMinimapPointerUp = (e: PointerEvent) => {
    if (!this._dragging) return;
    this._dragging = false;
    this._minimapCanvas.releasePointerCapture(e.pointerId);
  };
```

- [ ] **Step 2: Attach pointer events to the minimap canvas**

Update the `render()` method — replace the minimap-container section:

```typescript
        <div class="minimap-container"
          @pointerdown=${this._onMinimapPointerDown}
          @pointermove=${this._onMinimapPointerMove}
          @pointerup=${this._onMinimapPointerUp}
        >
          ${this._minimapCanvas}
        </div>
```

- [ ] **Step 3: Add cursor styling**

Add to the `canvas` CSS rule:

```css
      cursor: crosshair;
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Manual verification**

Run: `npm run dev`
Open the app. Draw something on the canvas, then:
1. Click on the minimap away from the viewport rect — view should jump to center on that point
2. Drag the red viewport rectangle — canvas should pan in real time
3. Zoom the canvas with Ctrl+wheel — viewport rect on minimap should update size
4. Click outside the rect and drag — should start panning from the click point

- [ ] **Step 6: Commit**

```bash
git add src/components/navigator-panel.ts
git commit -m "feat: add click-and-drag minimap interaction"
```

---

### Task 5: Add zoom controls (slider, +/- buttons, editable input)

**Files:**
- Modify: `src/components/navigator-panel.ts` — add zoom slider, buttons, and input

- [ ] **Step 1: Add zoom constants and conversion helpers**

In `src/components/navigator-panel.ts`, add these after the class declaration line:

```typescript
  private static readonly MIN_ZOOM = 0.1;
  private static readonly MAX_ZOOM = 10;
  private static readonly ZOOM_STEP = 1.1;
  private static readonly SLIDER_MAX = 1000;
```

Add helper methods after the minimap interaction methods:

```typescript
  // --- Zoom helpers ---

  /** Convert zoom level to slider position [0, SLIDER_MAX] using logarithmic mapping */
  private _zoomToSlider(zoom: number): number {
    const { MIN_ZOOM, MAX_ZOOM, SLIDER_MAX } = NavigatorPanel;
    const t = Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
    return Math.round(t * SLIDER_MAX);
  }

  /** Convert slider position [0, SLIDER_MAX] to zoom level using logarithmic mapping */
  private _sliderToZoom(value: number): number {
    const { MIN_ZOOM, MAX_ZOOM, SLIDER_MAX } = NavigatorPanel;
    const t = value / SLIDER_MAX;
    return MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, t);
  }

  private _dispatchZoom(zoom: number) {
    const clamped = Math.min(NavigatorPanel.MAX_ZOOM, Math.max(NavigatorPanel.MIN_ZOOM, zoom));
    this.dispatchEvent(new CustomEvent('navigator-zoom', {
      bubbles: true, composed: true,
      detail: { zoom: clamped },
    }));
  }

  private _onSliderInput = (e: Event) => {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    this._dispatchZoom(this._sliderToZoom(value));
  };

  private _onZoomIn = () => {
    this._dispatchZoom(this.ctx.zoom * NavigatorPanel.ZOOM_STEP);
  };

  private _onZoomOut = () => {
    this._dispatchZoom(this.ctx.zoom / NavigatorPanel.ZOOM_STEP);
  };
```

- [ ] **Step 2: Add the editable zoom input handlers**

Add these methods:

```typescript
  // --- Zoom input ---

  @state() private _editingZoom = false;
  @state() private _zoomInputValue = '';

  private _onZoomInputFocus = (e: FocusEvent) => {
    this._editingZoom = true;
    this._zoomInputValue = Math.round(this.ctx.zoom * 100).toString();
    const input = e.target as HTMLInputElement;
    requestAnimationFrame(() => input.select());
  };

  private _onZoomInputBlur = () => {
    this._commitZoomInput();
    this._editingZoom = false;
  };

  private _onZoomInputKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      this._commitZoomInput();
      this._editingZoom = false;
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      this._editingZoom = false;
      (e.target as HTMLInputElement).blur();
    }
    e.stopPropagation(); // prevent tool shortcuts
  };

  private _onZoomInputChange = (e: Event) => {
    this._zoomInputValue = (e.target as HTMLInputElement).value;
  };

  private _commitZoomInput() {
    const raw = this._zoomInputValue.replace('%', '').trim();
    const parsed = parseFloat(raw);
    if (isNaN(parsed) || parsed <= 0) return; // revert — don't dispatch

    // Always treat as percentage: "150" = 150% = 1.5x, "50" = 50% = 0.5x
    const zoom = parsed / 100;
    this._dispatchZoom(zoom);
  }
```

- [ ] **Step 3: Add zoom controls CSS**

Add these CSS rules to the component styles:

```css
    .zoom-controls {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px 6px;
    }

    .zoom-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: 1px solid #555;
      border-radius: 4px;
      background: #444;
      color: #ccc;
      cursor: pointer;
      font-size: 14px;
      padding: 0;
      line-height: 1;
      flex-shrink: 0;
    }

    .zoom-btn:hover {
      background: #555;
      color: #fff;
    }

    .zoom-slider {
      flex: 1;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: #555;
      border-radius: 2px;
      outline: none;
      min-width: 0;
    }

    .zoom-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #bbb;
      border: 1px solid #888;
      cursor: grab;
    }

    .zoom-slider::-webkit-slider-thumb:active {
      cursor: grabbing;
    }

    .zoom-input {
      width: 38px;
      background: #333;
      border: 1px solid #555;
      border-radius: 3px;
      padding: 1px 3px;
      text-align: center;
      font-size: 0.6875rem;
      color: #ddd;
      font-family: inherit;
      flex-shrink: 0;
    }

    .zoom-input:focus {
      outline: 1px solid #007bff;
      border-color: #007bff;
    }
```

- [ ] **Step 4: Update the render method with zoom controls**

Update `render()` to add the zoom controls row below the minimap:

```typescript
  override render() {
    if (!this._ctx.value) return html``;

    const zoom = this.ctx.zoom;
    const sliderValue = this._zoomToSlider(zoom);
    const zoomPercent = Math.round(zoom * 100);
    const displayValue = this._editingZoom
      ? this._zoomInputValue
      : `${zoomPercent}%`;

    return html`
      <div class="section">
        <div class="header">
          <span class="header-title">Navigator</span>
        </div>
        <div class="minimap-container"
          @pointerdown=${this._onMinimapPointerDown}
          @pointermove=${this._onMinimapPointerMove}
          @pointerup=${this._onMinimapPointerUp}
        >
          ${this._minimapCanvas}
        </div>
        <div class="zoom-controls">
          <button class="zoom-btn" title="Zoom out" @click=${this._onZoomOut}>&minus;</button>
          <input
            type="range"
            class="zoom-slider"
            min="0"
            max="${NavigatorPanel.SLIDER_MAX}"
            step="1"
            .value=${String(sliderValue)}
            @input=${this._onSliderInput}
          />
          <button class="zoom-btn" title="Zoom in" @click=${this._onZoomIn}>+</button>
          <input
            type="text"
            class="zoom-input"
            .value=${displayValue}
            @focus=${this._onZoomInputFocus}
            @blur=${this._onZoomInputBlur}
            @keydown=${this._onZoomInputKeydown}
            @input=${this._onZoomInputChange}
          />
        </div>
      </div>
    `;
  }
```

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Manual verification**

Run: `npm run dev`
Open the app. Test:
1. Drag the zoom slider — canvas should zoom smoothly, centered on viewport center
2. The slider should feel perceptually even (equal movement = equal perceived zoom change)
3. Click the +/- buttons — should step zoom in/out
4. Click the zoom percentage, type "200", press Enter — should zoom to 200%
5. Type "50%", press Enter — should zoom to 50%
6. Type "25", press Enter — should zoom to 25%
7. Type "garbage", press Enter — should revert to current zoom
8. Press Escape while editing — should revert without applying
8. Verify slider position updates when zooming via Ctrl+wheel on the canvas

- [ ] **Step 7: Commit**

```bash
git add src/components/navigator-panel.ts
git commit -m "feat: add logarithmic zoom slider and editable zoom input"
```

---

### Task 6: Add fullscreen toggle

**Files:**
- Modify: `src/components/navigator-panel.ts` — add fullscreen button and logic

- [ ] **Step 1: Add fullscreen state and handlers**

Add to `navigator-panel.ts`:

```typescript
  // --- Fullscreen ---
  @state() private _isFullscreen = false;

  private _onFullscreenChange = () => {
    this._isFullscreen = !!document.fullscreenElement;
  };
```

Update `connectedCallback()` to also listen for fullscreen changes:

```typescript
  override connectedCallback() {
    super.connectedCallback();
    (this.getRootNode() as ShadowRoot | Document).addEventListener(
      'composited',
      this._onComposited,
    );
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    (this.getRootNode() as ShadowRoot | Document).removeEventListener(
      'composited',
      this._onComposited,
    );
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
  }
```

Add the toggle method:

```typescript
  private _toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };
```

- [ ] **Step 2: Add fullscreen button CSS**

Add to the component styles:

```css
    .fullscreen-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: 1px solid #555;
      border-radius: 4px;
      background: #444;
      color: #ccc;
      cursor: pointer;
      padding: 0;
      flex-shrink: 0;
    }

    .fullscreen-btn:hover {
      background: #555;
      color: #fff;
    }
```

- [ ] **Step 3: Add fullscreen button to the zoom controls row**

In the `render()` method, add the fullscreen button after the zoom input inside `.zoom-controls`:

```typescript
          <button
            class="fullscreen-btn"
            title=${this._isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            @click=${this._toggleFullscreen}
          >
            ${this._isFullscreen
              ? html`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 2v3H2M14 5h-3V2M11 14v-3h3M2 11h3v3"/></svg>`
              : html`<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>`
            }
          </button>
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Manual verification**

Run: `npm run dev`
Open the app. Test:
1. Click the fullscreen button — browser should enter fullscreen mode
2. Button icon should change to "compress" arrows
3. Press Escape or click the button again — should exit fullscreen
4. Button icon should revert to "expand" arrows
5. Verify Escape still works for clearing selections when not in fullscreen

- [ ] **Step 6: Commit**

```bash
git add src/components/navigator-panel.ts
git commit -m "feat: add fullscreen toggle to navigator panel"
```

---

### Task 7: Handle collapsed sidebar state

**Files:**
- Modify: `src/components/navigator-panel.ts` — hide content when sidebar is collapsed

The navigator panel reads `layersPanelOpen` from context to determine collapsed state (same flag the layers panel uses).

- [ ] **Step 1: Update render to handle collapsed state**

Wrap the render method's return with a collapsed check:

```typescript
  override render() {
    if (!this._ctx.value) return html``;
    // When sidebar is collapsed, render nothing — layers-panel shows the collapsed strip
    if (!this.ctx.state.layersPanelOpen) return html``;

    // ... rest of existing render code
  }
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Manual verification**

Run: `npm run dev`
Open the app. Test:
1. Click the collapse button on the layers panel — both navigator and layers should hide, showing the 32px collapsed strip
2. Click expand — both should reappear
3. Minimap should re-render correctly after expanding

- [ ] **Step 4: Commit**

```bash
git add src/components/navigator-panel.ts
git commit -m "feat: hide navigator panel when sidebar is collapsed"
```

---

### Task 8: Final type check and build verification

**Files:** None (verification only)

- [ ] **Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: PASS (builds successfully)

- [ ] **Step 3: Full manual verification**

Run: `npm run dev`
Test all navigator features together:
1. Minimap shows document thumbnail with all visible layers
2. Red viewport rectangle updates on zoom/pan
3. Drag viewport rectangle on minimap — canvas pans
4. Click on minimap — view jumps to that point
5. Zoom slider is logarithmic — perceptually even
6. +/- buttons step zoom
7. Editable zoom input works with "150" (= 150%), "50%" (= 50%), "25" (= 25%)
8. Fullscreen toggle works and icon updates
9. Collapsed sidebar hides navigator
10. Multiple layers render correctly in minimap
11. Hiding a layer updates the minimap
12. Changing document size updates minimap aspect ratio

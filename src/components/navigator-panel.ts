import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';

@customElement('navigator-panel')
export class NavigatorPanel extends LitElement {
  private static readonly MIN_ZOOM = 0.1;
  private static readonly MAX_ZOOM = 10;
  private static readonly ZOOM_STEP = 1.1;
  private static readonly SLIDER_MAX = 1000;

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
      cursor: crosshair;
    }

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
  `;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private _minimapCanvas = document.createElement('canvas');

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  // --- Fullscreen ---
  @state() private _isFullscreen = false;

  private _onFullscreenChange = () => {
    this._isFullscreen = !!document.fullscreenElement;
  };

  private _toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  // --- Composited event listening (same pattern as layers-panel) ---

  private _minimapPending = false;

  private _onComposited = () => {
    // Defer render to next frame so Lit's context update cycle completes first.
    // Without this, viewport values (zoom/pan) in context are stale on initial load.
    if (!this._minimapPending) {
      this._minimapPending = true;
      requestAnimationFrame(() => {
        this._minimapPending = false;
        this._renderMinimap();
      });
    }
  };

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

  // --- Minimap rendering ---

  /** Scale factor from document coords to minimap pixel coords */
  private _minimapScale = 1;

  /** Offset to center the document thumbnail within the minimap canvas */
  private _minimapOffsetX = 0;
  private _minimapOffsetY = 0;

  // --- Minimap drag state ---
  private _dragging = false;
  private _dragOffsetX = 0;
  private _dragOffsetY = 0;

  private _renderMinimap() {
    if (!this._ctx.value) return;
    const { state } = this.ctx;
    const { layers, documentWidth: docW, documentHeight: docH } = state;

    const canvas = this._minimapCanvas;
    const container = this.shadowRoot?.querySelector('.minimap-container');
    if (!container) return;

    // Size the minimap canvas to the container width, capped at 150px height
    const containerWidth = container.clientWidth - 12; // subtract padding
    if (containerWidth <= 0) return;
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

  override render() {
    if (!this._ctx.value) return html``;

    // When sidebar is collapsed, render nothing — layers-panel shows the collapsed strip
    if (!this.ctx.state.layersPanelOpen) return html``;

    if (this.ctx.isMobile) return html``;

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

import { LitElement, html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Point, HistoryEntry, Layer, FloatingSelection } from '../types.js';
import { drawPencilSegment } from '../tools/pencil.js';
import { drawMarkerSegment } from '../tools/marker.js';
import { drawEraserSegment } from '../tools/eraser.js';
import { drawShapePreview } from '../tools/shapes.js';
import { floodFill } from '../tools/fill.js';
import { drawSelectionRect } from '../tools/select.js';

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

@customElement('drawing-canvas')
export class DrawingCanvas extends LitElement {
  static override styles = css`
    :host {
      display: block;
      flex: 1;
      overflow: hidden;
      position: relative;
      background: #3a3a3a;
    }

    canvas {
      display: block;
      touch-action: none;
    }

    #main {
      background: transparent;
      cursor: crosshair;
    }
  `;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  @query('#main') mainCanvas!: HTMLCanvasElement;
  @query('#preview') previewCanvas!: HTMLCanvasElement;

  private _checkerboardPattern: CanvasPattern | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _lastLayers: Layer[] | null = null;
  private _drawing = false;
  private _lastPoint: Point | null = null;
  private _startPoint: Point | null = null;

  // --- Pan state ---
  private _panX = 0;
  private _panY = 0;
  private _panning = false;
  private _panStartX = 0;
  private _panStartY = 0;
  private _panStartOffsetX = 0;
  private _panStartOffsetY = 0;
  private _panPointerId = -1;

  // --- Zoom state ---
  private _zoom = 1;
  private static readonly MIN_ZOOM = 0.1;
  private static readonly MAX_ZOOM = 10;
  private static readonly ZOOM_STEP = 1.1;

  // --- Floating selection state ---
  private _float: FloatingSelection | null = null;
  private _clipboard: ImageData | null = null;
  private _clipboardOrigin: Point | null = null;
  private _selectionDashOffset = 0;
  private _selectionAnimFrame: number | null = null;

  /** Cached canvas of originalImageData at original size — avoids re-creating per resize tick */
  private _floatSrcCanvas: HTMLCanvasElement | null = null;

  // Interaction state
  private _selectionDrawing = false;
  private _floatMoving = false;
  private _floatResizing = false;
  private _floatResizeHandle: ResizeHandle | null = null;
  private _floatDragOffset: Point | null = null;
  private _floatResizeOrigin: { rect: { x: number; y: number; w: number; h: number }; point: Point } | null = null;

  // --- Document dimension accessors (from context state) ---
  private get _docWidth(): number {
    return this._ctx.value?.state.documentWidth ?? 800;
  }

  private get _docHeight(): number {
    return this._ctx.value?.state.documentHeight ?? 600;
  }

  // --- Public dimension accessors ---
  public getWidth() { return this._docWidth; }
  public getHeight() { return this._docHeight; }

  // --- Viewport helpers ---
  private get _vw(): number { return this.mainCanvas?.width ?? 800; }
  private get _vh(): number { return this.mainCanvas?.height ?? 600; }

  // --- Layer-aware helpers ---

  private _getActiveLayerCtx(): CanvasRenderingContext2D | null {
    const state = this._ctx.value?.state;
    if (!state) return null;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    return layer?.canvas.getContext('2d') ?? null;
  }

  public composite() {
    if (!this.mainCanvas) return;
    const displayCtx = this.mainCanvas.getContext('2d')!;
    const vw = this._vw;
    const vh = this._vh;

    // Clear entire viewport with workspace background
    displayCtx.fillStyle = '#3a3a3a';
    displayCtx.fillRect(0, 0, vw, vh);

    // Translate to document position
    displayCtx.save();
    displayCtx.translate(this._panX, this._panY);
    displayCtx.scale(this._zoom, this._zoom);

    // Draw checkerboard within document bounds
    displayCtx.save();
    displayCtx.beginPath();
    displayCtx.rect(0, 0, this._docWidth, this._docHeight);
    displayCtx.clip();
    const pattern = this._getCheckerboardPattern(displayCtx);
    displayCtx.fillStyle = pattern;
    displayCtx.fillRect(0, 0, this._docWidth, this._docHeight);
    displayCtx.restore();

    // Composite layers bottom-to-top
    const layers = this._ctx.value?.state.layers ?? [];
    for (const layer of layers) {
      if (!layer.visible) continue;
      displayCtx.globalAlpha = layer.opacity;
      displayCtx.drawImage(layer.canvas, 0, 0);
      displayCtx.globalAlpha = 1.0;
    }

    // Document border
    displayCtx.strokeStyle = 'rgba(0,0,0,0.3)';
    displayCtx.lineWidth = 1;
    displayCtx.strokeRect(-0.5, -0.5, this._docWidth + 1, this._docHeight + 1);

    displayCtx.restore();

    this.dispatchEvent(new Event('composited', { bubbles: true, composed: true }));
  }

  private _getCheckerboardPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
    if (!this._checkerboardPattern) {
      const tile = document.createElement('canvas');
      tile.width = 20;
      tile.height = 20;
      const tileCtx = tile.getContext('2d')!;
      tileCtx.fillStyle = '#ffffff';
      tileCtx.fillRect(0, 0, 20, 20);
      tileCtx.fillStyle = '#e0e0e0';
      tileCtx.fillRect(10, 0, 10, 10);
      tileCtx.fillRect(0, 10, 10, 10);
      this._checkerboardPattern = ctx.createPattern(tile, 'repeat')!;
    }
    return this._checkerboardPattern;
  }

  override willUpdate() {
    const layers = this._ctx.value?.state.layers ?? null;
    if (layers && layers !== this._lastLayers) {
      this._lastLayers = layers;
      // Defer composite to after render so the display canvas exists
      if (this.mainCanvas) {
        this.composite();
      }
    }

    // Update cursor based on active tool
    if (this.mainCanvas && this._ctx.value) {
      const tool = this._ctx.value.state.activeTool;
      if (tool === 'hand') {
        this.mainCanvas.style.cursor = this._panning ? 'grabbing' : 'grab';
      } else if ((tool === 'select' || tool === 'stamp') && this._float && !this._floatMoving && !this._floatResizing) {
        // Dynamic cursor set by pointer move handler
      } else {
        this.mainCanvas.style.cursor = 'crosshair';
      }
    }
  }

  override firstUpdated() {
    const rect = this.getBoundingClientRect();
    const vw = rect.width > 0 ? Math.floor(rect.width) : 800;
    const vh = rect.height > 0 ? Math.floor(rect.height) : 600;

    this.mainCanvas.width = vw;
    this.mainCanvas.height = vh;
    this.previewCanvas.width = vw;
    this.previewCanvas.height = vh;

    // Center document in viewport
    this._panX = Math.round((vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((vh - this._docHeight * this._zoom) / 2);

    this._resizeObserver = new ResizeObserver(() => this._resizeToFit());
    this._resizeObserver.observe(this);

    // White-fill the initial default layer. Safe even when a project will be loaded
    // because Lit guarantees child firstUpdated fires before parent firstUpdated, so
    // this runs before drawing-app._loadProject(). _loadProject replaces the layers
    // array with entirely new Layer objects (new canvases), discarding this default one.
    // For new projects, this provides the expected white background.
    const layerCtx = this._getActiveLayerCtx();
    if (layerCtx) {
      layerCtx.fillStyle = '#ffffff';
      layerCtx.fillRect(0, 0, this._docWidth, this._docHeight);
    }
    this.composite();
  }

  /** Center the document in the viewport */
  public centerDocument() {
    if (!this.mainCanvas) return;
    this._panX = Math.round((this._vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((this._vh - this._docHeight * this._zoom) / 2);
    this.composite();
    if (this._float) this._redrawFloatPreview();
  }

  private _resizeToFit() {
    const rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const newWidth = Math.floor(rect.width);
    const newHeight = Math.floor(rect.height);
    const oldWidth = this.mainCanvas.width;
    const oldHeight = this.mainCanvas.height;
    if (oldWidth === newWidth && oldHeight === newHeight) return;

    // Resize display and preview canvases to viewport size only
    this.mainCanvas.width = newWidth;
    this.mainCanvas.height = newHeight;
    this.previewCanvas.width = newWidth;
    this.previewCanvas.height = newHeight;

    // Adjust pan to keep the center stable
    const oldCenterDocX = (oldWidth / 2 - this._panX) / this._zoom;
    const oldCenterDocY = (oldHeight / 2 - this._panY) / this._zoom;
    this._panX = newWidth / 2 - oldCenterDocX * this._zoom;
    this._panY = newHeight / 2 - oldCenterDocY * this._zoom;

    // Pattern is tied to canvas context, must recreate
    this._checkerboardPattern = null;

    this.composite();
    if (this._float) this._redrawFloatPreview();
  }

  // --- History ---
  private _history: HistoryEntry[] = [];
  private _historyIndex = -1;
  private _maxHistory = 50;
  private _historyVersion = 0;

  // --- Public history access for persistence ---
  /** Returns a shallow copy of the history array. Note: entries contain shared
   *  mutable references (e.g. ImageData in 'draw' entries). Callers that need
   *  isolation should snapshot data synchronously before any async work. */
  public getHistory(): HistoryEntry[] { return [...this._history]; }
  public getHistoryIndex(): number { return this._historyIndex; }
  public getHistoryVersion(): number { return this._historyVersion; }
  public setHistory(entries: HistoryEntry[], index: number) {
    this._history = entries;
    this._historyIndex = index;
    this._historyVersion = 0;
    this._notifyHistory();
  }

  private _beforeDrawData: ImageData | null = null;

  /** Call before a drawing operation starts (pointerdown) */
  private _captureBeforeDraw() {
    const ctx = this._getActiveLayerCtx();
    if (!ctx) return;
    this._beforeDrawData = ctx.getImageData(0, 0, this._docWidth, this._docHeight);
  }

  /** Call after a drawing operation completes (pointerup) */
  private _pushDrawHistory() {
    const state = this._ctx.value?.state;
    const ctx = this._getActiveLayerCtx();
    if (!ctx || !state || !this._beforeDrawData) return;
    const after = ctx.getImageData(0, 0, this._docWidth, this._docHeight);
    this._pushHistoryEntry({
      type: 'draw',
      layerId: state.activeLayerId,
      before: this._beforeDrawData,
      after,
    });
    this._beforeDrawData = null;
  }

  /** Called by drawing-app for layer structural operations */
  public pushLayerOperation(entry: HistoryEntry) {
    this._pushHistoryEntry(entry);
  }

  private _pushHistoryEntry(entry: HistoryEntry) {
    const prevLength = this._history.length;
    this._history = this._history.slice(0, this._historyIndex + 1);
    if (this._history.length < prevLength) {
      this._historyVersion++;
    }
    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
      this._historyVersion++;
    } else {
      this._historyIndex++;
    }
    this._notifyHistory();
  }

  private _notifyHistory() {
    this.dispatchEvent(
      new CustomEvent('history-change', {
        bubbles: true,
        composed: true,
        detail: {
          canUndo: this._historyIndex >= 0,
          canRedo: this._historyIndex < this._history.length - 1,
        },
      }),
    );
  }

  public undo() {
    if (this._historyIndex < 0) return;
    // Commit the active float first. This pushes a new history entry for the
    // lift+commit, which the undo below then immediately reverses — effectively
    // cancelling the float and restoring the layer to its pre-lift state.
    this._commitFloat();
    const entry = this._history[this._historyIndex];
    this._historyIndex--;
    this._applyUndo(entry);
    this.composite();
    this._notifyHistory();
  }

  public redo() {
    if (this._historyIndex >= this._history.length - 1) return;
    this._commitFloat();
    this._historyIndex++;
    const entry = this._history[this._historyIndex];
    this._applyRedo(entry);
    this.composite();
    this._notifyHistory();
  }

  private _applyUndo(entry: HistoryEntry) {
    const state = this._ctx.value?.state;
    if (!state) return;
    switch (entry.type) {
      case 'draw': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) layer.canvas.getContext('2d')!.putImageData(entry.before, 0, 0);
        break;
      }
      case 'add-layer': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: { action: 'remove-layer', layerId: entry.layer.id },
        }));
        break;
      }
      case 'delete-layer': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: { action: 'restore-layer', snapshot: entry.layer, index: entry.index },
        }));
        break;
      }
      case 'reorder': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: { action: 'reorder', fromIndex: entry.toIndex, toIndex: entry.fromIndex },
        }));
        break;
      }
      case 'visibility': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.visible = entry.before;
          this.dispatchEvent(new CustomEvent('layer-undo', {
            bubbles: true, composed: true,
            detail: { action: 'refresh' },
          }));
        }
        break;
      }
      case 'opacity': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.opacity = entry.before;
          this.dispatchEvent(new CustomEvent('layer-undo', {
            bubbles: true, composed: true,
            detail: { action: 'refresh' },
          }));
        }
        break;
      }
      case 'rename': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.name = entry.before;
          this.dispatchEvent(new CustomEvent('layer-undo', {
            bubbles: true, composed: true,
            detail: { action: 'refresh' },
          }));
        }
        break;
      }
    }
  }

  private _applyRedo(entry: HistoryEntry) {
    const state = this._ctx.value?.state;
    if (!state) return;
    switch (entry.type) {
      case 'draw': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) layer.canvas.getContext('2d')!.putImageData(entry.after, 0, 0);
        break;
      }
      case 'add-layer': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: { action: 'restore-layer', snapshot: entry.layer, index: entry.index },
        }));
        break;
      }
      case 'delete-layer': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: { action: 'remove-layer', layerId: entry.layer.id },
        }));
        break;
      }
      case 'reorder': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: { action: 'reorder', fromIndex: entry.fromIndex, toIndex: entry.toIndex },
        }));
        break;
      }
      case 'visibility': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.visible = entry.after;
          this.dispatchEvent(new CustomEvent('layer-undo', {
            bubbles: true, composed: true,
            detail: { action: 'refresh' },
          }));
        }
        break;
      }
      case 'opacity': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.opacity = entry.after;
          this.dispatchEvent(new CustomEvent('layer-undo', {
            bubbles: true, composed: true,
            detail: { action: 'refresh' },
          }));
        }
        break;
      }
      case 'rename': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          layer.name = entry.after;
          this.dispatchEvent(new CustomEvent('layer-undo', {
            bubbles: true, composed: true,
            detail: { action: 'refresh' },
          }));
        }
        break;
      }
    }
  }

  public clearCanvas() {
    this._captureBeforeDraw();
    const ctx = this._getActiveLayerCtx();
    if (ctx) {
      ctx.clearRect(0, 0, this._docWidth, this._docHeight);
    }
    this._pushDrawHistory();
    this.composite();
  }

  public saveCanvas() {
    // Composite onto a temp canvas without checkerboard for clean export
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this._docWidth;
    exportCanvas.height = this._docHeight;
    const exportCtx = exportCanvas.getContext('2d')!;
    const layers = this._ctx.value?.state.layers ?? [];
    for (const layer of layers) {
      if (!layer.visible) continue;
      exportCtx.globalAlpha = layer.opacity;
      exportCtx.drawImage(layer.canvas, 0, 0);
      exportCtx.globalAlpha = 1.0;
    }
    const link = document.createElement('a');
    link.download = 'drawing.png';
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }

  // --- Coordinate conversion ---

  /** Convert viewport pointer position to document coordinates */
  private _getDocPoint(e: PointerEvent): Point {
    const rect = this.mainCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this._panX) / this._zoom,
      y: (e.clientY - rect.top - this._panY) / this._zoom,
    };
  }

  // --- Panning ---

  private _startPan(e: PointerEvent) {
    this._panning = true;
    this._panStartX = e.clientX;
    this._panStartY = e.clientY;
    this._panStartOffsetX = this._panX;
    this._panStartOffsetY = this._panY;
    this._panPointerId = e.pointerId;
    this.mainCanvas.setPointerCapture(e.pointerId);
    this.mainCanvas.style.cursor = 'grabbing';
  }

  private _updatePan(e: PointerEvent) {
    if (!this._panning) return;
    this._panX = this._panStartOffsetX + (e.clientX - this._panStartX);
    this._panY = this._panStartOffsetY + (e.clientY - this._panStartY);
    this.composite();
    if (this._float) this._redrawFloatPreview();
  }

  private _endPan() {
    if (!this._panning) return;
    const pointerId = this._panPointerId;
    this._panning = false;
    this._panPointerId = -1;
    // Release pointer capture
    if (pointerId >= 0 && this.mainCanvas) {
      try { this.mainCanvas.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
    // Restore cursor
    if (this._ctx.value) {
      const tool = this._ctx.value.state.activeTool;
      this.mainCanvas.style.cursor = tool === 'hand' ? 'grab' : 'crosshair';
    }
  }

  private _onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom anchored to cursor position
      e.preventDefault();
      const rect = this.mainCanvas.getBoundingClientRect();
      const viewportX = e.clientX - rect.left;
      const viewportY = e.clientY - rect.top;

      const docX = (viewportX - this._panX) / this._zoom;
      const docY = (viewportY - this._panY) / this._zoom;

      const direction = e.deltaY < 0 ? 1 : -1;
      const newZoom = Math.min(
        DrawingCanvas.MAX_ZOOM,
        Math.max(
          DrawingCanvas.MIN_ZOOM,
          this._zoom * Math.pow(DrawingCanvas.ZOOM_STEP, direction),
        ),
      );
      if (newZoom === this._zoom) return;

      this._panX = viewportX - docX * newZoom;
      this._panY = viewportY - docY * newZoom;
      this._zoom = newZoom;

      this.composite();
      if (this._float) this._redrawFloatPreview();
      this._dispatchZoomChange();
      return;
    }

    // Plain wheel → pan
    e.preventDefault();
    this._panX -= e.deltaX;
    this._panY -= e.deltaY;
    this.composite();
    if (this._float) this._redrawFloatPreview();
  };

  private _dispatchZoomChange() {
    this.dispatchEvent(new CustomEvent('zoom-change', {
      bubbles: true,
      composed: true,
      detail: { zoom: this._zoom },
    }));
  }

  public zoomIn() {
    this._zoomToCenter(this._zoom * DrawingCanvas.ZOOM_STEP);
  }

  public zoomOut() {
    this._zoomToCenter(this._zoom / DrawingCanvas.ZOOM_STEP);
  }

  public zoomToFit() {
    const fitZoom = Math.min(
      this._vw / this._docWidth,
      this._vh / this._docHeight,
    ) * 0.9;
    this._zoom = Math.min(DrawingCanvas.MAX_ZOOM, Math.max(DrawingCanvas.MIN_ZOOM, fitZoom));
    this._panX = Math.round((this._vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((this._vh - this._docHeight * this._zoom) / 2);
    this.composite();
    if (this._float) this._redrawFloatPreview();
    this._dispatchZoomChange();
  }

  public getZoom(): number { return this._zoom; }

  private _zoomToCenter(newZoom: number) {
    const clamped = Math.min(DrawingCanvas.MAX_ZOOM, Math.max(DrawingCanvas.MIN_ZOOM, newZoom));
    if (clamped === this._zoom) return;

    const cx = this._vw / 2;
    const cy = this._vh / 2;
    const docX = (cx - this._panX) / this._zoom;
    const docY = (cy - this._panY) / this._zoom;

    this._panX = cx - docX * clamped;
    this._panY = cy - docY * clamped;
    this._zoom = clamped;

    this.composite();
    if (this._float) this._redrawFloatPreview();
    this._dispatchZoomChange();
  }

  // --- Pointer events ---

  private _onPointerDown(e: PointerEvent) {
    if (!this._ctx.value) return;

    // Middle mouse button → always pan
    if (e.button === 1) {
      e.preventDefault();
      this._startPan(e);
      return;
    }

    if (e.button !== 0) return;

    const { activeTool } = this.ctx.state;

    // Hand tool → pan
    if (activeTool === 'hand') {
      this._startPan(e);
      return;
    }

    this.mainCanvas.setPointerCapture(e.pointerId);
    const p = this._getDocPoint(e);

    if (activeTool === 'select') {
      this._handleSelectPointerDown(p);
      return;
    }

    if (activeTool === 'fill') {
      // Only fill if the click is within document bounds
      if (p.x >= 0 && p.y >= 0 && p.x < this._docWidth && p.y < this._docHeight) {
        this._captureBeforeDraw();
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          floodFill(layerCtx, p.x, p.y, this.ctx.state.strokeColor);
        }
        this._pushDrawHistory();
        this.composite();
      }
      return;
    }

    if (activeTool === 'stamp') {
      // If a float exists and click is on handle or inside, move/resize it
      if (this._float && (this._hitTestHandle(p) || this._isInsideFloat(p))) {
        this._handleSelectPointerDown(p);
        return;
      }
      if (this.ctx.state.stampImage) {
        this._commitFloat();
        this._captureBeforeDraw();
        this._createFloatFromImage(this.ctx.state.stampImage, p.x, p.y, this.ctx.state.brushSize * 10);
      }
      return;
    }

    this._drawing = true;
    this._lastPoint = p;
    this._startPoint = p;

    // For brushes, capture before draw and draw a dot at start
    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
      this._captureBeforeDraw();
      this._drawBrushAt(p, p);
    }
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._ctx.value) return;

    // Handle panning
    if (this._panning) {
      this._updatePan(e);
      return;
    }

    const { activeTool } = this.ctx.state;

    if (activeTool === 'select') {
      this._handleSelectPointerMove(e);
      return;
    }

    if (activeTool === 'stamp' && this._float) {
      this._handleSelectPointerMove(e);
      return;
    }

    if (!this._drawing || !this._lastPoint) return;
    const p = this._getDocPoint(e);

    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
      this._drawBrushAt(this._lastPoint, p);
      this._lastPoint = p;
    } else if (
      activeTool === 'rectangle' ||
      activeTool === 'circle' ||
      activeTool === 'line' ||
      activeTool === 'triangle'
    ) {
      // Preview on overlay with pan transform
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._vw, this._vh);
      previewCtx.save();
      previewCtx.translate(this._panX, this._panY);
      previewCtx.scale(this._zoom, this._zoom);
      drawShapePreview(
        previewCtx,
        activeTool,
        this._startPoint!,
        p,
        this.ctx.state.strokeColor,
        this.ctx.state.fillColor,
        this.ctx.state.useFill,
        this.ctx.state.brushSize,
      );
      previewCtx.restore();
    }
  }

  private _onPointerUp(e: PointerEvent) {
    if (!this._ctx.value) return;

    // Handle panning end
    if (this._panning) {
      this._endPan();
      return;
    }

    const { activeTool } = this.ctx.state;

    if (activeTool === 'select') {
      this._handleSelectPointerUp(e);
      return;
    }

    if (activeTool === 'stamp' && this._float) {
      this._handleSelectPointerUp(e);
      return;
    }

    if (!this._drawing) return;
    const p = this._getDocPoint(e);

    if (
      activeTool === 'rectangle' ||
      activeTool === 'circle' ||
      activeTool === 'line' ||
      activeTool === 'triangle'
    ) {
      // Capture before draw for shapes (they only commit on pointerup)
      this._captureBeforeDraw();
      // Commit shape to active layer
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        drawShapePreview(
          layerCtx,
          activeTool,
          this._startPoint!,
          p,
          this.ctx.state.strokeColor,
          this.ctx.state.fillColor,
          this.ctx.state.useFill,
          this.ctx.state.brushSize,
        );
      }
      // Clear preview
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._vw, this._vh);
    }

    this._drawing = false;
    this._lastPoint = null;
    this._startPoint = null;
    this._pushDrawHistory();
    this.composite();
  }

  private _drawBrushAt(from: Point, to: Point) {
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    const { activeTool, strokeColor, brushSize } = this.ctx.state;

    switch (activeTool) {
      case 'pencil':
        drawPencilSegment(layerCtx, from, to, strokeColor, brushSize);
        break;
      case 'marker':
        drawMarkerSegment(layerCtx, from, to, strokeColor, brushSize);
        break;
      case 'eraser':
        drawEraserSegment(layerCtx, from, to, brushSize);
        break;
    }
    this.composite();
  }

  // --- Selection / floating selection helpers ---

  private static readonly HANDLE_SIZE = 8;

  private _handleSizeDoc(): number {
    return DrawingCanvas.HANDLE_SIZE / this._zoom;
  }

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

  private _isInsideFloat(p: Point): boolean {
    if (!this._float) return false;
    const { x, y, w, h } = this._float.currentRect;
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
  }

  private _handleCursor(handle: ResizeHandle): string {
    const cursors: Record<ResizeHandle, string> = {
      nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
      se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
    };
    return cursors[handle];
  }

  private _handleSelectPointerDown(p: Point) {
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

    if (this._float && this._isInsideFloat(p)) {
      this._floatMoving = true;
      this._floatDragOffset = {
        x: p.x - this._float.currentRect.x,
        y: p.y - this._float.currentRect.y,
      };
      this._stopSelectionAnimation();
      return;
    }

    this._commitFloat();
    this._selectionDrawing = true;
    this._startPoint = p;
  }

  private _handleSelectPointerMove(e: PointerEvent) {
    const p = this._getDocPoint(e);

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

    if (this._floatResizing && this._float && this._floatResizeOrigin) {
      this._applyResize(p);
      this._redrawFloatPreview();
      return;
    }

    if (this._floatMoving && this._float && this._floatDragOffset) {
      this._float.currentRect.x = p.x - this._floatDragOffset.x;
      this._float.currentRect.y = p.y - this._floatDragOffset.y;
      this._redrawFloatPreview();
      return;
    }

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

      this._liftToFloat(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }
  }

  // --- Float lifecycle methods ---

  private _liftToFloat(x: number, y: number, w: number, h: number) {
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    this._captureBeforeDraw();
    const imageData = layerCtx.getImageData(x, y, w, h);
    layerCtx.clearRect(x, y, w, h);
    this.composite();

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
      originalImageData: imageData,
      currentRect: { x, y, w, h },
      tempCanvas: tmp,
    };
    this._startSelectionAnimation();
  }

  private _createFloatFromImage(img: HTMLImageElement, centerX: number, centerY: number, size: number) {
    const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const x = Math.round(centerX - w / 2);
    const y = Math.round(centerY - h / 2);

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

  private _commitFloat() {
    if (!this._float) return;
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;

    const { currentRect, tempCanvas } = this._float;
    layerCtx.drawImage(tempCanvas, Math.round(currentRect.x), Math.round(currentRect.y));

    this._pushDrawHistory();
    this.composite();
    this._clearFloatState();
  }

  private _clearFloatState() {
    this._float = null;
    this._floatSrcCanvas = null;
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

  private _rebuildTempCanvas() {
    if (!this._float || !this._floatSrcCanvas) return;
    const { currentRect } = this._float;
    const tmp = this._float.tempCanvas;
    const newW = Math.max(1, Math.round(currentRect.w));
    const newH = Math.max(1, Math.round(currentRect.h));
    // Setting width/height clears the canvas and reuses the element
    tmp.width = newW;
    tmp.height = newH;
    tmp.getContext('2d')!.drawImage(this._floatSrcCanvas, 0, 0, newW, newH);
  }

  private _applyResize(p: Point) {
    if (!this._float || !this._floatResizeOrigin) return;
    const { rect: orig, point: start } = this._floatResizeOrigin;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    const handle = this._floatResizeHandle!;
    const cur = this._float.currentRect;

    const minSize = 4 / this._zoom;

    let newX = orig.x, newY = orig.y, newW = orig.w, newH = orig.h;

    if (handle === 'nw' || handle === 'w' || handle === 'sw') {
      newX = orig.x + dx;
      newW = orig.w - dx;
    } else if (handle === 'ne' || handle === 'e' || handle === 'se') {
      newW = orig.w + dx;
    }

    if (handle === 'nw' || handle === 'n' || handle === 'ne') {
      newY = orig.y + dy;
      newH = orig.h - dy;
    } else if (handle === 'sw' || handle === 's' || handle === 'se') {
      newH = orig.h + dy;
    }

    // Enforce aspect ratio for corner handles BEFORE flip correction
    if (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw') {
      const aspect = orig.w / orig.h;
      if (Math.abs(newW - orig.w) / orig.w > Math.abs(newH - orig.h) / orig.h) {
        newH = newW / aspect;
      } else {
        newW = newH * aspect;
      }
      // Re-anchor after aspect ratio enforcement
      if (handle === 'nw') {
        newX = orig.x + orig.w - newW;
        newY = orig.y + orig.h - newH;
      } else if (handle === 'ne') {
        newY = orig.y + orig.h - newH;
      } else if (handle === 'sw') {
        newX = orig.x + orig.w - newW;
      }
    }

    // Flip if dragged past opposite edge (after aspect ratio so flipped dimensions are correct)
    if (newW < 0) { newX += newW; newW = -newW; }
    if (newH < 0) { newY += newH; newH = -newH; }

    if (newW < minSize) { newW = minSize; }
    if (newH < minSize) { newH = minSize; }

    cur.x = newX;
    cur.y = newY;
    cur.w = newW;
    cur.h = newH;

    this._rebuildTempCanvas();
  }

  private _redrawFloatPreview() {
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);

    if (!this._float) return;
    const { currentRect, tempCanvas } = this._float;

    previewCtx.save();
    previewCtx.translate(this._panX, this._panY);
    previewCtx.scale(this._zoom, this._zoom);
    previewCtx.drawImage(tempCanvas, currentRect.x, currentRect.y, currentRect.w, currentRect.h);
    drawSelectionRect(previewCtx, currentRect.x, currentRect.y, currentRect.w, currentRect.h, this._selectionDashOffset);
    previewCtx.restore();

    this._drawResizeHandles(previewCtx);
  }

  private _drawResizeHandles(ctx: CanvasRenderingContext2D) {
    if (!this._float) return;
    const { x, y, w, h } = this._float.currentRect;
    const hs = DrawingCanvas.HANDLE_SIZE;
    const half = hs / 2;

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

  private _startSelectionAnimation() {
    this._stopSelectionAnimation();
    const animate = () => {
      this._selectionDashOffset = (this._selectionDashOffset + 0.5) % 12;
      this._redrawFloatPreview();
      this._selectionAnimFrame = requestAnimationFrame(animate);
    };
    this._selectionAnimFrame = requestAnimationFrame(animate);
  }

  private _stopSelectionAnimation() {
    if (this._selectionAnimFrame !== null) {
      cancelAnimationFrame(this._selectionAnimFrame);
      this._selectionAnimFrame = null;
    }
  }

  // --- Public selection API (for keyboard shortcuts) ---

  public copySelection() {
    if (!this._float) return;
    const { tempCanvas, currentRect } = this._float;
    const ctx = tempCanvas.getContext('2d')!;
    this._clipboard = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    this._clipboardOrigin = { x: currentRect.x, y: currentRect.y };
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

    const w = this._clipboard.width;
    const h = this._clipboard.height;
    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    src.getContext('2d')!.putImageData(this._clipboard, 0, 0);
    this._floatSrcCanvas = src;

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.drawImage(src, 0, 0);

    this._float = {
      originalImageData: new ImageData(
        new Uint8ClampedArray(this._clipboard.data),
        w, h,
      ),
      currentRect: { x: this._clipboardOrigin.x, y: this._clipboardOrigin.y, w, h },
      tempCanvas: tmp,
    };
    this._startSelectionAnimation();
  }

  public deleteSelection() {
    if (!this._float) return;
    // For stamp floats, _beforeDrawData may already be consumed or the layer
    // wasn't modified — capture now so _pushDrawHistory has valid state.
    if (!this._beforeDrawData) {
      this._captureBeforeDraw();
    }
    this._pushDrawHistory();
    this.composite();
    this._clearFloatState();
  }

  public clearSelection() {
    this._commitFloat();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('wheel', this._onWheel, { passive: false });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._stopSelectionAnimation();
    this.removeEventListener('wheel', this._onWheel);
  }

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
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-canvas': DrawingCanvas;
  }
}

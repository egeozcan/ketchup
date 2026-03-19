import { LitElement, html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Point, HistoryEntry, Layer, FloatingSelection, LayerSnapshot } from '../types.js';
import { drawPencilSegment } from '../tools/pencil.js';
import { drawMarkerSegment } from '../tools/marker.js';
import { drawEraserSegment } from '../tools/eraser.js';
import { drawShapePreview } from '../tools/shapes.js';
import { floodFill } from '../tools/fill.js';
import { drawSelectionRect } from '../tools/select.js';
import { drawCropOverlay, hitTestCropHandle, parseAspectRatio, constrainCropToRatio, type CropRect, type CropHandle } from '../tools/crop.js';
import './resize-dialog.js';
import type { ResizeDialog } from './resize-dialog.js';

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

    :host(.drop-target) #main {
      outline: 3px dashed #4a90d9;
      outline-offset: -3px;
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
  @query('resize-dialog') private _resizeDialog!: ResizeDialog;

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

  // --- Move tool state ---
  private _moveTempCanvas: HTMLCanvasElement | null = null;
  private _moveStartPoint: Point | null = null;

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

  /** True when the current float was created via paste/drop — Escape discards + deletes layer */
  private _floatIsExternalImage = false;

  // Interaction state
  private _selectionDrawing = false;
  private _floatMoving = false;
  private _floatResizing = false;
  private _floatResizeHandle: ResizeHandle | null = null;
  private _floatDragOffset: Point | null = null;
  private _floatResizeOrigin: { rect: { x: number; y: number; w: number; h: number }; point: Point } | null = null;

  // --- Crop tool state ---
  private _cropRect: CropRect | null = null;
  private _cropDragging = false;
  private _cropHandle: CropHandle | null = null;
  private _cropDragOrigin: Point | null = null;
  private _cropRectOrigin: CropRect | null = null;

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

    const activeLayerId = this._ctx.value?.state.activeLayerId ?? null;
    const floatDetail = this._float && activeLayerId
      ? { tempCanvas: this._float.tempCanvas, rect: this._float.currentRect, layerId: activeLayerId }
      : null;
    this.dispatchEvent(new CustomEvent('composited', {
      bubbles: true, composed: true,
      detail: floatDetail,
    }));
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
      } else if (tool === 'move') {
        this.mainCanvas.style.cursor = 'move';
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
    this._dispatchViewportChange();
  }

  /** Center the document in the viewport */
  public centerDocument() {
    if (!this.mainCanvas) return;
    this._panX = Math.round((this._vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((this._vh - this._docHeight * this._zoom) / 2);
    this.composite();
    if (this._float) this._redrawFloatPreview();
    this._dispatchViewportChange();
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
    this._dispatchViewportChange();
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
    this._historyIndex = Math.max(-1, Math.min(index, entries.length - 1));
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
  private _pushDrawHistory(force = false) {
    const state = this._ctx.value?.state;
    const ctx = this._getActiveLayerCtx();
    if (!ctx || !state || !this._beforeDrawData) return;
    const after = ctx.getImageData(0, 0, this._docWidth, this._docHeight);
    // Skip no-op: if before and after are identical, discard without pushing.
    if (!force) {
      const beforeBuf = this._beforeDrawData.data;
      const afterBuf = after.data;
      if (beforeBuf.length === afterBuf.length) {
        let same = true;
        for (let i = 0; i < beforeBuf.length; i++) {
          if (beforeBuf[i] !== afterBuf[i]) { same = false; break; }
        }
        if (same) {
          this._beforeDrawData = null;
          return;
        }
      }
    }
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

  /** Extract the layer ID referenced by a history entry, or null if not layer-specific. */
  private _getEntryLayerId(entry: HistoryEntry): string | null {
    switch (entry.type) {
      case 'draw':
      case 'visibility':
      case 'opacity':
      case 'rename':
        return entry.layerId;
      case 'add-layer':
      case 'delete-layer':
        return entry.layer.id;
      case 'reorder':
        return null;
      case 'crop':
        return null;
    }
  }

  private _notifyHistory() {
    this.dispatchEvent(
      new CustomEvent('history-change', {
        bubbles: true,
        composed: true,
        detail: {
          canUndo: this._historyIndex >= 0 || this._float !== null,
          canRedo: this._historyIndex < this._history.length - 1,
        },
      }),
    );
  }

  public undo() {
    // Finalize any in-progress brush/shape/move so it becomes its own
    // history entry before we undo. Without this, the undo modifies the
    // layer under the stroke, corrupting _beforeDrawData and the history.
    if (this._drawing) {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory();
      if (this.previewCanvas) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      }
      this.composite();
    }
    if (this._moveTempCanvas) {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory();
      this.composite();
    }
    // Discard the active float first — this counts as its own undo step
    // (the float lift is a user action even though it has no history entry).
    if (this._float) {
      this._discardFloat();
      return;
    }
    if (this._historyIndex < 0) return;
    const entry = this._history[this._historyIndex];
    this._historyIndex--;
    this._applyUndo(entry);
    this.composite();
    this._notifyHistory();
  }

  public redo() {
    if (this._drawing) {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory();
      if (this.previewCanvas) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      }
      this.composite();
    }
    if (this._moveTempCanvas) {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory();
      this.composite();
    }
    if (this._historyIndex >= this._history.length - 1) return;
    this._discardFloat();
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
      case 'crop': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: {
            action: 'crop-restore',
            layers: entry.beforeLayers,
            width: entry.beforeWidth,
            height: entry.beforeHeight,
          },
        }));
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
      case 'crop': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: {
            action: 'crop-restore',
            layers: entry.afterLayers,
            width: entry.afterWidth,
            height: entry.afterHeight,
          },
        }));
        break;
      }
    }
  }

  public clearCanvas() {
    // Finalize any in-progress brush stroke before clearing
    if (this._drawing) {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory(true);
    }
    this.clearSelection();
    this._captureBeforeDraw();
    const ctx = this._getActiveLayerCtx();
    if (ctx) {
      ctx.clearRect(0, 0, this._docWidth, this._docHeight);
    }
    this._pushDrawHistory(true);
    this.composite();
  }

  public saveCanvas() {
    // Composite onto a temp canvas without checkerboard for clean export
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this._docWidth;
    exportCanvas.height = this._docHeight;
    const exportCtx = exportCanvas.getContext('2d')!;
    const state = this._ctx.value?.state;
    const layers = state?.layers ?? [];
    const activeLayerId = state?.activeLayerId ?? null;
    for (const layer of layers) {
      if (!layer.visible) continue;
      exportCtx.globalAlpha = layer.opacity;
      exportCtx.drawImage(layer.canvas, 0, 0);
      // Draw the float right after its owning layer so it composites
      // at the correct z-position instead of on top of everything.
      if (this._float && layer.id === activeLayerId) {
        const { currentRect, tempCanvas } = this._float;
        exportCtx.drawImage(tempCanvas, Math.round(currentRect.x), Math.round(currentRect.y));
      }
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
    // Restore cursor to match the active tool
    if (this._ctx.value) {
      const tool = this._ctx.value.state.activeTool;
      if (tool === 'hand') {
        this.mainCanvas.style.cursor = 'grab';
      } else if (tool === 'move') {
        this.mainCanvas.style.cursor = 'move';
      } else {
        this.mainCanvas.style.cursor = 'crosshair';
      }
    }
    this._dispatchViewportChange();
  }

  private _onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Zoom anchored to cursor position
      e.preventDefault();
      if (e.deltaY === 0) return; // Pure horizontal scroll — don't zoom
      const rect = this.mainCanvas.getBoundingClientRect();
      const viewportX = e.clientX - rect.left;
      const viewportY = e.clientY - rect.top;

      const docX = (viewportX - this._panX) / this._zoom;
      const docY = (viewportY - this._panY) / this._zoom;

      // Scale zoom factor by delta magnitude for smooth pinch-to-zoom.
      // Clamp delta to avoid huge jumps from mouse wheel acceleration.
      const delta = Math.max(-5, Math.min(5, -e.deltaY * 0.01));
      const newZoom = Math.min(
        DrawingCanvas.MAX_ZOOM,
        Math.max(
          DrawingCanvas.MIN_ZOOM,
          this._zoom * (1 + delta),
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
    this._dispatchViewportChange();
  };

  private _dispatchZoomChange() {
    this.dispatchEvent(new CustomEvent('zoom-change', {
      bubbles: true,
      composed: true,
      detail: { zoom: this._zoom },
    }));
    this._dispatchViewportChange();
  }

  private _dispatchViewportChange() {
    this.dispatchEvent(new CustomEvent('viewport-change', {
      bubbles: true,
      composed: true,
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

  public getViewport(): { zoom: number; panX: number; panY: number } {
    return { zoom: this._zoom, panX: this._panX, panY: this._panY };
  }

  public setViewport(zoom: number, panX: number, panY: number) {
    this._zoom = Math.min(DrawingCanvas.MAX_ZOOM, Math.max(DrawingCanvas.MIN_ZOOM, zoom));
    this._panX = panX;
    this._panY = panY;
    this.composite();
    this._dispatchViewportChange();
  }

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

    if (activeTool === 'crop') {
      this.mainCanvas.setPointerCapture(e.pointerId);
      const p = this._getDocPoint(e);
      this._handleCropPointerDown(p);
      return;
    }

    // Move tool → translate active layer
    if (activeTool === 'move') {
      this.mainCanvas.setPointerCapture(e.pointerId);
      this._commitFloat();
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

    this.mainCanvas.setPointerCapture(e.pointerId);
    const p = this._getDocPoint(e);

    if (activeTool === 'select') {
      this._handleSelectPointerDown(p);
      return;
    }

    if (activeTool === 'fill') {
      // Round to pixel coordinates first so the bounds check matches
      // what floodFill uses internally (Math.round).
      const fx = Math.round(p.x);
      const fy = Math.round(p.y);
      if (fx >= 0 && fy >= 0 && fx < this._docWidth && fy < this._docHeight) {
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          this._captureBeforeDraw();
          const modified = floodFill(layerCtx, fx, fy, this.ctx.state.strokeColor);
          if (modified) {
            this._pushDrawHistory();
            this.composite();
          } else {
            this._beforeDrawData = null;
          }
        }
      }
      return;
    }

    if (activeTool === 'stamp') {
      // If a float exists and click is on handle or inside, move/resize it
      if (this._float && (this._hitTestHandle(p) || this._isInsideFloat(p))) {
        this._handleSelectPointerDown(p);
        return;
      }
      this._commitFloat();
      if (this.ctx.state.stampImage) {
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

    if (activeTool === 'crop') {
      this._handleCropPointerMove(e);
      return;
    }

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

    if (activeTool === 'crop') {
      this._handleCropPointerUp();
      return;
    }

    // If a brush/shape stroke was in progress but the tool changed mid-stroke
    // (e.g. via keyboard shortcut), finalize the orphaned stroke now.
    // Select, stamp, move, hand, and fill never set _drawing, so _drawing
    // being true here means the tool switched away from a brush/shape tool.
    if (this._drawing && activeTool !== 'pencil' && activeTool !== 'marker' &&
        activeTool !== 'eraser' && activeTool !== 'rectangle' &&
        activeTool !== 'circle' && activeTool !== 'line' && activeTool !== 'triangle') {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory(true);
      this.composite();
      return;
    }

    // Same for the move tool: if a move drag was in progress but the tool
    // changed, finalize it so the partial move is recorded in history.
    if (this._moveTempCanvas && activeTool !== 'move') {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory(true);
      this.composite();
      return;
    }

    if (activeTool === 'move' && this._moveTempCanvas) {
      const p = this._getDocPoint(e);
      const dx = Math.round(p.x - this._moveStartPoint!.x);
      const dy = Math.round(p.y - this._moveStartPoint!.y);
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      if (dx === 0 && dy === 0) {
        // Click without drag — discard the no-op history entry
        this._beforeDrawData = null;
      } else {
        this._pushDrawHistory();
      }
      this.composite();
      return;
    }

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

  private _handleCropPointerDown(p: Point) {
    if (this._cropRect) {
      const handle = hitTestCropHandle(this._cropRect, p, this._zoom);
      if (handle && handle !== 'move') {
        this._cropHandle = handle;
        this._cropDragOrigin = { x: p.x, y: p.y };
        this._cropRectOrigin = { ...this._cropRect };
        return;
      }
      if (handle === 'move') {
        this._cropHandle = 'move';
        this._cropDragOrigin = { x: p.x, y: p.y };
        this._cropRectOrigin = { ...this._cropRect };
        return;
      }
    }
    this._cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    this._cropDragging = true;
    this._cropDragOrigin = { x: p.x, y: p.y };
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
      const rawLeft = Math.min(this._startPoint.x, p.x);
      const rawTop = Math.min(this._startPoint.y, p.y);
      const rawRight = Math.max(this._startPoint.x, p.x);
      const rawBottom = Math.max(this._startPoint.y, p.y);
      this._startPoint = null;

      // Clamp selection bounds to document so getImageData never receives
      // out-of-range coordinates.
      const x = Math.max(0, Math.min(this._docWidth, rawLeft));
      const y = Math.max(0, Math.min(this._docHeight, rawTop));
      const right = Math.max(0, Math.min(this._docWidth, rawRight));
      const bottom = Math.max(0, Math.min(this._docHeight, rawBottom));
      const w = right - x;
      const h = bottom - y;

      if (w < 2 || h < 2) {
        const previewCtx = this.previewCanvas.getContext('2d')!;
        previewCtx.clearRect(0, 0, this._vw, this._vh);
        return;
      }

      // Round endpoints first, then derive dimensions so the lifted region
      // exactly covers the rounded pixel boundaries.
      const rx = Math.round(x);
      const ry = Math.round(y);
      const rw = Math.round(right) - rx;
      const rh = Math.round(bottom) - ry;
      if (rw < 1 || rh < 1) {
        const previewCtx = this.previewCanvas.getContext('2d')!;
        previewCtx.clearRect(0, 0, this._vw, this._vh);
        return;
      }
      this._liftToFloat(rx, ry, rw, rh);
    }
  }

  private _handleCropPointerMove(e: PointerEvent) {
    const p = this._getDocPoint(e);
    const ratio = parseAspectRatio(this.ctx.state.cropAspectRatio);

    if (this._cropDragging && this._cropDragOrigin) {
      let rect: CropRect = {
        x: this._cropDragOrigin.x,
        y: this._cropDragOrigin.y,
        w: p.x - this._cropDragOrigin.x,
        h: p.y - this._cropDragOrigin.y,
      };
      if (ratio) {
        rect = constrainCropToRatio(rect, ratio, 'draw');
      }
      this._cropRect = rect;
      this._drawCropPreview();
      return;
    }

    if (this._cropHandle && this._cropDragOrigin && this._cropRectOrigin) {
      const dx = p.x - this._cropDragOrigin.x;
      const dy = p.y - this._cropDragOrigin.y;
      const orig = this._cropRectOrigin;

      if (this._cropHandle === 'move') {
        let nx = orig.x + dx;
        let ny = orig.y + dy;
        const nw = Math.abs(orig.w);
        const nh = Math.abs(orig.h);
        nx = Math.max(0, Math.min(nx, this._docWidth - nw));
        ny = Math.max(0, Math.min(ny, this._docHeight - nh));
        this._cropRect = { x: nx, y: ny, w: nw, h: nh };
      } else {
        let rect = this._resizeCropRect(orig, this._cropHandle, dx, dy);
        if (ratio) {
          rect = constrainCropToRatio(rect, ratio, this._cropHandle);
        }
        this._cropRect = rect;
      }
      this._drawCropPreview();
      return;
    }

    if (this._cropRect) {
      const handle = hitTestCropHandle(this._cropRect, p, this._zoom);
      if (handle && handle !== 'move') {
        this.mainCanvas.style.cursor = this._cropHandleCursor(handle);
      } else if (handle === 'move') {
        this.mainCanvas.style.cursor = 'move';
      } else {
        this.mainCanvas.style.cursor = 'crosshair';
      }
    }
  }

  private _cropHandleCursor(handle: CropHandle): string {
    const cursors: Record<string, string> = {
      nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
      se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
    };
    return cursors[handle] ?? 'crosshair';
  }

  private _resizeCropRect(orig: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
    let { x, y, w, h } = orig;
    switch (handle) {
      case 'nw': x += dx; y += dy; w -= dx; h -= dy; break;
      case 'n':  y += dy; h -= dy; break;
      case 'ne': w += dx; y += dy; h -= dy; break;
      case 'e':  w += dx; break;
      case 'se': w += dx; h += dy; break;
      case 's':  h += dy; break;
      case 'sw': x += dx; w -= dx; h += dy; break;
      case 'w':  x += dx; w -= dx; break;
    }
    return { x, y, w, h };
  }

  private _handleCropPointerUp() {
    if (this._cropDragging && this._cropRect) {
      this._cropRect = this._normalizeCropRect(this._cropRect);
      if (this._cropRect.w < 1 || this._cropRect.h < 1) {
        this._cropRect = null;
      }
    }
    this._cropDragging = false;
    this._cropHandle = null;
    this._cropDragOrigin = null;
    this._cropRectOrigin = null;
    if (this._cropRect) {
      this._cropRect = this._normalizeCropRect(this._cropRect);
      this._drawCropPreview();
    } else {
      this._clearCropPreview();
    }
  }

  private _normalizeCropRect(rect: CropRect): CropRect {
    let { x, y, w, h } = rect;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = Math.min(w, this._docWidth - x);
    h = Math.min(h, this._docHeight - y);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  private _drawCropPreview() {
    if (!this.previewCanvas || !this._cropRect) return;
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);
    previewCtx.save();
    previewCtx.translate(this._panX, this._panY);
    previewCtx.scale(this._zoom, this._zoom);
    drawCropOverlay(previewCtx, this._cropRect, this._docWidth, this._docHeight, this._zoom);
    previewCtx.restore();
  }

  /** Commit the active crop: trim all layers, push history, dispatch dimension change. */
  public commitCrop() {
    if (!this._cropRect) return;
    const rect = this._cropRect;
    const state = this._ctx.value?.state;
    if (!state) return;

    // Snapshot before-state
    const beforeWidth = this._docWidth;
    const beforeHeight = this._docHeight;
    const beforeLayers: LayerSnapshot[] = state.layers.map(l => {
      const ctx = l.canvas.getContext('2d')!;
      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
        imageData: ctx.getImageData(0, 0, l.canvas.width, l.canvas.height),
      };
    });

    // Crop each layer's canvas
    for (const layer of state.layers) {
      const ctx = layer.canvas.getContext('2d')!;
      const cropped = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      const newCanvas = document.createElement('canvas');
      newCanvas.width = rect.w;
      newCanvas.height = rect.h;
      newCanvas.getContext('2d')!.putImageData(cropped, 0, 0);
      layer.canvas = newCanvas;
    }

    // Snapshot after-state BEFORE dispatching event (avoids coupling with drawing-app state updates)
    const afterLayers: LayerSnapshot[] = state.layers.map(l => {
      const ctx = l.canvas.getContext('2d')!;
      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
        imageData: ctx.getImageData(0, 0, l.canvas.width, l.canvas.height),
      };
    });

    // Dispatch dimension change to drawing-app (also triggers layers array refresh)
    this.dispatchEvent(new CustomEvent('crop-commit', {
      bubbles: true, composed: true,
      detail: { width: rect.w, height: rect.h },
    }));

    // Push crop history entry
    this._pushHistoryEntry({
      type: 'crop',
      beforeLayers,
      afterLayers,
      beforeWidth,
      beforeHeight,
      afterWidth: rect.w,
      afterHeight: rect.h,
    });

    // Clear crop state and recomposite
    this._cropRect = null;
    this._clearCropPreview();
    this.composite();
  }

  /** Cancel the active crop, clearing the overlay. */
  public cancelCrop() {
    if (!this._cropRect) return;
    this._cropRect = null;
    this._cropDragging = false;
    this._cropHandle = null;
    this._cropDragOrigin = null;
    this._cropRectOrigin = null;
    this._clearCropPreview();
  }

  /** Whether a crop rect is currently active (used by drawing-app for keyboard dispatch). */
  public get hasCropRect(): boolean {
    return this._cropRect !== null;
  }

  private _clearCropPreview() {
    if (this.previewCanvas) {
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    }
  }

  // --- Float lifecycle methods ---

  private _liftToFloat(x: number, y: number, w: number, h: number) {
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    const clampedX = Math.max(0, Math.min(this._docWidth, x));
    const clampedY = Math.max(0, Math.min(this._docHeight, y));
    const clampedW = Math.max(0, Math.min(w, this._docWidth - clampedX));
    const clampedH = Math.max(0, Math.min(h, this._docHeight - clampedY));
    if (clampedW < 1 || clampedH < 1) return;

    this._captureBeforeDraw();
    const imageData = layerCtx.getImageData(clampedX, clampedY, clampedW, clampedH);
    layerCtx.clearRect(clampedX, clampedY, clampedW, clampedH);

    const src = document.createElement('canvas');
    src.width = clampedW;
    src.height = clampedH;
    src.getContext('2d')!.putImageData(imageData, 0, 0);
    this._floatSrcCanvas = src;

    const tmp = document.createElement('canvas');
    tmp.width = clampedW;
    tmp.height = clampedH;
    tmp.getContext('2d')!.drawImage(src, 0, 0);

    this._float = {
      originalImageData: imageData,
      currentRect: { x: clampedX, y: clampedY, w: clampedW, h: clampedH },
      tempCanvas: tmp,
    };
    this.composite();
    this._startSelectionAnimation();
  }

  private _createFloatFromImage(img: HTMLImageElement, centerX: number, centerY: number, size: number) {
    const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
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

  private _commitFloat() {
    if (!this._float) return;
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;

    if (!this._beforeDrawData) {
      this._captureBeforeDraw();
    }

    const { currentRect, tempCanvas } = this._float;
    layerCtx.drawImage(tempCanvas, Math.round(currentRect.x), Math.round(currentRect.y));

    this._pushDrawHistory(true);
    this.composite();
    this._clearFloatState();
  }

  /** Discard the active float by restoring the layer from _beforeDrawData
   *  without pushing a history entry. Used by undo/redo to avoid truncating
   *  the redo stack. */
  private _discardFloat() {
    if (!this._float) return;
    if (this._beforeDrawData) {
      const ctx = this._getActiveLayerCtx();
      if (ctx) {
        ctx.putImageData(this._beforeDrawData, 0, 0);
      }
      this._beforeDrawData = null;
    }
    this._clearFloatState();
    this.composite();
    this._notifyHistory();
  }

  private _clearFloatState() {
    this._float = null;
    this._floatSrcCanvas = null;
    this._floatIsExternalImage = false;
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
    const wFlipped = newW < 0;
    const hFlipped = newH < 0;
    if (newW < 0) { newX += newW; newW = -newW; }
    if (newH < 0) { newY += newH; newH = -newH; }

    // For corner handles, clamp to minSize while preserving aspect ratio
    if (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw') {
      const aspect = orig.w / orig.h;
      if (newW < minSize) {
        newW = minSize;
        newH = newW / aspect;
      }
      if (newH < minSize) {
        newH = minSize;
        newW = newH * aspect;
      }
    } else {
      if (newW < minSize) { newW = minSize; }
      if (newH < minSize) { newH = minSize; }
    }

    // Re-anchor after minSize clamp: handles that move the left/top edge
    // must keep the opposite (right/bottom) edge fixed. Flipped handles
    // already have their anchor set correctly by the flip logic above.
    if (!wFlipped && (handle === 'nw' || handle === 'w' || handle === 'sw')) {
      newX = orig.x + orig.w - newW;
    }
    if (!hFlipped && (handle === 'nw' || handle === 'n' || handle === 'ne')) {
      newY = orig.y + orig.h - newH;
    }

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

    // Look up owning layer's compositing state.
    const state = this._ctx.value?.state;
    const activeLayer = state?.layers.find(l => l.id === state.activeLayerId);

    previewCtx.save();
    previewCtx.translate(this._panX, this._panY);
    previewCtx.scale(this._zoom, this._zoom);

    // Only draw the float image if the owning layer is visible; apply its opacity.
    if (!activeLayer || activeLayer.visible) {
      previewCtx.globalAlpha = activeLayer?.opacity ?? 1.0;
      previewCtx.drawImage(tempCanvas, currentRect.x, currentRect.y, currentRect.w, currentRect.h);
      previewCtx.globalAlpha = 1.0;
    }

    // Always draw marching ants + handles so the user can interact with the float bounds.
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
    // Float was just created — undo button should reflect this
    this._notifyHistory();
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
    // Only capture if _beforeDrawData isn't already owned by an in-progress
    // brush stroke — overwriting it would corrupt that stroke's undo entry.
    if (!this._beforeDrawData) {
      this._captureBeforeDraw();
    }

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

    // Clamp origin so the pasted content is at least partially inside the
    // document (the clipboard may have been copied before a document resize).
    const x = Math.max(0, Math.min(this._clipboardOrigin.x, this._docWidth - 1));
    const y = Math.max(0, Math.min(this._clipboardOrigin.y, this._docHeight - 1));

    this._float = {
      originalImageData: new ImageData(
        new Uint8ClampedArray(this._clipboard.data),
        w, h,
      ),
      currentRect: { x, y, w, h },
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
    // Cancel any pending crop rect
    if (this._cropRect) {
      this.cancelCrop();
    }

    // Finalize any in-progress brush/shape stroke so _drawing doesn't
    // leak into the next tool and cause stale history entries.
    if (this._drawing) {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory();
      // Clear the preview canvas — shape tools draw live previews there
      // that would otherwise persist as ghost outlines.
      if (this.previewCanvas) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      }
      this.composite();
    }
    if (this._moveTempCanvas) {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory();
      this.composite();
    }
    this._commitFloat();
  }

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

    // Roll back the add-layer entry and any subsequent entries that target
    // this layer (rename, visibility, opacity, etc.), so canceling leaves
    // the undo stack clean as if the paste never happened.
    if (this._historyIndex >= 0) {
      let addLayerIdx = -1;
      for (let i = this._historyIndex; i >= 0; i--) {
        const entry = this._history[i];
        if (entry.type === 'add-layer' && entry.layer.id === layerId) {
          addLayerIdx = i;
          break;
        }
      }
      if (addLayerIdx >= 0) {
        const before = this._history.slice(0, addLayerIdx);
        const inspected = this._history.slice(addLayerIdx, this._historyIndex + 1);
        const kept = inspected.filter(entry => {
          const entryLayerId = this._getEntryLayerId(entry);
          return entryLayerId !== null && entryLayerId !== layerId;
        });
        this._history = [...before, ...kept];
        this._historyIndex = this._history.length - 1;
        this._historyVersion++;
      }
    }

    // Remove the layer without pushing a delete-layer history entry.
    this.dispatchEvent(new CustomEvent('layer-undo', {
      bubbles: true, composed: true,
      detail: { action: 'remove-layer', layerId },
    }));
    this.composite();
    this._notifyHistory();
  }

  /** Whether the internal clipboard has data (used by drawing-app to decide paste path) */
  public get hasClipboardData(): boolean {
    return this._clipboard !== null;
  }

  /** Whether an external image float is active (used by drawing-app for Escape handling) */
  public get hasExternalFloat(): boolean {
    return this._floatIsExternalImage && this._float !== null;
  }

  /** Returns active float info for persistence, or null if no float. */
  public getFloatSnapshot(): { layerId: string; tempCanvas: HTMLCanvasElement; x: number; y: number } | null {
    if (!this._float) return null;
    const layerId = this._ctx.value?.state.activeLayerId;
    if (!layerId) return null;
    const { currentRect, tempCanvas } = this._float;
    return { layerId, tempCanvas, x: Math.round(currentRect.x), y: Math.round(currentRect.y) };
  }

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

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('wheel', this._onWheel, { passive: false });
    this.addEventListener('dragover', this._onDragOver);
    this.addEventListener('dragenter', this._onDragEnter);
    this.addEventListener('dragleave', this._onDragLeave);
    this.addEventListener('drop', this._onDrop);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._stopSelectionAnimation();
    this.removeEventListener('wheel', this._onWheel);
    this.removeEventListener('dragover', this._onDragOver);
    this.removeEventListener('dragenter', this._onDragEnter);
    this.removeEventListener('dragleave', this._onDragLeave);
    this.removeEventListener('drop', this._onDrop);
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
      <resize-dialog></resize-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-canvas': DrawingCanvas;
  }
}

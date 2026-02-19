import { LitElement, html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Point, HistoryEntry, Layer } from '../types.js';
import { drawPencilSegment } from '../tools/pencil.js';
import { drawMarkerSegment } from '../tools/marker.js';
import { drawEraserSegment } from '../tools/eraser.js';
import { drawShapePreview } from '../tools/shapes.js';
import { floodFill } from '../tools/fill.js';
import { drawStamp } from '../tools/stamp.js';
import { drawSelectionRect } from '../tools/select.js';

@customElement('drawing-canvas')
export class DrawingCanvas extends LitElement {
  static override styles = css`
    :host {
      display: block;
      flex: 1;
      overflow: hidden;
      position: relative;
      background: #e8e8e8;
      background-image:
        linear-gradient(45deg, #ddd 25%, transparent 25%),
        linear-gradient(-45deg, #ddd 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #ddd 75%),
        linear-gradient(-45deg, transparent 75%, #ddd 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    }

    canvas {
      display: block;
      cursor: crosshair;
      touch-action: none;
    }

    #main {
      background: transparent;
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
  private _width = 800;
  private _height = 600;

  // Selection state
  private _selection: { x: number; y: number; w: number; h: number } | null = null;
  private _selectionImageData: ImageData | null = null;
  private _clipboard: ImageData | null = null;
  private _clipboardOrigin: Point | null = null;
  private _selectionMoving = false;
  private _selectionOffset: Point | null = null;
  private _selectionDashOffset = 0;
  private _selectionAnimFrame: number | null = null;
  private _selectionDrawing = false;

  // --- Public dimension accessors ---
  public getWidth() { return this._width; }
  public getHeight() { return this._height; }

  // --- Layer-aware helpers ---

  private _getActiveLayerCtx(): CanvasRenderingContext2D | null {
    const state = this._ctx.value?.state;
    if (!state) return null;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    return layer?.canvas.getContext('2d') ?? null;
  }

  public composite() {
    const displayCtx = this.mainCanvas.getContext('2d')!;
    displayCtx.clearRect(0, 0, this._width, this._height);
    // Draw checkerboard
    const pattern = this._getCheckerboardPattern(displayCtx);
    displayCtx.fillStyle = pattern;
    displayCtx.fillRect(0, 0, this._width, this._height);
    // Composite layers bottom-to-top
    const layers = this._ctx.value?.state.layers ?? [];
    for (const layer of layers) {
      if (!layer.visible) continue;
      displayCtx.globalAlpha = layer.opacity;
      displayCtx.drawImage(layer.canvas, 0, 0);
      displayCtx.globalAlpha = 1.0;
    }
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
  }

  override firstUpdated() {
    this._resizeToFit();
    this._resizeObserver = new ResizeObserver(() => this._resizeToFit());
    this._resizeObserver.observe(this);
    if (!this._skipInitialFill) {
      // Initialize first layer with white background
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        layerCtx.fillStyle = '#ffffff';
        layerCtx.fillRect(0, 0, this._width, this._height);
      }
    }
    this.composite();
  }

  private _resizeToFit() {
    this._commitSelection();
    const rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const newWidth = Math.floor(rect.width);
    const newHeight = Math.floor(rect.height);
    if (this.mainCanvas.width === newWidth && this.mainCanvas.height === newHeight) return;

    // Save each layer's content
    const layers = this._ctx.value?.state.layers ?? [];
    const savedLayerData: Map<string, ImageData> = new Map();
    for (const layer of layers) {
      if (layer.canvas.width > 0 && layer.canvas.height > 0) {
        const ctx = layer.canvas.getContext('2d')!;
        savedLayerData.set(layer.id, ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height));
      }
    }

    this._width = newWidth;
    this._height = newHeight;
    this.mainCanvas.width = newWidth;
    this.mainCanvas.height = newHeight;
    this.previewCanvas.width = newWidth;
    this.previewCanvas.height = newHeight;

    // Resize and restore each layer
    for (const layer of layers) {
      layer.canvas.width = newWidth;
      layer.canvas.height = newHeight;
      const saved = savedLayerData.get(layer.id);
      if (saved) {
        layer.canvas.getContext('2d')!.putImageData(saved, 0, 0);
      }
    }

    this.composite();
  }

  // --- History ---
  private _history: HistoryEntry[] = [];
  private _historyIndex = -1;
  private _maxHistory = 50;

  // --- Public history access for persistence ---
  public getHistory(): HistoryEntry[] { return this._history; }
  public getHistoryIndex(): number { return this._historyIndex; }
  public setHistory(entries: HistoryEntry[], index: number) {
    this._history = entries;
    this._historyIndex = index;
    this._notifyHistory();
  }

  private _skipInitialFill = false;
  public setSkipInitialFill() { this._skipInitialFill = true; }

  private _beforeDrawData: ImageData | null = null;

  /** Call before a drawing operation starts (pointerdown) */
  private _captureBeforeDraw() {
    const ctx = this._getActiveLayerCtx();
    if (!ctx) return;
    this._beforeDrawData = ctx.getImageData(0, 0, this._width, this._height);
  }

  /** Call after a drawing operation completes (pointerup) */
  private _pushDrawHistory() {
    const state = this._ctx.value?.state;
    const ctx = this._getActiveLayerCtx();
    if (!ctx || !state || !this._beforeDrawData) return;
    const after = ctx.getImageData(0, 0, this._width, this._height);
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
    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
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
    this._clearSelectionState();
    const entry = this._history[this._historyIndex];
    this._historyIndex--;
    this._applyUndo(entry);
    this.composite();
    this._notifyHistory();
  }

  public redo() {
    if (this._historyIndex >= this._history.length - 1) return;
    this._clearSelectionState();
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
      ctx.clearRect(0, 0, this._width, this._height);
    }
    this._pushDrawHistory();
    this.composite();
  }

  public saveCanvas() {
    // Composite onto a temp canvas without checkerboard for clean export
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this._width;
    exportCanvas.height = this._height;
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

  // --- Pointer events ---
  private _getPoint(e: PointerEvent): Point {
    const rect = this.mainCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private _onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !this._ctx.value) return;
    this.mainCanvas.setPointerCapture(e.pointerId);
    const p = this._getPoint(e);
    const { activeTool } = this.ctx.state;

    if (activeTool === 'select') {
      this._handleSelectPointerDown(p);
      return;
    }

    if (activeTool === 'fill') {
      this._captureBeforeDraw();
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        floodFill(layerCtx, p.x, p.y, this.ctx.state.strokeColor);
      }
      this._pushDrawHistory();
      this.composite();
      return;
    }

    if (activeTool === 'stamp') {
      if (this.ctx.state.stampImage) {
        this._captureBeforeDraw();
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          drawStamp(layerCtx, this.ctx.state.stampImage, p, this.ctx.state.brushSize * 10);
        }
        this._pushDrawHistory();
        this.composite();
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
    const { activeTool } = this.ctx.state;

    if (activeTool === 'select') {
      this._handleSelectPointerMove(e);
      return;
    }

    if (!this._drawing || !this._lastPoint) return;
    const p = this._getPoint(e);

    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
      this._drawBrushAt(this._lastPoint, p);
      this._lastPoint = p;
    } else if (
      activeTool === 'rectangle' ||
      activeTool === 'circle' ||
      activeTool === 'line' ||
      activeTool === 'triangle'
    ) {
      // Preview on overlay
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._width, this._height);
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
    }
  }

  private _onPointerUp(e: PointerEvent) {
    if (!this._ctx.value) return;
    const { activeTool } = this.ctx.state;

    if (activeTool === 'select') {
      this._handleSelectPointerUp(e);
      return;
    }

    if (!this._drawing) return;
    const p = this._getPoint(e);

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
      previewCtx.clearRect(0, 0, this._width, this._height);
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

  // --- Selection helpers ---

  private _isInsideSelection(p: Point): boolean {
    if (!this._selection) return false;
    const { x, y, w, h } = this._selection;
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
  }

  private _handleSelectPointerDown(p: Point) {
    if (this._selection && this._isInsideSelection(p)) {
      // Start moving existing selection
      this._selectionMoving = true;
      this._selectionOffset = {
        x: p.x - this._selection.x,
        y: p.y - this._selection.y,
      };
      if (!this._selectionImageData) {
        this._liftSelection();
      }
      this._stopSelectionAnimation();
    } else {
      // Commit any existing selection, start drawing new one
      this._commitSelection();
      this._selectionDrawing = true;
      this._startPoint = p;
    }
  }

  private _handleSelectPointerMove(e: PointerEvent) {
    const p = this._getPoint(e);

    // Update cursor
    if (this._selectionMoving || this._isInsideSelection(p)) {
      this.mainCanvas.style.cursor = 'move';
    } else {
      this.mainCanvas.style.cursor = 'crosshair';
    }

    if (this._selectionMoving && this._selection && this._selectionOffset) {
      this._selection = {
        ...this._selection,
        x: p.x - this._selectionOffset.x,
        y: p.y - this._selectionOffset.y,
      };
      this._redrawSelectionPreview();
    } else if (this._selectionDrawing && this._startPoint) {
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._width, this._height);
      const x = Math.min(this._startPoint.x, p.x);
      const y = Math.min(this._startPoint.y, p.y);
      const w = Math.abs(p.x - this._startPoint.x);
      const h = Math.abs(p.y - this._startPoint.y);
      drawSelectionRect(previewCtx, x, y, w, h, 0);
    }
  }

  private _handleSelectPointerUp(e: PointerEvent) {
    const p = this._getPoint(e);

    if (this._selectionMoving) {
      this._dropSelection();
      this._pushDrawHistory();
      this.composite();
      this._selectionMoving = false;
      this._selectionOffset = null;
      this._startSelectionAnimation();
    } else if (this._selectionDrawing && this._startPoint) {
      this._selectionDrawing = false;
      const x = Math.min(this._startPoint.x, p.x);
      const y = Math.min(this._startPoint.y, p.y);
      const w = Math.abs(p.x - this._startPoint.x);
      const h = Math.abs(p.y - this._startPoint.y);
      this._startPoint = null;

      if (w < 2 || h < 2) {
        // Too small, clear preview
        const previewCtx = this.previewCanvas.getContext('2d')!;
        previewCtx.clearRect(0, 0, this._width, this._height);
        return;
      }

      this._selection = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      this._startSelectionAnimation();
    }
  }

  private _liftSelection() {
    if (!this._selection) return;
    const { x, y, w, h } = this._selection;
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    this._captureBeforeDraw();
    this._selectionImageData = layerCtx.getImageData(x, y, w, h);
    // Clear the area on the active layer (transparent)
    layerCtx.clearRect(x, y, w, h);
    this.composite();
  }

  private _dropSelection() {
    if (!this._selection || !this._selectionImageData) return;
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    layerCtx.putImageData(this._selectionImageData, this._selection.x, this._selection.y);
    this._selectionImageData = null;
    this.composite();
  }

  private _commitSelection() {
    if (!this._selection || !this.mainCanvas) return;
    if (this._selectionImageData) {
      this._dropSelection();
    }
    this._clearSelectionState();
  }

  private _clearSelectionState() {
    this._selection = null;
    this._selectionImageData = null;
    this._selectionMoving = false;
    this._selectionOffset = null;
    this._selectionDrawing = false;
    this._stopSelectionAnimation();
    if (this.previewCanvas) {
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._width, this._height);
    }
  }

  private _redrawSelectionPreview() {
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._width, this._height);
    if (this._selectionImageData && this._selection) {
      previewCtx.putImageData(this._selectionImageData, this._selection.x, this._selection.y);
    }
    if (this._selection) {
      drawSelectionRect(
        previewCtx,
        this._selection.x,
        this._selection.y,
        this._selection.w,
        this._selection.h,
        this._selectionDashOffset,
      );
    }
  }

  private _startSelectionAnimation() {
    this._stopSelectionAnimation();
    const animate = () => {
      this._selectionDashOffset = (this._selectionDashOffset + 0.5) % 12;
      this._redrawSelectionPreview();
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
    if (!this._selection) return;
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    // If content is currently lifted, copy from the lifted data
    if (this._selectionImageData) {
      this._clipboard = new ImageData(
        new Uint8ClampedArray(this._selectionImageData.data),
        this._selectionImageData.width,
        this._selectionImageData.height,
      );
    } else {
      const { x, y, w, h } = this._selection;
      this._clipboard = layerCtx.getImageData(x, y, w, h);
    }
    this._clipboardOrigin = { x: this._selection.x, y: this._selection.y };
  }

  public cutSelection() {
    if (!this._selection) return;
    this.copySelection();
    this.deleteSelection();
  }

  public pasteSelection() {
    if (!this._clipboard || !this._clipboardOrigin) return;
    this._commitSelection();
    this._captureBeforeDraw();
    const layerCtx = this._getActiveLayerCtx();
    if (!layerCtx) return;
    layerCtx.putImageData(this._clipboard, this._clipboardOrigin.x, this._clipboardOrigin.y);
    this._selection = {
      x: this._clipboardOrigin.x,
      y: this._clipboardOrigin.y,
      w: this._clipboard.width,
      h: this._clipboard.height,
    };
    this._pushDrawHistory();
    this.composite();
    this._startSelectionAnimation();
  }

  public deleteSelection() {
    if (!this._selection) return;
    const { x, y, w, h } = this._selection;
    // If content was lifted, just discard it
    this._selectionImageData = null;
    // Clear the area on the active layer (transparent)
    this._captureBeforeDraw();
    const layerCtx = this._getActiveLayerCtx();
    if (layerCtx) {
      layerCtx.clearRect(x, y, w, h);
    }
    this._pushDrawHistory();
    this.composite();
    this._clearSelectionState();
  }

  public clearSelection() {
    this._commitSelection();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._stopSelectionAnimation();
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

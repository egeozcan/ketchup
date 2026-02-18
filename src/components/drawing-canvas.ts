import { LitElement, html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Point } from '../types.js';
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
      background: white;
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

  override firstUpdated() {
    this._resizeToFit();
    const ro = new ResizeObserver(() => this._resizeToFit());
    ro.observe(this);
    // Initialize with white background
    const c = this.mainCanvas.getContext('2d')!;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, this._width, this._height);
    this._pushHistory();
  }

  private _resizeToFit() {
    this._commitSelection();
    const rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const newWidth = Math.floor(rect.width);
    const newHeight = Math.floor(rect.height);
    if (this.mainCanvas.width === newWidth && this.mainCanvas.height === newHeight) return;

    // Save current content
    const mainCtx = this.mainCanvas.getContext('2d')!;
    let savedData: ImageData | null = null;
    if (this.mainCanvas.width > 0 && this.mainCanvas.height > 0) {
      savedData = mainCtx.getImageData(0, 0, this.mainCanvas.width, this.mainCanvas.height);
    }

    this._width = newWidth;
    this._height = newHeight;
    this.mainCanvas.width = newWidth;
    this.mainCanvas.height = newHeight;
    this.previewCanvas.width = newWidth;
    this.previewCanvas.height = newHeight;

    // Restore content
    if (savedData) {
      mainCtx.fillStyle = '#ffffff';
      mainCtx.fillRect(0, 0, newWidth, newHeight);
      mainCtx.putImageData(savedData, 0, 0);
    }
  }

  // --- History ---
  private _history: ImageData[] = [];
  private _historyIndex = -1;
  private _maxHistory = 50;

  private _pushHistory() {
    const c = this.mainCanvas.getContext('2d')!;
    const data = c.getImageData(0, 0, this._width, this._height);
    // Discard redo stack
    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(data);
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
          canUndo: this._historyIndex > 0,
          canRedo: this._historyIndex < this._history.length - 1,
        },
      }),
    );
  }

  public undo() {
    if (this._historyIndex > 0) {
      this._clearSelectionState();
      this._historyIndex--;
      const c = this.mainCanvas.getContext('2d')!;
      c.putImageData(this._history[this._historyIndex], 0, 0);
      this._notifyHistory();
    }
  }

  public redo() {
    if (this._historyIndex < this._history.length - 1) {
      this._clearSelectionState();
      this._historyIndex++;
      const c = this.mainCanvas.getContext('2d')!;
      c.putImageData(this._history[this._historyIndex], 0, 0);
      this._notifyHistory();
    }
  }

  public clearCanvas() {
    const c = this.mainCanvas.getContext('2d')!;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, this._width, this._height);
    this._pushHistory();
  }

  public saveCanvas() {
    const link = document.createElement('a');
    link.download = 'drawing.png';
    link.href = this.mainCanvas.toDataURL('image/png');
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
      const mainCtx = this.mainCanvas.getContext('2d')!;
      floodFill(mainCtx, p.x, p.y, this.ctx.state.strokeColor);
      this._pushHistory();
      return;
    }

    if (activeTool === 'stamp') {
      if (this.ctx.state.stampImage) {
        const mainCtx = this.mainCanvas.getContext('2d')!;
        drawStamp(mainCtx, this.ctx.state.stampImage, p, this.ctx.state.brushSize * 10);
        this._pushHistory();
      }
      return;
    }

    this._drawing = true;
    this._lastPoint = p;
    this._startPoint = p;

    // For brushes, draw a dot at start
    if (activeTool === 'pencil' || activeTool === 'marker' || activeTool === 'eraser') {
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
      // Commit shape to main canvas
      const mainCtx = this.mainCanvas.getContext('2d')!;
      drawShapePreview(
        mainCtx,
        activeTool,
        this._startPoint!,
        p,
        this.ctx.state.strokeColor,
        this.ctx.state.fillColor,
        this.ctx.state.useFill,
        this.ctx.state.brushSize,
      );
      // Clear preview
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._width, this._height);
    }

    this._drawing = false;
    this._lastPoint = null;
    this._startPoint = null;
    this._pushHistory();
  }

  private _drawBrushAt(from: Point, to: Point) {
    const mainCtx = this.mainCanvas.getContext('2d')!;
    const { activeTool, strokeColor, brushSize } = this.ctx.state;

    switch (activeTool) {
      case 'pencil':
        drawPencilSegment(mainCtx, from, to, strokeColor, brushSize);
        break;
      case 'marker':
        drawMarkerSegment(mainCtx, from, to, strokeColor, brushSize);
        break;
      case 'eraser':
        drawEraserSegment(mainCtx, from, to, brushSize);
        break;
    }
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
      this._pushHistory();
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
    const mainCtx = this.mainCanvas.getContext('2d')!;
    this._selectionImageData = mainCtx.getImageData(x, y, w, h);
    // Fill the area with white on the main canvas
    mainCtx.fillStyle = '#ffffff';
    mainCtx.fillRect(x, y, w, h);
  }

  private _dropSelection() {
    if (!this._selection || !this._selectionImageData) return;
    const mainCtx = this.mainCanvas.getContext('2d')!;
    mainCtx.putImageData(this._selectionImageData, this._selection.x, this._selection.y);
    this._selectionImageData = null;
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
    const mainCtx = this.mainCanvas.getContext('2d')!;
    // If content is currently lifted, copy from the lifted data
    if (this._selectionImageData) {
      this._clipboard = new ImageData(
        new Uint8ClampedArray(this._selectionImageData.data),
        this._selectionImageData.width,
        this._selectionImageData.height,
      );
    } else {
      const { x, y, w, h } = this._selection;
      this._clipboard = mainCtx.getImageData(x, y, w, h);
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
    const mainCtx = this.mainCanvas.getContext('2d')!;
    mainCtx.putImageData(this._clipboard, this._clipboardOrigin.x, this._clipboardOrigin.y);
    this._selection = {
      x: this._clipboardOrigin.x,
      y: this._clipboardOrigin.y,
      w: this._clipboard.width,
      h: this._clipboard.height,
    };
    this._pushHistory();
    this._startSelectionAnimation();
  }

  public deleteSelection() {
    if (!this._selection) return;
    const { x, y, w, h } = this._selection;
    // If content was lifted, just discard it
    this._selectionImageData = null;
    // Fill the area white on the main canvas
    const mainCtx = this.mainCanvas.getContext('2d')!;
    mainCtx.fillStyle = '#ffffff';
    mainCtx.fillRect(x, y, w, h);
    this._pushHistory();
    this._clearSelectionState();
  }

  public clearSelection() {
    this._commitSelection();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
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

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
      background: white;
      cursor: crosshair;
      touch-action: none;
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
      this._historyIndex--;
      const c = this.mainCanvas.getContext('2d')!;
      c.putImageData(this._history[this._historyIndex], 0, 0);
      this._notifyHistory();
    }
  }

  public redo() {
    if (this._historyIndex < this._history.length - 1) {
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
    if (!this._drawing || !this._lastPoint || !this._ctx.value) return;
    const p = this._getPoint(e);
    const { activeTool } = this.ctx.state;

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
    if (!this._drawing || !this._ctx.value) return;
    const p = this._getPoint(e);
    const { activeTool } = this.ctx.state;

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

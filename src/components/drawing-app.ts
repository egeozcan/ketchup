import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { DrawingState, ToolType } from '../types.js';
import type { DrawingCanvas } from './drawing-canvas.js';
import './app-toolbar.js';
import './tool-settings.js';
import './drawing-canvas.js';

@customElement('drawing-app')
export class DrawingApp extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: #1e1e1e;
      font-family: system-ui, -apple-system, sans-serif;
    }

    .main-area {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    drawing-canvas {
      flex: 1;
    }
  `;

  @state()
  private _state: DrawingState = {
    activeTool: 'pencil',
    strokeColor: '#000000',
    fillColor: '#ff0000',
    useFill: false,
    brushSize: 4,
    stampImage: null,
  };

  @state() private _canUndo = false;
  @state() private _canRedo = false;

  @query('drawing-canvas') canvas!: DrawingCanvas;

  private _provider = new ContextProvider(this, {
    context: drawingContext,
    initialValue: this._buildContextValue(),
  });

  private _buildContextValue(): DrawingContextValue {
    return {
      state: this._state,
      setTool: (tool: ToolType) => {
        this._state = { ...this._state, activeTool: tool };
      },
      setStrokeColor: (color: string) => {
        this._state = { ...this._state, strokeColor: color };
      },
      setFillColor: (color: string) => {
        this._state = { ...this._state, fillColor: color };
      },
      setUseFill: (useFill: boolean) => {
        this._state = { ...this._state, useFill };
      },
      setBrushSize: (size: number) => {
        this._state = { ...this._state, brushSize: size };
      },
      setStampImage: (img: HTMLImageElement | null) => {
        this._state = { ...this._state, stampImage: img };
      },
      undo: () => this.canvas?.undo(),
      redo: () => this.canvas?.redo(),
      clearCanvas: () => this.canvas?.clearCanvas(),
      saveCanvas: () => this.canvas?.saveCanvas(),
      canUndo: this._canUndo,
      canRedo: this._canRedo,
    };
  }

  override willUpdate() {
    this._provider.setValue(this._buildContextValue());
  }

  private _onHistoryChange(e: CustomEvent) {
    this._canUndo = e.detail.canUndo;
    this._canRedo = e.detail.canRedo;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('keydown', this._onKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this._onKeyDown);
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.canvas?.undo();
    } else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.canvas?.redo();
    }
  };

  override render() {
    return html`
      <tool-settings></tool-settings>
      <div class="main-area">
        <app-toolbar></app-toolbar>
        <drawing-canvas @history-change=${this._onHistoryChange}></drawing-canvas>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-app': DrawingApp;
  }
}

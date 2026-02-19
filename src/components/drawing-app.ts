import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { DrawingState, Layer, LayerSnapshot, ToolType } from '../types.js';
import type { DrawingCanvas } from './drawing-canvas.js';
import './app-toolbar.js';
import './tool-settings.js';
import './drawing-canvas.js';
import './layers-panel.js';

let _layerCounter = 0;

function createLayer(width: number, height: number): Layer {
  _layerCounter++;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    id: crypto.randomUUID(),
    name: `Layer ${_layerCounter}`,
    visible: true,
    opacity: 1.0,
    canvas,
  };
}

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

  private _initialLayer = createLayer(800, 600);

  @state()
  private _state: DrawingState = {
    activeTool: 'pencil',
    strokeColor: '#000000',
    fillColor: '#ff0000',
    useFill: false,
    brushSize: 4,
    stampImage: null,
    layers: [this._initialLayer],
    activeLayerId: this._initialLayer.id,
    layersPanelOpen: true,
  };

  @state() private _canUndo = false;
  @state() private _canRedo = false;

  @query('drawing-canvas') canvas!: DrawingCanvas;

  private _provider = new ContextProvider(this, {
    context: drawingContext,
    initialValue: this._buildContextValue(),
  });

  private _snapshotLayer(layer: Layer): LayerSnapshot {
    const ctx = layer.canvas.getContext('2d')!;
    return {
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      imageData: ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
    };
  }

  private _buildContextValue(): DrawingContextValue {
    return {
      state: this._state,
      setTool: (tool: ToolType) => {
        if (this._state.activeTool !== tool) {
          this.canvas?.clearSelection();
        }
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
      // Layer operations
      addLayer: () => {
        const layer = createLayer(this.canvas?.getWidth() ?? 800, this.canvas?.getHeight() ?? 600);
        const activeIdx = this._state.layers.findIndex(l => l.id === this._state.activeLayerId);
        const insertIdx = activeIdx + 1;
        const newLayers = [...this._state.layers];
        newLayers.splice(insertIdx, 0, layer);
        this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
        this.canvas?.pushLayerOperation({ type: 'add-layer', layer: this._snapshotLayer(layer), index: insertIdx });
      },
      deleteLayer: (id: string) => {
        if (this._state.layers.length <= 1) return;
        const idx = this._state.layers.findIndex(l => l.id === id);
        if (idx === -1) return;
        const layer = this._state.layers[idx];
        const snapshot = this._snapshotLayer(layer);
        const newLayers = this._state.layers.filter(l => l.id !== id);
        const newActiveId = this._state.activeLayerId === id
          ? newLayers[Math.min(idx, newLayers.length - 1)].id
          : this._state.activeLayerId;
        this._state = { ...this._state, layers: newLayers, activeLayerId: newActiveId };
        this.canvas?.pushLayerOperation({ type: 'delete-layer', layer: snapshot, index: idx });
      },
      setActiveLayer: (id: string) => {
        if (this._state.layers.some(l => l.id === id)) {
          this.canvas?.clearSelection();
          this._state = { ...this._state, activeLayerId: id };
        }
      },
      setLayerVisibility: (id: string, visible: boolean) => {
        const layer = this._state.layers.find(l => l.id === id);
        if (!layer || layer.visible === visible) return;
        const before = layer.visible;
        const newLayers = this._state.layers.map(l => l.id === id ? { ...l, visible } : l);
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'visibility', layerId: id, before, after: visible });
      },
      setLayerOpacity: (id: string, opacity: number) => {
        const layer = this._state.layers.find(l => l.id === id);
        if (!layer) return;
        const newLayers = this._state.layers.map(l => l.id === id ? { ...l, opacity } : l);
        this._state = { ...this._state, layers: newLayers };
      },
      reorderLayer: (id: string, newIndex: number) => {
        const oldIndex = this._state.layers.findIndex(l => l.id === id);
        if (oldIndex === -1 || oldIndex === newIndex) return;
        const newLayers = [...this._state.layers];
        const [layer] = newLayers.splice(oldIndex, 1);
        newLayers.splice(newIndex, 0, layer);
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'reorder', fromIndex: oldIndex, toIndex: newIndex });
      },
      renameLayer: (id: string, name: string) => {
        const layer = this._state.layers.find(l => l.id === id);
        if (!layer || layer.name === name) return;
        const before = layer.name;
        const newLayers = this._state.layers.map(l => l.id === id ? { ...l, name } : l);
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'rename', layerId: id, before, after: name });
      },
      toggleLayersPanel: () => {
        this._state = { ...this._state, layersPanelOpen: !this._state.layersPanelOpen };
      },
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

  private _onLayerUndo(e: CustomEvent) {
    const detail = e.detail;
    switch (detail.action) {
      case 'remove-layer': {
        const removedIdx = this._state.layers.findIndex(l => l.id === detail.layerId);
        const newLayers = this._state.layers.filter(l => l.id !== detail.layerId);
        if (newLayers.length === 0) return;
        const newActiveId = this._state.activeLayerId === detail.layerId
          ? newLayers[Math.min(removedIdx, newLayers.length - 1)].id
          : this._state.activeLayerId;
        this._state = { ...this._state, layers: newLayers, activeLayerId: newActiveId };
        break;
      }
      case 'restore-layer': {
        const snapshot = detail.snapshot as LayerSnapshot;
        const currentWidth = this.canvas?.getWidth() ?? 800;
        const currentHeight = this.canvas?.getHeight() ?? 600;
        const canvas = document.createElement('canvas');
        canvas.width = currentWidth;
        canvas.height = currentHeight;
        canvas.getContext('2d')!.putImageData(snapshot.imageData, 0, 0);
        const layer: Layer = {
          id: snapshot.id,
          name: snapshot.name,
          visible: snapshot.visible,
          opacity: snapshot.opacity,
          canvas,
        };
        const newLayers = [...this._state.layers];
        const idx = detail.index === -1 ? newLayers.length : detail.index;
        newLayers.splice(idx, 0, layer);
        this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
        break;
      }
      case 'reorder': {
        const newLayers = [...this._state.layers];
        const [moved] = newLayers.splice(detail.fromIndex, 1);
        newLayers.splice(detail.toIndex, 0, moved);
        this._state = { ...this._state, layers: newLayers };
        break;
      }
      case 'refresh': {
        // Force re-render by creating new layers array reference
        this._state = { ...this._state, layers: [...this._state.layers] };
        break;
      }
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('keydown', this._onKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this._onKeyDown);
  }

  private _onCommitOpacity(e: CustomEvent) {
    const { layerId, before, after } = e.detail;
    this.canvas?.pushLayerOperation({ type: 'opacity', layerId, before, after });
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.canvas?.undo();
    } else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.canvas?.redo();
    } else if (ctrl && e.key === 'c') {
      e.preventDefault();
      this.canvas?.copySelection();
    } else if (ctrl && e.key === 'x') {
      e.preventDefault();
      this.canvas?.cutSelection();
    } else if (ctrl && e.key === 'v') {
      e.preventDefault();
      this.canvas?.pasteSelection();
    } else if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      this._state.activeTool === 'select'
    ) {
      e.preventDefault();
      this.canvas?.deleteSelection();
    } else if (e.key === 'Escape') {
      this.canvas?.clearSelection();
    }
  };

  override render() {
    return html`
      <tool-settings></tool-settings>
      <div class="main-area">
        <app-toolbar></app-toolbar>
        <drawing-canvas
          @history-change=${this._onHistoryChange}
          @layer-undo=${this._onLayerUndo}
        ></drawing-canvas>
        <layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-app': DrawingApp;
  }
}

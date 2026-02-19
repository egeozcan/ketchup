import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { DrawingState, Layer, LayerSnapshot, ToolType, ProjectMeta } from '../types.js';
import type { DrawingCanvas } from './drawing-canvas.js';
import {
  listProjects,
  createProject as createProjectInDB,
  deleteProject as deleteProjectInDB,
  renameProject as renameProjectInDB,
  saveProjectState,
  loadProjectState,
  canvasToBlob,
  serializeLayerFromImageData,
  deserializeLayer,
} from '../project-store.js';
import './app-toolbar.js';
import './tool-settings.js';
import './drawing-canvas.js';
import './layers-panel.js';

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

  private _layerCounter = 0;

  private _createLayer(width: number, height: number): Layer {
    this._layerCounter++;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return {
      id: crypto.randomUUID(),
      name: `Layer ${this._layerCounter}`,
      visible: true,
      opacity: 1.0,
      canvas,
    };
  }

  @state() private _state!: DrawingState;
  @state() private _canUndo = false;
  @state() private _canRedo = false;
  @state() private _saving = false;
  @state() private _currentProject: ProjectMeta | null = null;
  @state() private _projectList: ProjectMeta[] = [];

  /** Sentinel value that never matches a real _historyVersion, forcing full history rewrite. */
  private static readonly FORCE_FULL_HISTORY_SAVE = -1;

  private _dirty = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _saveInProgress = false;
  private _lastSavedHistoryLength = 0;
  private _lastSavedHistoryVersion = 0;

  @query('drawing-canvas') canvas!: DrawingCanvas;

  private _provider!: ContextProvider<typeof drawingContext>;

  constructor() {
    super();
    const layer = this._createLayer(800, 600);
    this._state = {
      activeTool: 'pencil',
      strokeColor: '#000000',
      fillColor: '#ff0000',
      useFill: false,
      brushSize: 4,
      stampImage: null,
      layers: [layer],
      activeLayerId: layer.id,
      layersPanelOpen: true,
      documentWidth: 800,
      documentHeight: 600,
    };
    this._provider = new ContextProvider(this, {
      context: drawingContext,
      initialValue: this._buildContextValue(),
    });
  }

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

  private _onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this._dirty) {
      e.preventDefault();
    }
  };

  private _markDirty() {
    this._dirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  private async _save() {
    if (!this._currentProject || !this._dirty) return;
    if (this._saveInProgress) {
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._save(), 500);
      return;
    }
    this._saveInProgress = true;
    this._saving = true;
    try {
      // Synchronously snapshot all mutable data before any awaits
      const layerSnapshots = this._state.layers.map(l => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        imageData: l.canvas.getContext('2d')!.getImageData(0, 0, l.canvas.width, l.canvas.height),
      }));
      const historySnapshot = this.canvas?.getHistory() ?? [];
      const historyIndex = this.canvas?.getHistoryIndex() ?? -1;
      const historyVersion = this.canvas?.getHistoryVersion() ?? 0;

      // Determine incremental vs full history save
      const versionChanged = historyVersion !== this._lastSavedHistoryVersion;
      const clearExistingHistory = versionChanged;
      const entriesToSave = versionChanged
        ? historySnapshot
        : historySnapshot.slice(this._lastSavedHistoryLength);
      const startIndex = versionChanged ? 0 : this._lastSavedHistoryLength;

      // Async serialization from snapshots (not live canvas)
      const layers = await Promise.all(
        layerSnapshots.map(snap => serializeLayerFromImageData(snap, snap.imageData)),
      );

      const stateRecord = {
        projectId: this._currentProject.id,
        toolSettings: {
          activeTool: this._state.activeTool,
          strokeColor: this._state.strokeColor,
          fillColor: this._state.fillColor,
          useFill: this._state.useFill,
          brushSize: this._state.brushSize,
        },
        canvasWidth: this._state.documentWidth,
        canvasHeight: this._state.documentHeight,
        layers,
        activeLayerId: this._state.activeLayerId,
        layersPanelOpen: this._state.layersPanelOpen,
        historyIndex,
      };

      let thumbnail: Blob | null = null;
      if (this.canvas?.mainCanvas) {
        try { thumbnail = await canvasToBlob(this.canvas.mainCanvas); } catch { /* non-critical */ }
      }

      await saveProjectState(
        this._currentProject.id,
        stateRecord,
        entriesToSave,
        startIndex,
        clearExistingHistory,
        thumbnail,
      );

      this._dirty = false;
      this._lastSavedHistoryLength = historySnapshot.length;
      this._lastSavedHistoryVersion = historyVersion;
      this._projectList = await listProjects();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        console.error('Storage quota exceeded. Consider deleting old projects to free space.');
      } else {
        console.error('Save failed:', err);
      }
    } finally {
      this._saving = false;
      this._saveInProgress = false;
    }
  }

  private async _resetToFreshProject() {
    this._layerCounter = 0;
    const w = this._state.documentWidth;
    const h = this._state.documentHeight;
    const layer = this._createLayer(w, h);
    this._state = {
      activeTool: 'pencil',
      strokeColor: '#000000',
      fillColor: '#ff0000',
      useFill: false,
      brushSize: 4,
      stampImage: null,
      layers: [layer],
      activeLayerId: layer.id,
      layersPanelOpen: true,
      documentWidth: w,
      documentHeight: h,
    };
    await this.updateComplete;
    this.canvas?.setHistory([], -1);
    const ctx = layer.canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
    this.canvas?.composite();
    this._dirty = false;
    this._lastSavedHistoryLength = 0;
    this._lastSavedHistoryVersion = DrawingApp.FORCE_FULL_HISTORY_SAVE;
  }

  private async _loadProject(projectId: string) {
    try {
      const result = await loadProjectState(projectId);
      if (!result) {
        await this._resetToFreshProject();
        return;
      }
      const { state: record, history, historyIndex } = result;
      const layers: Layer[] = await Promise.all(
        record.layers.map(sl => deserializeLayer(sl, record.canvasWidth, record.canvasHeight)),
      );
      // Restore layer counter to max existing layer number
      const maxNum = layers.reduce((max, l) => {
        const match = l.name.match(/^Layer (\d+)$/);
        return match ? Math.max(max, parseInt(match[1])) : max;
      }, 0);
      this._layerCounter = maxNum;
      this._state = {
        activeTool: record.toolSettings.activeTool,
        strokeColor: record.toolSettings.strokeColor,
        fillColor: record.toolSettings.fillColor,
        useFill: record.toolSettings.useFill,
        brushSize: record.toolSettings.brushSize,
        stampImage: null,
        layers,
        activeLayerId: record.activeLayerId,
        layersPanelOpen: record.layersPanelOpen,
        documentWidth: record.canvasWidth,
        documentHeight: record.canvasHeight,
      };
      await this.updateComplete;
      this.canvas?.setHistory(history, historyIndex);
      this._dirty = false;
      this._lastSavedHistoryLength = history.length;
      this._lastSavedHistoryVersion = 0;
      this.canvas?.centerDocument();
      this.canvas?.composite();
    } catch (err) {
      console.error('Failed to load project:', err);
      await this._resetToFreshProject();
    }
  }

  override async firstUpdated() {
    this._projectList = await listProjects();
    if (this._projectList.length > 0) {
      this._currentProject = this._projectList[0];
      await this._loadProject(this._currentProject.id);
    } else {
      const meta = await createProjectInDB('Untitled');
      this._currentProject = meta;
      this._projectList = [meta];
      this._markDirty();
    }
  }

  private _buildContextValue(): DrawingContextValue {
    return {
      state: this._state,
      setTool: (tool: ToolType) => {
        if (this._state.activeTool !== tool) {
          this.canvas?.clearSelection();
        }
        this._state = { ...this._state, activeTool: tool };
        this._markDirty();
      },
      setStrokeColor: (color: string) => {
        this._state = { ...this._state, strokeColor: color };
        this._markDirty();
      },
      setFillColor: (color: string) => {
        this._state = { ...this._state, fillColor: color };
        this._markDirty();
      },
      setUseFill: (useFill: boolean) => {
        this._state = { ...this._state, useFill };
        this._markDirty();
      },
      setBrushSize: (size: number) => {
        this._state = { ...this._state, brushSize: size };
        this._markDirty();
      },
      setStampImage: (img: HTMLImageElement | null) => {
        this._state = { ...this._state, stampImage: img };
        this._markDirty();
      },
      undo: () => this.canvas?.undo(),
      redo: () => this.canvas?.redo(),
      clearCanvas: () => this.canvas?.clearCanvas(),
      saveCanvas: () => this.canvas?.saveCanvas(),
      // Layer operations
      addLayer: () => {
        const layer = this._createLayer(this._state.documentWidth, this._state.documentHeight);
        const activeIdx = this._state.layers.findIndex(l => l.id === this._state.activeLayerId);
        const insertIdx = activeIdx + 1;
        const newLayers = [...this._state.layers];
        newLayers.splice(insertIdx, 0, layer);
        this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
        this.canvas?.pushLayerOperation({ type: 'add-layer', layer: this._snapshotLayer(layer), index: insertIdx });
        this._markDirty();
      },
      deleteLayer: (id: string) => {
        if (this._state.layers.length <= 1) return;
        const idx = this._state.layers.findIndex(l => l.id === id);
        if (idx === -1) return;
        if (id === this._state.activeLayerId) {
          this.canvas?.clearSelection();
        }
        const layer = this._state.layers[idx];
        const snapshot = this._snapshotLayer(layer);
        const newLayers = this._state.layers.filter(l => l.id !== id);
        const newActiveId = this._state.activeLayerId === id
          ? newLayers[Math.min(idx, newLayers.length - 1)].id
          : this._state.activeLayerId;
        this._state = { ...this._state, layers: newLayers, activeLayerId: newActiveId };
        this.canvas?.pushLayerOperation({ type: 'delete-layer', layer: snapshot, index: idx });
        this._markDirty();
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
        this._markDirty();
      },
      // Called continuously during slider drag — no history entry here to avoid spam.
      // History is committed via the 'commit-opacity' event on pointerup. If the user
      // switches projects mid-drag, the opacity is persisted but won't have an undo entry.
      setLayerOpacity: (id: string, opacity: number) => {
        const layer = this._state.layers.find(l => l.id === id);
        if (!layer) return;
        const newLayers = this._state.layers.map(l => l.id === id ? { ...l, opacity } : l);
        this._state = { ...this._state, layers: newLayers };
        this._markDirty();
      },
      reorderLayer: (id: string, newIndex: number) => {
        const oldIndex = this._state.layers.findIndex(l => l.id === id);
        if (oldIndex === -1 || oldIndex === newIndex) return;
        const newLayers = [...this._state.layers];
        const [layer] = newLayers.splice(oldIndex, 1);
        newLayers.splice(newIndex, 0, layer);
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'reorder', fromIndex: oldIndex, toIndex: newIndex });
        this._markDirty();
      },
      renameLayer: (id: string, name: string) => {
        const layer = this._state.layers.find(l => l.id === id);
        if (!layer || layer.name === name) return;
        const before = layer.name;
        const newLayers = this._state.layers.map(l => l.id === id ? { ...l, name } : l);
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'rename', layerId: id, before, after: name });
        this._markDirty();
      },
      toggleLayersPanel: () => {
        this._state = { ...this._state, layersPanelOpen: !this._state.layersPanelOpen };
      },
      setDocumentSize: (width: number, height: number) => {
        if (width === this._state.documentWidth && height === this._state.documentHeight) return;
        this.canvas?.clearSelection();
        // Resize all layer canvases, preserving content
        for (const layer of this._state.layers) {
          const ctx = layer.canvas.getContext('2d')!;
          const imageData = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
          layer.canvas.width = width;
          layer.canvas.height = height;
          ctx.putImageData(imageData, 0, 0);
        }
        this._state = { ...this._state, documentWidth: width, documentHeight: height };
        // Clear history — old ImageData dimensions are incompatible
        this.canvas?.setHistory([], -1);
        this.canvas?.centerDocument();
        this.canvas?.composite();
        this._markDirty();
      },
      canUndo: this._canUndo,
      canRedo: this._canRedo,
      // Project operations
      currentProject: this._currentProject,
      projectList: this._projectList,
      saving: this._saving,
      switchProject: (id: string) => {
        if (id === this._currentProject?.id) return;
        const doSwitch = async () => {
          if (this._dirty) await this._save();
          const meta = this._projectList.find(p => p.id === id);
          if (!meta) return;
          this._currentProject = meta;
          await this._loadProject(id);
        };
        doSwitch().catch(err => console.error('Switch project failed:', err));
      },
      createProject: (name: string) => {
        const doCreate = async () => {
          if (this._dirty) await this._save();
          const meta = await createProjectInDB(name);
          this._currentProject = meta;
          this._projectList = await listProjects();
          await this._resetToFreshProject();
          this._markDirty();
        };
        doCreate().catch(err => console.error('Create project failed:', err));
      },
      deleteProject: (id: string) => {
        const doDelete = async () => {
          await deleteProjectInDB(id);
          this._projectList = await listProjects();
          if (id === this._currentProject?.id) {
            if (this._projectList.length > 0) {
              this._currentProject = this._projectList[0];
              await this._loadProject(this._currentProject.id);
            } else {
              const meta = await createProjectInDB('Untitled');
              this._currentProject = meta;
              this._projectList = [meta];
              await this._resetToFreshProject();
              this._markDirty();
            }
          }
        };
        doDelete().catch(err => console.error('Delete project failed:', err));
      },
      renameProject: (id: string, name: string) => {
        const doRename = async () => {
          await renameProjectInDB(id, name);
          if (this._currentProject?.id === id) {
            this._currentProject = { ...this._currentProject, name };
          }
          this._projectList = await listProjects();
        };
        doRename().catch(err => console.error('Rename project failed:', err));
      },
    };
  }

  override willUpdate() {
    this._provider.setValue(this._buildContextValue());
  }

  private _onHistoryChange(e: CustomEvent) {
    this._canUndo = e.detail.canUndo;
    this._canRedo = e.detail.canRedo;
    this._markDirty();
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
        const currentWidth = this._state.documentWidth;
        const currentHeight = this._state.documentHeight;
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
    this._markDirty();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('beforeunload', this._onBeforeUnload);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  private _onCommitOpacity(e: CustomEvent) {
    const { layerId, before, after } = e.detail;
    this.canvas?.pushLayerOperation({ type: 'opacity', layerId, before, after });
    this._markDirty();
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

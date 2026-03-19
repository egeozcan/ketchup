import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { DrawingState, Layer, LayerSnapshot, ToolType } from '../types.js';
import type { DrawingCanvas } from './drawing-canvas.js';
import { IndexedDBBackend, ProjectService, StorageQuotaError, collectBlobRefsFromEntry, storageBackendContext, projectServiceContext } from '../storage/index.js';
import type { StorageBackend, BlobStore, BlobRef, ProjectMeta as StorageProjectMeta, ProjectHistoryRecord } from '../storage/types.js';
import { canvasToBlob } from '../utils/canvas-helpers.js';
import {
  serializeLayerFromImageData, deserializeLayer,
  serializeHistoryEntry, deserializeHistoryEntry,
} from '../utils/storage-serialization.js';
import { toolForShortcut } from './tool-icons.js';
import './app-toolbar.js';
import './tool-settings.js';
import './drawing-canvas.js';
import './layers-panel.js';
import './navigator-panel.js';

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

    .right-sidebar {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      height: 100%;
      width: 200px;
      border-left: 1px solid #444;
      background: #2c2c2c;
      transition: width 0.2s ease;
    }

    .right-sidebar.collapsed {
      width: 32px;
    }

    .right-sidebar layers-panel {
      flex: 1;
      min-height: 0;
    }

    /* ── Mobile layout ─────────────────────────── */
    :host([mobile]) {
      flex-direction: column;
    }

    :host([mobile]) tool-settings {
      display: none;
    }

    :host([mobile]) .main-area {
      flex-direction: column;
    }

    :host([mobile]) .right-sidebar {
      display: none;
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
  @state() private _viewportZoom = 1;
  @state() private _viewportPanX = 0;
  @state() private _viewportPanY = 0;
  @state() private _viewportWidth = 800;
  @state() private _viewportHeight = 600;
  @state() private _currentProject: StorageProjectMeta | null = null;
  @state() private _projectList: StorageProjectMeta[] = [];
  @state() private _isMobile = false;
  private _mobileObserver: ResizeObserver | null = null;

  @property({ attribute: false })
  storageBackend?: StorageBackend;

  @state() private _storageState: 'loading' | 'ready' | 'error' = 'loading';
  @state() private _storageError?: string;
  @state() private _backend?: StorageBackend;
  /** True when we created the backend ourselves (not caller-supplied). Only dispose what we own. */
  private _ownsBackend = false;
  @state() private _projectService?: ProjectService;

  private _storageProvider?: ContextProvider<typeof storageBackendContext>;
  private _serviceProvider?: ContextProvider<typeof projectServiceContext>;
  private _initPromise?: Promise<void>;

  /** Sentinel value that never matches a real _historyVersion, forcing full history rewrite. */
  private static readonly FORCE_FULL_HISTORY_SAVE = -1;
  private static readonly NON_TEXT_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ]);

  private _dirty = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _saveInProgress = false;
  private _savePromise: Promise<void> | null = null;
  private _saveRequested = false;
  private _forceFlushNextSave = false;
  private _dirtyVersion = 0;
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
      cropAspectRatio: 'free',
      fontFamily: 'sans-serif',
      fontSize: 24,
      fontBold: false,
      fontItalic: false,
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
    // Commit any active float so the layer canvas includes the selection content.
    this.canvas?.clearSelection();
    if (this._dirty) {
      // Start the async save — it may or may not complete before unload.
      this._flushPendingSave();
      // Show the browser's "Leave site?" dialog so the save has time to finish.
      e.preventDefault();
    }
  };

  private _onVisibilityChange = () => {
    if (document.hidden) {
      // Commit any active float so the layer canvas includes the selection content.
      this.canvas?.clearSelection();
      // When the page is hidden (tab switch, close, refresh), flush immediately.
      // This fires before beforeunload and gives the save more time to complete.
      if (this._dirty) {
        this._flushPendingSave();
      }
    }
  };

  /** Cancel the debounce timer and start a save immediately. */
  private _flushPendingSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    void this._save(true);
  }

  /** Cancel debounce and await save completion, including any in-flight save. */
  private async _flushPendingSaveAndWait() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._save(true);
  }

  private _markDirty() {
    this._dirty = true;
    this._dirtyVersion++;
    this._saveRequested = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      void this._save();
    }, 500);
  }

  private async _save(flushing = false) {
    if (this._savePromise) {
      if (flushing) this._forceFlushNextSave = true;
      if (this._dirty) this._saveRequested = true;
      return this._savePromise;
    }
    if (!this._currentProject || !this._dirty) return;
    if (!this._backend) return;

    this._savePromise = (async () => {
      this._saveInProgress = true;
      this._saving = true;
      let flushingThisRun = flushing;
      try {
        while (this._currentProject && this._dirty) {
          const projectId = this._currentProject.id;
          const dirtyVersionAtSnapshot = this._dirtyVersion;
          const saveStartTime = Date.now();
          const forceFlush = this._forceFlushNextSave;
          this._forceFlushNextSave = false;
          this._saveRequested = false;
          const skipDelay = flushingThisRun || forceFlush;

          // Synchronously snapshot all mutable data before any awaits.
          // Tool settings and dimensions must be captured here so they stay
          // consistent with the layer snapshots if the user edits mid-save.
          const snapshotToolSettings = {
            activeTool: this._state.activeTool,
            strokeColor: this._state.strokeColor,
            fillColor: this._state.fillColor,
            useFill: this._state.useFill,
            brushSize: this._state.brushSize,
          };
          const snapshotWidth = this._state.documentWidth;
          const snapshotHeight = this._state.documentHeight;
          const snapshotActiveLayerId = this._state.activeLayerId;
          const snapshotLayersPanelOpen = this._state.layersPanelOpen;

          // If a floating selection is active, composite it into the owning
          // layer's snapshot so persisted data never has a hole from the lift.
          const floatSnap = this.canvas?.getFloatSnapshot() ?? null;
          const layerSnapshots = this._state.layers.map(l => {
            const ctx = l.canvas.getContext('2d')!;
            const imageData = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
            if (floatSnap && l.id === floatSnap.layerId) {
              // Draw the float onto a temp canvas copy so the live canvas is untouched.
              const tmp = document.createElement('canvas');
              tmp.width = l.canvas.width;
              tmp.height = l.canvas.height;
              const tmpCtx = tmp.getContext('2d')!;
              tmpCtx.putImageData(imageData, 0, 0);
              tmpCtx.drawImage(floatSnap.tempCanvas, floatSnap.x, floatSnap.y);
              return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity,
                imageData: tmpCtx.getImageData(0, 0, tmp.width, tmp.height) };
            }
            return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, imageData };
          });
          const viewport = this.canvas?.getViewport() ?? { zoom: 1, panX: 0, panY: 0 };
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

          // Capture old blob refs before serializing new ones, so we can reclaim them after save.
          const blobs = this._backend!.blobs;
          const [oldState, oldProject, oldHistoryEntries] = await Promise.all([
            this._backend!.state.get(projectId),
            this._backend!.projects.get(projectId),
            clearExistingHistory ? this._backend!.history.getEntries(projectId) : Promise.resolve([]),
          ]);

          // Abort if the project was deleted (e.g. by another tab or a custom backend).
          // Writing state/history for a missing project creates orphaned data.
          if (!oldProject) break;

          const oldLayerRefs = oldState?.layers.map(l => l.imageBlobRef) ?? [];
          const oldThumbRef = oldProject.thumbnailRef ?? null;

          // Track blob refs as they're created during serialization so partial
          // failures (e.g. quota hit on the Nth blob) can still be rolled back.
          const pendingBlobRefs: BlobRef[] = [];
          const trackingBlobs: BlobStore = {
            get: (ref) => blobs.get(ref),
            delete: (ref) => blobs.delete(ref),
            deleteMany: (refs) => blobs.deleteMany(refs),
            gc: blobs.gc ? (activeRefs) => blobs.gc!(activeRefs) : undefined,
            async put(data: Blob | ArrayBuffer): Promise<BlobRef> {
              const ref = await blobs.put(data);
              pendingBlobRefs.push(ref);
              return ref;
            },
          };

          // Async serialization from snapshots (not live canvas).
          // Uses trackingBlobs so every blobs.put() is recorded.
          let layers;
          let serializedEntries: ProjectHistoryRecord[];
          try {
            layers = await Promise.all(
              layerSnapshots.map(snap => serializeLayerFromImageData(snap, snap.imageData, trackingBlobs)),
            );

            serializedEntries = await Promise.all(
              entriesToSave.map(async (entry, i) => ({
                projectId,
                index: startIndex + i,
                entry: await serializeHistoryEntry(entry, trackingBlobs),
              })),
            );
          } catch (serializeErr) {
            // Partial serialization — clean up any blobs already written.
            if (pendingBlobRefs.length > 0) {
              blobs.deleteMany(pendingBlobRefs).catch(() => {});
            }
            throw serializeErr;
          }

          const stateRecord = {
            projectId,
            toolSettings: snapshotToolSettings,
            canvasWidth: snapshotWidth,
            canvasHeight: snapshotHeight,
            layers,
            activeLayerId: snapshotActiveLayerId,
            layersPanelOpen: snapshotLayersPanelOpen,
            historyIndex,
            zoom: viewport.zoom,
            panX: viewport.panX,
            panY: viewport.panY,
          };

          let thumbnail: Blob | null = null;
          if (this.canvas?.mainCanvas) {
            try { thumbnail = await canvasToBlob(this.canvas.mainCanvas); } catch { /* non-critical */ }
          }

          // Save state + history atomically: if either fails, restore the
          // previous state record (so the project doesn't point at deleted
          // blob refs) and clean up the new blobs.
          try {
            await this._backend!.state.save(stateRecord);
            if (clearExistingHistory) {
              await this._backend!.history.replaceAll(projectId, serializedEntries);
            } else if (serializedEntries.length > 0) {
              await this._backend!.history.putEntries(projectId, serializedEntries);
            }
          } catch (saveErr) {
            // Restore the previous state record so the project isn't left
            // pointing at blob refs we're about to delete.
            if (oldState) {
              this._backend!.state.save(oldState).catch((rollbackErr) => {
                console.error('Failed to rollback state after save failure:', rollbackErr);
              });
            }
            blobs.deleteMany(pendingBlobRefs).catch(() => {});
            throw saveErr;
          }

          // Advance save cursors immediately after state+history succeed.
          // If thumbnail/metadata fails later (e.g. QuotaExceededError), the
          // next autosave won't re-append the same history entries.
          if (this._currentProject?.id === projectId) {
            this._lastSavedHistoryLength = historySnapshot.length;
            this._lastSavedHistoryVersion = historyVersion;
          }

          // Update project metadata (thumbnail failure is non-fatal for data integrity)
          let newThumbRef = oldThumbRef;
          try {
            if (thumbnail) {
              newThumbRef = await blobs.put(thumbnail);
              await this._backend!.projects.update(projectId, { thumbnailRef: newThumbRef });
            } else {
              await this._backend!.projects.update(projectId, {});
            }
          } catch {
            // Thumbnail/metadata update failed — state+history are already saved,
            // cursors already advanced. Stale thumbnail is cosmetic.
            // Clean up orphaned thumbnail blob if it was written but update failed.
            if (newThumbRef !== oldThumbRef && newThumbRef) {
              blobs.delete(newThumbRef).catch(() => {});
            }
          }

          // Reclaim superseded blob refs (layers + thumbnail + replaced history).
          const newLayerRefs = new Set(layers.map(l => l.imageBlobRef));
          const staleRefs: BlobRef[] = oldLayerRefs.filter(r => !newLayerRefs.has(r));
          if (oldThumbRef && oldThumbRef !== newThumbRef) {
            staleRefs.push(oldThumbRef);
          }
          // When history is fully rewritten, the old entries' blobs are orphaned.
          if (clearExistingHistory && oldHistoryEntries.length > 0) {
            const oldHistoryRefs = new Set<BlobRef>();
            for (const h of oldHistoryEntries) collectBlobRefsFromEntry(h.entry, oldHistoryRefs);
            const newHistoryRefs = new Set<BlobRef>();
            for (const h of serializedEntries) collectBlobRefsFromEntry(h.entry, newHistoryRefs);
            for (const ref of oldHistoryRefs) {
              if (!newHistoryRefs.has(ref)) staleRefs.push(ref);
            }
          }
          if (staleRefs.length > 0) {
            blobs.deleteMany(staleRefs).catch(() => {/* best-effort cleanup */});
          }

          // Mark clean only if no new edits landed while this save was in flight.
          if (this._currentProject?.id === projectId) {
            if (this._dirtyVersion === dirtyVersionAtSnapshot) {
              this._dirty = false;
            }
          }

          this._projectList = await this._backend!.projects.list();

          // Show saving indicator for a minimum duration so it doesn't flash,
          // but skip the delay when flushing (beforeunload/visibilitychange)
          // to avoid data loss on page close.
          if (!skipDelay) {
            const elapsed = Date.now() - saveStartTime;
            if (elapsed < 1500) {
              await new Promise(resolve => setTimeout(resolve, 1500 - elapsed));
            }
          }

          if (!this._saveRequested || !this._dirty) {
            break;
          }
          flushingThisRun = false;
        }
      } catch (err) {
        if (err instanceof StorageQuotaError) {
          console.error('Storage quota exceeded. Consider deleting old projects to free space.');
        } else {
          console.error('Save failed:', err);
        }
      } finally {
        this._saving = false;
        this._saveInProgress = false;
      }
    })();

    try {
      await this._savePromise;
    } finally {
      this._savePromise = null;
    }
  }

  private _isTextEntryTarget(e: KeyboardEvent): boolean {
    for (const node of e.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.isContentEditable) return true;
      if (node instanceof HTMLTextAreaElement) return true;
      if (node instanceof HTMLInputElement) {
        return !DrawingApp.NON_TEXT_INPUT_TYPES.has(node.type);
      }
      // Modal dialogs (e.g. resize-dialog) should swallow shortcuts so
      // tool switches and undo/redo don't fire while the dialog is open.
      if (node instanceof HTMLDialogElement && node.open) return true;
    }
    return false;
  }

  private _onCommitOpacity(e: CustomEvent) {
    const { layerId, before, after } = e.detail;
    this.canvas?.pushLayerOperation({ type: 'opacity', layerId, before, after });
    this._markDirty();
  }

  private _onCropCommit(e: CustomEvent) {
    const { width, height } = e.detail;
    this._applyDocumentDimensions(width, height);
    // Force Lit re-render by creating new layers array reference
    // (layer.canvas was mutated in-place by drawing-canvas commitCrop)
    this._state = { ...this._state, layers: [...this._state.layers] };
    this._markDirty();
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    if (this._isTextEntryTarget(e)) {
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.canvas?.undo();
    } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.canvas?.redo();
    } else if (ctrl && key === 'c') {
      e.preventDefault();
      this.canvas?.copySelection();
    } else if (ctrl && key === 'x') {
      e.preventDefault();
      this.canvas?.cutSelection();
    } else if (ctrl && key === 'v') {
      e.preventDefault();
      if (this.canvas?.hasClipboardData) {
        this.canvas.pasteSelection();
      } else {
        this.canvas?.pasteExternalImage();
      }
    } else if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      (this._state.activeTool === 'select' || this._state.activeTool === 'stamp')
    ) {
      e.preventDefault();
      this.canvas?.deleteSelection();
    } else if (e.key === 'Enter' && this._state.activeTool === 'crop' && this.canvas?.hasCropRect) {
      e.preventDefault();
      this.canvas.commitCrop();
    } else if (e.key === 'Escape') {
      if (this._state.activeTool === 'crop' && this.canvas?.hasCropRect) {
        this.canvas.cancelCrop();
      } else if (this.canvas?.hasExternalFloat) {
        this.canvas.cancelExternalFloat();
      } else {
        this.canvas?.clearSelection();
      }
    } else if (e.key === '0' && ctrl) {
      e.preventDefault();
      this.canvas?.zoomToFit();
    } else if (ctrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.canvas?.zoomIn();
    } else if (ctrl && e.key === '-') {
      e.preventDefault();
      this.canvas?.zoomOut();
    } else if (!ctrl && !e.altKey && !e.shiftKey && key.length === 1) {
      const tool = toolForShortcut(key);
      if (tool && tool !== this._state.activeTool) {
        e.preventDefault();
        this.canvas?.cancelCrop();
        this.canvas?.clearSelection();
        this._state = { ...this._state, activeTool: tool };
        this._markDirty();
      }
    }
  };

  private async _resetToFreshProject(width = 800, height = 600) {
    this.canvas?.clearSelection();
    this._layerCounter = 0;
    const w = width;
    const h = height;
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
      cropAspectRatio: 'free',
      fontFamily: 'sans-serif',
      fontSize: 24,
      fontBold: false,
      fontItalic: false,
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
      this.canvas?.clearSelection();
      const record = await this._backend!.state.get(projectId);
      if (!record) {
        await this._resetToFreshProject();
        return;
      }

      const MAX_DIMENSION = 16384;
      if (record.canvasWidth <= 0 || record.canvasWidth > MAX_DIMENSION ||
          record.canvasHeight <= 0 || record.canvasHeight > MAX_DIMENSION) {
        console.error('Invalid canvas dimensions in saved state:', record.canvasWidth, record.canvasHeight);
        await this._resetToFreshProject();
        return;
      }

      const blobs = this._backend!.blobs;
      const layers: Layer[] = await Promise.all(
        record.layers.map(sl => deserializeLayer(sl, record.canvasWidth, record.canvasHeight, blobs)),
      );
      if (layers.length === 0) {
        await this._resetToFreshProject();
        return;
      }

      const historyRecords = await this._backend!.history.getEntries(projectId);
      const history = await Promise.all(
        historyRecords.map(r => deserializeHistoryEntry(r.entry, blobs)),
      );

      // Restore layer counter to max existing layer number
      const maxNum = layers.reduce((max, l) => {
        const match = l.name.match(/^Layer (\d+)$/);
        return match ? Math.max(max, parseInt(match[1])) : max;
      }, 0);
      this._layerCounter = maxNum;
      // Validate activeLayerId — fall back to first layer if the saved ID
      // doesn't match any loaded layer (e.g. data corruption).
      const validActiveId = layers.some(l => l.id === record.activeLayerId)
        ? record.activeLayerId
        : layers[0].id;
      this._state = {
        activeTool: record.toolSettings.activeTool,
        strokeColor: record.toolSettings.strokeColor,
        fillColor: record.toolSettings.fillColor,
        useFill: record.toolSettings.useFill,
        brushSize: record.toolSettings.brushSize,
        stampImage: null,
        layers,
        activeLayerId: validActiveId,
        layersPanelOpen: record.layersPanelOpen,
        documentWidth: record.canvasWidth,
        documentHeight: record.canvasHeight,
        cropAspectRatio: 'free',
        fontFamily: 'sans-serif',
        fontSize: 24,
        fontBold: false,
        fontItalic: false,
      };
      await this.updateComplete;
      this.canvas?.setHistory(history, record.historyIndex ?? (history.length - 1));
      this._dirty = false;
      this._lastSavedHistoryLength = history.length;
      this._lastSavedHistoryVersion = 0;
      // Restore saved viewport or fall back to centering for legacy records
      if (record.zoom != null && record.panX != null && record.panY != null) {
        this.canvas?.setViewport(record.zoom, record.panX, record.panY);
      } else {
        this.canvas?.centerDocument();
        this.canvas?.composite();
      }
    } catch (err) {
      console.error('Failed to load project:', err);
      await this._resetToFreshProject();
    }
  }


  /** Set document dimensions without clearing history (used by crop commit/undo). */
  private _applyDocumentDimensions(width: number, height: number) {
    this._state = { ...this._state, documentWidth: width, documentHeight: height };
  }

  private _buildContextValue(): DrawingContextValue {
    return {
      state: this._state,
      setTool: (tool: ToolType) => {
        if (this._state.activeTool !== tool) {
          this.canvas?.cancelCrop();
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
      addLayer: (name?: string) => {
        this.canvas?.clearSelection();
        const layer = this._createLayer(this._state.documentWidth, this._state.documentHeight);
        if (name) {
          layer.name = name;
          // Undo the counter increment since the generated name was discarded.
          this._layerCounter--;
        }
        const activeIdx = this._state.layers.findIndex(l => l.id === this._state.activeLayerId);
        const insertIdx = activeIdx + 1;
        const newLayers = [...this._state.layers];
        newLayers.splice(insertIdx, 0, layer);
        this._state = { ...this._state, layers: newLayers, activeLayerId: layer.id };
        this.canvas?.pushLayerOperation({ type: 'add-layer', layer: this._snapshotLayer(layer), index: insertIdx });
        this._markDirty();
        return layer.id;
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
        if (!this._state.layers.some(l => l.id === id)) return;
        if (id === this._state.activeLayerId) return;
        this.canvas?.clearSelection();
        this._state = { ...this._state, activeLayerId: id };
        this._markDirty();
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
        this._markDirty();
      },
      setCropAspectRatio: (ratio: string) => {
        this._state = { ...this._state, cropAspectRatio: ratio };
        this._markDirty();
      },
      setFontFamily: (family: string) => {
        this._state = { ...this._state, fontFamily: family };
        this._markDirty();
      },
      setFontSize: (size: number) => {
        this._state = { ...this._state, fontSize: Math.max(8, Math.min(200, size)) };
        this._markDirty();
      },
      setFontBold: (bold: boolean) => {
        this._state = { ...this._state, fontBold: bold };
        this._markDirty();
      },
      setFontItalic: (italic: boolean) => {
        this._state = { ...this._state, fontItalic: italic };
        this._markDirty();
      },
      canUndo: this._canUndo,
      canRedo: this._canRedo,
      // Project operations
      currentProject: this._currentProject,
      projectList: this._projectList,
      saving: this._saving,
      zoom: this._viewportZoom,
      panX: this._viewportPanX,
      panY: this._viewportPanY,
      viewportWidth: this._viewportWidth,
      viewportHeight: this._viewportHeight,
      isMobile: this._isMobile,
      switchProject: (id: string) => {
        if (id === this._currentProject?.id) return;
        const doSwitch = async () => {
          // Commit any float so the save captures the layer with
          // the float content (no hole from a pending selection lift).
          this.canvas?.clearSelection();
          if (this._savePromise || this._dirty) {
            await this._flushPendingSaveAndWait();
          }
          const meta = this._projectList.find(p => p.id === id);
          if (!meta) return;
          this._currentProject = meta;
          await this._loadProject(id);
        };
        doSwitch().catch(err => console.error('Switch project failed:', err));
      },
      createProject: (name: string, width: number, height: number) => {
        const doCreate = async () => {
          this.canvas?.clearSelection();
          if (this._savePromise || this._dirty) {
            await this._flushPendingSaveAndWait();
          }
          const meta = await this._backend!.projects.create({ name, thumbnailRef: null });
          this._currentProject = meta;
          this._projectList = await this._backend!.projects.list();
          await this._resetToFreshProject(width, height);
          this._markDirty();
        };
        doCreate().catch(err => console.error('Create project failed:', err));
      },
      deleteProject: (id: string) => {
        const doDelete = async () => {
          this.canvas?.clearSelection();
          if (this._savePromise || this._dirty) {
            await this._flushPendingSaveAndWait();
          }
          await this._projectService!.deleteProject(id);
          this._projectList = await this._backend!.projects.list();
          if (id === this._currentProject?.id) {
            if (this._projectList.length > 0) {
              this._currentProject = this._projectList[0];
              await this._loadProject(this._currentProject.id);
            } else {
              const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
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
          const updated = await this._backend!.projects.update(id, { name });
          if (this._currentProject?.id === id) {
            this._currentProject = updated;
          }
          this._projectList = await this._backend!.projects.list();
        };
        doRename().catch(err => console.error('Rename project failed:', err));
      },
    };
  }

  override willUpdate() {
    this._provider.setValue(this._buildContextValue());
    this.toggleAttribute('mobile', this._isMobile);
  }

  private _onHistoryChange(e: CustomEvent) {
    this._canUndo = e.detail.canUndo;
    this._canRedo = e.detail.canRedo;
    this._markDirty();
  }

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
      case 'crop-restore': {
        const snapshots = detail.layers as LayerSnapshot[];
        const width = detail.width as number;
        const height = detail.height as number;
        // Replace all layer canvases from snapshots
        const newLayers = this._state.layers.map(layer => {
          const snap = snapshots.find(s => s.id === layer.id);
          if (!snap) return layer;
          const canvas = document.createElement('canvas');
          canvas.width = snap.imageData.width;
          canvas.height = snap.imageData.height;
          canvas.getContext('2d')!.putImageData(snap.imageData, 0, 0);
          return { ...layer, canvas, visible: snap.visible, opacity: snap.opacity, name: snap.name };
        });
        this._applyDocumentDimensions(width, height);
        this._state = { ...this._state, layers: newLayers };
        break;
      }
    }
    this._markDirty();
  }

  override connectedCallback() {
    super.connectedCallback();
    this._initStorage();
    this._mobileObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this._isMobile = entry.contentRect.width < 768;
      }
    });
    this._mobileObserver.observe(this);
    this.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('beforeunload', this._onBeforeUnload);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  private _initStorage() {
    if (this._initPromise) return;
    this._initPromise = this._doInitStorage();
  }

  private async _doInitStorage() {
    try {
      const callerSupplied = !!this.storageBackend;
      const backend = this.storageBackend ?? new IndexedDBBackend();
      await backend.init();
      this._backend = backend;
      this._ownsBackend = !callerSupplied;
      this._projectService = new ProjectService(backend);
      this._storageProvider = new ContextProvider(this, {
        context: storageBackendContext,
        initialValue: this._backend,
      });
      this._serviceProvider = new ContextProvider(this, {
        context: projectServiceContext,
        initialValue: this._projectService,
      });
      this._storageState = 'ready';
      // Bootstrap project list now that storage is ready.
      // Cannot rely on firstUpdated() because it fires after the first render,
      // which happens before this async init completes.
      await this._bootstrapProjects();
    } catch (e) {
      console.error('Storage initialization failed:', e);
      this._storageState = 'error';
      this._storageError = 'Could not open local storage. Try reloading or checking browser storage settings.';
    }
  }

  private async _bootstrapProjects() {
    this._projectList = await this._backend!.projects.list();
    if (this._projectList.length > 0) {
      this._currentProject = this._projectList[0];
      await this._loadProject(this._currentProject.id);
    } else {
      const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
      this._currentProject = meta;
      this._projectList = [meta];
      this._markDirty();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._mobileObserver?.disconnect();
    this._mobileObserver = null;
    this.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    // Flush any pending save, then dispose the backend only after the save
    // settles. dispose() closes the IDBDatabase, so calling it while _save()
    // still has open transactions would cause InvalidStateError and silently
    // drop the user's final edits.
    if (this._dirty || this._savePromise) {
      // Capture the backend ref and ownership flag now — if the element
      // reconnects before the save settles, _initStorage() will assign a
      // new backend and the finally callback must dispose the OLD one.
      const backendToDispose = this._ownsBackend ? this._backend : undefined;
      const savePromise = this._dirty
        ? this._flushPendingSaveAndWait()
        : this._savePromise!;
      savePromise.finally(() => backendToDispose?.dispose());
    } else {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      if (this._ownsBackend) {
        this._backend?.dispose();
      }
    }
  }

  override render() {
    if (this._storageState === 'loading') {
      return html`<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;">Loading...</div>`;
    }
    if (this._storageState === 'error') {
      return html`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#ff6b6b;gap:8px;">
        <p>Failed to initialize storage</p>
        <p style="font-size:0.85em;color:#999;">${this._storageError}</p>
      </div>`;
    }
    return html`
      <tool-settings></tool-settings>
      <div class="main-area">
        <app-toolbar></app-toolbar>
        <drawing-canvas
          @history-change=${this._onHistoryChange}
          @layer-undo=${this._onLayerUndo}
          @crop-commit=${this._onCropCommit}
          @viewport-change=${this._onViewportChange}
        ></drawing-canvas>
        <div class="right-sidebar ${this._state.layersPanelOpen ? '' : 'collapsed'}">
          <navigator-panel
            @navigator-pan=${this._onNavigatorPan}
            @navigator-zoom=${this._onNavigatorZoom}
          ></navigator-panel>
          <layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-app': DrawingApp;
  }
}

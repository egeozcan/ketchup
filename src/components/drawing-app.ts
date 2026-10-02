import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import { blendModeToCompositeOp, type BlendMode, type BrushDescriptor, type TipDescriptor, type InkDescriptor } from '../engine/types.js';
import { getDefaultDescriptor, getPresetById } from '../engine/brush-presets.js';
import type { DrawingState, HistoryEntry, Layer, LayerSnapshot, ToolType } from '../types.js';
import type { DrawingCanvas } from './drawing-canvas.js';
import { IndexedDBBackend, MemoryBackend, ProjectService, StorageQuotaError, collectBlobRefsFromEntry, storageBackendContext, projectServiceContext } from '../storage/index.js';
import type { StorageBackend, BlobStore, BlobRef, ProjectMeta as StorageProjectMeta, ProjectHistoryRecord, StampEntry } from '../storage/types.js';
import { canvasToBlob } from '../utils/canvas-helpers.js';
import { hashImageData } from '../utils/image-diff.js';
import {
  serializeLayerFromImageData, deserializeLayer,
  serializeHistoryEntry, deserializeHistoryEntry,
} from '../utils/storage-serialization.js';
import { toolForShortcut, CHILD_TOOL_SET } from './tool-icons.js';
import { DEFAULT_STAMP_SIZE, normalizeStampSize } from '../tools/stamp-size.js';
import './app-toolbar.js';
import './tool-settings.js';
import { generateUUID } from '../utils/uuid.js';
import './drawing-canvas.js';
import './layers-panel.js';
import './navigator-panel.js';

/** A document state as the undo stack describes it; see `DrawingApp._savedDocument`. */
interface DocumentMark {
  top: HistoryEntry | null;
  trimmed: number;
  /** Which document this was: `DrawingApp._documentGeneration` when it was taken. */
  generation: number;
}

const MOBILE_ENTER_WIDTH = 768;
const MOBILE_EXIT_WIDTH = 800;

const MAX_DOCUMENT_DIMENSION = 16384;

function checkDocumentSize(width: number, height: number) {
  if (!(width > 0 && height > 0 && width <= MAX_DOCUMENT_DIMENSION && height <= MAX_DOCUMENT_DIMENSION)) {
    throw new RangeError(`Document size ${width}\u00d7${height} is outside 1\u2013${MAX_DOCUMENT_DIMENSION} pixels`);
  }
}

/** Tools that leave an active float as it is when chosen. */
function keepsFloat(tool: ToolType): boolean {
  return tool === 'select' || tool === 'hand';
}

/**
 * The compact layout is chosen by width alone, with hysteresis around the
 * breakpoint. Wide touch devices such as iPads get the desktop layout.
 */
export function shouldUseMobileLayout(width: number, currentlyMobile: boolean): boolean {
  return currentlyMobile ? width <= MOBILE_EXIT_WIDTH : width < MOBILE_ENTER_WIDTH;
}

@customElement('drawing-app')
export class DrawingApp extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      /* Focus comes back here when text or a rename ends by key, which would
         ring the whole editor; the controls inside show their own focus. */
      outline: none;
      /* The document's border-box rule does not cross the shadow boundary, so
         set it here: safe-area padding must fit inside the 100% height. */
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      /* Keep the UI clear of the status bar and home indicator when installed
         to the home screen (viewport-fit=cover). */
      padding-top: env(safe-area-inset-top);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
      background: #1e1e1e;
      font-family: system-ui, -apple-system, sans-serif;
      position: relative;
    }

    /* The mobile toolbar and layers panel pad their own bottom inset. */
    :host(:not([mobile])) {
      padding-bottom: env(safe-area-inset-bottom);
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


    :host([mobile]) .main-area {
      flex-direction: column;
    }


    :host([mobile]) .main-area app-toolbar {
      order: 1;
    }
  `;

  private _layerCounter = 0;

  private _createLayer(width: number, height: number): Layer {
    this._layerCounter++;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return {
      id: generateUUID(),
      name: `Layer ${this._layerCounter}`,
      visible: true,
      opacity: 1.0,
      blendMode: 'normal' as BlendMode,
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

  /**
   * The page hosting this element owns the document: it loads it with
   * `openImage()`/`newDocument()`, reads it back with `exportImage()`, and
   * keeps it wherever it keeps documents. Embedded, the element:
   *
   * - stores its working state in memory unless `storageBackend` is given,
   *   so nothing is left behind in the browser's IndexedDB;
   * - hides project switching, creation, renaming and deletion;
   * - answers Save (the toolbar button and Ctrl/Cmd+S) with a `save-request`
   *   event instead of downloading a PNG.
   *
   * Read once, when the element connects, so set it before inserting the
   * element (the `embedded` attribute in markup does that).
   */
  @property({ type: Boolean, reflect: true })
  embedded = false;

  @state() private _storageState: 'loading' | 'ready' | 'error' = 'loading';
  @state() private _storageError?: string;
  @state() private _backend?: StorageBackend;
  /** True when we created the backend ourselves (not caller-supplied). Only dispose what we own. */
  private _ownsBackend = false;
  /**
   * False when embedded on the in-memory backend we created: the host keeps
   * the document and nothing ever reads that copy back, so autosaving it would
   * only spend CPU and memory on every edit.
   */
  private _autosave = true;
  @state() private _projectService?: ProjectService;

  private _storageProvider?: ContextProvider<typeof storageBackendContext>;
  private _serviceProvider?: ContextProvider<typeof projectServiceContext>;
  private _initPromise?: Promise<void>;
  private _resolveReady!: () => void;
  private _rejectReady!: (err: unknown) => void;
  /** Settles once storage is open and the first document is on the canvas. */
  private _ready = new Promise<void>((resolve, reject) => {
    this._resolveReady = resolve;
    this._rejectReady = reject;
  });
  /**
   * The document the host last saved, as the undo stack described it: the
   * entry on top (null: nothing applied) and how many entries the stack had
   * dropped at its cap by then. The document is modified exactly when the top
   * differs, so undoing back to the saved state reads as unmodified, or when
   * the saved state was the bottom of a stack that has since dropped entries,
   * which no amount of undoing returns to.
   */
  private _savedDocument: DocumentMark = { top: null, trimmed: 0, generation: 0 };
  /** Counts documents opened or replaced, so a mark from an earlier one is recognised. */
  private _documentGeneration = 0;
  /** The document as `exportImage` last rendered it; what `markSaved()` records. */
  private _exportedDocument: DocumentMark | null = null;
  /** The document each exported Blob was rendered from, for `markSaved(blob)`. */
  private _exportMarks = new WeakMap<Blob, DocumentMark>();
  private _lastReportedModified = false;
  /** Serializes `openImage`/`newDocument`, which each replace the whole document, and the renders of `exportImage`. */
  private _documentReplacement: Promise<unknown> = Promise.resolve();

  /** Longest side of the project thumbnail stored with each save. */
  private static readonly THUMBNAIL_SIZE = 256;
  /** Autosave waits at most this many debounce periods for a pointer gesture to end. */
  private static readonly MAX_SAVE_DEFERRALS = 20;
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
  /** Bumped by every `'work'` dirty mark: anything that can change layer pixels. */
  private _contentVersion = 0;
  /** `_contentVersion` as of the last save's snapshot; equal means no layer changed since. */
  private _savedContentVersion = -1;
  /**
   * Content version and viewport the stored project thumbnail was rendered at
   * (it is a downscale of the on-screen view); null forces a new one.
   */
  private _savedThumbKey: string | null = null;
  /** A drawing change is waiting to be saved, so the next save shows the saving indicator. */
  private _unsavedWork = false;
  /**
   * History entries already in storage for the current project, by entry
   * identity, with the record index each was stored under and the blobs it
   * owns. A save writes only new entries and deletes only the ones that left
   * the undo stack, instead of re-encoding the whole history each time the
   * oldest entry is evicted or redo entries are discarded.
   */
  private _savedHistory = new Map<HistoryEntry, { index: number; blobRefs: BlobRef[] }>();
  /** Record index for the next stored history entry; only grows, so stored order is stack order. */
  private _nextHistoryRecordIndex = 0;
  /** Storage may hold history this session knows nothing about; the next save replaces all of it. */
  private _historyNeedsRewrite = false;
  /**
   * Content hash and stored blob of each layer as of the last save, by layer
   * id. Autosave runs after every edit but usually only one layer changed, so
   * the others keep their stored PNG instead of being re-encoded.
   */
  private _savedLayerBlobs = new Map<string, { hash: string; blobRef: BlobRef }>();
  /** Project the bookkeeping above describes; a save to any other project rewrites its history. */
  private _trackedProjectId: string | null = null;
  /** Bumped whenever the bookkeeping is reset for a newly loaded project. */
  private _trackingGeneration = 0;
  /**
   * Project loads in progress. While `_currentProject` already names the new
   * project but the canvas still holds the old one, a save would write the old
   * project's layers and history into the new one, so saves wait.
   */
  private _projectLoads = 0;
  /**
   * The layers panel's desktop open state while the mobile layout forces the
   * sheet closed, so a phone-width session never overwrites the saved setting.
   * Null when not in the mobile layout.
   */
  private _desktopLayersPanelOpen: boolean | null = null;

  @query('drawing-canvas') canvas!: DrawingCanvas;

  private _provider!: ContextProvider<typeof drawingContext>;

  constructor() {
    super();
    // whenReady() callers see the failure; nobody awaiting it is not an error.
    this._ready.catch(() => {});
    const layer = this._createLayer(800, 600);
    this._state = {
      activeTool: 'pencil',
      strokeColor: '#000000',
      fillColor: '#ff0000',
      useFill: false,
      brush: getDefaultDescriptor(),
      activePreset: 'round',
      isPresetModified: false,
      stampImage: null,
      activeStampId: null,
      stampSize: DEFAULT_STAMP_SIZE,
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
      eyedropperSampleAll: true,
      childMode: false,
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
      blendMode: layer.blendMode,
      imageData: ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height),
    };
  }

  private _snapshotAllLayers(): LayerSnapshot[] {
    return this._state.layers.map(l => this._snapshotLayer(l));
  }

  /**
   * Composites the given layers (in order, bottom-to-top) onto a new
   * offscreen canvas, baking each layer's opacity into the result.
   */
  private _compositeLayers(layers: Layer[], background: string | null = '#ffffff'): HTMLCanvasElement {
    const w = this._state.documentWidth;
    const h = this._state.documentHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    for (const layer of layers) {
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    return canvas;
  }

  private _onBeforeUnload = (e: BeforeUnloadEvent) => {
    // Embedded, the working copy is in memory and the host owns the document;
    // the host decides whether leaving needs a prompt (from `modified`).
    if (this.embedded) return;
    // Commit any active float so the layer canvas includes the selection content.
    this.canvas?.clearSelection();
    this.canvas?.flushViewportChange?.();
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
      // A coalesced wheel/pinch viewport change waits for a frame, and hidden
      // pages don't render frames.
      this.canvas?.flushViewportChange?.();
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

  /**
   * Schedule an autosave. `kind` says what changed: `'work'` is a change to the
   * drawing itself (pixels, layers, history, document size) and shows the
   * saving indicator; `'setting'` (tool, colour, brush, panel state) and
   * `'viewport'` (pan/zoom) are saved quietly.
   */
  private _markDirty(kind: 'work' | 'setting' | 'viewport' = 'work') {
    // Only 'work' can change layer pixels (every pixel change lands in history,
    // whose history-change event marks 'work'); settings and viewport changes
    // let the next save reuse the stored layer blobs without reading them back.
    if (kind === 'work') this._contentVersion++;
    if (!this._autosave) return;
    if (kind === 'work') this._unsavedWork = true;
    this._dirty = true;
    this._dirtyVersion++;
    this._saveRequested = true;
    this._scheduleSave();
  }

  /**
   * Debounce an autosave. A save reads back and encodes layers on the main
   * thread, so while a pointer gesture is in progress it waits for the gesture
   * to end rather than stalling the stroke — up to a bound, so a pointer whose
   * pointerup never arrived can't hold saving off indefinitely.
   */
  private _scheduleSave(deferrals = 0) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (deferrals < DrawingApp.MAX_SAVE_DEFERRALS && this.canvas?.isGestureActive?.()) {
        this._scheduleSave(deferrals + 1);
        return;
      }
      void this._save();
    }, 500);
  }

  private _updateBrush(partial: Partial<BrushDescriptor>) {
    this._state = {
      ...this._state,
      brush: { ...this._state.brush, ...partial },
      isPresetModified: true,
    };
    this._markDirty('setting');
  }

  private _updateStampSize(size: number) {
    const stampSize = normalizeStampSize(size, this._state.stampSize);
    if (stampSize === this._state.stampSize) return;
    this._state = { ...this._state, stampSize };
    this._markDirty('setting');
  }

  /**
   * Work out how stored history must change to match `entries`: which stored
   * records to delete and which entries to append after them. Falls back to a
   * full rewrite when storage holds unknown history, or when the stored
   * entries no longer lead the stack in stored order (not expected, since the
   * stack only drops entries from either end or filters them in place).
   */
  private _planHistorySave(projectId: string, entries: HistoryEntry[]) {
    const saved = this._savedHistory;
    let rewrite = this._historyNeedsRewrite ||
      this._trackedProjectId !== projectId ||
      !this._backend?.history.updateEntries;
    if (!rewrite) {
      let lastIndex = -1;
      let sawUnsaved = false;
      for (const entry of entries) {
        const record = saved.get(entry);
        if (!record) {
          sawUnsaved = true;
        } else if (sawUnsaved || record.index <= lastIndex) {
          rewrite = true;
          break;
        } else {
          lastIndex = record.index;
        }
      }
    }
    if (rewrite) {
      return { rewrite, remove: [...saved], add: entries, firstIndex: 0 };
    }
    const live = new Set(entries);
    return {
      rewrite,
      remove: [...saved].filter(([entry]) => !live.has(entry)),
      add: entries.filter(entry => !saved.has(entry)),
      firstIndex: this._nextHistoryRecordIndex,
    };
  }

  /** Update the stored-history bookkeeping once a planned history save has been written. */
  private _recordSavedHistory(
    projectId: string,
    plan: ReturnType<DrawingApp['_planHistorySave']>,
    records: ProjectHistoryRecord[],
  ) {
    this._trackedProjectId = projectId;
    if (plan.rewrite) this._savedHistory.clear();
    for (const [entry] of plan.remove) this._savedHistory.delete(entry);
    plan.add.forEach((entry, i) => {
      const refs = new Set<BlobRef>();
      collectBlobRefsFromEntry(records[i].entry, refs);
      this._savedHistory.set(entry, { index: records[i].index, blobRefs: [...refs] });
    });
    this._nextHistoryRecordIndex = plan.firstIndex + plan.add.length;
    this._historyNeedsRewrite = false;
  }

  /** Reset stored-history and layer-blob bookkeeping to match a freshly loaded project. */
  private _trackLoadedProject(
    projectId: string | null,
    history: HistoryEntry[],
    records: ProjectHistoryRecord[],
    layerBlobs = new Map<string, { hash: string; blobRef: BlobRef }>(),
  ) {
    this._trackedProjectId = projectId;
    this._trackingGeneration++;
    this._savedHistory = new Map(history.map((entry, i) => {
      const refs = new Set<BlobRef>();
      collectBlobRefsFromEntry(records[i].entry, refs);
      return [entry, { index: records[i].index, blobRefs: [...refs] }];
    }));
    this._nextHistoryRecordIndex = records.reduce((next, r) => Math.max(next, r.index + 1), 0);
    this._historyNeedsRewrite = false;
    this._savedLayerBlobs = layerBlobs;
    // The first save after a load always reads the layers back.
    this._savedContentVersion = -1;
    this._savedThumbKey = null;
    // Restoring history during the load isn't a new edit to show as saving.
    this._unsavedWork = false;
  }

  /**
   * Make `meta` the current project and run `load` to bring its content in.
   * No save runs until the load finishes, since until then the canvas still
   * holds the previous project. Once loaded, it reads as unmodified.
   */
  private async _enterProject(meta: StorageProjectMeta, load: () => Promise<void>) {
    this._projectLoads++;
    try {
      this._currentProject = meta;
      await load();
    } finally {
      this._projectLoads--;
    }
    // Another document is open, however it was reached (the host API, or the
    // project menu when standalone): it is the saved one, and marks taken of
    // the previous one no longer apply.
    this._markSaved();
  }

  /** Downscale the display canvas to a project thumbnail; encoding the full viewport each save is wasted work. */
  private _renderThumbnail(source: HTMLCanvasElement): HTMLCanvasElement {
    const scale = Math.min(1, DrawingApp.THUMBNAIL_SIZE / Math.max(source.width, source.height, 1));
    const thumb = document.createElement('canvas');
    thumb.width = Math.max(1, Math.round(source.width * scale));
    thumb.height = Math.max(1, Math.round(source.height * scale));
    thumb.getContext('2d')!.drawImage(source, 0, 0, thumb.width, thumb.height);
    return thumb;
  }

  private async _save(flushing = false) {
    if (this._savePromise) {
      if (flushing) this._forceFlushNextSave = true;
      if (this._dirty) this._saveRequested = true;
      return this._savePromise;
    }
    if (!this._currentProject || !this._dirty || this._projectLoads > 0) return;
    if (!this._backend) return;

    this._savePromise = (async () => {
      this._saveInProgress = true;
      let flushingThisRun = flushing;
      try {
        while (this._currentProject && this._dirty && this._projectLoads === 0) {
          const projectId = this._currentProject.id;
          const dirtyVersionAtSnapshot = this._dirtyVersion;
          const contentVersionAtSnapshot = this._contentVersion;
          // A gesture can leave layers mid-change (a move drag shifts the layer
          // and may restore it without a history entry), so a snapshot taken
          // during one is stored but not trusted as the saved content.
          let snapshotTrusted = !this.canvas?.isGestureActive?.();
          const saveStartTime = Date.now();
          const forceFlush = this._forceFlushNextSave;
          this._forceFlushNextSave = false;
          this._saveRequested = false;
          const skipDelay = flushingThisRun || forceFlush;
          // Only drawing changes show the indicator; tool and viewport changes
          // save quietly so the spinner doesn't flash on every tool switch.
          if (this._unsavedWork) {
            this._unsavedWork = false;
            this._saving = true;
          }

          // Synchronously snapshot all mutable data before any awaits.
          // Tool settings and dimensions must be captured here so they stay
          // consistent with the layer snapshots if the user edits mid-save.
          const snapshotToolSettings = {
            activeTool: this._state.activeTool,
            strokeColor: this._state.strokeColor,
            fillColor: this._state.fillColor,
            useFill: this._state.useFill,
            brushSize: this._state.brush.size,
            stampSize: this._state.stampSize,
            opacity: this._state.brush.opacity,
            flow: this._state.brush.flow,
            hardness: this._state.brush.hardness,
            spacing: this._state.brush.spacing,
            pressureSize: this._state.brush.pressureSize,
            pressureOpacity: this._state.brush.pressureOpacity,
            pressureCurve: this._state.brush.pressureCurve,
            tip: { ...this._state.brush.tip },
            ink: { ...this._state.brush.ink },
            activePreset: this._state.activePreset,
            isPresetModified: this._state.isPresetModified,
            cropAspectRatio: this._state.cropAspectRatio,
            fontFamily: this._state.fontFamily,
            fontSize: this._state.fontSize,
            fontBold: this._state.fontBold,
            fontItalic: this._state.fontItalic,
            eyedropperSampleAll: this._state.eyedropperSampleAll,
            childMode: this._state.childMode,
          };
          const snapshotWidth = this._state.documentWidth;
          const snapshotHeight = this._state.documentHeight;
          const snapshotActiveLayerId = this._state.activeLayerId;
          const snapshotLayersPanelOpen = this._desktopLayersPanelOpen ?? this._state.layersPanelOpen;

          // If a floating selection is active, composite it into the owning
          // layer's snapshot so persisted data never has a hole from the lift.
          const floatSnap = this.canvas?.getFloatSnapshot() ?? null;
          // Only the viewport moved since the last save and every layer still has
          // its stored blob: skip the full-canvas readback and hashing.
          const reuseSaved = !floatSnap
            && contentVersionAtSnapshot === this._savedContentVersion
            && this._trackedProjectId === projectId
            && this._state.layers.every(l => this._savedLayerBlobs.has(l.id));
          const layerSnapshots = this._state.layers.map(l => {
            const meta = { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode };
            if (reuseSaved) return { ...meta, imageData: null as ImageData | null };
            if (floatSnap && l.id === floatSnap.layerId) {
              // Draw the float onto a temp canvas copy so the live canvas is untouched.
              const tmp = document.createElement('canvas');
              tmp.width = l.canvas.width;
              tmp.height = l.canvas.height;
              const tmpCtx = tmp.getContext('2d')!;
              tmpCtx.drawImage(l.canvas, 0, 0);
              tmpCtx.drawImage(floatSnap.tempCanvas, floatSnap.x, floatSnap.y);
              return { ...meta, imageData: tmpCtx.getImageData(0, 0, tmp.width, tmp.height) as ImageData | null };
            }
            const ctx = l.canvas.getContext('2d')!;
            const imageData = ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
            return { ...meta, imageData: imageData as ImageData | null };
          });
          const layerHashes = layerSnapshots.map(snap =>
            snap.imageData ? hashImageData(snap.imageData) : this._savedLayerBlobs.get(snap.id)!.hash);
          const viewport = this.canvas?.getViewport() ?? { zoom: 1, panX: 0, panY: 0 };
          const viewportSize = this.canvas?.getViewportSize() ?? null;
          const historySnapshot = this.canvas?.getHistory() ?? [];
          const historyIndex = this.canvas?.getHistoryIndex() ?? -1;
          const trackingGeneration = this._trackingGeneration;
          const historyPlan = this._planHistorySave(projectId, historySnapshot);
          const clearExistingHistory = historyPlan.rewrite;

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
              layerSnapshots.map((snap, i) => {
                // Unchanged since the last save and still referenced by the
                // stored state: keep the stored PNG rather than re-encoding it.
                const saved = this._savedLayerBlobs.get(snap.id);
                if (saved && saved.hash === layerHashes[i] && oldLayerRefs.includes(saved.blobRef)) {
                  return {
                    id: snap.id, name: snap.name, visible: snap.visible, opacity: snap.opacity,
                    blendMode: snap.blendMode, imageBlobRef: saved.blobRef,
                  };
                }
                let imageData = snap.imageData;
                if (!imageData) {
                  // Reused, but the stored state no longer references our blob
                  // (e.g. another tab saved this project): encode the live layer.
                  const live = this._state.layers.find(l => l.id === snap.id)?.canvas;
                  if (!live) throw new Error(`Layer ${snap.id} disappeared during save`);
                  imageData = live.getContext('2d')!.getImageData(0, 0, live.width, live.height);
                  // Record the hash of what is actually stored, so a later save
                  // can't match the old hash and keep these different pixels.
                  layerHashes[i] = hashImageData(imageData);
                  snapshotTrusted = false;
                }
                return serializeLayerFromImageData(snap, imageData, trackingBlobs);
              }),
            );

            serializedEntries = await Promise.all(
              historyPlan.add.map(async (entry, i) => ({
                projectId,
                index: historyPlan.firstIndex + i,
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
            viewportWidth: viewportSize?.width,
            viewportHeight: viewportSize?.height,
          };

          // The thumbnail only needs refreshing when the drawing changed; a
          // viewport- or setting-only save keeps the stored one.
          let thumbnail: Blob | null = null;
          const thumbKey = `${contentVersionAtSnapshot}|${viewport.zoom},${viewport.panX},${viewport.panY}`
            + `|${viewportSize?.width}x${viewportSize?.height}`;
          const thumbnailCurrent = !floatSnap && oldThumbRef && thumbKey === this._savedThumbKey;
          if (this.canvas?.mainCanvas && !thumbnailCurrent) {
            try { thumbnail = await canvasToBlob(this._renderThumbnail(this.canvas.mainCanvas)); } catch { /* non-critical */ }
          }

          // Save state + history atomically: if either fails, restore the
          // previous state record (so the project doesn't point at deleted
          // blob refs) and clean up the new blobs.
          try {
            await this._backend!.state.save(stateRecord);
            if (clearExistingHistory) {
              await this._backend!.history.replaceAll(projectId, serializedEntries);
            } else if (historyPlan.remove.length > 0 || serializedEntries.length > 0) {
              // _planHistorySave only plans an incremental save when updateEntries exists.
              await this._backend!.history.updateEntries!(
                projectId,
                historyPlan.remove.map(([, saved]) => saved.index),
                serializedEntries,
              );
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

          // Record what is now stored immediately after state+history succeed.
          // If thumbnail/metadata fails later (e.g. QuotaExceededError), the
          // next autosave won't re-append the same history entries.
          if (this._currentProject?.id === projectId && this._trackingGeneration === trackingGeneration) {
            this._recordSavedHistory(projectId, historyPlan, serializedEntries);
            this._savedLayerBlobs = new Map(layerSnapshots.map((snap, i) => (
              [snap.id, { hash: layerHashes[i], blobRef: layers[i].imageBlobRef }]
            )));
            this._savedContentVersion = snapshotTrusted ? contentVersionAtSnapshot : -1;
          }

          // Update project metadata (thumbnail failure is non-fatal for data integrity)
          let newThumbRef = oldThumbRef;
          try {
            if (thumbnail) {
              newThumbRef = await blobs.put(thumbnail);
              await this._backend!.projects.update(projectId, { thumbnailRef: newThumbRef });
              if (this._currentProject?.id === projectId && this._trackingGeneration === trackingGeneration) {
                // The thumbnail is rendered after the snapshot's awaits; trust it
                // only if the view it captured is still the snapshot's.
                const vpNow = this.canvas?.getViewport();
                const viewUnchanged = vpNow?.zoom === viewport.zoom
                  && vpNow.panX === viewport.panX && vpNow.panY === viewport.panY;
                this._savedThumbKey = snapshotTrusted && viewUnchanged ? thumbKey : null;
              }
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
          // Entries that left the undo stack no longer need their blobs.
          if (!clearExistingHistory) {
            for (const [, saved] of historyPlan.remove) staleRefs.push(...saved.blobRefs);
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

          // Keep saves at least this far apart (and the indicator, when shown,
          // up long enough not to flash), but skip the delay when flushing
          // (beforeunload/visibilitychange) to avoid data loss on page close.
          if (!skipDelay) {
            const elapsed = Date.now() - saveStartTime;
            if (elapsed < 1500) {
              await new Promise(resolve => setTimeout(resolve, 1500 - elapsed));
            }
          }

          if (!this._saveRequested || !this._dirty) {
            break;
          }
          // Edits landed during this save. Unless flushing, let the debounce
          // pick them up so the next save also waits out a stroke in progress.
          if (!flushingThisRun && !this._forceFlushNextSave && this.canvas?.isGestureActive?.()) {
            this._scheduleSave();
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
    // Embedded, Ctrl/Cmd+S saves from anywhere, text fields included, rather
    // than falling through to the browser's "Save page as".
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 's' || e.code === 'KeyS') && this.embedded) {
      e.preventDefault();
      // A held key repeats; one press is one save.
      if (!e.repeat) this._requestSave();
      return;
    }
    if (this._isTextEntryTarget(e)) {
      return;
    }
    if (e.key === 'Escape' && this.canvas?.hasExternalFloat) {
      e.preventDefault();
      this.canvas.cancelExternalFloat();
      return;
    }
    // Transform mode shortcuts
    if (e.key === 'Escape' && this.canvas?.isTransformActive()) {
      e.preventDefault();
      this.canvas.cancelTransform();
      return;
    }
    if (e.key === 'Enter' && this.canvas?.isTransformActive()) {
      e.preventDefault();
      this.canvas.commitTransform();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Mid-gesture (a stroke, a drag, a float being moved) these would start or
    // end a float under it and leave the gesture's pixels outside history.
    if (this.canvas?.isGestureActive?.()
      && ((ctrl && ['t', 'c', 'x', 'v', 'd', 'a'].includes(key)) || e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      return;
    }
    if (ctrl && key === 't') {
      e.preventDefault();
      // As Ctrl+A and Ctrl+D do: the float's numeric panel is the select tool's.
      if (this._state.activeTool !== 'select') {
        this.canvas?.cancelCrop();
        if (!this.canvas?.isTransformActive()) this.canvas?.clearSelection();
        this._state = { ...this._state, activeTool: 'select' };
        this._markDirty('setting');
      }
      this.canvas?.enterTransformMode();
      return;
    }
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
      this.canvas?.paste();
    } else if (ctrl && key === 'd') {
      e.preventDefault();
      if (this._state.activeTool !== 'select') {
        this.canvas?.cancelCrop();
        // An active float is what gets duplicated, so it stays.
        if (!this.canvas?.isTransformActive()) this.canvas?.clearSelection();
        this._state = { ...this._state, activeTool: 'select' };
        this._markDirty('setting');
      }
      this.canvas?.duplicateInPlace();
    } else if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      (this._state.activeTool === 'select' || this._state.activeTool === 'stamp' || this.canvas?.isTransformActive())
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
    } else if (ctrl && key === 'a' && e.shiftKey) {
      e.preventDefault();
      if (this._state.activeTool !== 'select') {
        this.canvas?.cancelCrop();
        this.canvas?.clearSelection();
        this._state = { ...this._state, activeTool: 'select' };
        this._markDirty('setting');
      }
      this.canvas?.selectAllCanvas();
    } else if (ctrl && key === 'a' && !e.shiftKey) {
      e.preventDefault();
      if (this._state.activeTool !== 'select') {
        this.canvas?.cancelCrop();
        this.canvas?.clearSelection();
        this._state = { ...this._state, activeTool: 'select' };
        this._markDirty('setting');
      }
      this.canvas?.selectAll();
    } else if (e.key === '0' && ctrl) {
      e.preventDefault();
      this.canvas?.zoomToFit();
    } else if (ctrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.canvas?.zoomIn();
    } else if (ctrl && e.key === '-') {
      e.preventDefault();
      this.canvas?.zoomOut();
    } else if (!ctrl && !e.altKey && (key === '[' || key === ']')) {
      e.preventDefault();
      if (this._state.activeTool === 'stamp') {
        const current = this._state.stampSize;
        const next = key === ']'
          ? Math.max(current + 1, Math.round(current * 1.1))
          : Math.min(current - 1, Math.round(current / 1.1));
        this._updateStampSize(next);
        return;
      }
      const current = this._state.brush.size;
      const maxSize = 150;
      const minSize = 1;
      if (key === ']') {
        const newSize = Math.min(maxSize, Math.max(current + 1, Math.round(current * 1.1)));
        this._updateBrush({ size: newSize });
      } else {
        const newSize = Math.max(minSize, Math.min(current - 1, Math.round(current / 1.1)));
        this._updateBrush({ size: newSize });
      }
    } else if (!ctrl && !e.altKey && (e.key === '{' || e.key === '}')) {
      e.preventDefault();
      const current = this._state.brush.hardness;
      if (e.key === '}') {
        this._updateBrush({ hardness: Math.round(Math.min(1, current + 0.1) * 10) / 10 });
      } else {
        this._updateBrush({ hardness: Math.round(Math.max(0, current - 0.1) * 10) / 10 });
      }
    } else if (!ctrl && !e.altKey && !e.shiftKey && key.length === 1) {
      const tool = toolForShortcut(key);
      if (tool && tool !== this._state.activeTool) {
        e.preventDefault();
        this.canvas?.cancelCrop();
        // As the toolbar does: the select and hand tools keep an active float.
        if (!(keepsFloat(tool) && this.canvas?.isTransformActive())) this.canvas?.clearSelection();
        this._state = { ...this._state, activeTool: tool };
        this._markDirty('setting');
      }
    }
  };

  private async _resetToFreshProject(width = 800, height = 600, background: string | null = '#ffffff') {
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
      brush: getDefaultDescriptor(),
      activePreset: 'round',
      isPresetModified: false,
      stampImage: null,
      activeStampId: null,
      stampSize: DEFAULT_STAMP_SIZE,
      layers: [layer],
      activeLayerId: layer.id,
      // On phones the layers sheet would cover the toolbar, so start it closed.
      layersPanelOpen: !this._isMobile,
      documentWidth: w,
      documentHeight: h,
      cropAspectRatio: 'free',
      fontFamily: 'sans-serif',
      fontSize: 24,
      fontBold: false,
      fontItalic: false,
      eyedropperSampleAll: true,
      childMode: false,
    };
    await this.updateComplete;
    this.canvas?.setHistory([], -1);
    if (background) {
      const ctx = layer.canvas.getContext('2d')!;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
    }
    this.canvas?.composite();
    this._dirty = false;
    // Storage may still hold history for this project (e.g. a load that
    // failed part-way), so the next save must replace it rather than append.
    this._trackLoadedProject(this._currentProject?.id ?? null, [], []);
    this._historyNeedsRewrite = true;
    if (this._isMobile) this._desktopLayersPanelOpen = true;
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
      // The stored PNGs are what these layers were just decoded from, so a
      // layer still holding the same pixels at the next save can keep its blob.
      const layerBlobs = new Map(layers.map((layer, i) => {
        const imageData = layer.canvas.getContext('2d')!
          .getImageData(0, 0, layer.canvas.width, layer.canvas.height);
        return [layer.id, { hash: hashImageData(imageData), blobRef: record.layers[i].imageBlobRef }];
      }));

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
      // Restore brush descriptor from flat saved fields (backward compat)
      const ts = record.toolSettings;
      const defaultDesc = getDefaultDescriptor();
      const restoredBrush: BrushDescriptor = {
        size: ts.brushSize ?? defaultDesc.size,
        opacity: ts.opacity ?? defaultDesc.opacity,
        flow: ts.flow ?? defaultDesc.flow,
        hardness: ts.hardness ?? defaultDesc.hardness,
        spacing: ts.spacing ?? defaultDesc.spacing,
        pressureSize: ts.pressureSize ?? defaultDesc.pressureSize,
        pressureOpacity: ts.pressureOpacity ?? defaultDesc.pressureOpacity,
        pressureCurve: ts.pressureCurve ?? defaultDesc.pressureCurve,
        tip: { ...defaultDesc.tip, ...(ts.tip ?? {}) },
        ink: { ...defaultDesc.ink, ...(ts.ink ?? {}) },
      };
      this._state = {
        activeTool: ts.activeTool === 'marker' as string ? 'pencil' : ts.activeTool,
        strokeColor: ts.strokeColor,
        fillColor: ts.fillColor,
        useFill: ts.useFill,
        brush: restoredBrush,
        activePreset: ts.activePreset ?? 'round',
        isPresetModified: ts.isPresetModified ?? false,
        stampImage: null,
        activeStampId: null,
        stampSize: normalizeStampSize(ts.stampSize),
        layers,
        activeLayerId: validActiveId,
        layersPanelOpen: record.layersPanelOpen && !this._isMobile,
        documentWidth: record.canvasWidth,
        documentHeight: record.canvasHeight,
        cropAspectRatio: ts.cropAspectRatio ?? 'free',
        fontFamily: ts.fontFamily ?? 'sans-serif',
        fontSize: ts.fontSize ?? 24,
        fontBold: ts.fontBold ?? false,
        fontItalic: ts.fontItalic ?? false,
        eyedropperSampleAll: ts.eyedropperSampleAll ?? true,
        childMode: ts.childMode ?? false,
      };
      if (this._isMobile) this._desktopLayersPanelOpen = record.layersPanelOpen;
      await this.updateComplete;
      this.canvas?.setHistory(history, record.historyIndex ?? (history.length - 1));
      this._dirty = false;
      this._trackLoadedProject(projectId, history, historyRecords, layerBlobs);
      // Restore saved viewport or fall back to centering for legacy records
      if (record.zoom != null && record.panX != null && record.panY != null) {
        const savedSize = record.viewportWidth != null && record.viewportHeight != null
          ? { width: record.viewportWidth, height: record.viewportHeight }
          : undefined;
        this.canvas?.restoreViewport(record.zoom, record.panX, record.panY, savedSize);
      } else {
        this.canvas?.resetView();
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

  /**
   * Commits a pasted or dropped image's float before the layer list changes
   * around it. Cancelling it removes its layer and that layer's history, and
   * the indices of other reorders and deletions would then be off by one.
   */
  private _acceptPastedImage() {
    if (this.canvas?.hasExternalFloat) this.canvas.commitTransform();
  }

  private _buildContextValue(): DrawingContextValue {
    return {
      state: this._state,
      setTool: (tool: ToolType) => {
        if (this._state.activeTool !== tool) {
          this.canvas?.cancelCrop();
          // The select tool is where a float is worked on (its numeric panel),
          // and the hand tool pans around it, so both keep an active float.
          if (!(keepsFloat(tool) && this.canvas?.isTransformActive())) {
            if (this.canvas?.isTransformActive()) this.canvas.commitTransform();
            this.canvas?.clearSelection();
          }
        }
        this._state = { ...this._state, activeTool: tool };
        this._markDirty('setting');
      },
      setStrokeColor: (color: string) => {
        this._state = { ...this._state, strokeColor: color };
        this._markDirty('setting');
      },
      setFillColor: (color: string) => {
        this._state = { ...this._state, fillColor: color };
        this._markDirty('setting');
      },
      setUseFill: (useFill: boolean) => {
        this._state = { ...this._state, useFill };
        this._markDirty('setting');
      },
      setBrushSize: (size: number) => {
        const safe = Number.isNaN(size) ? this._state.brush.size : size;
        this._updateBrush({ size: Math.max(1, Math.min(150, safe)) });
      },
      setStampSize: (size: number) => {
        this._updateStampSize(size);
      },
      setStampImage: (img: HTMLImageElement | null, stampId: string | null = null) => {
        this._state = { ...this._state, stampImage: img, activeStampId: img ? stampId : null };
        this._markDirty('setting');
      },
      undo: () => this.canvas?.undo(),
      redo: () => this.canvas?.redo(),
      clearCanvas: () => this.canvas?.clearCanvas(),
      saveCanvas: () => this._requestSave(),
      embedded: this.embedded,
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
        this._acceptPastedImage();
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
        this._markDirty('setting');
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
        const safe = Number.isFinite(opacity) ? opacity : 1;
        const clamped = Math.max(0, Math.min(1, safe));
        const newLayers = this._state.layers.map(l => l.id === id ? { ...l, opacity: clamped } : l);
        this._state = { ...this._state, layers: newLayers };
        this._markDirty();
      },
      reorderLayer: (id: string, newIndex: number) => {
        const oldIndex = this._state.layers.findIndex(l => l.id === id);
        if (oldIndex === -1 || oldIndex === newIndex) return;
        this._acceptPastedImage();
        const newLayers = [...this._state.layers];
        const [layer] = newLayers.splice(oldIndex, 1);
        const normalizedIndex = newIndex < 0
          ? Math.max(newLayers.length + newIndex, 0)
          : Math.min(newIndex, newLayers.length);
        newLayers.splice(normalizedIndex, 0, layer);
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'reorder', fromIndex: oldIndex, toIndex: normalizedIndex });
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
      setLayerBlendMode: (id: string, mode: BlendMode) => {
        const layer = this._state.layers.find(l => l.id === id);
        if (!layer || layer.blendMode === mode) return;
        const before = layer.blendMode;
        const newLayers = this._state.layers.map(l =>
          l.id === id ? { ...l, blendMode: mode } : l
        );
        this._state = { ...this._state, layers: newLayers };
        this.canvas?.pushLayerOperation({ type: 'blend-mode', layerId: id, before, after: mode });
        this._markDirty();
      },
      mergeLayerDown: (id: string) => {
        const layers = this._state.layers;
        const idx = layers.findIndex(l => l.id === id);
        if (idx <= 0) return; // bottom layer or not found

        this.canvas?.clearSelection();
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;

        // Composite: bottom layer first, then active layer on top
        const bottomLayer = layers[idx - 1];
        const topLayer = layers[idx];
        const mergedCanvas = this._compositeLayers([bottomLayer, topLayer], null);

        // Build new layers array: remove topLayer, replace bottomLayer's canvas
        const newLayers = layers
          .filter(l => l.id !== topLayer.id)
          .map(l => l.id === bottomLayer.id
            ? { ...l, canvas: mergedCanvas, opacity: 1, blendMode: 'normal' as BlendMode }
            : l);

        this._state = { ...this._state, layers: newLayers, activeLayerId: bottomLayer.id };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId: bottomLayer.id,
        });
        this._markDirty();
      },
      mergeVisibleLayers: () => {
        const layers = this._state.layers;
        const visibleLayers = layers.filter(l => l.visible);
        if (visibleLayers.length < 2) return;

        this.canvas?.clearSelection();
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;

        // Target is the bottom-most visible layer
        const target = visibleLayers[0];
        const mergedCanvas = this._compositeLayers(visibleLayers, null);

        // Remove all visible layers except target, replace target's canvas
        const visibleIds = new Set(visibleLayers.map(l => l.id));
        const newLayers = layers
          .filter(l => !visibleIds.has(l.id) || l.id === target.id)
          .map(l => l.id === target.id
            ? { ...l, canvas: mergedCanvas, opacity: 1, blendMode: 'normal' as BlendMode }
            : l);

        // If active layer was hidden, it survives the merge — keep it active.
        // Otherwise the merged result becomes active.
        const activeLayerSurvived = newLayers.some(l => l.id === previousActiveLayerId);
        const afterActiveLayerId = activeLayerSurvived ? previousActiveLayerId : target.id;

        this._state = { ...this._state, layers: newLayers, activeLayerId: afterActiveLayerId };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId,
        });
        this._markDirty();
      },
      flattenImage: () => {
        if (this._state.layers.length <= 1) return;

        this.canvas?.clearSelection();
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;

        // Composite only visible layers
        const visibleLayers = this._state.layers.filter(l => l.visible);
        const target = visibleLayers.length > 0 ? visibleLayers[0] : this._state.layers[0];
        const mergedCanvas = this._compositeLayers(visibleLayers);

        // Single layer remains
        const flatLayer: Layer = {
          id: target.id,
          name: target.name,
          visible: true,
          opacity: 1,
          blendMode: 'normal' as BlendMode,
          canvas: mergedCanvas,
        };

        this._state = { ...this._state, layers: [flatLayer], activeLayerId: flatLayer.id };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId: flatLayer.id,
        });
        this._markDirty();
      },
      toggleLayersPanel: () => {
        this._state = { ...this._state, layersPanelOpen: !this._state.layersPanelOpen };
        this._markDirty('setting');
      },
      setCropAspectRatio: (ratio: string) => {
        this._state = { ...this._state, cropAspectRatio: ratio };
        this._markDirty('setting');
      },
      setFontFamily: (family: string) => {
        this._state = { ...this._state, fontFamily: family };
        this._markDirty('setting');
      },
      setFontSize: (size: number) => {
        const safe = Number.isFinite(size) ? size : 8;
        this._state = { ...this._state, fontSize: Math.max(8, Math.min(200, safe)) };
        this._markDirty('setting');
      },
      setFontBold: (bold: boolean) => {
        this._state = { ...this._state, fontBold: bold };
        this._markDirty('setting');
      },
      setFontItalic: (italic: boolean) => {
        this._state = { ...this._state, fontItalic: italic };
        this._markDirty('setting');
      },
      setBrush: (partial: Partial<BrushDescriptor>) => { this._updateBrush(partial); },
      setBrushTip: (tip: Partial<TipDescriptor>) => {
        this._updateBrush({ tip: { ...this._state.brush.tip, ...tip } });
      },
      setBrushInk: (ink: Partial<InkDescriptor>) => {
        this._updateBrush({ ink: { ...this._state.brush.ink, ...ink } });
      },
      selectPreset: (presetId: string) => {
        const preset = getPresetById(presetId);
        if (!preset) return;
        const desc = preset.descriptor;
        this._state = {
          ...this._state,
          brush: { ...desc, tip: { ...desc.tip }, ink: { ...desc.ink } },
          activePreset: presetId,
          isPresetModified: false,
        };
        this._markDirty('setting');
      },
      setEyedropperSampleAll: (v: boolean) => { this._state = { ...this._state, eyedropperSampleAll: v }; this._markDirty('setting'); },
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
          await this._enterProject(meta, () => this._loadProject(id));
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
          await this._enterProject(meta, async () => {
            this._projectList = await this._backend!.projects.list();
            await this._resetToFreshProject(width, height);
            this.canvas?.resetView();
          });
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
              const next = this._projectList[0];
              await this._enterProject(next, () => this._loadProject(next.id));
            } else {
              const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
              this._projectList = [meta];
              await this._enterProject(meta, async () => {
                await this._resetToFreshProject();
                this.canvas?.resetView();
              });
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
      transformActive: this.canvas?.isTransformActive() ?? false,
      getTransformValues: () => this.canvas?.getTransformValues() ?? null,
      setTransformValue: (key: string, value: number | boolean) => this.canvas?.setTransformValue(key, value),
      setChildMode: (on: boolean) => {
        this._state = { ...this._state, childMode: on };
        // Switch to pencil when entering child mode if current tool isn't child-friendly
        if (on && !CHILD_TOOL_SET.has(this._state.activeTool)) {
          // As any tool switch does: a float, crop or text in progress ends.
          if (this.canvas?.isTransformActive()) this.canvas.commitTransform();
          this.canvas?.cancelCrop();
          this.canvas?.clearSelection();
          this._state = { ...this._state, activeTool: 'pencil' };
        }
        this._markDirty('setting');
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
    // A float starting only makes Undo apply; nothing to save.
    if (e.detail.stackChanged !== false) this._markDirty();
    this._reportModified();
  }

  // ── Host API ──────────────────────────────────────────────
  // For pages that embed this element and keep the document themselves; see
  // `embedded`. Everything here also works on a standalone app.

  /** Resolves once storage is open and a document is on the canvas; rejects if storage failed. */
  whenReady(): Promise<void> {
    return this._ready;
  }

  /**
   * Replace the document with `source`, at the image's own size, on a single
   * layer, with empty history. The image is not composited over white, so its
   * transparency survives `exportImage({ background: null })`. Calls to this
   * and `newDocument` run one at a time, in the order they were made.
   */
  openImage(source: Blob, options: { name?: string } = {}): Promise<void> {
    return this._replaceDocumentInTurn(async () => {
      const bitmap = await createImageBitmap(source);
      try {
        // Refuse before anything changes when this browser says it cannot
        // hold a canvas this large (Safari caps the area), rather than leaving
        // a blank document named after the image on screen. Other browsers
        // may only fail later, at the paint.
        checkDocumentSize(bitmap.width, bitmap.height);
        const probe = document.createElement('canvas');
        probe.width = bitmap.width;
        probe.height = bitmap.height;
        const fits = !!probe.getContext('2d');
        probe.width = probe.height = 0;
        if (!fits) {
          throw new RangeError(`This browser cannot open a ${bitmap.width}\u00d7${bitmap.height} image`);
        }
        await this._replaceDocument(bitmap.width, bitmap.height, null, options.name ?? 'Untitled',
          (layer) => layer.canvas.getContext('2d')!.drawImage(bitmap, 0, 0));
      } finally {
        bitmap.close();
      }
    });
  }

  /** Replace the document with a blank one; `background: null` leaves it transparent. */
  newDocument(
    width: number,
    height: number,
    options: { name?: string; background?: string | null } = {},
  ): Promise<void> {
    return this._replaceDocumentInTurn(() => this._replaceDocument(
      width, height, options.background === undefined ? '#ffffff' : options.background, options.name ?? 'Untitled'));
  }

  /**
   * Flatten the visible layers into an encoded image. `background` defaults
   * to none (transparent), except for JPEG, which has no alpha and gets white.
   * Work in progress (a transform, a floating selection, text being typed) is
   * committed first, so the image is what the reader sees. It renders in call
   * order with `openImage`/`newDocument`: after the ones called before it, and
   * never the document of one called after. The rendered state is what a
   * later `markSaved()` records.
   */
  async exportImage(options: { type?: string; quality?: number; background?: string | null } = {}): Promise<Blob> {
    const type = options.type ?? 'image/png';
    const background = options.background !== undefined
      ? options.background
      : (type === 'image/jpeg' ? '#ffffff' : null);
    // Rendered in its turn among openImage/newDocument, before this first
    // await: an export renders the document that was open when it was asked
    // for, whatever the host opens next.
    const rendered = this._documentReplacement.then(async () => {
      await this._ready;
      this.canvas.clearSelection();
      const canvas = this.canvas.renderFlattened(background);
      return { canvas, mark: this._markDocument() };
    });
    this._documentReplacement = rendered.catch(() => {});
    const { canvas, mark } = await rendered;
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error(`Could not encode the image as ${type}`));
          return;
        }
        // Only an export the host received is one markSaved() may record.
        this._exportedDocument = mark;
        this._exportMarks.set(blob, mark);
        resolve(blob);
      }, type, options.quality);
    });
  }

  /** True when the document differs from the one opened or last saved (see `markSaved`). */
  get modified(): boolean {
    if (!this.canvas) return false;
    if (this.canvas.isTransformActive() || this.canvas.hasPendingText()) return true;
    const top = this._historyTop();
    if (top !== this._savedDocument.top) return true;
    return top === null && this.canvas.getHistoryTrimmedCount() !== this._savedDocument.trimmed;
  }

  /**
   * Record the host's copy as current. Given the Blob `exportImage()` returned,
   * the document as that export rendered it, so changes made while the host
   * was storing it, and later exports that have not landed, still read as
   * modified. Without one, the last export's document, or the document as it
   * is now if nothing was exported since it was opened. An export of a
   * document that has since been replaced is ignored: it says nothing about
   * the one open now.
   */
  markSaved(exported?: Blob): void {
    const fromExport = exported ? this._exportMarks.get(exported) : undefined;
    if (fromExport && fromExport.generation !== this._documentGeneration) return;
    this._savedDocument = fromExport ?? this._exportedDocument ?? this._markDocument();
    this._exportedDocument = null;
    this._reportModified();
  }

  /** Show the whole new document: at 100% when it fits, zoomed out until it does otherwise. */
  private async _showWholeDocument() {
    // The canvas takes the new document size from context on its own update.
    await this.updateComplete;
    const canvas = this.canvas;
    if (!canvas) return;
    await canvas.updateComplete;
    canvas.resetView();
  }

  private _historyTop(): HistoryEntry | null {
    const index = this.canvas?.getHistoryIndex() ?? -1;
    return index >= 0 ? this.canvas.getHistory()[index] ?? null : null;
  }

  private _markDocument(): DocumentMark {
    return {
      top: this._historyTop(),
      trimmed: this.canvas?.getHistoryTrimmedCount() ?? 0,
      generation: this._documentGeneration,
    };
  }

  /** A new document is open, and as it is now it is the saved one. */
  private _markSaved() {
    this._documentGeneration++;
    this._savedDocument = this._markDocument();
    this._exportedDocument = null;
    this._reportModified();
  }

  private _replaceDocumentInTurn(replace: () => Promise<void>): Promise<void> {
    const turn = this._documentReplacement.then(async () => {
      await this._ready;
      await replace();
      await this._showWholeDocument();
      this._markDirty();
      this._markSaved();
    });
    // A failed replacement must not stop the ones queued behind it.
    this._documentReplacement = turn.catch(() => {});
    return turn;
  }

  /** Fires `modified-change` when `modified` flips. */
  private _reportModified() {
    const modified = this.modified;
    if (modified === this._lastReportedModified) return;
    this._lastReportedModified = modified;
    this.dispatchEvent(new CustomEvent('modified-change', {
      detail: { modified },
      bubbles: true,
      composed: true,
    }));
  }

  /** Save, as the host sees it: embedded, the host is asked; standalone, a PNG downloads. */
  private _requestSave() {
    if (!this.embedded) {
      this.canvas?.saveCanvas();
      return;
    }
    // Commit a floating selection so the host exports what the reader sees.
    this.canvas?.clearSelection();
    this.dispatchEvent(new CustomEvent('save-request', { bubbles: true, composed: true }));
  }

  /**
   * Start a new project holding a fresh document and make it current.
   * Embedded, the previous project is deleted: the host keeps the document,
   * so keeping old ones here would only hold their memory.
   */
  private async _replaceDocument(
    width: number,
    height: number,
    background: string | null,
    name: string,
    paint?: (layer: Layer) => void,
  ) {
    width = Math.round(width);
    height = Math.round(height);
    checkDocumentSize(width, height);
    this.canvas?.cancelCrop();
    this.canvas?.clearSelection();
    if (this._savePromise || this._dirty) {
      await this._flushPendingSaveAndWait();
    }
    const previous = this._currentProject;
    const meta = await this._backend!.projects.create({ name, thumbnailRef: null });
    // Recent stamps are the user's, not the document's; they follow along
    // before the previous project, and its stamps, are discarded.
    if (this.embedded && previous) await this._carryStamps(previous.id, meta.id);
    await this._enterProject(meta, async () => {
      await this._resetToFreshProject(width, height, background);
      // Painted while the load holds autosave off, so no save sees the blank layer.
      if (paint) {
        paint(this._state.layers[0]);
        this.canvas?.composite();
      }
    });
    if (this.embedded && previous) {
      // The new document is already on screen; failing to free the old one
      // only costs memory, and must not fail the replacement.
      try {
        await this._projectService!.deleteProject(previous.id);
      } catch (err) {
        console.warn('Could not discard the previous document:', err);
      }
    }
    this._projectList = await this._backend!.projects.list();
  }

  /** Best effort: a stamp that cannot be copied is only a stamp to pick again. */
  private async _carryStamps(fromId: string, toId: string) {
    const backend = this._backend!;
    let stamps: StampEntry[];
    try {
      stamps = await backend.stamps.list(fromId);
    } catch (err) {
      console.warn('Could not keep the recent stamps:', err);
      return;
    }
    for (const stamp of stamps) {
      try {
        await backend.stamps.add(toId, await backend.blobs.get(stamp.blobRef), stamp.createdAt);
      } catch (err) {
        console.warn('Could not keep a recent stamp:', err);
      }
    }
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
    this._markDirty('viewport');
  }

  private _onTransformChange() {
    this.requestUpdate();
    this._reportModified();
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
          ? newLayers[Math.min(Math.max(0, removedIdx - 1), newLayers.length - 1)].id
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
          blendMode: snapshot.blendMode ?? ('normal' as BlendMode),
          canvas,
        };
        const newLayers = [...this._state.layers];
        const idx = detail.index === -1 ? newLayers.length : detail.index;
        newLayers.splice(idx, 0, layer);
        const activeStillExists = newLayers.some(l => l.id === this._state.activeLayerId);
        this._state = { ...this._state, layers: newLayers, activeLayerId: activeStillExists ? this._state.activeLayerId : layer.id };
        break;
      }
      case 'reorder': {
        const newLayers = [...this._state.layers];
        if (detail.fromIndex < 0 || detail.fromIndex >= newLayers.length ||
            detail.toIndex < 0 || detail.toIndex >= newLayers.length) break;
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
          return { ...layer, canvas, visible: snap.visible, opacity: snap.opacity, blendMode: snap.blendMode ?? ('normal' as BlendMode), name: snap.name };
        });
        this._applyDocumentDimensions(width, height);
        this._state = { ...this._state, layers: newLayers };
        break;
      }
      case 'stack-replace': {
        const snapshots = detail.layers as LayerSnapshot[];
        const activeLayerId = detail.activeLayerId as string;
        const newLayers: Layer[] = snapshots.map(snap => {
          const canvas = document.createElement('canvas');
          canvas.width = snap.imageData.width;
          canvas.height = snap.imageData.height;
          canvas.getContext('2d')!.putImageData(snap.imageData, 0, 0);
          return {
            id: snap.id,
            name: snap.name,
            visible: snap.visible,
            opacity: snap.opacity,
            blendMode: snap.blendMode ?? ('normal' as BlendMode),
            canvas,
          };
        });
        this._state = { ...this._state, layers: newLayers, activeLayerId };
        break;
      }
    }
    this._markDirty();
  }

  private _updateMobileLayout(width: number) {
    const useMobileLayout = shouldUseMobileLayout(width, this._isMobile);
    if (useMobileLayout === this._isMobile) return;

    this._isMobile = useMobileLayout;
    // The layers sheet covers the mobile toolbar; don't carry an open desktop
    // sidebar over into it.
    if (useMobileLayout) {
      this._desktopLayersPanelOpen = this._state.layersPanelOpen;
      this._state = { ...this._state, layersPanelOpen: false };
    } else if (this._desktopLayersPanelOpen !== null) {
      this._state = { ...this._state, layersPanelOpen: this._desktopLayersPanelOpen };
      this._desktopLayersPanelOpen = null;
    }
    // Child mode uses the compact toolbar; disable it when switching to desktop.
    if (!useMobileLayout && this._state.childMode) {
      this._state = { ...this._state, childMode: false };
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this._initStorage();
    this._mobileObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this._updateMobileLayout(entry.contentRect.width);
      }
    });
    this._mobileObserver.observe(this);
    this.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('focusin', this._onDocumentFocusIn);
    document.addEventListener('keydown', this._onStrayKeyDown);
    document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
    window.addEventListener('beforeunload', this._onBeforeUnload);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  /**
   * Whether keys pressed with nothing focused are the editor's: focus last
   * fell from something in it (a button that was disabled or removed, say)
   * rather than the user clicking away from it on the page.
   */
  private _strayKeysOurs = false;

  // Focus or a press anywhere says whose they are (another editor's, say).
  private _onDocumentFocusIn = (e: FocusEvent) => {
    this._strayKeysOurs = e.composedPath().includes(this);
  };

  private _onDocumentPointerDown = (e: PointerEvent) => {
    this._strayKeysOurs = e.composedPath().includes(this);
  };

  private _onStrayKeyDown = (e: KeyboardEvent) => {
    // Tab moves on from where focus was, as the browser does.
    if (!this._strayKeysOurs || e.defaultPrevented || e.key === 'Tab') return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    // Take the keyboard back, so later keys come straight here; an editor
    // that can't take it (hidden, inert, no tabindex) leaves keys alone.
    this.focus({ preventScroll: true });
    if (document.activeElement !== this) return;
    this._onKeyDown(e);
  };

  private _initStorage() {
    if (this._initPromise) return;
    this._initPromise = this._doInitStorage();
  }

  private async _doInitStorage() {
    try {
      const callerSupplied = !!this.storageBackend;
      const backend = this.storageBackend ?? (this.embedded ? new MemoryBackend() : new IndexedDBBackend());
      await backend.init();
      this._backend = backend;
      this._ownsBackend = !callerSupplied;
      this._autosave = !(this.embedded && !callerSupplied);
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
      this._markSaved();
      this._resolveReady();
    } catch (e) {
      this._rejectReady(e);
      console.error('Storage initialization failed:', e);
      this._storageState = 'error';
      this._storageError = 'Could not open local storage. Try reloading or checking browser storage settings.';
    }
  }

  private async _bootstrapProjects() {
    this._projectList = await this._backend!.projects.list();
    if (this._projectList.length > 0) {
      const first = this._projectList[0];
      await this._enterProject(first, () => this._loadProject(first.id));
    } else {
      const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
      this._currentProject = meta;
      this._projectList = [meta];
      this._markDirty();
      // The first render may have measured a pre-mobile layout; fit to the real one.
      await this.updateComplete;
      await this.canvas?.updateComplete;
      this.canvas?.resetView();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._mobileObserver?.disconnect();
    this._mobileObserver = null;
    this.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('focusin', this._onDocumentFocusIn);
    document.removeEventListener('keydown', this._onStrayKeyDown);
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    // Deliver a coalesced wheel/pinch viewport change while it can still be saved.
    this.canvas?.flushViewportChange?.();
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
      ${!this._isMobile ? html`<tool-settings></tool-settings>` : ''}
      <div class="main-area">
        <app-toolbar></app-toolbar>
        <drawing-canvas
          @history-change=${this._onHistoryChange}
          @layer-undo=${this._onLayerUndo}
          @crop-commit=${this._onCropCommit}
          @transform-change=${this._onTransformChange}
          @pending-text-change=${this._reportModified}
          @viewport-change=${this._onViewportChange}
        ></drawing-canvas>
        ${!this._isMobile ? html`
          <div class="right-sidebar ${this._state.layersPanelOpen ? '' : 'collapsed'}">
            <navigator-panel
              @navigator-pan=${this._onNavigatorPan}
              @navigator-zoom=${this._onNavigatorZoom}
            ></navigator-panel>
            <layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>
          </div>
        ` : ''}
      </div>
      ${this._isMobile && !this._state.childMode ? html`<layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-app': DrawingApp;
  }
}

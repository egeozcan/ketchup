import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import { blendModeToCompositeOp, type BlendMode, type BrushDescriptor, type TipDescriptor, type InkDescriptor } from '../engine/types.js';
import { getDefaultDescriptor, getPresetById } from '../engine/brush-presets.js';
import type { DrawingState, HistoryEntry, Layer, LayerSnapshot, ToolType } from '../types.js';
import type { DrawingCanvas } from './drawing-canvas.js';
import { IndexedDBBackend, MemoryBackend, ProjectService, StorageQuotaError, StorageNotFoundError, collectBlobRefsFromEntry, storageBackendContext, projectServiceContext } from '../storage/index.js';
import type { StorageBackend, BlobStore, BlobRef, ProjectMeta as StorageProjectMeta, ProjectHistoryRecord, StampEntry } from '../storage/types.js';
import { canvasToBlob, PixelDecodeError } from '../utils/canvas-helpers.js';
import { hashImageData } from '../utils/image-diff.js';
import { historyByteBudget, serializedHistoryEntryBytes } from '../utils/history-size.js';
import {
  serializeLayerFromImageData, deserializeLayer,
  serializeHistoryEntry, deserializeHistoryEntry,
} from '../utils/storage-serialization.js';
import { toolForShortcut, CHILD_TOOL_SET } from './tool-icons.js';
import { DEFAULT_STAMP_SIZE, normalizeStampSize } from '../tools/stamp-size.js';
import './app-toolbar.js';
import './tool-settings.js';
import { generateUUID } from '../utils/uuid.js';
import { containsAcrossShadows } from '../utils/focus-editor.js';
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

/** What stores a layer's saved blob: its pixel hash, and the canvas and revision it was stored from (see `getLayerRevision`). */
interface SavedLayerBlob {
  hash: string;
  blobRef: BlobRef;
  rev?: string | null;
  canvas?: HTMLCanvasElement;
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

    /* The layout lives here too, so a host page's own display rule on the
       element (display: block is common) can't undo it. */
    .app {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    .main-area {
      display: flex;
      flex: 1;
      min-height: 0;
      position: relative;
    }

    /* Inside the editor, so an embedded one doesn't cover its host page. */
    .save-banner {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 60;
      max-width: calc(100% - 32px);
      padding: 6px 12px;
      border-radius: 6px;
      background: #8b2c2c;
      color: #fff;
      font-size: 13px;
      pointer-events: none;
    }

    .save-error {
      color: #ff8a8a;
    }

    /* Another tab is editing this project: shown, not editable, here. */
    .read-only {
      position: absolute;
      inset: 0;
      z-index: 50;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 16px;
      background: rgba(30, 30, 30, 0.72);
      color: #eee;
      font-size: 14px;
      text-align: center;
    }

    .notices {
      position: absolute;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      z-index: 60;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      width: max-content;
      max-width: calc(100% - 32px);
    }

    .notice {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      background: rgba(30, 30, 30, 0.92);
      color: #eee;
      font-size: 13px;
    }

    .notice .notice-action {
      padding: 4px 10px;
      border-radius: 4px;
      background: #4a90d9;
      font-size: 13px;
    }

    .notice button {
      border: none;
      background: none;
      color: inherit;
      font-size: 16px;
      cursor: pointer;
    }

    .read-only-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
    }

    .read-only button {
      padding: 8px 18px;
      border: none;
      border-radius: 6px;
      background: #4a90d9;
      color: #fff;
      font-size: 14px;
      cursor: pointer;
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
  /** Opening storage waits on another window still on an older build. */
  @state() private _storageBlocked = false;
  /** Another window (a newer build) is upgrading storage: this one stores its work and steps aside. */
  @state() private _updateRequired = false;
  /** ...and has closed it: nothing is saved here any more, only a reload edits again. */
  @state() private _storageClosed = false;
  /** A newer build of the app is ready (`updateReady`): offered as a reload. */
  @state() private _updateReady = false;
  /** The offer was dismissed (the reload while hidden still happens). */
  @state() private _updateNoticeDismissed = false;
  /** Reloads the page (replaced in tests). */
  private _reload = () => location.reload();
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
  /** Ends the save loop's pause between saves early (set only while it sleeps). */
  private _wakeSaveSleep: (() => void) | null = null;
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
  /** `_contentVersion` as last loaded or written to storage; differing means work only here. */
  private _storedContentVersion = 0;
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
  private _savedLayerBlobs = new Map<string, SavedLayerBlob>();
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
    // Work another tab took the project from under is only on this page.
    if (this._stranded) {
      e.preventDefault();
      return;
    }
    // Storage closed for an upgrade before the work could be stored.
    if (this._storageClosed) {
      if (this._hasUnsavedWork()) e.preventDefault();
      return;
    }
    // Shown read-only, another tab has the work (one handing it over still saves).
    if (!this._ownsProject(this._currentProject?.id ?? '')) return;
    // Commit any active float so the layer canvas includes the selection content.
    // A crop being set up isn't work to commit; it stays (Stay on the prompt).
    this.canvas?.clearSelection({ keepCrop: true });
    this.canvas?.flushViewportChange?.();
    if (this._dirty) {
      // Start the async save — it may or may not complete before unload.
      const unsaved = this._hasUnsavedWork();
      this._flushPendingSave();
      // Show the browser's "Leave site?" dialog so the save has time to
      // finish, but only for real work: a pan/zoom or setting change alone
      // (restoreViewport after a load marks dirty) isn't worth a prompt.
      if (unsaved) e.preventDefault();
    }
  };

  /** Page going away (also fires where beforeunload doesn't, e.g. mobile): write at once. */
  private _onPageHide = () => {
    if (!this._ownsProject(this._currentProject?.id ?? '')) return;
    this.canvas?.clearSelection({ keepCrop: true });
    this.canvas?.flushViewportChange?.();
    if (this._dirty) this._flushPendingSave();
  };

  private _onVisibilityChange = () => {
    // Back in view, shown read-only: the other tab may have closed.
    if (!document.hidden && this._readOnly) void this._editHere(false);
    if (document.hidden) {
      // Commit any active float so the layer canvas includes the selection
      // content; a crop being set up stays for the user's return.
      this.canvas?.clearSelection({ keepCrop: true });
      // A coalesced wheel/pinch viewport change waits for a frame, and hidden
      // pages don't render frames.
      this.canvas?.flushViewportChange?.();
      // When the page is hidden (tab switch, close, refresh), flush immediately.
      // This fires before beforeunload and gives the save more time to complete.
      if (this._dirty) {
        this._flushPendingSave();
      }
      // An update waiting: a good moment to reload into it.
      if (this._updateReady || this._storageClosed) void this._reloadWhileHidden();
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

  /**
   * The last flush of an editor leaving the document, tried again a few times
   * if it fails: the 60 s retry doesn't run while detached, and nothing else
   * would store the work. A return resumes the ordinary retry.
   */
  private async _flushWhileDetached() {
    const id = this._currentProject?.id;
    await this._flushPendingSaveAndWait();
    let delay = DrawingApp.SAVE_RETRY_MIN / 2;
    for (let i = 0; i < 4; i++) {
      if (this.isConnected || !this._saveError || !this._dirty || !id || !this._canSaveProject(id)) return;
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      delay *= 2;
      if (this.isConnected) return;
      await this._flushPendingSaveAndWait();
    }
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

  /** Whether this tab may save the project now (backend open, not stranded/gone/deleting, lock held for its content). */
  private _canSaveProject(id: string): boolean {
    return !!this._backend && !this._storageClosed && id !== this._unsavableProjectId && id !== this._deletingProject
      && !this._projectGone && this._ownsProject(id)
      && this._projectLock === this._contentLock;
  }

  /** Tries a failed save again after a pause that doubles up to a minute. */
  private _scheduleSaveRetry() {
    // A detached editor retries when it is back (connectedCallback).
    if (this._saveRetryTimer || !this._autosave || !this.isConnected) return;
    const delay = this._saveRetryDelay;
    this._saveRetryDelay = Math.min(delay * 2, DrawingApp.SAVE_RETRY_MAX);
    this._saveRetryTimer = setTimeout(() => {
      this._saveRetryTimer = null;
      const id = this._currentProject?.id;
      // Saving isn't possible (lock lost, project gone or unsavable): the
      // stranded/gone screens say so, and a retry would only return early.
      if (!this._dirty || !id || this._stranded || !this._canSaveProject(id)) {
        this._clearSaveError();
        return;
      }
      if (this._projectLoads > 0) { this._scheduleSaveRetry(); return; }
      if (!this._saveTimer && !this._savePromise) void this._save();
    }, delay);
  }

  private _cancelSaveRetry() {
    if (this._saveRetryTimer) clearTimeout(this._saveRetryTimer);
    this._saveRetryTimer = null;
    this._saveRetryDelay = DrawingApp.SAVE_RETRY_MIN;
  }

  private _clearSaveError() {
    this._saveError = false;
    this._lastSaveError = null;
    this._cancelSaveRetry();
  }

  /** Back online: a save that failed may work now, so try at once. */
  private _onOnline = () => {
    if (!this._dirty || !this._autosave || this._projectLoads > 0) return;
    this._cancelSaveRetry();
    if (!this._savePromise) this._scheduleSave();
  };

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
    layerBlobs = new Map<string, SavedLayerBlob>(),
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
    // What was just decoded onto the layers is what is stored, as of the
    // revisions history now reports.
    this._savedLayerBlobs = new Map([...layerBlobs].map(([id, saved]) => {
      const layer = this._state.layers.find(l => l.id === id);
      return [id, { ...saved, rev: layer ? this.canvas?.getLayerRevision(id) ?? null : null, canvas: layer?.canvas }];
    }));
    // The first save after a load always reads the layers back.
    this._savedContentVersion = -1;
    this._storedContentVersion = this._contentVersion;
    this._savedThumbKey = null;
    // Restoring history during the load isn't a new edit to show as saving.
    this._unsavedWork = false;
  }

  /**
   * Make `meta` the current project and run `load` to bring its content in.
   * No save runs until the load finishes, since until then the canvas still
   * holds the previous project. Once loaded, it reads as unmodified. `stored`
   * says `load` brings in what storage holds (`_loadProject`): if that fails
   * the project is never saved over. A fresh document's failure is rethrown.
   */
  private async _enterProject(meta: StorageProjectMeta, load: () => Promise<void>, stored = false) {
    const generation = ++this._enterGeneration;
    // Another project was opened meanwhile: this one's load must not land,
    // nor wait any longer for another tab's save.
    const superseded = () => generation !== this._enterGeneration;
    this._enterAbort?.abort();
    const abort = this._enterAbort = new AbortController();
    let loadError: unknown = null;
    this._projectLoads++;
    this._keptElsewhere = false;
    this._stranded = false;
    this._keepError = '';
    this._overlayProjects = false;
    this._projectGone = false;
    this._noCanvas = false;
    // A failure of the last project's saves isn't this one's.
    this._saveFailed = false;
    this._clearSaveError();
    try {
      // Back in the page, storage may still be reopening.
      if (this._backendReopen) await this._backendReopen;
      if (superseded()) return;
      this._currentProject = meta;
      // One tab edits a project at a time: in another's, it's only shown.
      if (!(await this._lockProject(meta.id))) this._readOnly = true;
      // A tab that had it (and didn't answer in time to hand it over) may
      // still be writing a save.
      else await this._saveSettled(meta.id, abort.signal);
      if (superseded()) return;
      let noCanvas = false;
      try {
        await load();
      } catch (err) {
        if (superseded()) return;
        if (!stored) {
          // Nothing of this project is stored, so nothing is at risk: carry
          // on in a blank document of the default size and report the failure.
          console.error('Could not make the document:', err);
          loadError = err;
          if (!this.embedded) {
            this._notice = err instanceof RangeError
              ? "Couldn't make a canvas that large." : "Couldn't make the document.";
          }
          try {
            await this._resetToFreshProject();
          } catch (freshErr) {
            console.error('Could not start a blank document:', freshErr);
            noCanvas = true;
          }
        } else {
        // Whatever is on the canvas isn't this project's: it is never saved
        // over it. A fresh canvas carries on (unsaved), or none at all.
        console.error('Failed to open the project:', err);
        this._unsavableProjectId = meta.id;
        try {
          await this._resetToFreshProject();
        } catch (freshErr) {
          console.error('Could not start a blank document:', freshErr);
          noCanvas = true;
        }
        }
      }
      if (superseded()) return;
      // A load that failed carries on in a new project, which is ours.
      const current = this._currentProject ?? meta;
      if (current.id !== meta.id) await this._lockProject(current.id);
      this._contentLock = this._projectLock;
      // Editable once its own content is in, if still ours (another tab may
      // have asked for it meanwhile).
      this._noCanvas = noCanvas;
      this._readOnly = noCanvas || !this._ownsProject(current.id);
    } finally {
      this._projectLoads--;
      if (!superseded()) this._opening = false;
      // Saves wait for loads to end; one may have come due meanwhile.
      if (this._projectLoads === 0 && this._dirty && !this._saveTimer && !this._savePromise) this._scheduleSave();
    }
    if (superseded()) return;
    // Another document is open, however it was reached (the host API, or the
    // project menu when standalone): it is the saved one, and marks taken of
    // the previous one no longer apply.
    this._markSaved();
    this._rememberTabProject();
    if (loadError) throw loadError;
  }

  /** The project this tab had open before a reload (standalone). */
  private _readTabProject(): string | null {
    try {
      return sessionStorage.getItem('ketchup-tab-project');
    } catch {
      return null;
    }
  }

  private _rememberTabProject() {
    if (this.embedded || !this._currentProject) return;
    try {
      sessionStorage.setItem('ketchup-tab-project', this._currentProject.id);
    } catch {
      // Without session storage, a reload opens the project saved last.
    }
  }

  /** Shown while another tab of the standalone app has this project open for editing. */
  @state() private _readOnly = false;
  /** "Use here" asked the tab editing the project to let go, and it is saving first. */
  @state() private _waitingForTab = false;
  /** The project this tab holds the edit lock for, and how to let it go. */
  private _projectLock: { id: string; release: () => void } | null = null;
  /** The project lock the canvas content was loaded (or kept) under: saves are made only under it. */
  private _contentLock: { id: string; release: () => void } | null = null;
  /** Counts lock requests: one granted after another was made is let go at once. */
  private _lockRequest = 0;
  /** Ends a lock request queued behind the tab holding the lock. */
  private _lockWait: AbortController | null = null;
  /** Settles once the project lock this tab asked for last is held, or let go of as the browser sees it. */
  private _lockAsked: Promise<unknown> = Promise.resolve();
  /** Tabs of the app asking each other to hand a project over. */
  private _tabs: BroadcastChannel | null = null;
  /** Another tab asked for the project while this one was taking it back after a hand-over. */
  private _handOverAgain = false;
  /** Saving to hand the project to the tab that asked for it. */
  @state() private _handingOver = false;
  /** The tab editing the project couldn't save, so it kept the project. */
  @state() private _keptElsewhere = false;
  /** "Use here" got no answer from the tab editing the project; taking it is the user's call. */
  @state() private _otherTabSilent = false;
  private _forceTakeOver: (() => void) | null = null;
  /** Settles when the `_editHere` under way ends (so a wait it is in can be cancelled and awaited). */
  private _claimEnd: Promise<void> | null = null;
  /** "Keep as new project" was chosen during the `_editHere` under way: it ends without loading. */
  private _claimCancelled = false;
  /** The `_editHere` under way is taking the lock from its holder (cancelling that would lose it for both tabs). */
  private _stealing = false;
  /** Not even a blank document could be made: the tab holds the lock but has no canvas content to edit. */
  @state() private _noCanvas = false;
  /** The read-only overlay lists projects to open instead (phone layout). */
  @state() private _overlayProjects = false;
  /** Another tab took the project before this one stored its latest work, which is still here. */
  @state() private _stranded = false;
  /** Another tab deleted the project this tab shows (with `_stranded`, work of it isn't stored). */
  @state() private _projectGone = false;
  /** A short message about something that happened to the project list or the open project. */
  @state() private _notice = '';
  /** Saving that work as a new project. */
  @state() private _keeping = false;
  /** Waiting to load a project another tab is still saving. */
  @state() private _opening = false;
  /**
   * From the click on another project (or a new one) until its load ends: the
   * canvas and shortcuts are inert and "Opening the project…" shows.
   */
  @state() private _switching = false;
  /** Counts clicks to open a project, so only the latest goes ahead. */
  private _switchRequest = 0;
  /** A project this tab is deleting: it isn't saved, and its going isn't "deleted in another tab". */
  private _deletingProject: string | null = null;

  /**
   * Starts opening a project from a click: the editor goes inert and any
   * gesture under way is cancelled, then pending work is saved. Resolves true
   * if this is still the latest request (otherwise a newer one carries on).
   */
  private async _beginSwitch(request: number): Promise<boolean> {
    this._switching = true;
    // What happened to the last project isn't news about the next.
    this._notice = '';
    // A press still down would otherwise leave half a stroke for the save.
    this.canvas?.cancelGesture();
    // Commit any float so the save captures the layer with
    // the float content (no hole from a pending selection lift).
    this.canvas?.clearSelection();
    if (this._savePromise || this._dirty) await this._flushPendingSaveAndWait();
    // Unsaved work would be lost by going on: ask first.
    // Work held on screen after a lost lock stays: its own screen offers to keep or drop it.
    if (this._stranded) {
      this._endSwitch(request);
      return false;
    }
    if (this._hasUnsavedWork() && request === this._switchRequest
        && !confirm("Changes couldn't be saved — discard them?")) {
      this._endSwitch(request);
      return false;
    }
    return request === this._switchRequest;
  }

  /** Ends the opening started by `_beginSwitch` that didn't reach a load (or whose load ended). */
  private _endSwitch(request: number) {
    if (request === this._switchRequest) this._switching = false;
  }
  /** Counts project openings: one that a later opening replaced does nothing more. */
  private _enterGeneration = 0;
  /** Ends the latest opening's wait for another tab's save. */
  private _enterAbort: AbortController | null = null;
  /** Taking the project up here: getting its lock, then loading it. */
  @state() private _claiming = false;
  /** The last save failed, so its work is only here. */
  private _saveFailed = false;
  /** Saves are failing: shown until one succeeds, retried meanwhile with a growing pause. */
  @state() private _saveError = false;
  private _lastSaveError: unknown = null;
  private _saveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _saveRetryDelay = DrawingApp.SAVE_RETRY_MIN;
  private static readonly SAVE_RETRY_MIN = 2000;
  private static readonly STEAL_WAIT = 2000;
  private static readonly REASK_WAIT = 1500;
  private static readonly SAVE_RETRY_MAX = 60000;
  /** Why the last "Keep as a new project" failed, shown over the kept work. */
  @state() private _keepError = '';

  private get _locks(): LockManager | null {
    // Embedded editors keep their own documents; without Web Locks every tab
    // edits, as before.
    return this.embedded ? null : (navigator as Navigator & { locks?: LockManager }).locks ?? null;
  }

  /** Edits on the canvas that storage doesn't have yet. */
  private _hasUnsavedWork() {
    return (this._dirty && this._contentVersion !== this._storedContentVersion)
      || !!this.canvas?.hasPendingText?.();
  }

  /** Whether this tab may write project `id`: it holds its lock, or nothing is locked. */
  private _ownsProject(id: string) {
    return !this._locks || this._projectLock?.id === id;
  }

  /**
   * Takes the edit lock for a project, letting go of any other; resolves
   * whether this tab has it. `try` takes it only if free, `wait` queues
   * behind the tab holding it, `steal` takes it from that tab.
   */
  private _lockProject(id: string, mode: 'try' | 'wait' | 'steal' = 'try'): Promise<boolean> {
    if (this._projectLock?.id === id) {
      this._cancelLockRequests();
      return Promise.resolve(true);
    }
    this._releaseProjectLock();
    const locks = this._locks;
    if (!locks) return Promise.resolve(true);
    this._listenToTabs();
    const request = this._lockRequest;
    let options: LockOptions = { ifAvailable: true };
    if (mode === 'steal') {
      options = { steal: true };
    } else if (mode === 'wait') {
      this._lockWait = new AbortController();
      options = { signal: this._lockWait.signal };
    }
    let held: { id: string; release: () => void } | null = null;
    let asked: Promise<unknown> = Promise.resolve();
    // Asked once this tab's previous request has let go of whatever it gave
    // up (a grant not yet returned, a lock just released): asking for the
    // same project before then would find this tab's own lock in the way.
    // A steal doesn't wait on a request that never lets go (a grant stuck
    // behind a frozen callback): the lock is taken from whoever holds it.
    const turn = mode === 'steal'
      ? Promise.race([this._lockAsked, new Promise<void>(r => setTimeout(r, DrawingApp.STEAL_WAIT))])
      : this._lockAsked;
    const result = turn.then(() => new Promise<boolean>(resolve => {
      // Another project was asked for while this one waited its turn.
      if (request !== this._lockRequest) {
        resolve(false);
        return;
      }
      asked = locks.request(`ketchup-project:${id}`, options, lock => {
        // Not free, or another project was asked for since: settled below,
        // once let go.
        if (!lock || request !== this._lockRequest) return undefined;
        resolve(true);
        // Other tabs still waiting for it ask this one now.
        this._tabs?.postMessage({ type: 'taken', id });
        // Held until let go (another project, or handed over).
        return new Promise<void>(release => {
          held = { id, release };
          this._projectLock = held;
        });
      });
      asked.then(() => resolve(false), () => {
        // No longer waited for; or taken by another tab whose "Use here"
        // this one didn't answer: show it, don't save, but keep any work not
        // yet stored for the user to keep as a new project.
        resolve(false);
        if (!held || this._projectLock !== held) return;
        this._projectLock = null;
        this._readOnly = true;
        // A float moved since the last save is work too: onto its layer.
        this.canvas?.clearSelection({ keepCrop: true });
        this._stranded = this._hasUnsavedWork();
      });
    }));
    this._lockAsked = result.then(() => asked).catch(() => undefined);
    return result;
  }

  /** Makes lock requests still pending moot: a grant is let go at once, a wait ends. */
  private _cancelLockRequests() {
    this._lockRequest++;
    this._lockWait?.abort();
    this._lockWait = null;
  }

  private _releaseProjectLock() {
    this._cancelLockRequests();
    this._projectLock?.release();
    this._projectLock = null;
  }

  /** Waits for a save of project `id` that another tab still has under way, shown and not editable meanwhile. */
  private async _saveSettled(id: string, signal: AbortSignal) {
    const locks = this._locks;
    if (!locks) return;
    const name = `ketchup-save:${id}`;
    if (await locks.request(name, { ifAvailable: true }, lock => !!lock)) return;
    if (signal.aborted) return;
    this._readOnly = true;
    this._opening = true;
    // Ended early by opening another project.
    await locks.request(name, { signal }, () => undefined).catch(() => undefined);
  }

  private _listenToTabs() {
    if (this._tabs || typeof BroadcastChannel === 'undefined') return;
    this._tabs = new BroadcastChannel('ketchup-projects');
    this._tabs.addEventListener('message', (e: MessageEvent) => {
      const { type, id } = e.data ?? {};
      // Another tab wants to edit what this one is editing.
      if (type === 'release' && this._projectLock?.id === id) void this._handOver(id);
      // Asked while this tab takes the project back after a hand-over: asked again once it has.
      else if (type === 'release' && this._handingOver && this._currentProject?.id === id) this._handOverAgain = true;
      // Another tab created, renamed or deleted a project.
      else if (type === 'projects') void this._refreshProjects();
    });
  }

  /**
   * Whether another tab has a request for project `id`'s lock pending (given
   * a moment to show up, since it asks as it posts `release`). Assumed if the
   * browser can't say.
   */
  private async _projectWanted(id: string): Promise<boolean> {
    const query = this._locks?.query?.bind(this._locks);
    if (!query) return true;
    try {
      for (let i = 0; i < 6; i++) {
        const { pending = [] } = await query();
        if (pending.some(lock => lock.name === `ketchup-project:${id}`)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    } catch {
      return true;
    }
  }

  /** Whether a tab other than this one holds project `id`'s edit lock. */
  private async _openInAnotherTab(id: string): Promise<boolean> {
    const locks = this._locks;
    if (!locks?.query || this._projectLock?.id === id) return false;
    try {
      const { held = [] } = await locks.query();
      return held.some(lock => lock.name === `ketchup-project:${id}`);
    } catch {
      return false;
    }
  }

  private _lastSaveAnnounce = 0;
  private _saveAnnounceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * After a save, other tabs' project lists (thumbnail, order) are stale. Tell
   * them at most once per 5 s, with a trailing announcement. Receiving a
   * `projects` message only reloads the list; it never announces.
   */
  private _announceSavedThrottled() {
    if (this.embedded || this._saveAnnounceTimer !== undefined) return;
    const wait = Math.max(0, this._lastSaveAnnounce + 5000 - Date.now());
    this._saveAnnounceTimer = setTimeout(() => {
      this._saveAnnounceTimer = undefined;
      this._lastSaveAnnounce = Date.now();
      this._announceProjects();
    }, wait);
  }

  /** Tells other tabs that the list of projects changed. */
  private _announceProjects() {
    this._tabs?.postMessage({ type: 'projects' });
  }

  /**
   * Reloads the project list after another tab changed it, so renames reach
   * the open project and its deletion is noticed.
   */
  private async _refreshProjects() {
    if (!this._backend) return;
    let list: StorageProjectMeta[];
    try {
      list = await this._backend.projects.list();
    } catch {
      return;
    }
    this._projectList = list;
    const current = this._currentProject;
    if (!current || this._projectLoads > 0 || this.embedded) return;
    const fresh = list.find(p => p.id === current.id);
    if (fresh) {
      if (fresh.name !== current.name) this._currentProject = { ...current, name: fresh.name };
    // A list read before this tab created the project may lack it.
    } else if (!(await Promise.resolve().then(() => this._backend?.projects.get(current.id)).catch(() => current))) {
      void this._onProjectGone(current.id);
    }
  }

  /**
   * The project shown was deleted (by another tab). Work not stored stays on
   * screen to keep as a new project; otherwise another project opens.
   */
  private async _onProjectGone(id: string) {
    if (this._currentProject?.id !== id || this._projectLoads > 0 || this._projectGone || this.embedded
      || this._deletingProject === id) return;
    // A float moved since the last save is work too: onto its layer.
    this.canvas?.clearSelection({ keepCrop: true });
    this._projectGone = true;
    this._stranded = this._hasUnsavedWork();
    if (this._stranded) {
      this._readOnly = true;
      return;
    }
    await this._openAfterGone();
  }

  /** Opens a project in place of one that was deleted, and says so. */
  private async _openAfterGone(deletedName?: string) {
    const backend = this._backend;
    if (!backend) return;
    const gone = deletedName ?? this._currentProject?.name ?? 'The project';
    const list = await backend.projects.list();
    this._projectList = list;
    this._notice = `"${gone}" was deleted in another tab.`;
    if (list.length > 0) {
      const next = list[0];
      await this._enterProject(next, () => this._loadProject(next.id), true);
    } else {
      const meta = await backend.projects.create({ name: 'Untitled', thumbnailRef: null });
      this._projectList = [meta];
      await this._enterProject(meta, async () => {
        await this._resetToFreshProject();
        this.canvas?.resetView();
      });
      this._markDirty();
      this._announceProjects();
    }
  }

  /**
   * Hands the project to the tab that asked: answers at once (that tab then
   * waits however long the save takes), stops edits here, saves, and lets
   * go. A save that fails keeps the project here, with its work.
   */
  private async _handOver(id: string) {
    this._tabs?.postMessage({ type: 'releasing', id });
    if (this._handingOver) return;
    this._handingOver = true;
    this._handOverAgain = false;
    try {
      const held = this._projectLock;
      this._readOnly = true;
      this.canvas?.clearSelection({ keepCrop: true });
      if (this._dirty || this._savePromise) await this._flushPendingSaveAndWait();
      if (!held || this._projectLock !== held) return;
      if (this._dirty && this._saveFailed) {
        this._readOnly = this._noCanvas;
        this._tabs?.postMessage({ type: 'kept', id });
        return;
      }
      // The tab that asked may have given up meanwhile: no one waiting, so
      // stay editable rather than leave the project to no one.
      if (!(await this._projectWanted(id))) {
        if (this._projectLock === held) this._readOnly = this._noCanvas;
        return;
      }
      if (this._projectLock !== held) return;
      // Only content loaded under this very lock, with no load or stranded
      // state since, may be made writable again below.
      const contentIsHeld = this._contentLock === held && this._projectLoads === 0 && !this._stranded;
      this._releaseProjectLock();
      // The tab that asked is first in line; if it gave up since the check,
      // nobody holds the project, so this tab takes it back (saved: nothing
      // to reload) unless it has moved on meanwhile, or left the page (where
      // it would hold the project for no one; a return reloads it).
      if (contentIsHeld && !this._projectLock && this._readOnly && this._currentProject?.id === id && !this._claiming
        && !this._detached && !this._updateRequired
        && await this._lockProject(id) && this._currentProject?.id === id) {
        // Left the page while the lock was asked for.
        if (this._detached) {
          this._releaseProjectLock();
          return;
        }
        this._contentLock = this._projectLock;
        this._readOnly = this._noCanvas;
      }
    } finally {
      this._handingOver = false;
      // Another tab asked while the project was being taken back.
      const again = this._handOverAgain;
      this._handOverAgain = false;
      if (again && this._projectLock?.id === id) void this._handOver(id);
    }
  }

  /**
   * Edits the project shown read-only here, from what was last saved: if
   * free (the other tab closed, when this one comes back into view), or
   * (`takeOver`, "Use here") once the other tab has saved and let go.
   */
  private async _editHere(takeOver: boolean) {
    const meta = this._currentProject;
    if (!meta || !this._readOnly || this._projectLock || this._claiming || this._updateRequired) return;
    // Work kept from a take-over goes only by the user's choice (and work
    // not stored is kept, not reloaded away).
    if (!takeOver && (this._stranded || this._hasUnsavedWork())) {
      this._stranded = true;
      return;
    }
    this._claiming = true;
    this._claimCancelled = false;
    this._stealing = false;
    let claimEnd!: () => void;
    this._claimEnd = new Promise<void>(resolve => { claimEnd = resolve; });
    if (takeOver) this._keptElsewhere = false;
    try {
      // A save of this tab's from before it lost the project ends first
      // (it can't write now).
      if (this._savePromise) await this._savePromise;
      // Shown from the start, so "Opening…" doesn't flash before the wait.
      if (takeOver) this._waitingForTab = true;
      let got: boolean;
      try {
        got = await this._lockProject(meta.id);
      } catch (err) {
        this._waitingForTab = false;
        throw err;
      }
      if (!got && takeOver && this._currentProject?.id === meta.id && !this._claimCancelled) {
        try {
          got = await this._takeOver(meta.id);
        } finally {
          this._waitingForTab = false;
        }
      } else {
        this._waitingForTab = false;
      }
      // Keep was chosen meanwhile: a lock got stays (Keep moves it to the copy),
      // and nothing is reloaded over the work Keep is saving.
      if (!got || this._claimCancelled) return;
      // Taken out of the page during the wait (its storage may be closed):
      // let go, and a return edits it again (`connectedCallback`).
      if (this._detached || this._updateRequired) {
        if (this._ownsProject(meta.id)) this._releaseProjectLock();
        return;
      }
      // Opened as it is now (renamed meanwhile, say). Another project opened
      // meanwhile has its own lock; one got for this project but not loaded
      // under is let go.
      const current = this._currentProject;
      if (current?.id !== meta.id) {
        if (this._ownsProject(meta.id)) this._releaseProjectLock();
        return;
      }
      await this._enterProject(current, () => this._loadProject(current.id), true);
    } finally {
      this._stealing = false;
      this._claiming = false;
      claimEnd();
    }
  }

  /**
   * Asks the tab editing project `id` to save and let go, and waits until it
   * has (or has closed). If it doesn't answer within 2 s, it may be frozen
   * in the background or just busy (a long save, a dialog); if it answers
   * but hasn't let go 15 s later, its save may be stuck: either way the
   * user can take the lock from it (`_forceTakeOver`). Resolves false if its save failed: it
   * keeps the project, and that work.
   */
  private _takeOver(id: string): Promise<boolean> {
    const tabs = this._tabs;
    if (!tabs) {
      this._stealing = true;
      return this._lockProject(id, 'steal');
    }
    return new Promise<boolean>(resolve => {
      let stealing = false;
      let released = false;
      let offered = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reask: ReturnType<typeof setTimeout> | undefined;
      const answered = () => {
        clearTimeout(timer);
        clearTimeout(reask);
        this._otherTabSilent = false;
        this._forceTakeOver = null;
      };
      const onMessage = (e: MessageEvent) => {
        if (e.data?.id !== id) return;
        if (e.data.type === 'releasing') {
          // Answered again whenever it is asked again: the 15 s run from the
          // first answer, and an offer already made stays.
          if (released) return;
          released = true;
          clearTimeout(timer);
          // Saving to let go; if that seems stuck, taking over is offered
          // again (a save it has under way still lands first).
          if (!offered) timer = setTimeout(offerTakeOver, 15000);
          // The holder may have looked for this tab's request before it was
          // pending and kept the project: asked once more, it hands over (a
          // holder still saving just answers again).
          reask = setTimeout(() => tabs.postMessage({ type: 'release', id }), DrawingApp.REASK_WAIT);
        }
        // Another tab asking at the same time got it (unless this one is
        // already taking it).
        else if (e.data.type === 'taken') { if (!stealing) this._cancelLockRequests(); }
        // Ends the wait below.
        else if (e.data.type === 'kept') {
          if (stealing) return;
          this._keptElsewhere = true;
          this._cancelLockRequests();
        }
      };
      const done = (got: boolean) => {
        answered();
        tabs.removeEventListener('message', onMessage);
        resolve(got);
      };
      tabs.addEventListener('message', onMessage);
      // Granted once the other tab lets go, or closes.
      void this._lockProject(id, 'wait').then(got => {
        if (!stealing) done(got);
      });
      const request = this._lockRequest;
      const offerTakeOver = () => {
        // Unless something else was asked for since (which ended the wait).
        if (request !== this._lockRequest) return;
        offered = true;
        this._otherTabSilent = true;
        this._forceTakeOver = () => {
          stealing = true;
          this._stealing = true;
          answered();
          void this._lockProject(id, 'steal').then(done);
        };
      };
      timer = setTimeout(offerTakeOver, 2000);
      tabs.postMessage({ type: 'release', id });
    });
  }

  /**
   * Saves what this tab shows, taken over by another tab before its latest
   * work was stored, as a new project, and edits that.
   */
  private async _keepAsNewProject() {
    const from = this._currentProject;
    // Waiting for the other tab ("Use here without them"): that ends first.
    if (this._claiming && this._claimEnd) {
      // Not while it is taking the lock: letting go of that grant would cost
      // the other tab its lock without this one getting it.
      this._claimCancelled = true;
      if (!this._stealing) this._cancelLockRequests();
      await this._claimEnd;
    }
    if (!from || !this._backend || this._claiming || !this._stranded) {
      // A lock the cancelled claim got isn't needed.
      if (from && this._readOnly && this._projectLock?.id === from.id) this._releaseProjectLock();
      return;
    }
    this._claiming = true;
    this._keeping = true;
    this._keepError = '';
    // Puts the kept work back on screen, as it was, when the copy fails.
    let rollback: (() => void) | null = null;
    let kept = false;
    try {
      // This tab's save under way when the project was taken finishes, and
      // may store the work after all.
      if (this._savePromise) await this._savePromise;
      if (!this._stranded) return;
      let meta: StorageProjectMeta;
      try {
        meta = await this._backend.projects.create({ name: `${from.name} (copy)`, thumbnailRef: null });
      } catch (err) {
        this._keepError = err instanceof StorageQuotaError
          ? 'Storage is full, so the copy could not be saved.'
          : 'The copy could not be saved.';
        throw err;
      }
      // Back to showing the kept work if the copy can't be saved: nothing is
      // given up (stranded, read-only) until its content is stored.
      const priorGone = this._projectGone;
      const undo = () => {
        this._currentProject = from;
        this._projectGone = priorGone;
        this._releaseProjectLock();
        this._contentLock = null;
        this._clearSaveError();
        this._saveFailed = false;
        // The work is only on screen again: stranded, and not stored anywhere.
        this._stranded = true;
        this._storedContentVersion = -1;
        this._dirty = true;
        this._trackedProjectId = null;
        this._trackingGeneration++;
        this._rememberTabProject();
        void this._projectService?.deleteProject(meta.id).catch(() => undefined);
        void this._backend?.projects.list().then(list => { this._projectList = list; }).catch(() => undefined);
      };
      rollback = undo;
      if (!(await this._lockProject(meta.id))) {
        void this._projectService?.deleteProject(meta.id).catch(() => undefined);
        return;
      }
      this._contentLock = this._projectLock;
      await this._carryStamps(from.id, meta.id);
      this._currentProject = meta;
      this._projectList = await this._backend.projects.list().catch(() => [meta, ...this._projectList]);
      // All of it goes to the new project: the whole history, and every
      // layer encoded afresh.
      this._trackedProjectId = null;
      this._trackingGeneration++;
      this._savedHistory = new Map();
      this._nextHistoryRecordIndex = 0;
      this._savedLayerBlobs = new Map();
      this._savedContentVersion = -1;
      this._savedThumbKey = null;
      this._projectGone = false;
      this._saveFailed = false;
      this._keepError = '';
      this._markDirty();
      await this._flushPendingSaveAndWait();
      // Judged by whether the content is stored, not by how the save ended
      // (a failure after the writes still left the copy holding the work).
      if (this._hasUnsavedWork()) {
        this._keepError = this._lastSaveError instanceof StorageQuotaError
          ? 'Storage is full, so the copy could not be saved.'
          : 'The copy could not be saved.';
        undo();
        return;
      }
      kept = true;
      this._stranded = false;
      this._readOnly = false;
      this._overlayProjects = false;
      this._rememberTabProject();
      this._announceProjects();
    } catch (err) {
      console.error('Could not keep the work as a new project:', err);
      // A lock taken for the copy (after a steal, the only one this tab has)
      // would leave "Use here without them" with nothing to do.
      if (rollback && !kept) {
        this._keepError ||= 'The copy could not be saved.';
        (rollback as () => void)();
      }
    } finally {
      this._claiming = false;
      this._keeping = false;
      // A save refused while this ran isn't scheduled by anything else.
      if (this._dirty && this._autosave && !this._stranded) this._scheduleSave();
    }
  }

  /**
   * Whether this tab holds project `id`'s lock as the browser sees it, which
   * may be ahead of `_projectLock`. Called holding the project's save lock.
   */
  private async _holdsProjectLock(id: string): Promise<boolean> {
    const locks = this._locks;
    if (!locks) return true;
    if (this._projectLock?.id !== id) return false;
    if (!locks.query) return true;
    try {
      const { held = [] } = await locks.query();
      const me = held.find(lock => lock.name === `ketchup-save:${id}`)?.clientId;
      return !!me && held.some(lock => lock.name === `ketchup-project:${id}` && lock.clientId === me);
    } catch {
      return true;
    }
  }

  /** Runs a save's writes for project `id` holding its save lock (when there are locks). */
  private _holdingSaveLock<T>(id: string, write: () => Promise<T>): Promise<T> {
    const locks = this._locks;
    return locks ? locks.request(`ketchup-save:${id}`, {}, write) as Promise<T> : write();
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
      if (flushing) {
        this._forceFlushNextSave = true;
        // Cut the pause between saves short so this flush writes at once.
        this._wakeSaveSleep?.();
      }
      if (this._dirty) this._saveRequested = true;
      return this._savePromise;
    }
    if (!this._currentProject || !this._dirty || this._projectLoads > 0) return;
    const savingId = this._currentProject.id;
    // Only under the lock the content was loaded under: a tab holding a lock
    // it never loaded under (or took back without reloading) has stale content.
    if (!this._canSaveProject(savingId)) {
      // Nothing can retry it now: the banner would stay up for good.
      if (this._saveError) this._clearSaveError();
      return;
    }

    const enterGeneration = this._enterGeneration;
    this._savePromise = (async () => {
      this._saveInProgress = true;
      this._saveFailed = false;
      if (this._backendReopen) {
        await this._backendReopen;
        // Nothing can retry a save the project is no longer this tab's for.
        if (this._saveError && !this._canSaveProject(savingId)) this._clearSaveError();
      }
      let flushingThisRun = flushing;
      // Hands the write to a save-lock request made before encoding (a flush);
      // settled with null if the run ends without reaching the write.
      let proceedWrite: ((write: (() => Promise<boolean>) | null) => void) | null = null;
      try {
        // Only while this tab still has the project ("Use here anyway" in
        // another tab takes it; the writes below check again).
        while (this._currentProject?.id === savingId && this._dirty && this._projectLoads === 0
          && this._ownsProject(savingId) && this._projectLock === this._contentLock) {
          const projectId = savingId;
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
          const floatKey = this.canvas?.getFloatKey() ?? null;
          let floatSnapshot: ReturnType<DrawingCanvas['getFloatSnapshot']> | undefined;
          // Only the viewport moved since the last save and every layer still has
          // its stored blob: skip the full-canvas readback and hashing.
          const reuseSaved = !floatKey
            && contentVersionAtSnapshot === this._savedContentVersion
            && this._trackedProjectId === projectId
            && this._state.layers.every(l => this._savedLayerBlobs.has(l.id));
          // Per layer, the revision its pixels have now. The float's layer, whose
          // lift leaves a hole history doesn't know of, adds the float's key: the
          // same layer revision under the same float is the same stored pixels,
          // so an autosave of an unmoved huge float reads nothing back.
          const layerRevs = this._state.layers.map(l => {
            const rev = this.canvas?.getLayerRevision(l.id) ?? null;
            return floatKey && l.id === floatKey.layerId && rev !== null ? `${rev}|float:${floatKey.key}` : rev;
          });
          // A layer whose revision is the one it was stored under, on the same
          // canvas, still holds the stored pixels: it needn't be read back, so
          // only the layers an edit touched are read and hashed.
          const layerCanvases = this._state.layers.map(l => l.canvas);
          const layerUnchanged = this._state.layers.map((l, i) => {
            const saved = this._savedLayerBlobs.get(l.id);
            return layerRevs[i] !== null && !!saved && saved.rev === layerRevs[i] && saved.canvas === l.canvas
              && this._trackedProjectId === projectId;
          });
          // The layer with the float merged in, on a copy so the live canvas is
          // untouched; null when the float can't be had (stored but not trusted).
          const readLayerWithFloat = (
            canvas: HTMLCanvasElement,
            floatSnap = (floatSnapshot ??= this.canvas?.getFloatSnapshot() ?? null),
          ): ImageData | null => {
            if (!floatSnap) return null;
            const tmp = document.createElement('canvas');
            tmp.width = canvas.width;
            tmp.height = canvas.height;
            const tmpCtx = tmp.getContext('2d')!;
            tmpCtx.drawImage(canvas, 0, 0);
            tmpCtx.drawImage(floatSnap.tempCanvas, floatSnap.x, floatSnap.y);
            return tmpCtx.getImageData(0, 0, tmp.width, tmp.height);
          };
          const layerSnapshots = this._state.layers.map((l, i) => {
            const meta = { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode };
            if (reuseSaved || layerUnchanged[i]) return { ...meta, imageData: null as ImageData | null };
            if (floatKey && l.id === floatKey.layerId) {
              const imageData = readLayerWithFloat(l.canvas);
              if (!imageData) snapshotTrusted = false;
              return { ...meta, imageData: imageData ?? l.canvas.getContext('2d')!.getImageData(0, 0, l.canvas.width, l.canvas.height) as ImageData | null };
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
          // The lock this snapshot was taken under: one lost and taken again
          // since (the project reloaded) isn't it.
          const lockAtSnapshot = this._projectLock;
          const historyPlan = this._planHistorySave(projectId, historySnapshot);
          const clearExistingHistory = historyPlan.rewrite;

          // A flush (page going away) has little time: request the save lock
          // and check the browser's view of the project lock now, alongside
          // the reads and encoding below, instead of after them.
          let earlyWrite: Promise<boolean> | null = null;
          if (skipDelay) {
            const gate = new Promise<(() => Promise<boolean>) | null>(resolve => { proceedWrite = resolve; });
            earlyWrite = this._holdingSaveLock(projectId, async () => {
              if (this._locks && !(await this._holdsProjectLock(projectId))) return false;
              const write = await gate;
              return write ? write() : false;
            });
            earlyWrite.catch(() => {});
          }

          // Capture old blob refs before serializing new ones, so we can reclaim them after save.
          const blobs = this._backend!.blobs;
          const [oldState, oldProject, oldHistoryEntries] = await Promise.all([
            this._backend!.state.get(projectId),
            this._backend!.projects.get(projectId),
            clearExistingHistory ? this._backend!.history.getEntries(projectId) : Promise.resolve([]),
          ]);

          // Abort if the project was deleted (e.g. by another tab or a custom backend).
          // Writing state/history for a missing project creates orphaned data.
          if (!oldProject) {
            // Nothing can retry it now: the banner would stay up for good.
            this._clearSaveError();
            void this._onProjectGone(projectId);
            break;
          }

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
                  // The float's layer: whatever float is on it now is merged in
                  // (it may have moved since the snapshot; this save is stored
                  // untrusted, so the next one corrects it). With none left, the
                  // layer holds it, committed. A float that can't be had fails
                  // the save rather than storing the layer with a hole.
                  const nowOnLayer = this.canvas?.getFloatKey()?.layerId === snap.id;
                  if (nowOnLayer) {
                    const current = this.canvas?.getFloatSnapshot() ?? null;
                    if (!current) throw new Error(`Could not read the float on layer ${snap.id}`);
                    imageData = readLayerWithFloat(live, current)!;
                  } else {
                    imageData = live.getContext('2d')!.getImageData(0, 0, live.width, live.height);
                  }
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
          const thumbnailCurrent = !floatKey && oldThumbRef && thumbKey === this._savedThumbKey;
          if (this.canvas?.mainCanvas && !thumbnailCurrent) {
            try { thumbnail = await canvasToBlob(this._renderThumbnail(this.canvas.mainCanvas)); } catch { /* non-critical */ }
          }

          // Thumbnail and blob cleanup run holding the save lock too, so a tab
          // taking the project over (which waits for it) finds them done.
          const finishWrite = async () => {
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
          };

          // Written holding the project's save lock, which a tab taking the
          // project over waits for before it loads, and only if this tab
          // still holds the project as the browser sees it: one blocked by a
          // dialog may not know yet that "Use here anyway" took it, and the
          // tab that took it may have loaded already.
          const writeState = async () => {
            if (this._projectLock !== lockAtSnapshot || this._trackingGeneration !== trackingGeneration) return false;
            if (!earlyWrite && this._locks && !(await this._holdsProjectLock(projectId))) return false;
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
            await finishWrite();
            return true;
          };
          const wrote = earlyWrite
            ? (proceedWrite!(writeState), await earlyWrite)
            : await this._holdingSaveLock(projectId, writeState);
          if (!wrote) {
            blobs.deleteMany(pendingBlobRefs).catch(() => {});
            // A retry refused because the lock went: nothing will retry it, so
            // drop the banner; otherwise (reloaded meanwhile) try again.
            if (this._saveError) {
              if (this._canSaveProject(projectId)) this._scheduleSaveRetry();
              else this._clearSaveError();
            }
            break;
          }

          // Record what is now stored immediately after state+history succeed.
          // If thumbnail/metadata fails later (e.g. QuotaExceededError), the
          // next autosave won't re-append the same history entries.
          if (this._currentProject?.id === projectId && this._trackingGeneration === trackingGeneration) {
            this._recordSavedHistory(projectId, historyPlan, serializedEntries);
            this._savedLayerBlobs = new Map(layerSnapshots.map((snap, i) => (
              [snap.id, {
                hash: layerHashes[i],
                blobRef: layers[i].imageBlobRef,
                rev: snapshotTrusted ? layerRevs[i] : null,
                canvas: layerCanvases[i],
              }]
            )));
            this._savedContentVersion = snapshotTrusted ? contentVersionAtSnapshot : -1;
            this._storedContentVersion = contentVersionAtSnapshot;
          }

          // Mark clean only if no new edits landed while this save was in flight.
          if (this._currentProject?.id === projectId) {
            if (this._dirtyVersion === dirtyVersionAtSnapshot) {
              this._dirty = false;
            }
          }
          this._clearSaveError();

          // Best-effort: the content is stored by now, so a failed listing
          // mustn't read as a failed save.
          await this._backend!.projects.list().then(list => { this._projectList = list; }).catch(() => undefined);
          this._announceSavedThrottled();

          // Keep saves at least this far apart (and the indicator, when shown,
          // up long enough not to flash), but skip the delay when flushing
          // (beforeunload/visibilitychange) to avoid data loss on page close.
          if (!skipDelay && !this._forceFlushNextSave) {
            const elapsed = Date.now() - saveStartTime;
            if (elapsed < 1500) {
              await new Promise<void>(resolve => {
                const done = () => {
                  clearTimeout(timer);
                  if (this._wakeSaveSleep === done) this._wakeSaveSleep = null;
                  resolve();
                };
                const timer = setTimeout(done, 1500 - elapsed);
                this._wakeSaveSleep = done;
              });
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
        // A project since replaced is no news about this one; storage closed
        // for an upgrade can't be retried (its overlay says so).
        if (this._currentProject?.id === savingId && this._enterGeneration === enterGeneration && !this._storageClosed) {
          this._saveFailed = true;
          this._lastSaveError = err;
          this._saveError = true;
          this._scheduleSaveRetry();
        }
        if (err instanceof StorageQuotaError) {
          console.error('Storage quota exceeded. Consider deleting old projects to free space.');
        } else {
          console.error('Save failed:', err);
        }
      } finally {
        (proceedWrite as ((write: null) => void) | null)?.(null);
        this._saving = false;
        this._saveInProgress = false;
        // Taken mid-save, but the save got the work in after all.
        if (this._stranded && !this._hasUnsavedWork()) this._stranded = false;
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
      // What the host page wraps the editor in (its own modal dialog, say)
      // isn't where the key was typed.
      if (node === this) break;
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
    // Shown here while another tab edits it: no edits by key either.
    if (this._readOnly || this._switching) return;
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
    // Typing meant for text being edited, after a click on Bold or a colour
    // took the keyboard: back into the text, where the key lands (a focus
    // moved during keydown takes the typed character), not a shortcut. Enter
    // and arrows move on in the text too, unless the focused control uses
    // them (a slider, the font list); Escape stays with what has focus.
    const origin = e.composedPath()[0];
    const usesKeys = origin instanceof HTMLInputElement || origin instanceof HTMLSelectElement;
    const typing = e.key.length === 1 || ['Backspace', 'Delete', 'Dead', 'Process'].includes(e.key);
    const moving = ['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key);
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (typing || (moving && !usesKeys))
      && this.canvas?.focusText?.()) {
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
      // Used here, it isn't also a host dialog's close request.
      if (this._state.activeTool === 'crop' && this.canvas?.hasCropRect) {
        e.preventDefault();
        this.canvas.cancelCrop();
      } else if (this.canvas?.hasExternalFloat) {
        e.preventDefault();
        this.canvas.cancelExternalFloat();
      } else {
        // Ending text being typed uses it too (focus was on Bold, say).
        if (this.canvas?.isTextEditing?.()) e.preventDefault();
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
    const w = width;
    const h = height;
    const prevCounter = this._layerCounter;
    this._layerCounter = 0;
    const layer = this._createLayer(w, h);
    // A canvas the browser can't back fails here, before the state changes.
    if (!layer.canvas.getContext('2d')) {
      this._layerCounter = prevCounter;
      throw new RangeError(`This browser cannot make a ${w}\u00d7${h} canvas`);
    }
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
    // Child mode, which kept the compact layout at any width, is off now.
    if (this._layoutWidth > 0) this._updateMobileLayout(this._layoutWidth);
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
    // Opened by `_enterProject`: a later opening replaces this one.
    const generation = this._enterGeneration;
    const superseded = () => generation !== this._enterGeneration;
    try {
      this.canvas?.clearSelection();
      const record = await this._backend!.state.get(projectId);
      if (superseded()) return;
      if (!record) {
        // Deleted by another tab (a project not yet saved still has its entry).
        if (!(await this._backend!.projects.get(projectId).catch(() => ({})))) {
          if (superseded()) return;
          await this._replaceDeletedProject(projectId);
          return;
        }
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
      if (superseded()) return;
      if (layers.length === 0) {
        await this._resetToFreshProject();
        return;
      }

      const allHistoryRecords = await this._backend!.history.getEntries(projectId);
      // Decode only the entries that fit the undo memory budget (at least the
      // one under the index), one at a time so decoded pixels don't pile up
      // beyond it. Entries are kept from the index downward, then redo entries
      // upward while they fit, so redo never skips over a dropped one. What
      // isn't decoded is dropped from the stack, so the first save replaces
      // stored history rather than appending to it.
      const total = allHistoryRecords.length;
      // The stored index counts from the oldest stored entry, kept or not.
      const storedIndex = Math.min(record.historyIndex ?? (total - 1), total - 1);
      const budget = historyByteBudget();
      let bytes = 0;
      let keepFrom = storedIndex + 1;
      while (keepFrom > 0) {
        bytes += serializedHistoryEntryBytes(allHistoryRecords[keepFrom - 1].entry);
        if (bytes > budget && keepFrom < storedIndex + 1) break;
        keepFrom--;
      }
      let keepTo = storedIndex + 1;
      while (keepTo < total) {
        bytes += serializedHistoryEntryBytes(allHistoryRecords[keepTo].entry);
        if (bytes > budget) break;
        keepTo++;
      }
      const candidates = allHistoryRecords.slice(keepFrom, keepTo);
      let history: HistoryEntry[] = [];
      let firstKept = keepFrom;
      for (let i = 0; i < candidates.length; i++) {
        try {
          history.push(await deserializeHistoryEntry(candidates[i].entry, blobs));
        } catch (err) {
          if (superseded()) return;
          // Only corrupt data is dropped; a storage failure (transient read
          // error) fails the load, so history isn't deleted by a hiccup.
          const name = (err as { name?: string } | null)?.name;
          const missing = err instanceof StorageNotFoundError || name === 'StorageNotFoundError' ||
            name === 'NotFoundError' || name === 'NotReadableError';
          if (!(err instanceof PixelDecodeError || missing)) throw err;
          // An undecodable entry costs the history, not the project: drop it
          // and everything older (or, for a redo entry, it and what follows).
          console.error('Dropping undecodable history entry:', err);
          const abs = keepFrom + i;
          if (abs <= storedIndex) {
            history = [];
            firstKept = abs + 1;
          } else {
            keepTo = abs;
            break;
          }
        }
        if (superseded()) return;
      }
      if (superseded()) return;
      keepFrom = firstKept;
      const historyRecords = allHistoryRecords.slice(keepFrom, keepTo);
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
      // The layout the view is restored into: the size observer may not have
      // reported yet, and a phone restored in the desktop layout gets reset.
      // Its content width, as the observer reports it (not the safe-area padding).
      const style = getComputedStyle(this);
      const width = this.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (width > 0) this._updateMobileLayout(width);
      if (this._isMobile) this._desktopLayersPanelOpen = record.layersPanelOpen;
      await this.updateComplete;
      if (superseded()) return;
      this.canvas?.setHistory(history, storedIndex - keepFrom);
      this._dirty = false;
      this._trackLoadedProject(projectId, history, historyRecords, layerBlobs);
      if (keepFrom > 0 || keepTo < total) this._historyNeedsRewrite = true;
      // Loaded after all: what is stored is in, and saves go on over it.
      if (this._unsavableProjectId === projectId) this._unsavableProjectId = null;
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
      if (superseded()) return;
      console.error('Failed to load project:', err);
      // What is stored stays as it is: saving this blank document under its
      // id would replace it (and drop its images). Carry on in a new project,
      // or, if not even that can be made, without saving.
      try {
        const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
        if (superseded()) {
          void this._projectService?.deleteProject(meta.id).catch(() => undefined);
          return;
        }
        this._currentProject = meta;
        this._projectList = await this._backend!.projects.list();
        // Opened over meanwhile: nothing opened this one, so it stays empty.
        if (superseded()) {
          void this._projectService?.deleteProject(meta.id)
            .then(() => this._backend?.projects.list()).then(list => { if (list) this._projectList = list; })
            .catch(() => undefined);
          return;
        }
      } catch (createErr) {
        console.error('Could not start a new project:', createErr);
        this._unsavableProjectId = projectId;
      }
      if (superseded()) return;
      await this._resetToFreshProject();
    }
  }

  /**
   * Carries on in another project (or a new one) in place of `projectId`,
   * which was deleted, and says so. Entered afresh, so the new project's lock
   * is taken before its content loads; this opening is superseded by it.
   */
  private async _replaceDeletedProject(projectId: string) {
    const gone = this._projectList.find(p => p.id === projectId)?.name ?? 'The project';
    await this._openAfterGone(gone);
  }

  /** A project whose stored data failed to load and must not be saved over. */
  private _unsavableProjectId: string | null = null;


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
      clearCanvas: (allLayers = false) => {
        if (!allLayers) { this.canvas?.clearCanvas(); return; }
        // Every layer at once, as one undo step: the added layers go and the
        // bottom one comes back white.
        this.canvas?.clearSelection();
        const layers = this._state.layers;
        if (layers.length === 0) return;
        const beforeLayers = this._snapshotAllLayers();
        const previousActiveLayerId = this._state.activeLayerId;
        const base = layers[0];
        const w = this._state.documentWidth;
        const h = this._state.documentHeight;
        const cleared = document.createElement('canvas');
        cleared.width = w;
        cleared.height = h;
        const cctx = cleared.getContext('2d')!;
        cctx.fillStyle = '#ffffff';
        cctx.fillRect(0, 0, w, h);
        const baseLayer: Layer = { ...base, visible: true, opacity: 1, blendMode: 'normal' as BlendMode, canvas: cleared };
        this._state = { ...this._state, layers: [baseLayer], activeLayerId: baseLayer.id };
        const afterLayers = this._snapshotAllLayers();
        this.canvas?.pushLayerOperation({
          type: 'merge',
          beforeLayers,
          afterLayers,
          previousActiveLayerId,
          afterActiveLayerId: baseLayer.id,
        });
        this._markDirty();
      },
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
        const request = ++this._switchRequest;
        const doSwitch = async () => {
          if (!(await this._beginSwitch(request))) return;
          const meta = this._projectList.find(p => p.id === id);
          if (!meta) return;
          await this._enterProject(meta, () => this._loadProject(id), true);
        };
        doSwitch()
          .catch(err => console.error('Switch project failed:', err))
          .finally(() => this._endSwitch(request));
      },
      createProject: (name: string, width: number, height: number) => {
        const request = ++this._switchRequest;
        const doCreate = async () => {
          if (!(await this._beginSwitch(request))) return;
          // Announced once this tab has it open (and locked), not before: a
          // tab that listed it meanwhile could open it, and the delete below
          // doesn't check for that.
          const meta = await this._backend!.projects.create({ name, thumbnailRef: null });
          if (request !== this._switchRequest) {
            // Never opened, so nothing is in it: don't leave an empty project behind.
            await this._projectService!.deleteProject(meta.id).catch(() => {});
            this._announceProjects();
            this._projectList = await this._backend!.projects.list();
            return;
          }
          await this._enterProject(meta, async () => {
            this._projectList = await this._backend!.projects.list();
            await this._resetToFreshProject(width, height);
            this.canvas?.resetView();
          });
          this._announceProjects();
          this._markDirty();
        };
        doCreate()
          .catch(err => console.error('Create project failed:', err))
          .finally(() => this._endSwitch(request));
      },
      deleteProject: (id: string) => {
        const deletingCurrent = id === this._currentProject?.id;
        const request = deletingCurrent ? ++this._switchRequest : this._switchRequest;
        const doDelete = async () => {
          if (deletingCurrent) {
            if (!(await this._beginSwitch(request))) return;
          } else {
            this.canvas?.clearSelection();
            if (this._savePromise || this._dirty) await this._flushPendingSaveAndWait();
          }
          // Another tab editing it would lose what it has not stored.
          if (await this._openInAnotherTab(id)) {
            this._notice = 'That project is open in another tab. Close it there to delete it.';
            return;
          }
          // Its own deletion isn't a deletion by another tab, and nothing saves it back.
          this._deletingProject = id;
          try {
            await this._projectService!.deleteProject(id);
            this._announceProjects();
            this._projectList = await this._backend!.projects.list();
            if (request !== this._switchRequest && deletingCurrent) return;
            if (id === this._currentProject?.id) {
              if (this._projectList.length > 0) {
                const next = this._projectList[0];
                await this._enterProject(next, () => this._loadProject(next.id), true);
              } else {
                const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
                this._projectList = [meta];
                this._announceProjects();
                await this._enterProject(meta, async () => {
                  await this._resetToFreshProject();
                  this.canvas?.resetView();
                });
                this._markDirty();
              }
            }
          } finally {
            if (this._deletingProject === id) this._deletingProject = null;
          }
        };
        doDelete()
          .catch(err => console.error('Delete project failed:', err))
          .finally(() => { if (deletingCurrent) this._endSwitch(request); });
      },
      renameProject: (id: string, name: string) => {
        const doRename = async () => {
          const updated = await this._backend!.projects.update(id, { name });
          if (this._currentProject?.id === id) {
            this._currentProject = updated;
          }
          this._projectList = await this._backend!.projects.list();
          this._announceProjects();
        };
        doRename().catch(err => console.error('Rename project failed:', err));
      },
      transformActive: this.canvas?.isTransformActive() ?? false,
      getTransformValues: () => this.canvas?.getTransformValues() ?? null,
      setTransformValue: (key: string, value: number | boolean) => this.canvas?.setTransformValue(key, value),
      setChildMode: (on: boolean) => {
        this._state = { ...this._state, childMode: on };
        // Leaving it on a wide screen: the full layout again.
        if (!on && this._layoutWidth > 0) this._updateMobileLayout(this._layoutWidth);
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

  override updated(changed: PropertyValues) {
    // A dialog left open over an editor that is now inert (read-only, or
    // switching) would answer for a document this tab no longer edits.
    if ((changed.has('_readOnly') || changed.has('_switching')) && (this._readOnly || this._switching)) {
      this.canvas?.dismissResizeDialog();
    }
  }

  override willUpdate() {
    // Nothing edits again here after storage was upgraded elsewhere (a load
    // or hand-over under way may have made the tab editable since).
    if (this._updateRequired && !this._readOnly) this._readOnly = true;
    this._provider.setValue(this._buildContextValue());
    this.toggleAttribute('mobile', this._isMobile);
    // The overlay's project list belongs to one showing of the overlay.
    if (this._overlayProjects && !this._readOnly) this._overlayProjects = false;
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
        // (_replaceDocument runs the canvas probe, with this wording.)
        await this._replaceDocument(bitmap.width, bitmap.height, null, options.name ?? 'Untitled',
          (layer) => layer.canvas.getContext('2d')!.drawImage(bitmap, 0, 0),
          `This browser cannot open a ${bitmap.width}\u00d7${bitmap.height} image`);
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
      // A crop being set up isn't work to commit; it stays for the user.
      this.canvas.clearSelection({ keepCrop: true });
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
      // Text still being typed is on screen; the PNG has it too.
      this.canvas?.commitPendingText();
      this.canvas?.saveCanvas();
      return;
    }
    // Commit a floating selection so the host exports what the reader sees.
    this.canvas?.clearSelection({ keepCrop: true });
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
    cannotFitMessage?: string,
  ) {
    width = Math.round(width);
    height = Math.round(height);
    checkDocumentSize(width, height);
    // Refuse before anything is touched when the browser can't back a canvas
    // this size, so the current document and project stay as they are.
    {
      const probe = document.createElement('canvas');
      probe.width = width;
      probe.height = height;
      const fits = !!probe.getContext('2d');
      probe.width = probe.height = 0;
      if (!fits) throw new RangeError(cannotFitMessage ?? `This browser cannot make a ${width}×${height} canvas`);
    }
    this.canvas?.cancelCrop();
    this.canvas?.clearSelection();
    if (this._savePromise || this._dirty) {
      await this._flushPendingSaveAndWait();
    }
    const previous = this._currentProject;
    // Nothing stores the previous document without autosave (embedded, in
    // memory), so a failed replacement puts this very state back.
    const keep = !this._autosave && previous && this.canvas
      ? {
        state: this._state,
        history: this.canvas.getHistory(),
        index: this.canvas.getHistoryIndex(),
        counter: this._layerCounter,
        saved: this._savedDocument,
        generation: this._documentGeneration,
        exported: this._exportedDocument,
      }
      : null;
    // Announced once this tab has it open (see createProject).
    const meta = await this._backend!.projects.create({ name, thumbnailRef: null });
    // Recent stamps are the user's, not the document's; they follow along
    // before the previous project, and its stamps, are discarded.
    if (this.embedded && previous) await this._carryStamps(previous.id, meta.id);
    try {
      await this._enterProject(meta, async () => {
        await this._resetToFreshProject(width, height, background);
        // Painted while the load holds autosave off, so no save sees the blank layer.
        if (paint) {
          paint(this._state.layers[0]);
          this.canvas?.composite();
        }
      });
    } catch (err) {
      // The editor holds a blank stand-in for the document that failed: go
      // back to the previous project and drop the one made for this.
      if (previous) {
        try {
          await (keep
            ? this._enterProject(previous, async () => {
              this._layerCounter = keep.counter;
              this._state = keep.state;
              await this.updateComplete;
              this.canvas?.setHistory(keep.history, keep.index);
              this.canvas?.composite();
              this.canvas?.resetView();
              this._dirty = false;
              this._trackLoadedProject(previous.id, [], []);
            })
            : this._enterProject(previous, () => this._loadProject(previous.id), true));
          // Still the document it was: edits since its last save stay unsaved.
          if (keep) {
            // Marks (and exports in flight) from before the attempt are valid
            // again, so the generation goes back too rather than moving on.
            this._documentGeneration = keep.generation;
            this._savedDocument = keep.saved;
            this._exportedDocument = keep.exported;
            if (this._layoutWidth > 0) this._updateMobileLayout(this._layoutWidth);
            this._reportModified();
          }
        } catch (backErr) {
          console.error('Could not return to the previous document:', backErr);
        }
        if (this._currentProject?.id !== meta.id) {
          await this._projectService!.deleteProject(meta.id).catch(() => {});
          this._announceProjects();
        }
      }
      this._projectList = await this._backend!.projects.list().catch(() => this._projectList);
      throw err;
    }
    this._announceProjects();
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
    this._layoutWidth = width;
    // Child mode keeps the compact layout at any width: a phone turned on its
    // side would otherwise show a child the whole app (projects, delete).
    const useMobileLayout = this._state.childMode || shouldUseMobileLayout(width, this._isMobile);
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
  }

  /** The width the layout was last chosen for. */
  private _layoutWidth = 0;

  override connectedCallback() {
    super.connectedCallback();
    this._detached = false;
    // Standalone, the page is the editor: keys typed before any click are its.
    if (!this.embedded) this._strayKeysOurs = true;
    this._initStorage();
    // Back after a while away (a cached view, say): reopen what leaving closed.
    // A failing save's retry stopped while out of the document: resume.
    if (this._saveError && this._dirty) this._scheduleSaveRetry();
    if (this._backendClosed && this._backend) {
      this._backendClosed = false;
      const reopen = this._backend.init()
        .catch(e => console.error('Could not reopen storage:', e))
        .finally(() => { if (this._backendReopen === reopen) this._backendReopen = null; });
      this._backendReopen = reopen;
    }
    // Back after letting go of its project: edit it again, as now stored
    // (another tab may have changed it), if it's free.
    if (this._readOnly && !this._projectLock && this._projectLoads === 0) void this._editHere(false);
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
    window.addEventListener('online', this._onOnline);
    window.addEventListener('pagehide', this._onPageHide);
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
    // Typed inside the editor: its own handler has it. (In a host component's
    // shadow tree, the target seen here is that component.)
    if ((this.getRootNode() as Document | ShadowRoot).activeElement === this || e.composedPath().includes(this)) return;
    // Focus fell to the page, or to what holds the editor (a host's dialog,
    // or a host component whose shadow tree it is in).
    if (!(e.target instanceof Node) || !containsAcrossShadows(e.target, this)) return;
    // Take the keyboard back, so later keys come straight here; an editor
    // that can't take it (hidden, inert, no tabindex) leaves keys alone.
    this.focus({ preventScroll: true });
    if ((this.getRootNode() as Document | ShadowRoot).activeElement !== this) return;
    this._onKeyDown(e);
  };

  private _initStorage() {
    if (this._initPromise) return;
    this._initPromise = this._doInitStorage();
  }

  private async _doInitStorage() {
    try {
      const callerSupplied = !!this.storageBackend;
      const backend = this.storageBackend ?? (this.embedded ? new MemoryBackend() : new IndexedDBBackend({
        onBlocked: (b) => { this._storageBlocked = b; },
        onVersionChange: () => this._onStorageVersionChange(),
      }));
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
      // A reloaded tab reopens its own project (another tab may be editing
      // the one saved last); a new tab opens the one saved last.
      const own = this.embedded ? null : this._readTabProject();
      const first = this._projectList.find(p => p.id === own) ?? this._projectList[0];
      await this._enterProject(first, () => this._loadProject(first.id), true);
    } else {
      const meta = await this._backend!.projects.create({ name: 'Untitled', thumbnailRef: null });
      this._projectList = [meta];
      this._announceProjects();
      try {
        await this._enterProject(meta, async () => {
          // The first render may have measured a pre-mobile layout; fit to the real one.
          await this.updateComplete;
          await this.canvas?.updateComplete;
          this.canvas?.resetView();
        });
      } catch (err) {
        // The editor already carries on in a blank document: not a reason to fail the app.
        console.error('Could not start the first project cleanly:', err);
      }
      this._markDirty();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._detached = true;
    // Work in progress goes onto its layer while the canvas can still put it
    // there (it lets go of a float, a text box and a stroke as it leaves), and
    // in time for the save below. A crop being set up stays for a return.
    this.canvas?.clearSelection({ keepCrop: true });
    this._mobileObserver?.disconnect();
    this._mobileObserver = null;
    this.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('focusin', this._onDocumentFocusIn);
    document.removeEventListener('keydown', this._onStrayKeyDown);
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    window.removeEventListener('online', this._onOnline);
    this._cancelSaveRetry();
    window.removeEventListener('pagehide', this._onPageHide);
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
        ? this._flushWhileDetached()
        : this._savePromise!;
      savePromise.finally(() => {
        this._leaveProject();
        this._closeBackend(backendToDispose);
      });
    } else {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      // A move in the DOM reconnects at once; only an editor still out of
      // the document closes its storage and lets go of its project.
      setTimeout(() => this._leaveProject(), 0);
      if (this._ownsBackend) {
        const backend = this._backend;
        setTimeout(() => this._closeBackend(backend), 0);
      }
    }
  }

  /**
   * Lets another tab edit the project, once out of the document with the
   * last save in; it's then only shown here until a return reloads it. Work
   * not stored (its save failed) keeps the project here.
   */
  private _leaveProject() {
    if (this.isConnected || !this._projectLock || this._hasUnsavedWork()) return;
    // A project loading (back briefly, gone again) is let go once it's in.
    if (this._projectLoads > 0) {
      setTimeout(() => this._leaveProject(), 100);
      return;
    }
    this._releaseProjectLock();
    this._tabs?.close();
    this._tabs = null;
    this._readOnly = true;
  }

  /** Taken out of the document (and not back yet). */
  private _detached = false;
  /** Whether leaving the document closed our backend, which a return reopens. */
  private _backendClosed = false;
  private _backendReopen: Promise<void> | null = null;

  private _closeBackend(backend: StorageBackend | undefined) {
    if (!backend || this.isConnected) return;
    if (backend === this._backend) {
      // Work that couldn't be stored keeps storage open for another try
      // (and the project, `_leaveProject`).
      if (this._hasUnsavedWork()) return;
      // A project loading (back briefly, gone again) closes once it's in.
      if (this._projectLoads > 0) {
        setTimeout(() => this._closeBackend(backend), 100);
        return;
      }
    }
    // Reopening (back briefly, gone again): close once it's open.
    if (this._backendReopen) {
      void this._backendReopen.then(() => this._closeBackend(backend));
      return;
    }
    if (backend === this._backend) this._backendClosed = true;
    void backend.dispose();
  }

  /**
   * Another window (a newer build) wants to upgrade storage. Stops edits here,
   * stores what is under way, then (once this resolves the backend closes
   * the database) saves nothing more and lets go of the project, so the
   * upgrade goes ahead and that window can edit it. Only a reload, into the
   * newer build, edits here again.
   */
  private async _onStorageVersionChange() {
    if (this._updateRequired) return;
    this._updateRequired = true;
    this._readOnly = true;
    // Work in progress onto its layer, for the save below.
    this.canvas?.clearSelection({ keepCrop: true });
    this.canvas?.flushViewportChange?.();
    try {
      if (this._dirty || this._savePromise) await this._flushPendingSaveAndWait();
      await this._savesDone();
    } finally {
      this._storageClosed = true;
      this._clearSaveError();
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      this._releaseProjectLock();
      if (document.hidden) this._reloadIfIdle();
    }
  }

  /**
   * A newer build of the app has taken over this page's service worker (the
   * standalone app's entry calls this). Reloads into it while the page is
   * hidden with nothing to lose (now, or the next time it is hidden);
   * meanwhile offers a reload.
   */
  updateReady() {
    if (this.embedded) return;
    this._updateReady = true;
    if (document.hidden) void this._reloadWhileHidden();
  }

  private get _showUpdateNotice() {
    return this._updateReady && !this._updateNoticeDismissed && !this._updateRequired;
  }

  /** Settles once no save of this tab's is under way. */
  private async _savesDone() {
    while (this._savePromise) await this._savePromise.catch(() => undefined);
  }

  /** The page was hidden with an update waiting: stores what is pending, then reloads if still hidden and idle. */
  private async _reloadWhileHidden() {
    if (!this._storageClosed && this._dirty) await this._flushPendingSaveAndWait();
    await this._savesDone();
    if (document.hidden) this._reloadIfIdle();
  }

  /** Reloads for an update if nothing would be lost or cut short by it. */
  private _reloadIfIdle() {
    if (!this._updateReady && !this._storageClosed) return;
    if (this._hasUnsavedWork() || this._savePromise || this._stranded || this._claiming || this._keeping
      || this._handingOver || this._projectLoads > 0 || (this._dirty && !this._storageClosed)) return;
    this._reload();
  }

  /** The update banner's and overlay's Reload: stores what it can first. */
  private async _reloadForUpdate() {
    this.canvas?.clearSelection({ keepCrop: true });
    this.canvas?.flushViewportChange?.();
    if (!this._storageClosed && this._dirty) await this._flushPendingSaveAndWait();
    await this._savesDone();
    // Work that couldn't be stored: the browser asks first (beforeunload).
    this._reload();
  }

  /** A file dropped on the read-only overlay isn't opened by the browser in place of the app. */
  private _ignoreDrop = (e: DragEvent) => e.preventDefault();

  /** The read-only overlay's way to open another project (phone layout). */
  private _renderOverlayProjects() {
    return html`
      <button @click=${() => { this._overlayProjects = !this._overlayProjects; }}>Open another project</button>
      ${this._overlayProjects ? html`
        <div class="read-only-actions">
          ${this._projectList.filter(p => p.id !== this._currentProject?.id).map(p => html`
            <button @click=${() => { this._overlayProjects = false; this._buildContextValue().switchProject(p.id); }}>${p.name}</button>
          `)}
        </div>
      ` : ''}
    `;
  }

  /** The read-only overlay's "Use here" (as `label`), and what follows a press. */
  private _renderClaim(label: string) {
    if (this._waitingForTab) {
      return this._otherTabSilent ? html`
        <p>The other tab hasn't let go yet. It may be busy (a dialog, a long save) or frozen in the background. Taking over keeps any changes it hasn't saved there, to keep as a new project.</p>
        <button @click=${() => this._forceTakeOver?.()}>Use here anyway</button>
      ` : html`<p>Waiting for the other tab to save…</p>`;
    }
    if (this._claiming) return html`<p>${this._keeping ? 'Saving them as a new project…' : 'Opening the project…'}</p>`;
    return html`<button @click=${() => this._editHere(true)}>${label}</button>`;
  }

  override render() {
    if (this._storageState === 'loading') {
      return html`<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;">${this._storageBlocked ? 'Close other Ketchup windows to finish updating' : 'Loading...'}</div>`;
    }
    if (this._storageState === 'error') {
      return html`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#ff6b6b;gap:8px;">
        <p>Failed to initialize storage</p>
        <p style="font-size:0.85em;color:#999;">${this._storageError}</p>
      </div>`;
    }
    return html`<div class="app">
      ${this._saveError ? html`<div class="save-banner" role="alert">Couldn't save your work${this._lastSaveError instanceof StorageQuotaError ? ': storage is full' : ''}. Trying again…</div>` : ''}
      ${!this._isMobile ? html`<tool-settings ?inert=${this._stranded || this._updateRequired || (this._switching && !this._opening)}></tool-settings>` : ''}
      <div class="main-area">
        ${this._readOnly || this._switching ? html`
          <div class="read-only" role="alert" @dragover=${this._ignoreDrop} @drop=${this._ignoreDrop}>
            ${this._updateRequired ? html`
              ${this._storageClosed ? html`
                <p>Ketchup was updated in another window. Reload this one to keep editing.</p>
                ${this._hasUnsavedWork() ? html`<p class="save-error">Changes made here since the last save couldn't be stored.</p>` : ''}
                <div class="read-only-actions">
                  <button @click=${() => { void this._reloadForUpdate(); }}>Reload</button>
                </div>
              ` : html`<p>Ketchup was updated in another window. Saving your changes…</p>`}
            ` : this._opening || this._switching ? html`
              <p>Opening the project…</p>
              ${this._opening && this._isMobile ? this._renderOverlayProjects() : ''}
            ` : this._projectGone ? html`
              <p>This project was deleted in another tab.${this._stranded ? ' Changes made here since the last save are still here.' : ''}</p>
              ${this._keepError ? html`<p class="save-error">${this._keepError}</p>` : ''}
              <div class="read-only-actions">
                ${this._stranded ? html`<button ?disabled=${this._keeping} @click=${() => this._keepAsNewProject()}>Keep them as a new project</button>` : ''}
                <button ?disabled=${this._keeping} @click=${() => { this._stranded = false; void this._openAfterGone().catch(err => console.error('Could not open another project:', err)); }}>${this._stranded ? 'Discard and open another project' : 'Open another project'}</button>
              </div>
            ` : this._stranded ? html`
              <p>Another tab took this project over before this tab saved its latest changes. They are still here.</p>
              ${this._keepError ? html`<p class="save-error">${this._keepError}</p>` : ''}
              ${this._waitingForTab ? html`
                ${this._renderClaim('')}
                <div class="read-only-actions">
                  <button @click=${() => this._keepAsNewProject()}>Keep them as a new project</button>
                </div>
              ` : this._claiming ? this._renderClaim('') : html`
                <div class="read-only-actions">
                  <button @click=${() => this._keepAsNewProject()}>Keep them as a new project</button>
                  ${this._renderClaim('Use here without them')}
                </div>
              `}
            ` : this._noCanvas ? html`
              <p>Couldn't make a document to edit. Open another project, or reload to try again.</p>
              ${this._isMobile ? this._renderOverlayProjects() : ''}
            ` : this._handingOver ? html`<p>Saving, for the tab that asked to edit this project…</p>` : html`
              <p>This project is open in another tab. Changes made there are saved; this tab only shows it.</p>
              ${this._keptElsewhere
                ? html`<p>That tab couldn't save its changes, so it keeps the project for now.</p>` : ''}
              ${this._renderClaim('Use here')}
              ${this._isMobile && !this._waitingForTab && !this._claiming ? this._renderOverlayProjects() : ''}
            `}
          </div>
        ` : ''}
        ${this._notice || this._showUpdateNotice ? html`
          <div class="notices">
            ${this._showUpdateNotice ? html`
              <div class="notice" role="status">
                <span>A new version of Ketchup is ready.</span>
                <button class="notice-action" @click=${() => { void this._reloadForUpdate(); }}>Reload</button>
                <button aria-label="Dismiss" @click=${() => { this._updateNoticeDismissed = true; }}>×</button>
              </div>
            ` : ''}
            ${this._notice ? html`
              <div class="notice" role="status">
                <span>${this._notice}</span>
                <button aria-label="Dismiss" @click=${() => { this._notice = ''; }}>×</button>
              </div>
            ` : ''}
          </div>
        ` : ''}
        <app-toolbar ?inert=${this._readOnly || this._switching}></app-toolbar>
        <drawing-canvas
          ?inert=${this._readOnly || this._switching}
          @history-change=${this._onHistoryChange}
          @layer-undo=${this._onLayerUndo}
          @crop-commit=${this._onCropCommit}
          @transform-change=${this._onTransformChange}
          @pending-text-change=${this._reportModified}
          @viewport-change=${this._onViewportChange}
        ></drawing-canvas>
        ${!this._isMobile ? html`
          <div class="right-sidebar ${this._state.layersPanelOpen ? '' : 'collapsed'}" ?inert=${this._readOnly || this._switching}>
            <navigator-panel
              @navigator-pan=${this._onNavigatorPan}
              @navigator-zoom=${this._onNavigatorZoom}
            ></navigator-panel>
            <layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>
          </div>
        ` : ''}
      </div>
      ${this._isMobile && !this._state.childMode && !this._readOnly && !this._switching
        ? html`<layers-panel @commit-opacity=${this._onCommitOpacity}></layers-panel>` : ''}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-app': DrawingApp;
  }
}

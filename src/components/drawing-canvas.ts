import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Point, HistoryEntry, Layer, LayerSnapshot } from '../types.js';
import { drawShapePreview, isShapeTool, shapeBounds } from '../tools/shapes.js';
import { StampStrokeEngine } from '../engine/stamp-stroke.js';
import { blendModeToCompositeOp } from '../engine/types.js';
import type { BrushDescriptor } from '../engine/types.js';
import { tintAlphaMask } from '../engine/canvas-pool.js';
import { createThrottledScheduler } from '../utils/raf-throttle.js';
import { normalizePointerPressure } from '../utils/pointer-pressure.js';
import { getDefaultDescriptor } from '../engine/brush-presets.js';
import { floodFill } from '../tools/fill.js';
import { drawSelectionRect } from '../tools/select.js';
import { drawCropOverlay, hitTestCropHandle, parseAspectRatio, constrainCropToRatio, type CropRect, type CropHandle } from '../tools/crop.js';
import { drawText, measureTextBlock, buildFontString, LINE_HEIGHT } from '../tools/text.js';
import { TransformManager } from '../transform/transform-manager.js';
import { HANDLE_CONFIG_TOUCH } from '../transform/transform-types.js';
import { detectContentBounds } from '../transform/transform-math.js';
import { diffBounds, cropImageData, type PixelRect } from '../utils/image-diff.js';
import { historyEntryBytes, historyByteBudget } from '../utils/history-size.js';
import { focusEditor } from '../utils/focus-editor.js';
import { sizeViewCanvas, viewBackingSize, viewCanvasSize } from '../utils/view-canvas.js';
import './resize-dialog.js';
import type { ResizeDialog } from './resize-dialog.js';

/**
 * A forced entry for an operation that changed nothing stores one identical
 * pixel twice. Writing it back could only revert later, unrecorded changes to
 * that pixel, so undo/redo skip it.
 */
function isNoOpPatch(entry: Extract<HistoryEntry, { type: 'patch' }>): boolean {
  return entry.before.width === 1 && entry.before.height === 1 && !diffBounds(entry.before, entry.after);
}

/** Turn a project name into a safe download file name (without extension). */
export function exportFileBaseName(projectName: string | undefined): string {
  const cleaned = (projectName ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || 'drawing';
}

/** A pointer release at (clientX, clientY), standing in for one that was missed. */
function releasedAt(e: PointerEvent, clientX: number, clientY: number): PointerEvent {
  return {
    pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
    button: 0, buttons: 0, clientX, clientY, pressure: 0,
    tiltX: e.tiltX, tiltY: e.tiltY, twist: e.twist, width: e.width, height: e.height,
    timeStamp: e.timeStamp, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey,
    preventDefault: () => e.preventDefault(),
  } as PointerEvent;
}

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

    /* Crop has no keyboard on touch devices, so the commit/cancel actions
       live on the canvas instead of behind Enter/Escape. */
    .crop-actions {
      position: absolute;
      left: 50%;
      bottom: 1rem;
      transform: translateX(-50%);
      display: flex;
      gap: 0.5rem;
      padding: 0.375rem;
      border-radius: 0.625rem;
      background: rgba(30, 30, 30, 0.92);
      border: 1px solid #555;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    }

    .crop-actions button {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 44px;
      padding: 0 0.875rem;
      border: 1px solid #555;
      border-radius: 0.5rem;
      background: #3a3a3a;
      color: #ddd;
      font-family: inherit;
      font-size: 0.875rem;
      cursor: pointer;
      touch-action: manipulation;
    }

    .crop-actions button.apply {
      background: #2f7d32;
      border-color: #3f9e43;
      color: #fff;
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
  /** The pan `_resizeToFit` last set, and what rounding took off it. */
  private _resizePan = { x: NaN, y: NaN, dx: 0, dy: 0 };

  // --- Move tool state ---
  private _moveTempCanvas: HTMLCanvasElement | null = null;
  private _moveStartPoint: Point | null = null;

  // --- Zoom state ---
  private _zoom = 1;
  private static readonly MIN_ZOOM = 0.1;
  private static readonly MAX_ZOOM = 10;
  private static readonly ZOOM_STEP = 1.1;

  // --- Multi-touch state ---
  private _pointers = new Map<number, { x: number; y: number; type: string }>();
  /** Touches that landed during a pen stroke: a resting palm, ignored until they lift. */
  private _palmPointers = new Set<number>();
  /** The two pointers a pinch is following; when that pair changes it starts afresh. */
  private _pinchPair = '';
  private _pinching = false;
  private _lastPinchDist = 0;
  private _lastPinchMidX = 0;
  private _lastPinchMidY = 0;

  // --- Floating selection / transform state ---
  private _transformManager: TransformManager | null = null;
  /** Inserted content is not present on the layer until commit; lifted content is. */
  private _transformContentMode: 'lifted' | 'inserted' = 'lifted';
  private _clipboard: ImageData | null = null;
  private _clipboardOrigin: Point | null = null;
  private _clipboardRotation = 0;
  /** Our latest write to the system clipboard: whether it got there, once settled. */
  private _systemClipboardWrite: Promise<boolean> | null = null;

  private _engine = new StampStrokeEngine();
  private _tintPreviewCanvas: HTMLCanvasElement | null = null;
  /** Viewport-size scratch for compositing the active layer with its float merged in. */
  private _transformViewCanvas: HTMLCanvasElement | null = null;
  private _strokeTintCanvas: HTMLCanvasElement | null = null;
  private _samplingDirty = true;
  /** Coalesces gesture-driven composites into at most one per animation frame. */
  private _compositeScheduler = createThrottledScheduler(() => this._composite(this._compositeContentPending));
  /**
   * Wheel and pinch deliver many events per frame on some devices, and each
   * viewport-change re-renders the whole app through the context; coalesce
   * them to one per frame.
   */
  private _viewportChangeScheduler = createThrottledScheduler(() => this._dispatchViewportChange());
  private _viewportChangePending = false;
  /** A scheduled composite follows a change to layer (or transform) content, not just the view. */
  private _compositeContentPending = false;
  /** Cached mainCanvas bounding rect — avoids a forced layout on every pointer move. */
  private _canvasRect: DOMRect | null = null;
  /** Set when a new stroke starts so the stroke tint scratch canvas is fully cleared once. */
  private _strokeTintNeedsClear = true;
  /** `_tintPreviewCanvas` needs a full copy of the layer before this stroke's first merged frame. */
  private _tintPreviewNeedsCopy = true;
  private _samplingBuffer: HTMLCanvasElement | null = null;
  private _altSampling = false;

  private _lastPointerScreenX = 0;
  private _lastPointerScreenY = 0;
  private _pointerOnCanvas = false;

  /** When and where ✓/✗ last ended a float, to ignore the second press of a double-click. */
  private _floatButtonEnd: { time: number; x: number; y: number } | null = null;
  /**
   * A touch on a tool that acts on a tap (stamp, fill, eyedropper, a new text
   * box), held until the finger lifts: a second finger first makes it a
   * pinch, which must leave nothing behind.
   */
  private _pendingTap: { pointerId: number; down: PointerEvent } | null = null;
  /** The held tap is being carried out now, after its finger lifted. */
  private _replayingTap = false;

  /** True when the current float was created via paste/drop — Escape discards + deletes layer */
  private _floatIsExternalImage = false;

  // Interaction state
  private _selectionDrawing = false;

  // --- Crop tool state ---
  private _cropRectValue: CropRect | null = null;
  private _cropDragging = false;
  private _cropHandle: CropHandle | null = null;
  private _cropDragOrigin: Point | null = null;
  private _cropRectOrigin: CropRect | null = null;
  /** The text caret before a press inside the text box, restored if it starts a pinch. */
  private _textSelectionBeforePress: [number, number] | null = null;
  /** The rect a new crop drag replaced, restored if that drag turns out to start a pinch. */
  private _cropRectBeforeNew: CropRect | null = null;
  /** Drives the on-canvas Apply/Cancel buttons. */
  @state() private _cropActionsVisible = false;

  private get _cropRect(): CropRect | null {
    return this._cropRectValue;
  }

  private set _cropRect(rect: CropRect | null) {
    this._cropRectValue = rect;
    this._updateCropActions();
  }

  /** Show the crop actions only for a usable rect that is not mid-drag. */
  private _updateCropActions() {
    const rect = this._cropRectValue;
    this._cropActionsVisible =
      rect !== null &&
      !this._cropDragging &&
      this._cropHandle === null &&
      Math.abs(rect.w) >= 1 &&
      Math.abs(rect.h) >= 1;
  }

  // --- Text tool state ---
  private _textEditing = false;
  private _textPosition: Point = { x: 0, y: 0 };
  private _textSelecting = false;
  private _textSelectAnchor = 0;
  private _textAreaEl: HTMLTextAreaElement | null = null;
  private _textCursorVisible = false;
  private _textCursorInterval = 0;

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
  public invalidateSamplingBuffer() { this._samplingDirty = true; }
  /** A pointer is down on the canvas (drawing, dragging, panning or pinching). */
  public isGestureActive() { return this._pointers.size > 0; }

  /**
   * Request a composite on the next animation frame. Use this for anything driven
   * by a continuous gesture (drawing, dragging, panning, zooming) so a burst of
   * pointer/wheel events produces one redraw per frame instead of one per event.
   * Discrete operations (undo, layer edits, commits) should call composite() directly.
   *
   * Pass `contentChanged = false` when no layer pixels changed (pan, zoom, or a
   * stroke still in the engine's buffer): listeners of `composited` then skip
   * redrawing thumbnails and minimaps that would come out the same.
   */
  public scheduleComposite(contentChanged = true) {
    if (contentChanged) this._compositeContentPending = true;
    this._compositeScheduler.schedule();
  }

  // --- Transform mode ---

  isTransformActive(): boolean {
    return this._transformManager !== null;
  }

  /**
   * While text is being edited, puts the keyboard back in it (a click on a
   * font control took it away). Returns whether text is being edited.
   */
  focusText(): boolean {
    if (!this._textEditing || !this._textAreaEl) return false;
    this._textAreaEl.focus({ preventScroll: true });
    return true;
  }

  /** Whether a text box is open for typing. */
  isTextEditing(): boolean {
    return this._textEditing;
  }

  /** Puts text still being typed onto its layer (before an export, say). */
  commitPendingText() {
    if (this._textEditing) this._commitText();
  }

  /** True while the text tool holds typed text that is not on a layer yet. */
  hasPendingText(): boolean {
    return this._textEditing && !!this._textAreaEl?.value;
  }

  private _dispatchPendingTextChange() {
    // Heard by drawing-app on this element; not part of the host API.
    this.dispatchEvent(new CustomEvent('pending-text-change', {
      detail: { pending: this.hasPendingText() },
    }));
    // Redo waits while text is typed (see redo()).
    if (this.hasPendingText() !== this._redoHeldByText) {
      this._redoHeldByText = this.hasPendingText();
      this._notifyHistory(false);
    }
  }

  private _redoHeldByText = false;

  enterTransformMode(): void {
    if (this._transformManager) return;
    // The float would hide the crop rectangle, which would stay armed.
    if (this._cropRect) this.cancelCrop();
    const state = this._ctx.value?.state;
    if (!state) return;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    if (!layer) return;
    const ctx = layer.canvas.getContext('2d')!;

    // No selection — transform entire layer content bounds
    const imageData = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    const bounds = detectContentBounds(imageData);
    if (!bounds) return;
    this._captureBeforeDraw();
    const regionData = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    this._transformContentMode = 'lifted';
    this._transformManager = new TransformManager(
      regionData,
      bounds,
      this.previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    this._notifyHistory();
  }

  getTransformValues(): { x: number; y: number; width: number; height: number; rotation: number; skewX: number; skewY: number; flipH: boolean; flipV: boolean } | null {
    if (!this._transformManager) return null;
    const tm = this._transformManager;
    return {
      x: tm.x, y: tm.y, width: tm.width, height: tm.height,
      rotation: tm.rotation, skewX: tm.skewX, skewY: tm.skewY,
      flipH: tm.flipH, flipV: tm.flipV,
    };
  }

  setTransformValue(key: string, value: number | boolean): void {
    if (!this._transformManager) return;
    const tm = this._transformManager;
    switch (key) {
      case 'x': tm.x = value as number; break;
      case 'y': tm.y = value as number; break;
      case 'width': tm.width = value as number; break;
      case 'height': tm.height = value as number; break;
      case 'rotation': tm.rotation = value as number; break;
      case 'skewX': tm.skewX = value as number; break;
      case 'skewY': tm.skewY = value as number; break;
      case 'flipH': tm.flipH = !tm.flipH; break;
      case 'flipV': tm.flipV = !tm.flipV; break;
    }
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
  }

  commitTransform(): void {
    if (!this._transformManager) return;
    const state = this._ctx.value?.state;
    if (!state) return;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    if (!layer) return;

    const layerCtx = layer.canvas.getContext('2d')!;
    const isInsertion = this._transformContentMode === 'inserted';
    let patch: { x: number; y: number; w: number; h: number; before: ImageData } | null = null;
    if (isInsertion) {
      const bounds = this._transformManager.getBounds();
      const x = Math.max(0, bounds.x);
      const y = Math.max(0, bounds.y);
      const right = Math.min(this._docWidth, bounds.x + bounds.w);
      const bottom = Math.min(this._docHeight, bounds.y + bounds.h);
      const w = right - x;
      const h = bottom - y;
      if (w > 0 && h > 0) {
        patch = { x, y, w, h, before: layerCtx.getImageData(x, y, w, h) };
      }
    }

    // Always commit the image back to the layer (or add it for an insertion).
    this._transformManager.commit(layer.canvas);

    if (isInsertion && patch) {
      const after = layerCtx.getImageData(patch.x, patch.y, patch.w, patch.h);
      const changed = diffBounds(patch.before, after);
      if (changed) {
        this._pushHistoryEntry({
          type: 'patch',
          layerId: layer.id,
          x: patch.x + changed.x,
          y: patch.y + changed.y,
          before: cropImageData(patch.before, changed),
          after: cropImageData(after, changed),
        });
      }
    } else if (this._transformManager.hasChanged() && this._beforeDrawCanvas) {
      const changed = this._readChangedPatch(layerCtx, undefined, true);
      if (changed) this._pushHistoryEntry({ type: 'patch', layerId: layer.id, ...changed });
    }
    this._beforeDrawCanvas = null;
    this._transformContentMode = 'lifted';
    this._floatIsExternalImage = false;

    this._transformManager.dispose();
    this._transformManager = null;
    this.previewCanvas.getContext('2d')!.clearRect(
      0, 0, this.previewCanvas.width, this.previewCanvas.height,
    );
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    // A no-op or fully off-canvas insertion does not push history, but ending
    // the transform still changes whether Undo/Redo should be enabled.
    this._notifyHistory();
  }

  cancelTransform(): void {
    if (!this._transformManager) return;
    const state = this._ctx.value?.state;
    if (!state) return;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    if (!layer) return;

    if (this._floatIsExternalImage) {
      this.cancelExternalFloat();
      return;
    }

    const ctx = layer.canvas.getContext('2d')!;

    if (this._transformContentMode === 'inserted') {
      this._transformManager.cancel();
    } else if (this._beforeDrawCanvas) {
      this._restoreBeforeDraw(ctx);
    } else {
      const originalData = this._transformManager.cancel();
      const srcRect = this._transformManager.getSourceRect();
      ctx.putImageData(originalData, srcRect.x, srcRect.y);
    }

    this._transformManager.dispose();
    this._transformManager = null;
    this._beforeDrawCanvas = null;
    this._transformContentMode = 'lifted';
    this.previewCanvas.getContext('2d')!.clearRect(
      0, 0, this.previewCanvas.width, this.previewCanvas.height,
    );
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    this._notifyHistory();
  }

  // --- Viewport helpers ---
  /** The view's size in CSS pixels: what pan, zoom and everything drawn on the view canvases are measured in. */
  private get _vw(): number { return this.mainCanvas ? viewCanvasSize(this.mainCanvas).width : 800; }
  private get _vh(): number { return this.mainCanvas ? viewCanvasSize(this.mainCanvas).height : 600; }

  // --- Layer-aware helpers ---

  private get _brushDescriptor(): BrushDescriptor {
    const state = this.ctx.state as DrawingContextValue['state'] & { brushSize?: number };
    if (state.brush) {
      return state.brush;
    }
    const fallback = getDefaultDescriptor();
    return {
      ...fallback,
      size: state.brushSize ?? fallback.size,
      tip: { ...fallback.tip },
      ink: { ...fallback.ink },
    };
  }

  private _getActiveLayerCtx(): CanvasRenderingContext2D | null {
    const state = this._ctx.value?.state;
    if (!state) return null;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    return layer?.canvas.getContext('2d') ?? null;
  }

  public composite() {
    this._composite(true);
  }

  private _composite(contentChanged: boolean) {
    if (!this.mainCanvas) return;
    this._compositeScheduler.cancel();
    this._compositeContentPending = false;
    const displayCtx = this.mainCanvas.getContext('2d')!;
    const vw = this._vw;
    if (!this._transformManager && this._transformViewCanvas) {
      // Free the scratch canvas once the transform has ended.
      this._transformViewCanvas.width = this._transformViewCanvas.height = 0;
      this._transformViewCanvas = null;
    }
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
    const activeLayerId = this._ctx.value?.state.activeLayerId ?? null;
    const hasBlend = layers.some(l => l.visible && l.blendMode !== 'normal');
    for (const layer of layers) {
      if (!layer.visible) continue;
      displayCtx.globalAlpha = layer.opacity;
      const transform = this._transformManager && layer.id === activeLayerId ? this._transformManager : null;
      // Commit merges the float onto its layer with source-over. Source-over is
      // associative, so on a normal, opaque layer the float can follow the layer
      // straight onto the display; otherwise the layer's blend mode and opacity
      // must apply to the merged result, so they are merged first.
      const mergeTransform = transform !== null && (layer.blendMode !== 'normal' || layer.opacity < 1);
      if (hasBlend) {
        displayCtx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
      }
      // Show the in-progress stroke on top of the layer it is being drawn into.
      // Only the region the stroke has actually touched (preview.bounds) is
      // reprocessed each frame — a long stroke still repaints one rect, not the page.
      const preview = this._drawing && layer.id === activeLayerId
        ? this._engine.getStrokePreview()
        : null;
      const b = preview?.bounds ?? null;

      if (mergeTransform) {
        this._drawLayerWithTransformInView(displayCtx, layer, transform);
      } else if (preview && b) {
        // Source-over is associative, so a plain stroke on an opaque, normally
        // blended layer can go straight to the display. Erasing cannot: its
        // destination-out would punch through the checkerboard and workspace
        // behind the document, so it merges onto a temp copy of the layer first.
        // Partial layer opacity and blend modes also have to merge, because the
        // stroke's own opacity must be applied before the layer's is.
        const canDrawDirect = !preview.eraser && layer.opacity >= 1 && layer.blendMode === 'normal';

        if (canDrawDirect) {
          displayCtx.drawImage(layer.canvas, 0, 0);
          const strokeSrc = preview.color === null
            ? (preview.canvas as HTMLCanvasElement)
            : this._tintStrokeRegion(preview.canvas as HTMLCanvasElement, b, preview.color);
          displayCtx.globalAlpha = preview.opacity;
          displayCtx.drawImage(strokeSrc, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
          displayCtx.globalAlpha = layer.opacity;
        } else {
          if (!this._tintPreviewCanvas || this._tintPreviewCanvas.width !== this._docWidth || this._tintPreviewCanvas.height !== this._docHeight) {
            this._tintPreviewCanvas = document.createElement('canvas');
            this._tintPreviewCanvas.width = this._docWidth;
            this._tintPreviewCanvas.height = this._docHeight;
            this._tintPreviewNeedsCopy = true;
          }
          const tintCtx = this._tintPreviewCanvas.getContext('2d')!;
          tintCtx.globalCompositeOperation = 'source-over';

          // Start with the layer content. The layer doesn't change until the
          // stroke commits, and the stroke's bounds only grow, so after one full
          // copy per stroke only the stroke's region needs refreshing.
          if (this._tintPreviewNeedsCopy) {
            tintCtx.clearRect(0, 0, this._docWidth, this._docHeight);
            tintCtx.drawImage(layer.canvas, 0, 0);
            this._tintPreviewNeedsCopy = false;
          } else {
            tintCtx.clearRect(b.x, b.y, b.w, b.h);
            tintCtx.drawImage(layer.canvas, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
          }

          tintCtx.globalAlpha = preview.opacity;
          if (preview.eraser) {
            // Apply eraser: destination-out on the layer copy
            tintCtx.globalCompositeOperation = 'destination-out';
            tintCtx.drawImage(preview.canvas as HTMLCanvasElement, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
          } else if (preview.color === null) {
            // Color mode / wet brush — preview already has correct colors
            tintCtx.drawImage(preview.canvas as HTMLCanvasElement, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
          } else {
            const tinted = this._tintStrokeRegion(preview.canvas as HTMLCanvasElement, b, preview.color);
            tintCtx.drawImage(tinted, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
          }

          tintCtx.globalAlpha = 1;
          tintCtx.globalCompositeOperation = 'source-over';

          // Draw the combined layer+stroke preview instead of the raw layer
          displayCtx.drawImage(this._tintPreviewCanvas, 0, 0);
        }
      } else {
        displayCtx.drawImage(layer.canvas, 0, 0);
      }

      if (transform) {
        if (mergeTransform) {
          // The merged copy stops at the document edge; still show the float
          // beyond it while it is being positioned, as on a normal layer.
          const fb = transform.getBounds();
          const inside = fb.x >= 0 && fb.y >= 0 && fb.x + fb.w <= this._docWidth && fb.y + fb.h <= this._docHeight;
          if (!inside) {
            displayCtx.save();
            displayCtx.beginPath();
            displayCtx.rect(-1e6, -1e6, 2e6, 2e6);
            displayCtx.rect(0, 0, this._docWidth, this._docHeight);
            displayCtx.clip('evenodd');
            transform.renderTransformed(displayCtx);
            displayCtx.restore();
          }
        } else {
          transform.renderTransformed(displayCtx);
        }
      }
      if (hasBlend) {
        displayCtx.globalCompositeOperation = 'source-over';
      }
      displayCtx.globalAlpha = 1.0;
    }

    // Document border
    displayCtx.strokeStyle = 'rgba(0,0,0,0.3)';
    displayCtx.lineWidth = 1;
    displayCtx.strokeRect(-0.5, -0.5, this._docWidth + 1, this._docHeight + 1);

    displayCtx.restore();

    this.dispatchEvent(new CustomEvent('composited', {
      bubbles: true, composed: true,
      detail: { contentChanged },
    }));
    if (contentChanged) this.invalidateSamplingBuffer();
  }

  /**
   * Copy `bounds` of an alpha-mask stroke buffer into a scratch canvas and tint it
   * with `color`, returning the scratch canvas. Work is clipped to `bounds`, and the
   * caller is expected to read back only that region: outside it the scratch canvas
   * is transparent, cleared once when the stroke began.
   */
  private _tintStrokeRegion(
    source: HTMLCanvasElement,
    bounds: { x: number; y: number; w: number; h: number },
    color: string,
  ): HTMLCanvasElement {
    const w = this._docWidth;
    const h = this._docHeight;
    if (!this._strokeTintCanvas || this._strokeTintCanvas.width !== w || this._strokeTintCanvas.height !== h) {
      this._strokeTintCanvas = document.createElement('canvas');
      this._strokeTintCanvas.width = w;
      this._strokeTintCanvas.height = h;
      this._strokeTintNeedsClear = false; // a fresh canvas is already blank
    }
    const ctx = this._strokeTintCanvas.getContext('2d')!;
    if (this._strokeTintNeedsClear) {
      ctx.clearRect(0, 0, w, h);
      this._strokeTintNeedsClear = false;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.clip();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.drawImage(source, bounds.x, bounds.y, bounds.w, bounds.h, bounds.x, bounds.y, bounds.w, bounds.h);
    // Clipped so source-in only erases inside the region we just rewrote
    tintAlphaMask(ctx, color, w, h);
    ctx.restore();

    return this._strokeTintCanvas;
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

    // Update cursor based on active tool. A transform sets its own on pointer
    // moves; ending it requests an update, which restores the tool's.
    if (this.mainCanvas && this._ctx.value && !this._transformManager) {
      const tool = this._ctx.value.state.activeTool;
      if (tool === 'hand') {
        this.mainCanvas.style.cursor = this._panning ? 'grabbing' : 'grab';
      } else if (tool === 'move') {
        this.mainCanvas.style.cursor = 'move';
      } else if (tool === 'text') {
        this.mainCanvas.style.cursor = 'text';
      } else {
        this.mainCanvas.style.cursor = 'crosshair';
      }

      // Re-render text preview when context state changes during editing
      // (e.g., user changes font family/size/bold/italic/color mid-edit)
      if (this._textEditing) {
        this._renderTextPreview();
      }
    }

    this._renderPreview();
  }

  override firstUpdated() {
    const view = this._measureView();
    const vw = view?.width ?? 800;
    const vh = view?.height ?? 600;
    this._laidOut = view !== null;
    this._sizeViewCanvases(vw, vh, view?.scale ?? DrawingCanvas._devicePixelRatio());

    // Center document in viewport, shrinking it to fit small screens
    this._zoom = Math.max(DrawingCanvas.MIN_ZOOM, Math.min(this._zoom, this._fitZoom()));
    this._panX = Math.round((vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((vh - this._docHeight * this._zoom) / 2);

    this._observeSize();

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

    // Append hidden textarea for text tool
    if (this._textAreaEl) {
      this.shadowRoot!.appendChild(this._textAreaEl);
    }
  }

  private _observeSize() {
    this._resizeObserver = new ResizeObserver(() => {
      this._invalidateCanvasRect();
      this._resizeToFit();
    });
    this._resizeObserver.observe(this);
    this._watchDevicePixelRatio();
  }

  private static _devicePixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  private _dprQuery: MediaQueryList | null = null;

  /**
   * Re-measures when the device pixel ratio changes (the window moved to
   * another screen, or the page zoomed without resizing this element),
   * which no size observer reports.
   */
  private _watchDevicePixelRatio() {
    this._unwatchDevicePixelRatio();
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${DrawingCanvas._devicePixelRatio()}dppx)`);
    query.addEventListener?.('change', this._onDevicePixelRatioChange);
    this._dprQuery = query;
  }

  private _unwatchDevicePixelRatio() {
    this._dprQuery?.removeEventListener?.('change', this._onDevicePixelRatioChange);
    this._dprQuery = null;
  }

  private _onDevicePixelRatioChange = () => {
    if (!this.isConnected) return;
    this._watchDevicePixelRatio();
    this._invalidateCanvasRect();
    this._resizeToFit();
  };

  /**
   * The element's size in its own CSS pixels, and how many device pixels
   * each covers. A host's CSS `zoom` scales the client rect, not the
   * element's own pixels (the computed size), so the two are measured apart.
   */
  private _measureView(): { width: number; height: number; scale: number } | null {
    const rect = this.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    let cssW = rect.width, cssH = rect.height;
    if (this.isConnected) {
      const cs = getComputedStyle(this);
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      if (w > 0 && h > 0) { cssW = w; cssH = h; }
    }
    const width = Math.floor(cssW), height = Math.floor(cssH);
    if (width <= 0 || height <= 0) return null;
    return { width, height, scale: DrawingCanvas._devicePixelRatio() * (rect.width / cssW) };
  }

  /** Sizes the display and preview canvases to the view, at device resolution. */
  private _sizeViewCanvases(width: number, height: number, scale: number) {
    sizeViewCanvas(this.mainCanvas, width, height, scale);
    sizeViewCanvas(this.previewCanvas, width, height, scale);
  }

  /** Center the document in the viewport */
  public centerDocument() {
    if (!this.mainCanvas) return;
    this._panX = Math.round((this._vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((this._vh - this._docHeight * this._zoom) / 2);
    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.composite();
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
    this._dispatchViewportChange();
  }

  private _resizeToFit() {
    const view = this._measureView();
    if (!view) return;

    const newWidth = view.width;
    const newHeight = view.height;
    this._laidOut = true;
    const oldWidth = this._vw;
    const oldHeight = this._vh;
    const sameSize = oldWidth === newWidth && oldHeight === newHeight;
    const backing = viewBackingSize(newWidth, newHeight, view.scale);
    if (sameSize && backing.width === this.mainCanvas.width && backing.height === this.mainCanvas.height) return;

    // Resize display and preview canvases to viewport size only
    this._sizeViewCanvases(newWidth, newHeight, view.scale);
    if (sameSize) {
      // Only the resolution changed (another screen): the view stays put.
      this._checkerboardPattern = null;
      this._redrawView(false);
      return;
    }

    // Adjust pan to keep the center stable, on whole pixels (a half-pixel pan
    // would blur the document at 100%). What rounding took off is carried to
    // the next resize, so resizing back returns to the same pan instead of
    // drifting a pixel each time; any other pan change drops it.
    const exactX = this._panX + (this._panX === this._resizePan.x ? this._resizePan.dx : 0) + (newWidth - oldWidth) / 2;
    const exactY = this._panY + (this._panY === this._resizePan.y ? this._resizePan.dy : 0) + (newHeight - oldHeight) / 2;
    this._panX = Math.round(exactX);
    this._panY = Math.round(exactY);
    this._resizePan = { x: this._panX, y: this._panY, dx: exactX - this._panX, dy: exactY - this._panY };

    // Pattern is tied to canvas context, must recreate
    this._checkerboardPattern = null;

    this._redrawView(true);
    this._dispatchViewportChange();
  }

  /** Repaints the display and preview canvases after a resize cleared them. */
  private _redrawView(contentChanged: boolean) {
    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    if (contentChanged) this.composite();
    else this._composite(false);
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
  }

  // --- History ---
  private _history: HistoryEntry[] = [];
  /** Bumped by `setHistory`, as each document is opened or started. */
  private _documentGeneration = 0;
  private _historyIndex = -1;
  private _maxHistory = 50;
  /** Entries dropped off the bottom of the stack at the cap, ever; the states before them can no longer be undone to. */
  private _historyTrimmed = 0;

  // --- Public history access for persistence ---
  /** Returns a shallow copy of the history array. Note: entries contain shared
   *  mutable references (e.g. ImageData in 'patch' entries). Callers that need
   *  isolation should snapshot data synchronously before any async work. */
  public getHistory(): HistoryEntry[] { return [...this._history]; }
  public getHistoryIndex(): number { return this._historyIndex; }
  public getHistoryTrimmedCount(): number { return this._historyTrimmed; }

  /**
   * Per-layer pixel revisions, for persistence: a layer whose revision is the
   * one it had when it was stored still holds the stored pixels, so a save
   * needn't read it back. Bumped when history records a pixel change to the
   * layer, on undo and redo of one, and for every layer on structural changes
   * (add, delete, crop, merge) and whenever a document is opened. Pixels that
   * are only lifted into a float don't count; callers treat the float's layer
   * as changed.
   */
  private _layerRevisions = new Map<string, number>();
  private _revisionEpoch = 0;
  public getLayerRevision(layerId: string): string {
    return `${this._revisionEpoch}:${this._layerRevisions.get(layerId) ?? 0}`;
  }
  private _bumpLayerRevisions(entry: HistoryEntry) {
    switch (entry.type) {
      case 'draw':
      case 'patch':
      case 'transform':
        this._layerRevisions.set(entry.layerId, (this._layerRevisions.get(entry.layerId) ?? 0) + 1);
        break;
      case 'visibility':
      case 'opacity':
      case 'rename':
      case 'blend-mode':
      case 'reorder':
        break;
      default:
        this._revisionEpoch++;
    }
  }
  public setHistory(entries: HistoryEntry[], index: number) {
    // A document was opened or started: a drop still asking how to fit the
    // old one is dropped.
    this._documentGeneration++;
    this._revisionEpoch++;
    this._resizeDialog?.dismiss();
    this._history = entries;
    this._historyIndex = Math.max(-1, Math.min(index, entries.length - 1));
    this._notifyHistory();
  }

  /**
   * The active layer as it was when the current undoable operation began, or
   * null when none is pending. It is a canvas copy rather than an ImageData
   * readback, so starting an operation never stalls on a full-document
   * getImageData; only the region that changed is read back when the history
   * entry is recorded.
   */
  private _beforeDrawCanvas: HTMLCanvasElement | null = null;
  /** Reused backing store for _beforeDrawCanvas. */
  private _beforeDrawBuffer: HTMLCanvasElement | null = null;

  /** Call before a drawing operation starts (pointerdown) */
  private _captureBeforeDraw() {
    const ctx = this._getActiveLayerCtx();
    if (!ctx) return;
    const { width, height } = ctx.canvas;
    let buffer = this._beforeDrawBuffer;
    if (!buffer || buffer.width !== width || buffer.height !== height) {
      buffer = document.createElement('canvas');
      buffer.width = width;
      buffer.height = height;
      this._beforeDrawBuffer = buffer;
    }
    const bufferCtx = buffer.getContext('2d')!;
    bufferCtx.clearRect(0, 0, width, height);
    bufferCtx.drawImage(ctx.canvas, 0, 0);
    this._beforeDrawCanvas = buffer;
  }

  /** Put the pixels captured by _captureBeforeDraw() back onto `ctx`. */
  private _restoreBeforeDraw(ctx: CanvasRenderingContext2D) {
    const snapshot = this._beforeDrawCanvas;
    if (!snapshot) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(snapshot, 0, 0);
    ctx.restore();
  }

  /**
   * Call after a drawing operation completes (pointerup). Records only the
   * rectangle that changed, not the whole layer. `region` bounds where the
   * operation can have drawn, when the caller knows it, so only that much of
   * the document is read back and compared.
   */
  private _pushDrawHistory(force = false, region?: PixelRect) {
    const state = this._ctx.value?.state;
    const ctx = this._getActiveLayerCtx();
    if (!ctx || !state || !this._beforeDrawCanvas) return;
    const patch = this._readChangedPatch(ctx, region, force);
    this._beforeDrawCanvas = null;
    if (!patch) return;
    this._pushHistoryEntry({ type: 'patch', layerId: state.activeLayerId, ...patch });
  }

  /**
   * Compare the captured before-snapshot with the layer inside `region`
   * (default: the whole document) and return the smallest before/after patch
   * covering every changed pixel. Returns null when nothing changed, unless
   * `force` asks for an entry anyway, in which case it is a no-op 1x1 patch.
   */
  private _readChangedPatch(
    ctx: CanvasRenderingContext2D,
    region: PixelRect | undefined,
    force: boolean,
  ): { x: number; y: number; before: ImageData; after: ImageData } | null {
    const snapshot = this._beforeDrawCanvas!;
    const width = Math.min(snapshot.width, ctx.canvas.width);
    const height = Math.min(snapshot.height, ctx.canvas.height);
    const r = region ?? { x: 0, y: 0, w: width, h: height };
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.min(width, Math.ceil(r.x + r.w)) - x;
    const h = Math.min(height, Math.ceil(r.y + r.h)) - y;
    const snapshotCtx = snapshot.getContext('2d')!;

    let changed: PixelRect | null = null;
    let before: ImageData | null = null;
    let after: ImageData | null = null;
    if (w > 0 && h > 0) {
      before = snapshotCtx.getImageData(x, y, w, h);
      after = ctx.getImageData(x, y, w, h);
      changed = diffBounds(before, after);
    }
    if (changed && before && after) {
      return {
        x: x + changed.x,
        y: y + changed.y,
        before: cropImageData(before, changed),
        after: cropImageData(after, changed),
      };
    }
    if (!force || width <= 0 || height <= 0) return null;
    return { x: 0, y: 0, before: snapshotCtx.getImageData(0, 0, 1, 1), after: ctx.getImageData(0, 0, 1, 1) };
  }

  /**
   * Commit the in-progress brush stroke to the layer. Returns the region it
   * can have changed, for _pushDrawHistory(), or undefined when no stroke was
   * in progress (the change, if any, is then not bounded by a stroke).
   */
  private _commitStroke(layerCtx: CanvasRenderingContext2D): PixelRect | undefined {
    if (!this._engine.commit(layerCtx)) return undefined;
    const bounds = this._engine.getDirtyBounds();
    if (!bounds) return { x: 0, y: 0, w: 0, h: 0 };
    // Margin for anti-aliased stamp edges.
    const pad = 2;
    return { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
  }

  /** Called by drawing-app for layer structural operations */
  public pushLayerOperation(entry: HistoryEntry) {
    this._pushHistoryEntry(entry);
  }

  private _pushHistoryEntry(entry: HistoryEntry) {
    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(entry);
    this._bumpLayerRevisions(entry);
    this._historyIndex = this._history.length - 1;
    // Drop the oldest entries past the count cap or the pixel-memory budget,
    // always keeping the newest so the last change can be undone.
    let bytes = this._history.reduce((n, e) => n + historyEntryBytes(e), 0);
    const budget = historyByteBudget();
    while (this._history.length > 1 && (this._history.length > this._maxHistory || bytes > budget)) {
      bytes -= historyEntryBytes(this._history.shift()!);
      this._historyIndex--;
      this._historyTrimmed++;
    }
    this._notifyHistory();
  }

  /** Extract the layer ID referenced by a history entry, or null if not layer-specific. */
  private _getEntryLayerId(entry: HistoryEntry): string | null {
    switch (entry.type) {
      case 'draw':
      case 'patch':
      case 'visibility':
      case 'opacity':
      case 'rename':
      case 'blend-mode':
      case 'transform':
        return entry.layerId;
      case 'add-layer':
      case 'delete-layer':
        return entry.layer.id;
      case 'reorder':
        return null;
      case 'crop':
      case 'merge':
        return null;
    }
  }

  /** `stackChanged = false`: only whether Undo applies changed (a float started). */
  private _notifyHistory(stackChanged = true) {
    this.dispatchEvent(
      new CustomEvent('history-change', {
        bubbles: true,
        composed: true,
        detail: {
          canUndo: this._historyIndex >= 0 || this._transformManager !== null,
          canRedo: this._historyIndex < this._history.length - 1 && !this.hasPendingText() && !this._floatHoldsWork(),
          stackChanged,
        },
      }),
    );
  }

  /**
   * A float that would put something on its layer (a paste, or a lifted part
   * moved or reshaped): committing it is a new step, which ends the redo
   * stack, and dropping it loses it, so Redo waits (as for typed text).
   */
  private _floatHoldsWork(): boolean {
    const tm = this._transformManager;
    return !!tm && (this._transformContentMode === 'inserted' || tm.hasChanged());
  }

  private _redoHeldByFloat = false;

  private _dispatchTransformChange() {
    if (this._floatHoldsWork() !== this._redoHeldByFloat) {
      this._redoHeldByFloat = this._floatHoldsWork();
      this._notifyHistory(false);
    }
    this.dispatchEvent(new CustomEvent('transform-change', {
      bubbles: true,
      composed: true,
      detail: {
        active: this._transformManager !== null,
        values: this.getTransformValues(),
      },
    }));
  }

  private _transformValuesEqual(
    a: ReturnType<DrawingCanvas['getTransformValues']>,
    b: ReturnType<DrawingCanvas['getTransformValues']>,
  ): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height &&
      a.rotation === b.rotation &&
      a.skewX === b.skewX &&
      a.skewY === b.skewY &&
      a.flipH === b.flipH &&
      a.flipV === b.flipV;
  }

  public undo() {
    // Finalize any in-progress text/brush/shape/move so it becomes its own
    // history entry before we undo. Without this, the undo modifies the
    // layer under the stroke, corrupting _beforeDrawCanvas and the history.
    if (this._textEditing) {
      this._commitText();
    }
    if (this._drawing) {
      // Commit the engine's stroke buffer to the layer before capturing history
      const layerCtx = this._getActiveLayerCtx();
      const region = layerCtx ? this._commitStroke(layerCtx) : undefined;
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      const hadBeforeData = this._beforeDrawCanvas !== null;
      this._pushDrawHistory(false, region);
      if (this.previewCanvas) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      }
      this.composite();
      if (!hadBeforeData) return;
    }
    if (this._moveTempCanvas) {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory();
      this.composite();
    }
    // A live float is committed and that step undone, so nothing is lost for
    // good: Redo puts it back. (A float that changed nothing just ends.)
    if (this._transformManager) {
      const before = this._history;
      this.commitTransform();
      if (this._history === before) return;
    }
    if (this._historyIndex < 0) return;
    const entry = this._history[this._historyIndex];
    this._historyIndex--;
    this._applyUndo(entry);
    this._bumpLayerRevisions(entry);
    // A crop rectangle drawn on the other size of document no longer fits it.
    if (entry.type === 'crop' && this._cropRect) this.cancelCrop();
    this.composite();
    this._notifyHistory();
  }

  public redo() {
    // Committing typed text would be a new step, which ends the redo stack:
    // Redo waits until the text is done. So for a float holding work (see
    // `_floatHoldsWork`); one that changed nothing just ends below.
    if (this.hasPendingText() || this._floatHoldsWork()) return;
    if (this._textEditing) {
      this._commitText();
    }
    if (this._drawing) {
      const layerCtx = this._getActiveLayerCtx();
      const region = layerCtx ? this._commitStroke(layerCtx) : undefined;
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      const hadBeforeData = this._beforeDrawCanvas !== null;
      this._pushDrawHistory(false, region);
      if (this.previewCanvas) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      }
      this.composite();
      if (!hadBeforeData) return;
    }
    if (this._moveTempCanvas) {
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this._pushDrawHistory();
      this.composite();
    }
    if (this._historyIndex >= this._history.length - 1) return;
    if (this._transformManager) {
      this.cancelTransform();
    }
    this._historyIndex++;
    const entry = this._history[this._historyIndex];
    this._applyRedo(entry);
    this._bumpLayerRevisions(entry);
    if (entry.type === 'crop' && this._cropRect) this.cancelCrop();
    this.composite();
    this._notifyHistory();
  }

  private _applyUndo(entry: HistoryEntry) {
    const state = this._ctx.value?.state;
    if (!state) return;
    switch (entry.type) {
      case 'draw':
      case 'transform': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) layer.canvas.getContext('2d')!.putImageData(entry.before, 0, 0);
        break;
      }
      case 'patch': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer && !isNoOpPatch(entry)) layer.canvas.getContext('2d')!.putImageData(entry.before, entry.x, entry.y);
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
      case 'blend-mode': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          (layer as unknown as Record<string, unknown>).blendMode = entry.before;
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
      case 'merge': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: {
            action: 'stack-replace',
            layers: entry.beforeLayers,
            activeLayerId: entry.previousActiveLayerId,
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
      case 'draw':
      case 'transform': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) layer.canvas.getContext('2d')!.putImageData(entry.after, 0, 0);
        break;
      }
      case 'patch': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer && !isNoOpPatch(entry)) layer.canvas.getContext('2d')!.putImageData(entry.after, entry.x, entry.y);
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
      case 'blend-mode': {
        const layer = state.layers.find(l => l.id === entry.layerId);
        if (layer) {
          (layer as unknown as Record<string, unknown>).blendMode = entry.after;
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
      case 'merge': {
        this.dispatchEvent(new CustomEvent('layer-undo', {
          bubbles: true, composed: true,
          detail: {
            action: 'stack-replace',
            layers: entry.afterLayers,
            activeLayerId: entry.afterActiveLayerId,
          },
        }));
        break;
      }
    }
  }

  public clearCanvas() {
    // Finalize any in-progress brush stroke before clearing
    if (this._drawing) {
      const layerCtx = this._getActiveLayerCtx();
      const region = layerCtx ? this._commitStroke(layerCtx) : undefined;
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory(true, region);
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

  /**
   * Draws `layer` with the floating transform merged in by source-over, as
   * commit will, through `ctx`'s current blend mode and alpha. The merge
   * happens at viewport resolution in a scratch canvas sharing `ctx`'s
   * transform, so a drag costs no more than drawing the two separately, and
   * the merged result is clipped to the document, as the layer is.
   */
  private _drawLayerWithTransformInView(ctx: CanvasRenderingContext2D, layer: Layer, tm: TransformManager): void {
    const { width, height } = ctx.canvas;
    let scratch = this._transformViewCanvas;
    if (!scratch) scratch = this._transformViewCanvas = document.createElement('canvas');
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    // Only the document's on-screen rectangle is ever drawn in, so only it is
    // cleared and copied.
    const m = ctx.getTransform();
    const lw = layer.canvas.width, lh = layer.canvas.height;
    const xs = [m.e, m.a * lw + m.e, m.c * lh + m.e, m.a * lw + m.c * lh + m.e];
    const ys = [m.f, m.b * lw + m.f, m.d * lh + m.f, m.b * lw + m.d * lh + m.f];
    const rx = Math.max(0, Math.floor(Math.min(...xs))), ry = Math.max(0, Math.floor(Math.min(...ys)));
    const rw = Math.min(width, Math.ceil(Math.max(...xs))) - rx;
    const rh = Math.min(height, Math.ceil(Math.max(...ys))) - ry;
    if (rw <= 0 || rh <= 0) return;
    const sctx = scratch.getContext('2d')!;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(rx, ry, rw, rh);
    sctx.setTransform(m);
    sctx.save();
    sctx.beginPath();
    sctx.rect(0, 0, lw, lh);
    sctx.clip();
    sctx.drawImage(layer.canvas, 0, 0);
    tm.renderTransformed(sctx);
    sctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(scratch, rx, ry, rw, rh, rx, ry, rw, rh);
    ctx.restore();
  }

  /**
   * The layer as it will be once the active transform commits: a new canvas
   * with the floating content merged in by source-over, as
   * `TransformManager.commit` does, for flattening and sampling at document
   * resolution. Other layers, and every layer with no transform, come back as is.
   */
  private _layerWithTransform(layer: Layer, activeLayerId: string | null): HTMLCanvasElement {
    if (!this._transformManager || layer.id !== activeLayerId) return layer.canvas;
    const merged = document.createElement('canvas');
    merged.width = layer.canvas.width;
    merged.height = layer.canvas.height;
    const ctx = merged.getContext('2d')!;
    ctx.drawImage(layer.canvas, 0, 0);
    this._transformManager.renderTransformed(ctx, { x: 0, y: 0, w: merged.width, h: merged.height });
    return merged;
  }

  /**
   * Flattens every visible layer (plus any active transform at its layer's
   * z-position) onto a new canvas at document size, without the checkerboard.
   * `background` fills the canvas first; `null` keeps transparency.
   */
  public renderFlattened(background: string | null = '#ffffff'): HTMLCanvasElement {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = this._docWidth;
    exportCanvas.height = this._docHeight;
    const exportCtx = exportCanvas.getContext('2d')!;
    if (background) {
      exportCtx.fillStyle = background;
      exportCtx.fillRect(0, 0, this._docWidth, this._docHeight);
    }
    const state = this._ctx.value?.state;
    const layers = state?.layers ?? [];
    const activeLayerId = state?.activeLayerId ?? null;
    for (const layer of layers) {
      if (!layer.visible) continue;
      exportCtx.globalAlpha = layer.opacity;
      exportCtx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
      // Includes active transform content at its z-position
      exportCtx.drawImage(this._layerWithTransform(layer, activeLayerId), 0, 0);
      exportCtx.globalCompositeOperation = 'source-over';
      exportCtx.globalAlpha = 1.0;
    }
    return exportCanvas;
  }

  public saveCanvas() {
    // Composite onto a temp canvas without checkerboard for clean export
    const exportCanvas = this.renderFlattened('#ffffff');
    const link = document.createElement('a');
    link.download = `${exportFileBaseName(this._ctx.value?.currentProject?.name)}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }

  // --- Coordinate conversion ---

  /**
   * Bounding rect of the display canvas, cached between layout changes.
   * getBoundingClientRect() forces a layout flush and the pointer handlers call it
   * several times per event; the cache is dropped whenever the canvas can have moved.
   */
  private _getCanvasRect(): DOMRect {
    if (!this._canvasRect) {
      this._canvasRect = this.mainCanvas.getBoundingClientRect();
    }
    return this._canvasRect;
  }

  private _invalidateCanvasRect = () => { this._canvasRect = null; };

  /** Convert viewport pointer position to document coordinates */
  private _getDocPoint(e: PointerEvent): Point {
    const rect = this._getCanvasRect();
    const k = this._clientScale(rect);
    return {
      x: ((e.clientX - rect.left) * k.x - this._panX) / this._zoom,
      y: ((e.clientY - rect.top) * k.y - this._panY) / this._zoom,
    };
  }

  /**
   * View (CSS) pixels per client pixel. 1 unless a host's CSS `zoom` (or a
   * transform) scales the editor, when the canvas is shown at another size
   * than its own CSS size.
   */
  private _clientScale(rect: DOMRect): Point {
    const w = this._vw, h = this._vh;
    return {
      x: rect.width > 0 && w > 0 ? w / rect.width : 1,
      y: rect.height > 0 && h > 0 ? h / rect.height : 1,
    };
  }

  /** Client position as a position in the display canvas's own pixels. */
  private _clientToView(clientX: number, clientY: number): Point {
    const rect = this._getCanvasRect();
    const k = this._clientScale(rect);
    return { x: (clientX - rect.left) * k.x, y: (clientY - rect.top) * k.y };
  }

  private _clientToDoc(clientX: number, clientY: number): Point {
    const rect = this._getCanvasRect();
    const k = this._clientScale(rect);
    return {
      x: ((clientX - rect.left) * k.x - this._panX) / this._zoom,
      y: ((clientY - rect.top) * k.y - this._panY) / this._zoom,
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
    const k = this._clientScale(this._getCanvasRect());
    this._panX = this._panStartOffsetX + (e.clientX - this._panStartX) * k.x;
    this._panY = this._panStartOffsetY + (e.clientY - this._panStartY) * k.y;
    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.scheduleComposite(false);
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
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
      const rect = this._getCanvasRect();
      const k = this._clientScale(rect);
      const viewportX = (e.clientX - rect.left) * k.x;
      const viewportY = (e.clientY - rect.top) * k.y;

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

      this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
      this.scheduleComposite(false);
      if (this._textEditing) this._renderTextPreview();
      if (this._cropRect) this._drawCropPreview();
      this._dispatchZoomChange(true);
      return;
    }

    // Plain wheel → pan
    e.preventDefault();
    // Wheel deltas are client pixels; the pan is in display-canvas pixels.
    const k = this._clientScale(this._getCanvasRect());
    this._panX -= e.deltaX * k.x;
    this._panY -= e.deltaY * k.y;
    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.scheduleComposite(false);
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
    this._scheduleViewportChange();
  };

  /** `coalesce` defers viewport-change to the next frame, for continuous gestures. */
  private _dispatchZoomChange(coalesce = false) {
    this.dispatchEvent(new CustomEvent('zoom-change', {
      bubbles: true,
      composed: true,
      detail: { zoom: this._zoom },
    }));
    if (coalesce) {
      this._scheduleViewportChange();
    } else {
      this._dispatchViewportChange();
    }
  }

  private _scheduleViewportChange() {
    this._viewportChangePending = true;
    this._viewportChangeScheduler.schedule();
  }

  /** Dispatch a coalesced viewport-change now rather than on the next frame. */
  public flushViewportChange() {
    if (this._viewportChangePending) this._dispatchViewportChange();
  }

  private _dispatchViewportChange() {
    this._viewportChangeScheduler.cancel();
    this._viewportChangePending = false;
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

  /** Show the whole document: 100% when it fits, otherwise fit it to the viewport. */
  public resetView() {
    if (!this.mainCanvas) return;
    this._setCenteredZoom(Math.min(1, this._fitZoom()));
  }

  public zoomToFit() {
    this._setCenteredZoom(this._fitZoom());
  }

  private _fitZoom(): number {
    return Math.min(
      this._vw / this._docWidth,
      this._vh / this._docHeight,
    ) * 0.9;
  }

  private _setCenteredZoom(zoom: number) {
    this._zoom = Math.min(DrawingCanvas.MAX_ZOOM, Math.max(DrawingCanvas.MIN_ZOOM, zoom));
    this._panX = Math.round((this._vw - this._docWidth * this._zoom) / 2);
    this._panY = Math.round((this._vh - this._docHeight * this._zoom) / 2);
    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.composite();
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
    this._dispatchZoomChange();
  }

  public getZoom(): number { return this._zoom; }

  public getViewport(): { zoom: number; panX: number; panY: number } {
    return { zoom: this._zoom, panX: this._panX, panY: this._panY };
  }

  /** Whether the display canvas has been sized from real layout, not the 800×600 fallback. */
  private _laidOut = false;

  /** The display canvas size in CSS pixels, saved with the viewport so a restore can tell the screen changed. */
  public getViewportSize(): { width: number; height: number } | null {
    return this._laidOut ? { width: this._vw, height: this._vh } : null;
  }

  /**
   * Restore a saved view. When it was saved on a noticeably different screen
   * size (a desktop project opened on a phone), or it would leave most of the
   * document off-screen, show the whole document instead.
   */
  public restoreViewport(
    zoom: number,
    panX: number,
    panY: number,
    savedSize?: { width: number; height: number },
  ) {
    // Measured now, not when the size observer next reports: the layout may
    // have just changed (the phone layout chosen as the document loads).
    this._resizeToFit();
    if (savedSize && this._laidOut) {
      if (!DrawingCanvas._similarSize(savedSize, { width: this._vw, height: this._vh })) {
        this.resetView();
        return;
      }
      // Keep the same document point at the centre, as a window resize does,
      // on whole pixels. A half pixel either way is dropped, not rounded up,
      // or reloads at sizes an odd pixel apart would creep the view along.
      const ox = (this._vw - savedSize.width) / 2, oy = (this._vh - savedSize.height) / 2;
      const exactX = panX + ox, exactY = panY + oy;
      panX = Math.round(panX + Math.trunc(ox));
      panY = Math.round(panY + Math.trunc(oy));
      this.setViewport(zoom, panX, panY);
      // The canvas often resizes again (the tool bar settling to the saved
      // tool's height), which takes the view back to where it was saved.
      this._resizePan = { x: panX, y: panY, dx: exactX - panX, dy: exactY - panY };
    } else {
      this.setViewport(zoom, panX, panY);
    }
    if (this._visibleDocumentFraction() < 0.5) this.resetView();
  }

  private static _similarSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
    const close = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * 0.2;
    return close(a.width, b.width) && close(a.height, b.height);
  }

  /**
   * How much of the document is on screen, relative to the most that could
   * be: the whole document when it is smaller than the viewport, otherwise a
   * viewport's worth of it.
   */
  private _visibleDocumentFraction(): number {
    const docW = this._docWidth * this._zoom;
    const docH = this._docHeight * this._zoom;
    const visW = Math.max(0, Math.min(this._vw, this._panX + docW) - Math.max(0, this._panX));
    const visH = Math.max(0, Math.min(this._vh, this._panY + docH) - Math.max(0, this._panY));
    const possible = Math.min(docW, this._vw) * Math.min(docH, this._vh);
    return possible > 0 ? (visW * visH) / possible : 0;
  }

  public setViewport(zoom: number, panX: number, panY: number) {
    this._zoom = Math.min(DrawingCanvas.MAX_ZOOM, Math.max(DrawingCanvas.MIN_ZOOM, zoom));
    this._panX = panX;
    this._panY = panY;
    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.scheduleComposite(false);
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
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

    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.composite();
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
    this._dispatchZoomChange();
  }

  // --- Eyedropper helpers ---

  private _ensureSamplingBuffer(): CanvasRenderingContext2D {
    if (!this._samplingBuffer || this._samplingBuffer.width !== this._docWidth || this._samplingBuffer.height !== this._docHeight) {
      this._samplingBuffer = document.createElement('canvas');
      this._samplingBuffer.width = this._docWidth;
      this._samplingBuffer.height = this._docHeight;
      this._samplingDirty = true;
    }
    const ctx = this._samplingBuffer.getContext('2d', { willReadFrequently: true })!;
    if (this._samplingDirty) {
      ctx.clearRect(0, 0, this._docWidth, this._docHeight);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this._docWidth, this._docHeight);
      const layers = this._ctx.value?.state.layers ?? [];
      const activeLayerId = this._ctx.value?.state.activeLayerId ?? null;
      for (const layer of layers) {
        if (!layer.visible) continue;
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = blendModeToCompositeOp(layer.blendMode);
        // Includes active transform content at its z-position
        ctx.drawImage(this._layerWithTransform(layer, activeLayerId), 0, 0);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
      this._samplingDirty = false;
    }
    return ctx;
  }

  private _sampleColor(docX: number, docY: number): string | null {
    const x = Math.round(docX);
    const y = Math.round(docY);
    if (x < 0 || y < 0 || x >= this._docWidth || y >= this._docHeight) return null;

    const sampleAll = this.ctx.state.eyedropperSampleAll;

    if (sampleAll) {
      const ctx = this._ensureSamplingBuffer();
      const data = ctx.getImageData(x, y, 1, 1).data;
      return `#${data[0].toString(16).padStart(2, '0')}${data[1].toString(16).padStart(2, '0')}${data[2].toString(16).padStart(2, '0')}`;
    } else {
      const layerCtx = this._getActiveLayerCtx();
      if (!layerCtx) return null;
      const data = layerCtx.getImageData(x, y, 1, 1).data;
      if (data[3] === 0) return null;
      if (data[3] < 255) {
        const a = data[3] / 255;
        const r = Math.round(data[0] * a + 255 * (1 - a));
        const g = Math.round(data[1] * a + 255 * (1 - a));
        const b = Math.round(data[2] * a + 255 * (1 - a));
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      }
      return `#${data[0].toString(16).padStart(2, '0')}${data[1].toString(16).padStart(2, '0')}${data[2].toString(16).padStart(2, '0')}`;
    }
  }

  private _renderEyedropperPreview(e: PointerEvent) {
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);

    const docPoint = this._getDocPoint(e);
    const color = this._sampleColor(docPoint.x, docPoint.y);

    // The loupe's cells are document pixels, read from what is picked from:
    // the flattened document or the active layer (not the display canvas,
    // whose device pixels differ from them by zoom and devicePixelRatio).
    const sampleAll = this.ctx.state.eyedropperSampleAll;
    const sourceCanvas = sampleAll ? this._ensureSamplingBuffer().canvas : this._getActiveLayerCtx()?.canvas;

    const GRID_SIZE = 88;
    const SWATCH_HEIGHT = 24;
    const TOTAL_HEIGHT = GRID_SIZE + SWATCH_HEIGHT + 4;
    const OFFSET = 20;

    const view = this._clientToView(e.clientX, e.clientY);
    let destX = view.x + OFFSET;
    let destY = view.y - OFFSET - TOTAL_HEIGHT;

    if (destX + GRID_SIZE > this._vw) destX = destX - GRID_SIZE - 2 * OFFSET;
    if (destY < 0) destY = destY + TOTAL_HEIGHT + 2 * OFFSET;

    previewCtx.save();
    previewCtx.imageSmoothingEnabled = false;

    if (sourceCanvas) {
      const srcX = Math.round(docPoint.x);
      const srcY = Math.round(docPoint.y);
      previewCtx.drawImage(sourceCanvas, srcX - 5, srcY - 5, 11, 11, destX, destY, GRID_SIZE, GRID_SIZE);
    }

    previewCtx.restore();

    // Grid lines
    previewCtx.strokeStyle = 'rgba(255,255,255,0.3)';
    previewCtx.lineWidth = 0.5;
    const cellSize = GRID_SIZE / 11;
    for (let i = 0; i <= 11; i++) {
      const x = destX + i * cellSize;
      const y = destY + i * cellSize;
      previewCtx.beginPath();
      previewCtx.moveTo(x, destY);
      previewCtx.lineTo(x, destY + GRID_SIZE);
      previewCtx.stroke();
      previewCtx.beginPath();
      previewCtx.moveTo(destX, y);
      previewCtx.lineTo(destX + GRID_SIZE, y);
      previewCtx.stroke();
    }

    // Center crosshair
    const cx = destX + 5 * cellSize;
    const cy = destY + 5 * cellSize;
    previewCtx.strokeStyle = '#fff';
    previewCtx.lineWidth = 1.5;
    previewCtx.strokeRect(cx, cy, cellSize, cellSize);

    // Border
    previewCtx.strokeStyle = '#555';
    previewCtx.lineWidth = 1;
    previewCtx.strokeRect(destX - 0.5, destY - 0.5, GRID_SIZE + 1, TOTAL_HEIGHT + 1);

    // Color swatch and hex label
    if (color) {
      previewCtx.fillStyle = color;
      previewCtx.fillRect(destX, destY + GRID_SIZE + 2, SWATCH_HEIGHT, SWATCH_HEIGHT);
      previewCtx.fillStyle = '#fff';
      previewCtx.font = '11px monospace';
      previewCtx.fillText(color.toUpperCase(), destX + SWATCH_HEIGHT + 6, destY + GRID_SIZE + 16);
    }
  }

  private _clearEyedropperPreview() {
    const previewCtx = this.previewCanvas?.getContext('2d');
    if (previewCtx) previewCtx.clearRect(0, 0, this._vw, this._vh);
  }

  /** Blurs a focused form field elsewhere in the app, applying a value typed in it. */
  private _blurFocusedField() {
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (el !== this._textAreaEl && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
      // Typing goes on into the text being edited (a font size was set, say),
      // or else to the app, whose shortcuts listen there (a touch drag, unlike
      // a click, focuses nothing itself).
      if (this._textEditing) this._textAreaEl?.focus();
      else focusEditor(this);
      el.blur();
    }
  }

  private _isInTextBox(p: Point): boolean {
    const box = this._getTextBoundingBox();
    return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
  }

  /** On macOS Ctrl+click opens it, and a transform uses Ctrl+drag. */
  private _onContextMenu = (e: Event) => {
    if (this._transformManager) e.preventDefault();
  };

  private _onWindowBlur = () => {
    this._altSampling = false;
    this._clearEyedropperPreview();
    // Something may be copied elsewhere now; see paste().
    this._systemClipboardWrite = null;
  };

  /** Text copied in a field or on the page (our own copy shortcuts fire no copy event): see paste(). */
  private _onOtherCopy = () => {
    this._systemClipboardWrite = null;
  };

  // --- Brush cursor / preview ---

  private _renderBrushCursor() {
    if (!this._pointerOnCanvas) return;
    if (this._altSampling) return;
    const { activeTool } = this.ctx.state;
    const brush = this._brushDescriptor;
    const brushSize = brush.size;
    const hardness = brush.hardness;
    if (activeTool !== 'pencil' && activeTool !== 'eraser') return;

    const previewCtx = this.previewCanvas.getContext('2d')!;

    const cx = this._lastPointerScreenX;
    const cy = this._lastPointerScreenY;
    const outerRadius = (brushSize / 2) * this._zoom;

    // Outer ring: black + white (inverted outline)
    previewCtx.beginPath();
    previewCtx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    previewCtx.strokeStyle = 'rgba(0,0,0,0.7)';
    previewCtx.lineWidth = 1.5;
    previewCtx.stroke();
    previewCtx.beginPath();
    previewCtx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    previewCtx.strokeStyle = 'rgba(255,255,255,0.7)';
    previewCtx.lineWidth = 0.75;
    previewCtx.stroke();

    // Inner dashed ring for hardness
    if (hardness < 1) {
      const innerRadius = outerRadius * hardness;
      previewCtx.beginPath();
      previewCtx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
      previewCtx.setLineDash([3, 3]);
      previewCtx.strokeStyle = 'rgba(255,255,255,0.5)';
      previewCtx.lineWidth = 0.75;
      previewCtx.stroke();
      previewCtx.setLineDash([]);
    }
  }

  private _renderStampCursor() {
    if (!this._pointerOnCanvas || this._transformManager) return;
    const img = this.ctx.state.stampImage;
    if (!img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

    const previewCtx = this.previewCanvas.getContext('2d')!;
    const size = this.ctx.state.stampSize;
    const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.max(1, img.naturalWidth * scale) * this._zoom;
    const h = Math.max(1, img.naturalHeight * scale) * this._zoom;
    const x = this._lastPointerScreenX - w / 2;
    const y = this._lastPointerScreenY - h / 2;

    previewCtx.save();
    previewCtx.globalAlpha = 0.55;
    previewCtx.drawImage(img, x, y, w, h);
    previewCtx.globalAlpha = 1;
    previewCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    previewCtx.lineWidth = 1;
    previewCtx.setLineDash([4, 3]);
    previewCtx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
    previewCtx.restore();
  }

  private _renderPreview() {
    const previewCtx = this.previewCanvas?.getContext('2d');
    if (!previewCtx) return;
    // TransformManager owns the preview canvas while a float is active. Any
    // general preview refresh must delegate to it so the outline and handles
    // remain populated after reactive updates or canvas clears.
    if (this._transformManager) {
      this._transformManager.renderPreview();
      return;
    }

    const { activeTool } = this.ctx.state;

    if (activeTool === 'pencil' || activeTool === 'eraser' || activeTool === 'eyedropper' || activeTool === 'stamp') {
      previewCtx.clearRect(0, 0, this._vw, this._vh);

      if (this._altSampling || activeTool === 'eyedropper') {
        return;
      }

      if (activeTool === 'stamp') {
        this._renderStampCursor();
      } else if (!this._drawing) {
        this._renderBrushCursor();
      }
    }
  }

  // --- Pointer events ---

  private _onPointerDown(e: PointerEvent) {
    // Re-measure once per gesture: panels and toolbars may have shifted the canvas
    // since the last pointer interaction.
    this._invalidateCanvasRect();
    if (!this._replayingTap) {
      // A touch while a pen is down is a resting palm, not a second finger.
      if (e.pointerType === 'touch' && [...this._pointers.values()].some(p => p.type === 'pen')) {
        this._palmPointers.add(e.pointerId);
        return;
      }
      // A pen landing while touches are down: they are a resting palm. Undo
      // what they started and ignore them until they lift.
      if (e.pointerType === 'pen') {
        for (const [id, p] of this._pointers) {
          if (p.type !== 'touch') continue;
          this._cancelCurrentTool(id, true);
          this._pointers.delete(id);
          this._palmPointers.add(id);
        }
        this._pendingTap = null;
        this._pinching = false;
      }
      // A primary pointer means no other of its kind is down: any still
      // listed lost its release (lifted off the canvas, say).
      if (e.isPrimary) {
        for (const [id, p] of this._pointers) {
          if (id !== e.pointerId && p.type === e.pointerType) this._pointers.delete(id);
        }
        if (this._pointers.size < 2) this._pinching = false;
      }
      // A value typed in a panel field applies when the field blurs, which
      // this press would only do after this handler; apply it first. It may
      // move the float: the press means what was on screen.
      if (e.button === 0) {
        const tm = this._transformManager;
        const p = this._getDocPoint(e);
        const drawn = tm && { kind: tm.hitKind(p), button: tm.buttonAt(p), values: this.getTransformValues() };
        this._blurFocusedField();
        // Off the float, a press that applied a value shows it rather than
        // committing it unseen.
        if (tm && drawn && tm === this._transformManager && (drawn.kind !== tm.hitKind(p)
          || (drawn.kind === 'outside' && !this._transformValuesEqual(drawn.values, this.getTransformValues())))) {
          this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
          // A button as drawn still acts on release; anything else, the float
          // has moved out from under, so this press only applied the value.
          if (drawn.button) tm.pressButton(drawn.button);
          this.mainCanvas.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    // Track all active pointers for multi-touch
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Two fingers → enter pinch/pan mode
    if (this._pointers.size === 2) {
      this._enterPinchMode(e);
      return;
    }

    // More than 2 fingers → ignore
    if (this._pointers.size > 2) return;

    if (!this._ctx.value) return;

    // Middle mouse button → always pan
    if (e.button === 1) {
      e.preventDefault();
      this._startPan(e);
      return;
    }

    if (e.button !== 0) {
      // Not a gesture we track (e.g. right-click, whose pointerup a context
      // menu can swallow); don't leave it counted as a pointer down.
      this._pointers.delete(e.pointerId);
      return;
    }

    const tm = this._transformManager;
    const hand = this.ctx.state.activeTool === 'hand';
    // Touch gets bigger handles and buttons, laid out differently; a first
    // tap on the ✓/✗ drawn for the mouse still means them.
    if (tm && e.pointerType === 'touch' && !tm.touchMode && !tm.hitTestButton(this._getDocPoint(e))) {
      const p = this._getDocPoint(e);
      const drawn = tm.hitKind(p);
      tm.setTouchMode(true);
      // The bigger touch layout puts something else under the finger than
      // what was on screen: this tap only switches layouts. (Under the hand
      // tool, which pans everywhere else, only a button counts.)
      if (hand ? tm.hitTestButton(p) : tm.hitKind(p) !== drawn) return;
    }

    // The hand tool pans, a float or not; only the float's ✓/✗ still take a
    // press (a pasted or dropped float can be active under it).
    if (tm && hand && !tm.hitTestButton(this._getDocPoint(e))) {
      this._startPan(e);
      return;
    }

    // TransformManager intercepts all pointer events when active
    if (tm) {
      const p = this._getDocPoint(e);
      const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
      // A pen tap drifts more than a click.
      tm.onPointerDown(p, modifiers, e.pointerType === 'pen' ? HANDLE_CONFIG_TOUCH.outsideDragThreshold : undefined);
      if (!this._replayingTap) this.mainCanvas.setPointerCapture(e.pointerId);
      return;
    }

    const { activeTool } = this.ctx.state;

    if (e.pointerType === 'touch' && !this._replayingTap && (
      activeTool === 'stamp' || activeTool === 'fill' || activeTool === 'eyedropper'
      // A new text box, or committing one by tapping outside it.
      || (activeTool === 'text' && (!this._textEditing || !this._isInTextBox(this._getDocPoint(e)))))) {
      // Keeps the text box's textarea focusable, as below.
      if (activeTool === 'text') e.preventDefault();
      if (activeTool === 'stamp') {
        // The second press of a double-click on ✓/✗ is judged when it lands,
        // not when the finger lifts (a held press would outlast the window).
        const ended = this._floatButtonEnd;
        this._floatButtonEnd = null;
        if (ended && e.timeStamp - ended.time < 400
            && Math.hypot(e.clientX - ended.x, e.clientY - ended.y) < 6) return;
      }
      this._pendingTap = { pointerId: e.pointerId, down: e };
      return;
    }

    // Alt-hold eyedropper modifier for drawing tools
    if (e.altKey && (activeTool === 'pencil' || activeTool === 'eraser')) {
      this._altSampling = true;
      const p = this._getDocPoint(e);
      const color = this._sampleColor(p.x, p.y);
      if (color) this.ctx.setStrokeColor(color);
      return;
    }

    // Hand tool → pan
    if (activeTool === 'hand') {
      this._startPan(e);
      return;
    }

    if (activeTool === 'crop') {
      this.mainCanvas.setPointerCapture(e.pointerId);
      const p = this._getDocPoint(e);
      this._handleCropPointerDown(p, e.pointerType === 'touch');
      return;
    }

    // Eyedropper tool → sample color
    if (activeTool === 'eyedropper') {
      const p = this._getDocPoint(e);
      const color = this._sampleColor(p.x, p.y);
      if (color) this.ctx.setStrokeColor(color);
      return;
    }

    // Block drawing on invisible layers — all tools below modify the active layer
    const activeLayer = this.ctx.state.layers.find(l => l.id === this.ctx.state.activeLayerId);
    if (activeLayer && !activeLayer.visible) return;

    // Move tool → translate active layer
    if (activeTool === 'move') {
      this.mainCanvas.setPointerCapture(e.pointerId);
      if (this._transformManager) this.commitTransform();
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

    // A held tap's pointer is gone by the time it is carried out.
    if (!this._replayingTap) this.mainCanvas.setPointerCapture(e.pointerId);
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
          // WebKit may defer the snapshot's drawImage until it is read, and
          // the fill's putImageData then shows through it (the fill had no
          // undo step): read it now.
          this._beforeDrawCanvas?.getContext('2d')!.getImageData(0, 0, 1, 1);
          const filled = floodFill(layerCtx, fx, fy, this.ctx.state.strokeColor);
          if (filled) {
            this._pushDrawHistory(false, filled);
            this.composite();
          } else {
            this._beforeDrawCanvas = null;
          }
        }
      }
      return;
    }

    if (activeTool === 'stamp') {
      const ended = this._floatButtonEnd;
      this._floatButtonEnd = null;
      if (ended && e.timeStamp - ended.time < 400
          && Math.hypot(e.clientX - ended.x, e.clientY - ended.y) < 6) return;
      // TransformManager intercept above handles active transforms.
      // Commit any active transform, then place a new stamp.
      if (this._transformManager) this.commitTransform();
      if (this.ctx.state.stampImage) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
        this._createStampAsTransform(
          this.ctx.state.stampImage,
          p.x,
          p.y,
          this.ctx.state.stampSize,
          e.pointerType === 'touch',
        );
      }
      return;
    }

    if (activeTool === 'text') {
      // Prevent mousedown compatibility event from stealing focus from
      // the hidden textarea. Without this, the browser's default mousedown
      // behavior blurs the textarea, causing keyboard shortcuts to fire
      // instead of typing into the text tool.
      e.preventDefault();
      if (this._textEditing) {
        // Check if click is inside the text bounding box -> place caret / start selection
        const box = this._getTextBoundingBox();
        if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) {
          const offset = this._pointToTextOffset(p);
          if (this._textAreaEl) {
            // Put back if this finger turns out to start a pinch.
            this._textSelectionBeforePress = [this._textAreaEl.selectionStart, this._textAreaEl.selectionEnd];
            this._textAreaEl.selectionStart = offset;
            this._textAreaEl.selectionEnd = offset;
          }
          this._textSelectAnchor = offset;
          this._textSelecting = true;
          this._startTextCursorBlink();
          this._renderTextPreview();
          return;
        }
        // Click outside -> commit current text
        this._commitText();
        return;
      }
      // Start new text session
      this._textPosition = p;
      this._textEditing = true;
      if (this._textAreaEl) {
        this._textAreaEl.value = '';
        this._textAreaEl.focus();
      }
      this._startTextCursorBlink();
      this._renderTextPreview();
      return;
    }

    this._drawing = true;
    this._lastPoint = p;
    this._startPoint = p;

    if (activeTool === 'pencil' || activeTool === 'eraser') {
      // Clear the brush cursor ring from the preview canvas before drawing starts
      this.previewCanvas?.getContext('2d')?.clearRect(0, 0, this._vw, this._vh);
      this._captureBeforeDraw();
      const desc = this._brushDescriptor;
      const color = this.ctx.state.strokeColor;
      const eraser = this.ctx.state.activeTool === 'eraser';
      this._engine.begin(desc, color, eraser, this._docWidth, this._docHeight);
      // The tint scratch canvas is only cleared inside the previous stroke's bounds,
      // so wipe it once per stroke before reusing it.
      this._strokeTintNeedsClear = true;
      this._tintPreviewNeedsCopy = true;
      const layerCtx = desc.ink.wetness > 0 ? this._getActiveLayerCtx() ?? undefined : undefined;
      this._engine.stroke(p.x, p.y, normalizePointerPressure(e), layerCtx, e.timeStamp);
      this.composite();
    }
  }

  private _onPointerMove(e: PointerEvent) {
    if (this._palmPointers.has(e.pointerId)) return;
    // A mouse release never seen (a context menu took it, say) leaves a
    // gesture running with no button held: end it where it was last pressed.
    const tracked = this._pointers.get(e.pointerId);
    if (e.pointerType === 'mouse' && e.buttons === 0 && tracked) {
      this._onPointerUp(releasedAt(e, tracked.x, tracked.y));
      return;
    }

    // While another pointer is down, a pen or mouse merely hovering moves
    // nothing (the gesture under way would follow it).
    if (!tracked && this._pointers.size > 0) return;

    // Update pointer position
    if (tracked) {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: tracked.type });
    }

    const view = this._clientToView(e.clientX, e.clientY);
    this._lastPointerScreenX = view.x;
    this._lastPointerScreenY = view.y;

    // Handle pinch/pan gesture
    if (this._pinching) {
      this._updatePinch();
      return;
    }

    if (!this._ctx.value) return;

    // A middle-button pan, also during a transform.
    if (this._panning) {
      this._updatePan(e);
      return;
    }

    // TransformManager intercepts all pointer events when active
    if (this._transformManager) {
      const p = this._getDocPoint(e);
      const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
      const before = this.getTransformValues();
      const changed = this._transformManager.onPointerMove(p, modifiers);
      // On the canvas itself, whose own cursor would hide the host's. The
      // next update resets it once the transform ends.
      this.mainCanvas.style.cursor = this._transformCursor(p);
      if (changed) {
        // The float isn't on its layer until commit, so layer pixels (and the
        // thumbnails drawn from them) stay as they are; only the sampling
        // buffer, which merges the float in, goes stale.
        this.invalidateSamplingBuffer();
        this.scheduleComposite(false);
        const after = this.getTransformValues();
        if (!this._transformValuesEqual(before, after)) {
          this._dispatchTransformChange();
        }
      }
      return;
    }

    {
      const activeTool = this.ctx.state.activeTool;

      // Held down and dragged, a mouse or pen picks where the loupe is, so
      // what it's let go on is the colour, as with a finger (which picks as
      // it lifts).
      const pickHere = () => {
        // Not when Alt comes down in the middle of a stroke.
        if (!tracked || e.pointerType === 'touch' || !(e.buttons & 1) || this._drawing) return;
        const p = this._getDocPoint(e);
        const color = this._sampleColor(p.x, p.y);
        if (color) this.ctx.setStrokeColor(color);
      };

      if (activeTool === 'eyedropper') {
        this._renderEyedropperPreview(e);
        pickHere();
        return;
      }

      if (this._altSampling || (e.altKey && (activeTool === 'pencil' || activeTool === 'eraser'))) {
        this._altSampling = e.altKey;
        if (!e.altKey) {
          this._clearEyedropperPreview();
          return;
        }
        this._renderEyedropperPreview(e);
        pickHere();
        return;
      }
    }

    if (this._textSelecting) {
      const p = this._getDocPoint(e);
      const offset = this._pointToTextOffset(p);
      if (this._textAreaEl) {
        const anchor = this._textSelectAnchor;
        this._textAreaEl.selectionStart = Math.min(anchor, offset);
        this._textAreaEl.selectionEnd = Math.max(anchor, offset);
      }
      this._renderTextPreview();
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
        this.scheduleComposite();
      }
      return;
    }

    if (activeTool === 'select') {
      this._handleSelectPointerMove(e);
      return;
    }

    if (activeTool === 'stamp') {
      this._renderPreview();
      return;
    }

    // Render brush cursor when hovering (not drawing)
    if (!this._drawing && (activeTool === 'pencil' || activeTool === 'eraser')) {
      this._renderPreview();
    }

    if (!this._drawing || !this._lastPoint) return;
    const p = this._getDocPoint(e);

    if (activeTool === 'pencil' || activeTool === 'eraser') {
      const desc = this._brushDescriptor;
      const layerCtx = desc.ink.wetness > 0 ? this._getActiveLayerCtx() ?? undefined : undefined;
      this._engine.stroke(p.x, p.y, normalizePointerPressure(e), layerCtx, e.timeStamp);
      this._lastPoint = p;
      // The stroke stays in the engine's buffer until pointerup; the layer is unchanged.
      this.scheduleComposite(false);
    } else if (isShapeTool(activeTool)) {
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
        this._brushDescriptor.size,
      );
      previewCtx.restore();
    }
  }

  /** What the pointer is over once a gesture ends, while a transform is still active. */
  private _refreshTransformCursor(e: PointerEvent) {
    if (this._transformManager) this.mainCanvas.style.cursor = this._transformCursor(this._getDocPoint(e));
  }

  /** The cursor over `p` during a transform; under the hand tool, which only pans, the float's own except on ✓/✗. */
  private _transformCursor(p: Point): string {
    const cursor = this._transformManager!.getCursor(p);
    return this.ctx.state.activeTool === 'hand' && cursor !== 'pointer' ? 'grab' : cursor;
  }

  private _onPointerUp(e: PointerEvent) {
    if (this._palmPointers.delete(e.pointerId)) return;
    // Remove pointer from tracking
    this._pointers.delete(e.pointerId);

    // End pinch mode when fewer than 2 pointers
    if (this._pinching) {
      if (this._pointers.size < 2) {
        this._pinching = false;
      }
      return;
    }

    if (!this._ctx.value) return;

    const tap = this._pendingTap;
    if (tap && tap.pointerId === e.pointerId) {
      this._pendingTap = null;
      // The eyedropper samples, and a stamp (previewed under the finger) lands,
      // where the finger lifts; the rest act where it landed, unless it slid
      // off into a drag.
      const tool = this.ctx.state.activeTool;
      const slid = Math.hypot(e.clientX - tap.down.clientX, e.clientY - tap.down.clientY) > 10;
      const r = this._getCanvasRect();
      const onCanvas = e.clientX >= r.left && e.clientX <= r.left + r.width && e.clientY >= r.top && e.clientY <= r.top + r.height;
      const act = tool === 'eyedropper' || tool === 'stamp' ? (onCanvas ? e : null) : slid ? null : tap.down;
      if (act) {
        this._replayingTap = true;
        try {
          this._onPointerDown(act);
        } finally {
          this._replayingTap = false;
          this._pointers.delete(e.pointerId);
        }
      }
      return;
    }

    // A middle-button pan, also during a transform.
    if (this._panning) {
      this._endPan();
      this._refreshTransformCursor(e);
      return;
    }

    // TransformManager intercepts all pointer events when active
    if (this._transformManager) {
      const p = this._getDocPoint(e);
      const result = this._transformManager.onPointerUp(p);
      if (result === 'commit' || result === 'commit-button') {
        this.commitTransform();
      } else if (result === 'cancel-button') {
        this.cancelTransform();
      }
      // The second click of a double-click on ✓/✗ lands on the canvas, where
      // the stamp tool would drop a stray stamp.
      if (result === 'commit-button' || result === 'cancel-button') {
        this._floatButtonEnd = { time: e.timeStamp, x: e.clientX, y: e.clientY };
      }
      this.composite();
      this._refreshTransformCursor(e);
      return;
    }

    if (this._textSelecting) {
      this._textSelecting = false;
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
    if (this._drawing && activeTool !== 'pencil' &&
        activeTool !== 'eraser' && !isShapeTool(activeTool)) {
      const layerCtx = this._getActiveLayerCtx();
      const region = layerCtx ? this._commitStroke(layerCtx) : undefined;
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory(true, region);
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
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      // Records the layer as last rendered; a click without a drag (or a drag
      // back to the start) changes nothing and records nothing.
      this._pushDrawHistory();
      this.composite();
      return;
    }

    if (activeTool === 'select') {
      this._handleSelectPointerUp(e);
      return;
    }

    // Stamp transforms are handled by the TransformManager intercept above.

    if (!this._drawing) return;
    const p = this._getDocPoint(e);

    let region: PixelRect | undefined;
    if (isShapeTool(activeTool)) {
      // Capture before draw for shapes (they only commit on pointerup)
      this._captureBeforeDraw();
      // Commit shape to active layer
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        region = shapeBounds(this._startPoint!, p, this._brushDescriptor.size);
        drawShapePreview(
          layerCtx,
          activeTool,
          this._startPoint!,
          p,
          this.ctx.state.strokeColor,
          this.ctx.state.fillColor,
          this.ctx.state.useFill,
          this._brushDescriptor.size,
        );
      }
      // Clear preview
      const previewCtx = this.previewCanvas.getContext('2d')!;
      previewCtx.clearRect(0, 0, this._vw, this._vh);
    }

    // Commit engine stroke buffer to layer before capturing history
    if (activeTool === 'pencil' || activeTool === 'eraser') {
      const layerCtx = this._getActiveLayerCtx();
      if (layerCtx) {
        region = this._commitStroke(layerCtx);
      }
    }

    this._drawing = false;
    this._lastPoint = null;
    this._startPoint = null;
    this._pushDrawHistory(false, region);
    this.composite();
  }

  private _onPointerEnter = (e: PointerEvent) => {
    this._pointerOnCanvas = true;
    const view = this._clientToView(e.clientX, e.clientY);
    this._lastPointerScreenX = view.x;
    this._lastPointerScreenY = view.y;
    this._renderPreview();
  };

  private _onPointerLeave(e: PointerEvent) {
    this._pointerOnCanvas = false;
    this._renderPreview();
    if (this._pinching) {
      return;
    }
    // Only a pointer still down has a gesture to end (a lifted palm's leave
    // follows its release).
    if (!this._pointers.has(e.pointerId)) return;
    // If this pointer is captured, pointerleave is spurious — the real
    // end-of-interaction will arrive as pointerup or pointercancel.
    try {
      if (this.mainCanvas.hasPointerCapture(e.pointerId)) {
        return;
      }
    } catch {
      // hasPointerCapture can throw if canvas is not in DOM
    }
    this._onPointerUp(e);
  }

  private _onPointerCancel(e: PointerEvent) {
    if (this._palmPointers.delete(e.pointerId)) return;
    this._pointers.delete(e.pointerId);
    if (this._pendingTap?.pointerId === e.pointerId) this._pendingTap = null;
    if (this._pinching) {
      if (this._pointers.size < 2) {
        this._pinching = false;
      }
    } else {
      // Single-pointer cancel: discard any in-progress tool operation
      this._cancelCurrentTool(e.pointerId);
    }
  }

  /**
   * Cancel any in-progress tool operation and release pointer capture.
   * Called when a second pointer arrives (entering pinch/pan mode).
   */
  /** `revert`: the gesture turned out to be a pinch's first finger, so undo what it started. */
  private _cancelCurrentTool(pointerId: number, revert = false) {
    // Release pointer capture if held
    try { this.mainCanvas.releasePointerCapture(pointerId); } catch { /* not captured */ }

    // Cancel brush/shape strokes
    this._engine.cancel();
    if (this._drawing) {
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      // Restore layer to before the stroke
      if (this._beforeDrawCanvas) {
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          this._restoreBeforeDraw(layerCtx);
        }
        this._beforeDrawCanvas = null;
      }
      // Clear shape preview
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      this.composite();
    }

    // Cancel panning
    if (this._panning) {
      this._endPan();
    }

    // End a transform gesture where it is (or was, for a pinch), so a finger
    // left on the screen stops driving it and a drafted warp is redone in full.
    if (this._transformManager?.cancelInteraction(revert)) {
      this.composite();
    }

    // Cancel move tool drag
    if (this._moveTempCanvas) {
      if (this._beforeDrawCanvas) {
        const layerCtx = this._getActiveLayerCtx();
        if (layerCtx) {
          this._restoreBeforeDraw(layerCtx);
        }
        this._beforeDrawCanvas = null;
      }
      this._moveTempCanvas = null;
      this._moveStartPoint = null;
      this.composite();
    }

    // A caret placed (or text selected) by a pinch's first finger goes back.
    if (this._textSelecting) {
      this._textSelecting = false;
      if (revert && this._textAreaEl && this._textSelectionBeforePress) {
        [this._textAreaEl.selectionStart, this._textAreaEl.selectionEnd] = this._textSelectionBeforePress;
        this._renderTextPreview();
      }
    }

    // Cancel selection drawing (but keep existing float)
    if (this._selectionDrawing) {
      this._selectionDrawing = false;
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    }

    // Cancel crop drag (keep existing rect, normalized so it stays committable;
    // for a pinch, the rect as it was before)
    const wasCropGesture = this._cropDragging || this._cropHandle !== null;
    if (revert && this._cropDragging) this._cropRect = this._cropRectBeforeNew;
    else if (revert && this._cropHandle !== null && this._cropRectOrigin) this._cropRect = { ...this._cropRectOrigin };
    this._cropDragging = false;
    this._cropHandle = null;
    this._cropDragOrigin = null;
    this._cropRectOrigin = null;
    if (wasCropGesture && this._cropRect) {
      const ratio = parseAspectRatio(this._ctx.value?.state.cropAspectRatio ?? 'free');
      const rect = this._normalizeCropRect(this._cropRect, ratio);
      this._cropRect = rect.w < 1 || rect.h < 1 ? null : rect;
      if (this._cropRect) {
        this._drawCropPreview();
      } else {
        this._clearCropPreview();
      }
    }
    this._updateCropActions();
  }

  /** Enter pinch/pan mode: cancel current tool, initialize pinch tracking */
  private _enterPinchMode(e: PointerEvent) {
    // A held tap becomes the pinch's first finger: nothing to carry out.
    this._pendingTap = null;
    // Undo whatever the first finger had started.
    for (const [id] of this._pointers) {
      if (id !== e.pointerId) {
        this._cancelCurrentTool(id, true);
        break;
      }
    }
    // Both fingers' releases must come here, even off the canvas, or a
    // finger would stay counted as down.
    for (const id of this._pointers.keys()) {
      try { this.mainCanvas.setPointerCapture(id); } catch { /* already gone */ }
    }
    this._pinchPair = [...this._pointers.keys()].slice(0, 2).join();

    this._pinching = true;
    const pts = [...this._pointers.values()];
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    this._lastPinchDist = Math.hypot(dx, dy);
    this._lastPinchMidX = (pts[0].x + pts[1].x) / 2;
    this._lastPinchMidY = (pts[0].y + pts[1].y) / 2;
  }

  /** Process a pinch/pan gesture frame: update zoom and pan */
  private _updatePinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    // A third finger took over from a lifted one: start from where they are.
    const pair = [...this._pointers.keys()].slice(0, 2).join();
    if (pair !== this._pinchPair) {
      this._pinchPair = pair;
      this._lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      this._lastPinchMidX = (pts[0].x + pts[1].x) / 2;
      this._lastPinchMidY = (pts[0].y + pts[1].y) / 2;
      return;
    }

    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const dist = Math.hypot(dx, dy);
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;

    // Pan: delta of midpoint (applied first so zoom anchor uses already-panned state)
    const k = this._clientScale(this._getCanvasRect());
    const panDx = (midX - this._lastPinchMidX) * k.x;
    const panDy = (midY - this._lastPinchMidY) * k.y;
    this._panX += panDx;
    this._panY += panDy;

    // Zoom: ratio of current distance to previous distance
    if (this._lastPinchDist > 0) {
      const scale = dist / this._lastPinchDist;
      const { x: viewportX, y: viewportY } = this._clientToView(midX, midY);

      // Anchor zoom to the midpoint between the two fingers
      const docX = (viewportX - this._panX) / this._zoom;
      const docY = (viewportY - this._panY) / this._zoom;

      const newZoom = Math.min(
        DrawingCanvas.MAX_ZOOM,
        Math.max(DrawingCanvas.MIN_ZOOM, this._zoom * scale),
      );

      this._panX = viewportX - docX * newZoom;
      this._panY = viewportY - docY * newZoom;
      this._zoom = newZoom;
    }

    this._lastPinchDist = dist;
    this._lastPinchMidX = midX;
    this._lastPinchMidY = midY;

    this._transformManager?.updateViewport(this._zoom, { x: this._panX, y: this._panY });
    this.scheduleComposite(false);
    if (this._textEditing) this._renderTextPreview();
    if (this._cropRect) this._drawCropPreview();
    this._dispatchZoomChange(true);
  }

  // --- Selection helpers ---

  private _handleSelectPointerDown(p: Point) {
    // If a transform is active, the TransformManager intercept in _onPointerDown
    // handles it. As a safety net, commit any lingering transform.
    if (this._transformManager) {
      this.commitTransform();
    }
    this._selectionDrawing = true;
    this._startPoint = p;
  }

  private _handleCropPointerDown(p: Point, touch = false) {
    this._cropRectBeforeNew = null;
    if (this._cropRect) {
      // Fingers get handles of the size transforms give them.
      const handle = hitTestCropHandle(this._cropRect, p, this._zoom, touch ? HANDLE_CONFIG_TOUCH.hitRadius : undefined);
      if (handle && handle !== 'move') {
        this._cropHandle = handle;
        this._cropDragOrigin = { x: p.x, y: p.y };
        this._cropRectOrigin = { ...this._cropRect };
        this._updateCropActions();
        return;
      }
      if (handle === 'move') {
        this._cropHandle = 'move';
        this._cropDragOrigin = { x: p.x, y: p.y };
        this._cropRectOrigin = { ...this._cropRect };
        this._updateCropActions();
        return;
      }
    }
    this._cropRectBeforeNew = this._cropRect;
    this._cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    this._cropDragging = true;
    this._cropDragOrigin = { x: p.x, y: p.y };
  }

  private _handleSelectPointerMove(e: PointerEvent) {
    // Active transforms are handled by the TransformManager intercept in _onPointerMove.
    // This method only handles drawing a new selection rectangle.
    if (this._selectionDrawing && this._startPoint) {
      const p = this._getDocPoint(e);
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
      const selX = Math.max(0, Math.min(this._docWidth, rawLeft));
      const selY = Math.max(0, Math.min(this._docHeight, rawTop));
      const selRight = Math.max(0, Math.min(this._docWidth, rawRight));
      const selBottom = Math.max(0, Math.min(this._docHeight, rawBottom));
      const selW = selRight - selX;
      const selH = selBottom - selY;

      if (selW < 2 || selH < 2) {
        const previewCtx = this.previewCanvas.getContext('2d')!;
        previewCtx.clearRect(0, 0, this._vw, this._vh);
        return;
      }

      // Round endpoints first, then derive dimensions so the lifted region
      // exactly covers the rounded pixel boundaries.
      const rx = Math.round(selX);
      const ry = Math.round(selY);
      const rw = Math.round(selRight) - rx;
      const rh = Math.round(selBottom) - ry;
      if (rw < 1 || rh < 1) {
        const previewCtx = this.previewCanvas.getContext('2d')!;
        previewCtx.clearRect(0, 0, this._vw, this._vh);
        return;
      }

      // Lift selection to TransformManager
      const state = this._ctx.value?.state;
      if (!state) return;
      const layer = state.layers.find(l => l.id === state.activeLayerId);
      if (layer && rw > 0 && rh > 0) {
        const ctx = layer.canvas.getContext('2d')!;
        this._captureBeforeDraw();
        const regionData = ctx.getImageData(rx, ry, rw, rh);
        ctx.clearRect(rx, ry, rw, rh);
        this._transformContentMode = 'lifted';
        this._transformManager = new TransformManager(
          regionData,
          { x: rx, y: ry, w: rw, h: rh },
          this.previewCanvas,
          this._zoom,
          { x: this._panX, y: this._panY },
        );
        // Drawn by a finger, it gets finger-sized handles from the start.
        if (e.pointerType === 'touch') this._transformManager.setTouchMode(true);
        this.composite();
        this.requestUpdate();
        this._dispatchTransformChange();
        // Undo can now cancel the float (nothing to save yet).
        this._notifyHistory(false);
      }
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
    const cropRatio = parseAspectRatio(this.ctx.state.cropAspectRatio);
    if (this._cropDragging && this._cropRect) {
      this._cropRect = this._normalizeCropRect(this._cropRect, cropRatio);
      if (this._cropRect.w < 1 || this._cropRect.h < 1) {
        this._cropRect = null;
      }
    }
    this._cropDragging = false;
    this._cropHandle = null;
    this._cropDragOrigin = null;
    this._cropRectOrigin = null;
    if (this._cropRect) {
      this._cropRect = this._normalizeCropRect(this._cropRect, cropRatio);
      if (this._cropRect.w < 1 || this._cropRect.h < 1) {
        this._cropRect = null;
      }
    }
    this._updateCropActions();
    if (this._cropRect) {
      this._drawCropPreview();
    } else {
      this._clearCropPreview();
    }
  }

  private _normalizeCropRect(rect: CropRect, ratio?: number | null): CropRect {
    let { x, y, w, h } = rect;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    // If no explicit ratio was provided, derive from the rect's current dimensions
    if (ratio === undefined && h > 0 && w > 0) {
      ratio = w / h;
    }
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    const maxW = this._docWidth - x;
    const maxH = this._docHeight - y;
    const wClamped = w > maxW;
    const hClamped = h > maxH;
    w = Math.min(w, maxW);
    h = Math.min(h, maxH);
    if (ratio && (wClamped || hClamped)) {
      if (wClamped && hClamped) {
        // Both clamped: pick whichever produces the smaller rect that fits
        const hFromW = w / ratio;
        const wFromH = h * ratio;
        if (hFromW <= maxH) {
          h = hFromW;
        } else if (wFromH <= maxW) {
          w = wFromH;
        } else {
          // Both overflow — shrink to fit both constraints
          if (w / h > ratio) {
            w = h * ratio;
          } else {
            h = w / ratio;
          }
        }
      } else if (wClamped) {
        h = w / ratio;
      } else {
        w = h * ratio;
      }
      // Re-clamp after ratio adjustment
      w = Math.min(w, this._docWidth - x);
      h = Math.min(h, this._docHeight - y);
    }
    const rx = Math.round(x), ry = Math.round(y);
    let rw = Math.round(w), rh = Math.round(h);
    rw = Math.min(rw, this._docWidth - rx);
    rh = Math.min(rh, this._docHeight - ry);
    return { x: rx, y: ry, w: rw, h: rh };
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
    // Within the document (it may have changed size under the rectangle).
    const x = Math.max(0, this._cropRect.x), y = Math.max(0, this._cropRect.y);
    const rect = {
      x, y,
      w: Math.min(this._docWidth, this._cropRect.x + this._cropRect.w) - x,
      h: Math.min(this._docHeight, this._cropRect.y + this._cropRect.h) - y,
    };
    if (rect.w < 1 || rect.h < 1) return;
    const state = this._ctx.value?.state;
    if (!state) return;
    // Work in progress goes onto its layer first: a lifted float has left a
    // hole there, which the crop's undo snapshot would otherwise keep.
    if (this._transformManager) this.commitTransform();
    if (this._textEditing) this._commitText();

    // Snapshot before-state
    const beforeWidth = this._docWidth;
    const beforeHeight = this._docHeight;
    const beforeLayers: LayerSnapshot[] = state.layers.map(l => {
      const ctx = l.canvas.getContext('2d')!;
      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode,
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
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode,
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

  /**
   * Ends every gesture under way (a stroke, a drag, a pinch) as a cancelled
   * one, so what it started is undone and nothing is left half done for a
   * save to capture. Pointer releases that follow find nothing to end.
   */
  public cancelGesture() {
    for (const id of [...this._pointers.keys()]) this._cancelCurrentTool(id, true);
    this._pointers.clear();
    this._palmPointers.clear();
    this._pendingTap = null;
    this._pinching = false;
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

  private _onApplyCropClick = () => {
    this.commitCrop();
  };

  private _onCancelCropClick = () => {
    this.cancelCrop();
  };

  /** Whether a crop rect is currently active (used by drawing-app for keyboard dispatch). */
  public get hasCropRect(): boolean {
    return this._cropRect !== null;
  }

  private _clearCropPreview() {
    if (this.previewCanvas) {
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    }
  }

  // --- Stamp as TransformManager ---

  private _createStampAsTransform(
    img: HTMLImageElement,
    centerX: number,
    centerY: number,
    size: number,
    touch = false,
  ) {
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
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

    this._transformContentMode = 'inserted';
    this._transformManager = new TransformManager(
      imageData,
      { x, y, w, h },
      this.previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    this._transformManager.setTouchMode(touch);
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    this._notifyHistory();
  }

  /**
   * Whether the user is in the middle of something a reload would cut short
   * though nothing of it is in history yet: a crop being set up, a selection
   * being dragged out, or a resize dialog asking about a dropped image.
   */
  public hasInteractionInProgress(): boolean {
    return this._cropRect !== null || this._selectionDrawing || !!this._resizeDialog?.asking;
  }

  /** Closes a resize dialog still asking about a dropped image (the editor went inert). */
  public dismissResizeDialog() {
    this._resizeDialog?.dismiss();
  }

  /** Whether the editor sits in an inert subtree, as when a tab is read-only. */
  private _isInert(): boolean {
    for (let node: Node | null = this; node; node = node.parentNode ?? (node as ShadowRoot).host ?? null) {
      if (node instanceof Element && node.hasAttribute('inert')) return true;
    }
    return false;
  }

  /**
   * Shared handler for external images from paste or drag-and-drop.
   * Creates a new layer, optionally shows resize dialog, places a TransformManager.
   */
  private async _handleExternalImage(img: HTMLImageElement, name: string) {
    // Commit any active transform first
    if (this._transformManager) this.commitTransform();

    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const canvasW = this._docWidth;
    const canvasH = this._docHeight;

    // Show resize dialog if image exceeds canvas
    if (w > canvasW || h > canvasH) {
      const generation = this._documentGeneration;
      const shouldScale = await this._resizeDialog.show(w, h, canvasW, canvasH);
      // Another document, or an editor taken away while it asked.
      if (generation !== this._documentGeneration || !this.isConnected) return;
      // Handed over to another tab meanwhile: the editor is read-only (inert).
      if (this._isInert()) return;
      if (shouldScale) {
        const scale = Math.min(canvasW / w, canvasH / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
    }

    // Create new layer via context
    this.ctx.addLayer(name);
    await this.updateComplete;

    // Preserve the established undo barrier for deleting an uncommitted
    // external-image float. Committing it still stores only a bounded patch.
    this._captureBeforeDraw();

    // Create the TransformManager for the external image
    this._floatIsExternalImage = true;
    // Centred on the part of the document in view (all of it, when all is),
    // so it lands on screen when zoomed in on a corner.
    const vx0 = Math.max(0, -this._panX / this._zoom), vx1 = Math.min(this._docWidth, (this._vw - this._panX) / this._zoom);
    const vy0 = Math.max(0, -this._panY / this._zoom), vy1 = Math.min(this._docHeight, (this._vh - this._panY) / this._zoom);
    const cx = vx1 > vx0 ? (vx0 + vx1) / 2 : this._docWidth / 2;
    const cy = vy1 > vy0 ? (vy0 + vy1) / 2 : this._docHeight / 2;
    // Inside the document where it fits (a sliver of it in view would
    // hang it off the edge, where commit clips it).
    const within = (v: number, size: number, doc: number) => (size <= doc ? Math.min(Math.max(v, 0), doc - size) : v);
    const x = within(Math.round(cx - w / 2), w, this._docWidth);
    const y = within(Math.round(cy - h / 2), h, this._docHeight);

    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    src.getContext('2d')!.drawImage(img, 0, 0, w, h);
    const imageData = src.getContext('2d')!.getImageData(0, 0, w, h);

    this._transformContentMode = 'inserted';
    this._transformManager = new TransformManager(
      imageData,
      { x, y, w, h },
      this.previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    this._notifyHistory();
  }

  // --- Public selection API (for keyboard shortcuts) ---

  public copySelection() {
    if (!this._transformManager) return;
    this._copyFloatToClipboard();
    // Commit so the document matches what the user copied and the transform
    // remains undoable through the normal history entry.
    this.commitTransform();
    this._notifyHistory();
  }

  /** Puts the float, as shown, on the clipboards. */
  private _copyFloatToClipboard(): boolean {
    const snapshot = this._clippedFloatSnapshot();
    if (!snapshot) return false;
    try {
      this._clipboard = snapshot.canvas.getContext('2d')!.getImageData(0, 0, snapshot.w, snapshot.h);
    } catch (err) {
      console.error('Copy failed', err);
      return false;
    }
    this._clipboardOrigin = { x: snapshot.x, y: snapshot.y };
    this._clipboardRotation = 0;
    this._writeToSystemClipboard(snapshot.canvas);
    return true;
  }

  /**
   * The float as shown, clipped to the document (only that part survives a
   * commit, and a float dragged far outside could otherwise ask for too large
   * a canvas); null when nothing of it is on the document or it can't be made.
   */
  private _clippedFloatSnapshot() {
    try {
      return this._transformManager!.snapshot({ x: 0, y: 0, w: this._docWidth, h: this._docHeight });
    } catch (err) {
      console.error('Float snapshot failed', err);
      return null;
    }
  }

  private _writeToSystemClipboard(canvas: HTMLCanvasElement) {
    // Absent outside secure contexts (plain HTTP); the internal clipboard still works.
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
    const png = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
    // Started now, within the shortcut's user activation (Safari requires
    // it), with the image to follow; paste waits for it.
    this._systemClipboardWrite = navigator.clipboard
      .write([new ClipboardItem({ 'image/png': png })])
      .then(() => true, () => false);
  }

  public cutSelection() {
    if (!this._transformManager) return;
    // Copy, then delete the float rather than commit it: clearing what it
    // covers after a commit would also clear everything else in its bounds
    // (it may be rotated or warped) and whatever it was moved over.
    // Nothing copied (off the document, or too large): keep the float.
    if (!this._copyFloatToClipboard()) return;
    this.deleteSelection();
  }

  public pasteSelection() {
    if (!this._clipboard || !this._clipboardOrigin) return;
    // The float would hide the crop rectangle, which would stay armed.
    if (this._cropRect) this.cancelCrop();
    if (this._transformManager) this.commitTransform();
    // Keep the pre-paste snapshot until the float is either committed or
    // deleted. Deleting a pasted float is a deliberate, undoable action.
    if (!this._beforeDrawCanvas) this._captureBeforeDraw();
    const w = this._clipboard.width;
    const h = this._clipboard.height;

    // Clamp origin so the pasted content is at least partially inside the
    // document (the clipboard may have been copied before a document resize).
    const x = Math.max(0, Math.min(this._clipboardOrigin.x, this._docWidth - 1));
    const y = Math.max(0, Math.min(this._clipboardOrigin.y, this._docHeight - 1));

    const imageData = new ImageData(
      new Uint8ClampedArray(this._clipboard.data),
      w, h,
    );

    this._transformContentMode = 'inserted';
    this._transformManager = new TransformManager(
      imageData,
      { x, y, w, h },
      this.previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    if (this._clipboardRotation) {
      this._transformManager.rotation = (this._clipboardRotation * 180) / Math.PI;
    }
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    this._notifyHistory();
  }

  public async paste() {
    // Until our own copy reaches the system clipboard, that still holds what
    // was there before; if it never gets there, the internal clipboard is the
    // latest copy (until the window loses focus, when one may be made elsewhere).
    const ours = this._systemClipboardWrite;
    if (ours && !(await ours)) {
      if (!this.isGestureActive()) this.pasteSelection();
      return;
    }
    let read = false;
    try {
      const items = await navigator.clipboard.read();
      read = true;
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);

        // Decode the blob to check dimensions
        const url = URL.createObjectURL(blob);
        let img: HTMLImageElement;
        try {
          img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('Image load failed'));
            el.src = url;
          });
          URL.revokeObjectURL(url);
        } catch {
          URL.revokeObjectURL(url);
          continue;
        }

        // If we have an internal clipboard with matching dimensions,
        // use it to preserve selection state (rotation, position).
        // Blob-size comparison is unreliable since browsers re-encode PNGs.
        if (this._clipboard &&
            img.naturalWidth === this._clipboard.width &&
            img.naturalHeight === this._clipboard.height) {
          if (!this.isGestureActive()) this.pasteSelection();
          return;
        }

        // External content — decode and handle. A stroke or drag begun while
        // the clipboard was read would be cut short; let the paste go instead.
        if (!this.isGestureActive()) await this._handleExternalImage(img, 'Pasted Image');
        return;
      }
    } catch {
      // Clipboard API denied — fall back to internal
    }

    // No image on the system clipboard. The internal clipboard's is the latest
    // copy if that couldn't be read, or if nothing can have been copied
    // elsewhere since ours; otherwise (text copied in another window, say)
    // pasting it would bring back something older.
    if ((!read || ours) && !this.isGestureActive()) this.pasteSelection();
  }

  public selectAll() {
    if (this._transformManager) this.commitTransform();

    const state = this._ctx.value?.state;
    if (!state) return;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    if (!layer) return;
    const ctx = layer.canvas.getContext('2d')!;

    const w = this._docWidth;
    const h = this._docHeight;
    const imageData = ctx.getImageData(0, 0, w, h);
    const bounds = detectContentBounds(imageData);
    if (!bounds) return;

    this._captureBeforeDraw();
    const regionData = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
    ctx.clearRect(bounds.x, bounds.y, bounds.w, bounds.h);
    this._transformContentMode = 'lifted';
    this._transformManager = new TransformManager(
      regionData,
      bounds,
      this.previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    // Undo can now cancel the float (nothing to save yet).
    this._notifyHistory(false);
  }

  public selectAllCanvas() {
    if (this._transformManager) this.commitTransform();

    const state = this._ctx.value?.state;
    if (!state) return;
    const layer = state.layers.find(l => l.id === state.activeLayerId);
    if (!layer) return;
    const ctx = layer.canvas.getContext('2d')!;

    const w = this._docWidth;
    const h = this._docHeight;
    this._captureBeforeDraw();
    const regionData = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    this._transformContentMode = 'lifted';
    this._transformManager = new TransformManager(
      regionData,
      { x: 0, y: 0, w, h },
      this.previewCanvas,
      this._zoom,
      { x: this._panX, y: this._panY },
    );
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    // Undo can now cancel the float (nothing to save yet).
    this._notifyHistory(false);
  }

  public duplicateInPlace() {
    if (this._transformManager) {
      const snapshot = this._clippedFloatSnapshot();
      if (!snapshot) return;
      let imageData: ImageData;
      try {
        imageData = snapshot.canvas.getContext('2d')!.getImageData(0, 0, snapshot.w, snapshot.h);
      } catch (err) {
        console.error('Duplicate failed', err);
        return;
      }

      // Store the transformed result in the clipboard. Neither the clipboard
      // nor a TransformManager writes to its ImageData, so the duplicate below
      // shares this one rather than each copying a possibly huge buffer.
      this._clipboard = imageData;
      this._clipboardOrigin = { x: snapshot.x, y: snapshot.y };
      this._clipboardRotation = 0;
      this._writeToSystemClipboard(snapshot.canvas);

      // Commit the first copy back to the layer, then create a new active
      // transform for the duplicate using the rasterized transformed content.
      this.commitTransform();
      // Deleting the duplicate is an explicit undo step, matching paste.
      this._captureBeforeDraw();
      this._transformContentMode = 'inserted';
      this._transformManager = new TransformManager(
        imageData,
        { x: snapshot.x, y: snapshot.y, w: snapshot.w, h: snapshot.h },
        this.previewCanvas,
        this._zoom,
        { x: this._panX, y: this._panY },
      );
      this.composite();
      this.requestUpdate();
      this._dispatchTransformChange();
      this._notifyHistory();
    } else {
      // No active transform — paste from internal clipboard if available
      this.pasteSelection();
    }
  }

  public deleteSelection() {
    if (!this._transformManager) return;
    // A pasted or dropped image goes with the layer it came on, as with Escape.
    if (this._floatIsExternalImage) {
      this.cancelExternalFloat();
      return;
    }
    // A newly inserted stamp has no pre-existing layer mutation, so Delete is
    // equivalent to cancelling it. Pasted floats retain a before snapshot so
    // their deletion stays as an explicit undo step.
    if (this._transformContentMode === 'inserted' && !this._beforeDrawCanvas) {
      this.cancelTransform();
      return;
    }
    // Cancel the transform (discards the lifted content, restoring before-draw state
    // if available). Then push a history entry for the deletion.
    if (!this._beforeDrawCanvas) {
      this._captureBeforeDraw();
    }
    // Discard the transform content by NOT putting it back on the layer.
    this._transformManager.dispose();
    this._transformManager = null;
    this._transformContentMode = 'lifted';
    // Push history so the deletion is undoable.
    this._pushDrawHistory(true);
    this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    this.composite();
    this.requestUpdate();
    this._dispatchTransformChange();
    this._notifyHistory();
  }

  public clearSelection({ keepCrop = false } = {}) {
    if (this._textEditing) {
      this._commitText();
    }

    // Cancel any pending crop rect
    if (this._cropRect && !keepCrop) {
      this.cancelCrop();
    }

    // Finalize any in-progress brush/shape stroke so _drawing doesn't
    // leak into the next tool and cause stale history entries.
    if (this._drawing) {
      // Commit the brush stroke too; left in the engine, it would land on the
      // layer at the next commit with no history entry of its own.
      const layerCtx = this._getActiveLayerCtx();
      const region = layerCtx ? this._commitStroke(layerCtx) : undefined;
      this._drawing = false;
      this._lastPoint = null;
      this._startPoint = null;
      this._pushDrawHistory(false, region);
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
    // Cancel any in-progress selection drag (before a float is created)
    if (this._selectionDrawing) {
      this._selectionDrawing = false;
      this._startPoint = null;
      if (this.previewCanvas) {
        this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
      }
    }
    if (this._transformManager) this.commitTransform();
  }

  /**
   * Cancel an external image float: discard without drawing, delete the empty layer.
   * Called exclusively by the Escape handler in drawing-app for external image floats.
   * clearSelection() is NOT modified — it always commits, which is correct for
   * tool switches, layer switches, project switches, etc.
   */
  public cancelExternalFloat() {
    if (!this._floatIsExternalImage || !this._transformManager) return;
    const layerId = this.ctx.state.activeLayerId;
    this._transformManager.dispose();
    this._transformManager = null;
    this._floatIsExternalImage = false;
    this._transformContentMode = 'lifted';
    this._selectionDrawing = false;
    this._beforeDrawCanvas = null;
    if (this.previewCanvas) {
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    }
    this._dispatchTransformChange();

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
          return entryLayerId === null || entryLayerId !== layerId;
        });
        this._history = [...before, ...kept];
        this._historyIndex = this._history.length - 1;
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

  /** Whether an external image float is active (used by drawing-app for Escape handling) */
  public get hasExternalFloat(): boolean {
    return this._floatIsExternalImage && this._transformManager !== null;
  }

  /** The float's layer and a key that changes with the float (see `TransformManager.getStateKey`), without rendering it. */
  public getFloatKey(): { layerId: string; key: string } | null {
    const layerId = this._ctx.value?.state.activeLayerId;
    if (!this._transformManager || !layerId) return null;
    return { layerId, key: this._transformManager.getStateKey() };
  }

  /** Returns active transform info for persistence, or null if no transform. */
  public getFloatSnapshot(): { layerId: string; tempCanvas: HTMLCanvasElement; x: number; y: number } | null {
    if (!this._transformManager) return null;
    const layerId = this._ctx.value?.state.activeLayerId;
    if (!layerId) return null;
    // Only the part on the document survives a commit, so only that is kept;
    // a corner dragged far outside could otherwise ask for too large a canvas.
    const snapshot = this._transformManager.snapshot({ x: 0, y: 0, w: this._docWidth, h: this._docHeight });
    // A float moved wholly off the document still leaves its layer changed
    // (lifted content leaves a hole), so report it, with nothing to draw.
    const tempCanvas = snapshot?.canvas ?? document.createElement('canvas');
    return { layerId, tempCanvas, x: snapshot?.x ?? 0, y: snapshot?.y ?? 0 };
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

    // Create hidden textarea for text tool input
    const ta = document.createElement('textarea');
    // Keep textarea in-viewport (Firefox won't fire selectionchange for
    // off-screen elements) but visually hidden via clip-rect + opacity.
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;';
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('aria-label', 'Text');
    // Focused while text is edited; not a stop for Tab, where it would take
    // keys meant for the app.
    ta.tabIndex = -1;
    ta.addEventListener('input', () => {
      if (this._textEditing) {
        this._startTextCursorBlink();
        this._renderTextPreview();
        this._dispatchPendingTextChange();
      }
    });
    ta.addEventListener('keydown', (e) => this._onTextKeydown(e));
    ta.addEventListener('selectionchange', () => {
      if (this._textEditing) {
        this._startTextCursorBlink();
        this._renderTextPreview();
      }
    });
    this._textAreaEl = ta;

    this.addEventListener('wheel', this._onWheel, { passive: false });
    this.addEventListener('dragover', this._onDragOver);
    this.addEventListener('dragenter', this._onDragEnter);
    this.addEventListener('dragleave', this._onDragLeave);
    this.addEventListener('drop', this._onDrop);
    window.addEventListener('blur', this._onWindowBlur);
    document.addEventListener('copy', this._onOtherCopy, true);
    document.addEventListener('cut', this._onOtherCopy, true);
    window.addEventListener('resize', this._invalidateCanvasRect);
    // Any scroll in an ancestor can move the canvas without resizing it.
    window.addEventListener('scroll', this._invalidateCanvasRect, true);

    // Moved in the DOM (or back after being taken out): what leaving undid,
    // and what first render did, is set up again.
    if (this.hasUpdated) {
      this.shadowRoot!.appendChild(ta);
      this._observeSize();
      // A composite scheduled before it left was dropped as it went.
      this.scheduleComposite(false);
      if (this._cropRect) this._drawCropPreview();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._textCursorInterval) {
      clearInterval(this._textCursorInterval);
      this._textCursorInterval = 0;
    }
    if (this._textAreaEl) {
      this._textAreaEl.remove();
      this._textAreaEl = null;
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._unwatchDevicePixelRatio();
    this._compositeScheduler.cancel();
    // drawing-app flushes a pending viewport change from its own disconnect,
    // before deciding whether to save; by now it would only re-arm a save.
    this._viewportChangeScheduler.cancel();
    this._viewportChangePending = false;
    if (this._transformManager) {
      this._transformManager.dispose();
      this._transformManager = null;
      this._transformContentMode = 'lifted';
      this._floatIsExternalImage = false;
    }
    if (this._transformViewCanvas) {
      this._transformViewCanvas.width = this._transformViewCanvas.height = 0;
      this._transformViewCanvas = null;
    }
    this._pointers.clear();
    this._pinching = false;
    this._panning = false;
    this._panPointerId = -1;
    this.removeEventListener('wheel', this._onWheel);
    this.removeEventListener('dragover', this._onDragOver);
    this.removeEventListener('dragenter', this._onDragEnter);
    this.removeEventListener('dragleave', this._onDragLeave);
    this.removeEventListener('drop', this._onDrop);
    window.removeEventListener('blur', this._onWindowBlur);
    document.removeEventListener('copy', this._onOtherCopy, true);
    document.removeEventListener('cut', this._onOtherCopy, true);
    window.removeEventListener('resize', this._invalidateCanvasRect);
    window.removeEventListener('scroll', this._invalidateCanvasRect, true);
  }

  /** Re-render the text preview on the overlay canvas with cursor and bounding box. */
  private _renderTextPreview() {
    if (!this._textEditing || !this._textAreaEl || !this.previewCanvas) return;
    const previewCtx = this.previewCanvas.getContext('2d')!;
    previewCtx.clearRect(0, 0, this._vw, this._vh);

    const state = this.ctx.state;
    const text = this._textAreaEl.value;
    const { fontFamily, fontSize, fontBold, fontItalic, strokeColor } = state;

    previewCtx.save();
    previewCtx.translate(this._panX, this._panY);
    previewCtx.scale(this._zoom, this._zoom);

    // Draw text
    drawText(
      previewCtx,
      text,
      this._textPosition.x,
      this._textPosition.y,
      fontSize,
      fontFamily,
      fontBold,
      fontItalic,
      strokeColor,
    );

    // Measure for cursor and bounding box
    const metrics = measureTextBlock(previewCtx, text, fontSize, fontFamily, fontBold, fontItalic);
    const lineHeight = fontSize * LINE_HEIGHT;

    // Compute cursor/selection positions
    const selStart = this._textAreaEl.selectionStart ?? 0;
    const selEnd = this._textAreaEl.selectionEnd ?? selStart;
    const lines = text.split('\n');

    previewCtx.font = buildFontString(fontSize, fontFamily, fontBold, fontItalic);
    previewCtx.textBaseline = 'top';

    // Helper: convert a character offset to { line, x, y }
    const offsetToPos = (offset: number) => {
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (count + lines[i].length >= offset) {
          const col = offset - count;
          const prefix = lines[i].substring(0, col);
          return {
            line: i,
            x: this._textPosition.x + previewCtx.measureText(prefix).width,
            y: this._textPosition.y + i * lineHeight,
          };
        }
        count += lines[i].length + 1;
      }
      // Past end — put on last line
      const lastLine = lines.length - 1;
      return {
        line: lastLine,
        x: this._textPosition.x + previewCtx.measureText(lines[lastLine]).width,
        y: this._textPosition.y + lastLine * lineHeight,
      };
    };

    if (selStart !== selEnd) {
      // Draw selection highlight
      previewCtx.fillStyle = 'rgba(99, 102, 241, 0.3)';
      const startPos = offsetToPos(selStart);
      const endPos = offsetToPos(selEnd);

      if (startPos.line === endPos.line) {
        // Single-line selection
        previewCtx.fillRect(startPos.x, startPos.y, endPos.x - startPos.x, lineHeight);
      } else {
        // Multi-line selection
        // First line: from start to end of line
        const firstLineWidth = previewCtx.measureText(lines[startPos.line]).width;
        previewCtx.fillRect(
          startPos.x, startPos.y,
          this._textPosition.x + firstLineWidth - startPos.x, lineHeight,
        );
        // Middle lines: full width
        for (let i = startPos.line + 1; i < endPos.line; i++) {
          const w = previewCtx.measureText(lines[i]).width;
          previewCtx.fillRect(
            this._textPosition.x, this._textPosition.y + i * lineHeight,
            w, lineHeight,
          );
        }
        // Last line: from start of line to end position
        previewCtx.fillRect(
          this._textPosition.x, endPos.y,
          endPos.x - this._textPosition.x, lineHeight,
        );
      }
    } else if (this._textCursorVisible) {
      // Draw blinking caret
      const pos = offsetToPos(selStart);
      previewCtx.fillStyle = strokeColor;
      previewCtx.fillRect(pos.x, pos.y, 2 / this._zoom, fontSize);
    }

    // Draw bounding box (dashed border for drag affordance)
    const padding = 4 / this._zoom;
    const boxX = this._textPosition.x - padding;
    const boxY = this._textPosition.y - padding;
    const boxW = Math.max(metrics.width, fontSize) + padding * 2;
    const boxH = metrics.height + padding * 2;

    previewCtx.strokeStyle = 'rgba(99, 102, 241, 0.6)';
    previewCtx.lineWidth = 1 / this._zoom;
    previewCtx.setLineDash([4 / this._zoom, 4 / this._zoom]);
    previewCtx.strokeRect(boxX, boxY, boxW, boxH);

    previewCtx.restore();
  }

  /** Get the bounding box of the current text block in document space. */
  private _getTextBoundingBox(): { x: number; y: number; w: number; h: number } {
    const state = this.ctx.state;
    const text = this._textAreaEl?.value ?? '';
    const previewCtx = this.previewCanvas.getContext('2d')!;
    const metrics = measureTextBlock(
      previewCtx, text,
      state.fontSize, state.fontFamily, state.fontBold, state.fontItalic,
    );
    const padding = 4 / this._zoom;
    return {
      x: this._textPosition.x - padding,
      y: this._textPosition.y - padding,
      w: Math.max(metrics.width, state.fontSize) + padding * 2,
      h: metrics.height + padding * 2,
    };
  }

  /** Convert a document-space point to a character offset in the current text. */
  private _pointToTextOffset(docPoint: Point): number {
    if (!this._textAreaEl) return 0;
    const state = this.ctx.state;
    const text = this._textAreaEl.value;
    const lines = text.split('\n');
    const { fontSize, fontFamily, fontBold, fontItalic } = state;
    const lineHeight = fontSize * LINE_HEIGHT;
    const ctx = this.previewCanvas.getContext('2d')!;
    ctx.save();
    ctx.font = buildFontString(fontSize, fontFamily, fontBold, fontItalic);
    ctx.textBaseline = 'top';

    // Find which line the point is on
    const relY = docPoint.y - this._textPosition.y;
    let lineIdx = Math.floor(relY / lineHeight);
    lineIdx = Math.max(0, Math.min(lineIdx, lines.length - 1));

    // Find character position within the line via binary search
    const line = lines[lineIdx];
    const relX = docPoint.x - this._textPosition.x;
    let best = 0;
    for (let i = 0; i <= line.length; i++) {
      const w = ctx.measureText(line.substring(0, i)).width;
      if (i > 0) {
        const prevW = ctx.measureText(line.substring(0, i - 1)).width;
        const mid = (prevW + w) / 2;
        if (relX >= mid) best = i;
      } else if (relX < 0) {
        best = 0;
      }
    }

    ctx.restore();

    // Convert line + col to absolute offset
    let offset = 0;
    for (let i = 0; i < lineIdx; i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    return offset + best;
  }

  private _startTextCursorBlink() {
    this._textCursorVisible = true;
    if (this._textCursorInterval) clearInterval(this._textCursorInterval);
    this._textCursorInterval = window.setInterval(() => {
      this._textCursorVisible = !this._textCursorVisible;
      this._renderTextPreview();
    }, 530);
  }

  private _stopTextCursorBlink() {
    if (this._textCursorInterval) {
      clearInterval(this._textCursorInterval);
      this._textCursorInterval = 0;
    }
    this._textCursorVisible = false;
  }

  private _onTextKeydown(e: KeyboardEvent) {
    if (!this._textEditing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this._textAreaEl && this._textAreaEl.value.length > 0) {
        this._commitText();
      } else {
        this._cancelText();
      }
    } else if (e.key === 'Tab') {
      // Prevent Tab from moving focus out of the hidden textarea
      e.preventDefault();
    }
  }

  private _commitText() {
    if (!this._textEditing || !this._textAreaEl) return;
    const text = this._textAreaEl.value;
    if (!text) {
      this._cancelText();
      return;
    }

    const state = this.ctx.state;
    this._captureBeforeDraw();
    const layerCtx = this._getActiveLayerCtx();
    if (layerCtx) {
      drawText(
        layerCtx,
        text,
        this._textPosition.x,
        this._textPosition.y,
        state.fontSize,
        state.fontFamily,
        state.fontBold,
        state.fontItalic,
        state.strokeColor,
      );
      this._pushDrawHistory();
      this.composite();
    } else {
      this._beforeDrawCanvas = null;
    }
    this._endTextEditing();
  }

  private _cancelText() {
    this._endTextEditing();
  }

  private _endTextEditing() {
    this._textEditing = false;
    this._stopTextCursorBlink();
    if (this._textAreaEl) {
      this._textAreaEl.value = '';
      // Give the keyboard back to the app (its shortcuts listen there), not
      // the page; unless the user already moved focus somewhere else.
      if (this.shadowRoot?.activeElement === this._textAreaEl) focusEditor(this);
      this._textAreaEl.blur();
    }
    this._dispatchPendingTextChange();
    if (this.previewCanvas) {
      this.previewCanvas.getContext('2d')!.clearRect(0, 0, this._vw, this._vh);
    }
  }

  override render() {
    return html`
      <canvas
        id="main"
        @pointerenter=${this._onPointerEnter}
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointerleave=${this._onPointerLeave}
        @pointercancel=${this._onPointerCancel}
        @contextmenu=${this._onContextMenu}
      ></canvas>
      <canvas
        id="preview"
        style="position:absolute;top:0;left:0;pointer-events:none;"
      ></canvas>
      ${this._cropActionsVisible ? html`
        <div class="crop-actions" role="group" aria-label="Crop actions">
          <button class="apply" type="button" title="Apply crop (Enter)" @click=${this._onApplyCropClick}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            Apply
          </button>
          <button type="button" title="Cancel crop (Esc)" @click=${this._onCancelCropClick}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            Cancel
          </button>
        </div>
      ` : ''}
      <resize-dialog></resize-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'drawing-canvas': DrawingCanvas;
  }
}

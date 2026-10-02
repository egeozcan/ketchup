import type { Point } from '../types.js';
import {
  type HandleType, type HandleConfig, type TransformState, type TransformInteraction,
  type PerspectiveCorners, type TransformRect,
  HANDLE_CONFIG_DESKTOP, HANDLE_CONFIG_TOUCH, MIN_TRANSFORM_SIZE, OUTSIDE_DRAG_THRESHOLD,
} from './transform-types.js';
import {
  composeMatrix, docToLocal, localToDoc, getTransformCenter,
  snapAngle, getPerspectiveDestCorners, warpPerspective,
} from './transform-math.js';
import {
  hitTestHandle, hitTestRotationHandle, isInsideTransform,
  getCommitCancelPositions,
  drawHandles, drawRotationHandle as drawRotationHandleUI, drawCommitCancelButtons, getCursorForPoint,
} from './transform-handles.js';

/**
 * The most pixels a preview warp computes, at rest and while a handle is being
 * dragged. Larger warps are previewed at reduced resolution: while dragging,
 * to keep frames fast; at rest, only past 4096² (about the most iOS Safari
 * allows a canvas). Commit always warps at full resolution.
 */
const WARP_PREVIEW_PIXELS = 4096 * 4096;
const WARP_DRAG_PIXELS = 1024 * 1024;
/** Copies of the float are full resolution unless absurdly large (corners dragged far off). */
const WARP_SNAPSHOT_PIXELS = 8192 * 8192;

interface WarpCache {
  key: string; canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number; scale: number;
}

export class TransformManager {
  // --- Source data ---
  private _sourceImageData: ImageData;
  private _sourceRect: TransformRect;
  private _sourceCanvas: HTMLCanvasElement;

  // --- Transform state ---
  private _state: TransformState;
  private _initialState: TransformState;

  // --- Perspective ---
  private _perspectiveCorners: PerspectiveCorners = {
    nw: { x: 0, y: 0 }, ne: { x: 0, y: 0 }, se: { x: 0, y: 0 }, sw: { x: 0, y: 0 },
  };
  private _perspectiveActive = false;
  /**
   * The perspective-warped source, kept between composites: warping maps
   * every pixel, and pan, zoom, hover and stroke frames composite without
   * moving the corners. Keyed by destination corners, which (with the fixed
   * source) fully determine every pixel, so any region of a warp is reused as
   * long as it covers what is needed. Full-resolution warps (what commit,
   * autosave and, below WARP_PREVIEW_PIXELS, the preview use) and reduced
   * ones (drafts) are kept apart, so neither evicts the other: commit draws
   * from the warp the preview showed, and repeated autosaves of a drafted
   * float don't redo either.
   */
  private _warpCache: WarpCache | null = null;
  private _draftWarpCache: WarpCache | null = null;

  // --- Interaction ---
  private _interaction: TransformInteraction = { type: 'idle' };
  private _handleConfig: HandleConfig = HANDLE_CONFIG_DESKTOP;

  // --- Rendering ---
  private _previewCanvas: HTMLCanvasElement;
  private _zoom: number;
  private _pan: Point;

  constructor(
    source: ImageData,
    sourceRect: TransformRect,
    previewCanvas: HTMLCanvasElement,
    zoom: number,
    pan: Point,
  ) {
    this._sourceImageData = source;
    this._sourceRect = sourceRect;
    this._previewCanvas = previewCanvas;
    this._zoom = zoom;
    this._pan = pan;

    this._sourceCanvas = document.createElement('canvas');
    this._sourceCanvas.width = source.width;
    this._sourceCanvas.height = source.height;
    this._sourceCanvas.getContext('2d')!.putImageData(source, 0, 0);

    this._state = {
      x: sourceRect.x,
      y: sourceRect.y,
      width: sourceRect.w,
      height: sourceRect.h,
      rotation: 0,
      skewX: 0,
      skewY: 0,
      scaleX: 1,
      scaleY: 1,
    };
    this._initialState = { ...this._state };

    this.renderPreview();
  }

  // --- Public getters/setters for numeric panel ---

  get x(): number { return this._state.x; }
  set x(v: number) { this._state.x = v; this._onChange(); }

  get y(): number { return this._state.y; }
  set y(v: number) { this._state.y = v; this._onChange(); }

  get width(): number { return Math.abs(this._state.width * this._state.scaleX); }
  set width(v: number) {
    if (v <= 0) return;
    this._state.scaleX = (this._state.scaleX < 0 ? -1 : 1) * v / this._state.width;
    this._onChange();
  }

  get height(): number { return Math.abs(this._state.height * this._state.scaleY); }
  set height(v: number) {
    if (v <= 0) return;
    this._state.scaleY = (this._state.scaleY < 0 ? -1 : 1) * v / this._state.height;
    this._onChange();
  }

  get rotation(): number { return (this._state.rotation * 180) / Math.PI; }
  set rotation(deg: number) {
    this._state.rotation = (deg * Math.PI) / 180;
    this._onChange();
  }

  get skewX(): number { return this._state.skewX; }
  set skewX(v: number) { this._state.skewX = Math.max(-89, Math.min(89, v)); this._onChange(); }

  get skewY(): number { return this._state.skewY; }
  set skewY(v: number) { this._state.skewY = Math.max(-89, Math.min(89, v)); this._onChange(); }

  get flipH(): boolean { return this._state.scaleX < 0; }
  set flipH(v: boolean) {
    const shouldBeNeg = v;
    const isNeg = this._state.scaleX < 0;
    if (shouldBeNeg !== isNeg) {
      this._state.scaleX = -this._state.scaleX;
      this._onChange();
    }
  }

  get flipV(): boolean { return this._state.scaleY < 0; }
  set flipV(v: boolean) {
    const shouldBeNeg = v;
    const isNeg = this._state.scaleY < 0;
    if (shouldBeNeg !== isNeg) {
      this._state.scaleY = -this._state.scaleY;
      this._onChange();
    }
  }

  get perspectiveActive(): boolean { return this._perspectiveActive; }

  setTouchMode(touch: boolean): void {
    this._handleConfig = touch ? HANDLE_CONFIG_TOUCH : HANDLE_CONFIG_DESKTOP;
    this.renderPreview();
  }

  // --- Pointer event handlers ---

  onPointerDown(docPoint: Point, modifiers: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    const buttons = getCommitCancelPositions(this._state, this._handleConfig, this._zoom);
    const commitDist = Math.hypot(docPoint.x - buttons.commitCenter.x, docPoint.y - buttons.commitCenter.y);
    if (commitDist <= buttons.buttonRadius) return true;
    const cancelDist = Math.hypot(docPoint.x - buttons.cancelCenter.x, docPoint.y - buttons.cancelCenter.y);
    if (cancelDist <= buttons.buttonRadius) return true;

    if (hitTestRotationHandle(docPoint, this._state, this._handleConfig, this._zoom)) {
      const center = getTransformCenter(this._state);
      const startAngle = Math.atan2(docPoint.y - center.y, docPoint.x - center.x);
      this._interaction = { type: 'rotating', startAngle, startRotation: this._state.rotation };
      return true;
    }

    const handle = hitTestHandle(docPoint, this._state, this._handleConfig, this._zoom);
    if (handle) {
      if (modifiers.ctrl && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
        this._perspectiveActive = true;
        this._interaction = { type: 'perspective', corner: handle, startPoint: docPoint };
      } else if (modifiers.ctrl && (handle === 'n' || handle === 'e' || handle === 's' || handle === 'w')) {
        this._interaction = {
          type: 'skewing', edge: handle, startPoint: docPoint,
          startSkewX: this._state.skewX, startSkewY: this._state.skewY,
        };
      } else {
        this._interaction = {
          type: 'resizing', handle,
          origin: {
            rect: { x: this._state.x, y: this._state.y, w: this._state.width, h: this._state.height },
            point: docPoint,
          },
        };
      }
      return true;
    }

    if (isInsideTransform(docPoint, this._state)) {
      this._interaction = { type: 'moving', startPoint: docPoint, startX: this._state.x, startY: this._state.y };
      return true;
    }

    this._interaction = { type: 'outside-pending', startPoint: docPoint };
    return true;
  }

  onPointerMove(docPoint: Point, modifiers: { shift: boolean; ctrl: boolean; alt: boolean }): void {
    switch (this._interaction.type) {
      case 'moving': this._handleMove(docPoint, modifiers); break;
      case 'resizing': this._handleResize(docPoint, modifiers); break;
      case 'rotating': this._handleRotate(docPoint, modifiers); break;
      case 'skewing': this._handleSkew(docPoint); break;
      case 'perspective': this._handlePerspective(docPoint); break;
      case 'outside-pending': {
        const dx = docPoint.x - this._interaction.startPoint.x;
        const dy = docPoint.y - this._interaction.startPoint.y;
        const distVp = Math.sqrt(dx * dx + dy * dy) * this._zoom;
        if (distVp > OUTSIDE_DRAG_THRESHOLD) {
          const center = getTransformCenter(this._state);
          const startAngle = Math.atan2(
            this._interaction.startPoint.y - center.y,
            this._interaction.startPoint.x - center.x,
          );
          this._interaction = { type: 'rotating', startAngle, startRotation: this._state.rotation };
          this._handleRotate(docPoint, modifiers);
        }
        break;
      }
    }
  }

  onPointerUp(docPoint: Point): 'commit' | 'cancel-button' | 'commit-button' | null {
    const buttons = getCommitCancelPositions(this._state, this._handleConfig, this._zoom);
    const commitDist = Math.hypot(docPoint.x - buttons.commitCenter.x, docPoint.y - buttons.commitCenter.y);
    if (commitDist <= buttons.buttonRadius) {
      this._interaction = { type: 'idle' };
      return 'commit-button';
    }
    const cancelDist = Math.hypot(docPoint.x - buttons.cancelCenter.x, docPoint.y - buttons.cancelCenter.y);
    if (cancelDist <= buttons.buttonRadius) {
      this._interaction = { type: 'idle' };
      return 'cancel-button';
    }
    const result: 'commit' | null = this._interaction.type === 'outside-pending' ? 'commit' : null;
    this._interaction = { type: 'idle' };
    return result;
  }

  /**
   * Ends a gesture whose pointer was cancelled, leaving the transform where it
   * got to. Returns whether one was in progress.
   */
  cancelInteraction(): boolean {
    if (this._interaction.type === 'idle') return false;
    this._interaction = { type: 'idle' };
    return true;
  }

  // --- Private interaction handlers ---

  private _handleMove(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'moving') return;
    let dx = docPoint.x - inter.startPoint.x;
    let dy = docPoint.y - inter.startPoint.y;
    if (modifiers.shift) {
      if (Math.abs(dx) > Math.abs(dy)) { dy = 0; } else { dx = 0; }
    }
    this._state.x = inter.startX + dx;
    this._state.y = inter.startY + dy;
    this._onChange();
  }

  private _handleResize(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'resizing') return;
    const { handle, origin } = inter;
    const { rect, point: startPoint } = origin;
    const localCurrent = docToLocal(docPoint, this._state);
    const localStart = docToLocal(startPoint, this._state);
    const dx = localCurrent.x - localStart.x;
    const dy = localCurrent.y - localStart.y;
    let newX = rect.x, newY = rect.y, newW = rect.w, newH = rect.h;
    if (handle.includes('e')) { newW = rect.w + dx; }
    if (handle.includes('w')) { newX = rect.x + dx; newW = rect.w - dx; }
    if (handle.includes('s')) { newH = rect.h + dy; }
    if (handle.includes('n')) { newY = rect.y + dy; newH = rect.h - dy; }
    if (modifiers.shift && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
      const aspect = rect.w / rect.h;
      if (Math.abs(newW / newH) > aspect) { newH = newW / aspect; }
      else { newW = newH * aspect; }
    }
    const minSize = MIN_TRANSFORM_SIZE / this._zoom;
    if (Math.abs(newW) < minSize) newW = newW < 0 ? -minSize : minSize;
    if (Math.abs(newH) < minSize) newH = newH < 0 ? -minSize : minSize;
    this._state.x = newX;
    this._state.y = newY;
    this._state.width = Math.abs(newW);
    this._state.height = Math.abs(newH);
    if (newW < 0) this._state.scaleX = -Math.abs(this._state.scaleX);
    if (newH < 0) this._state.scaleY = -Math.abs(this._state.scaleY);
    this._onChange();
  }

  private _handleRotate(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'rotating') return;
    const center = getTransformCenter(this._state);
    const currentAngle = Math.atan2(docPoint.y - center.y, docPoint.x - center.x);
    let newRotation = inter.startRotation + (currentAngle - inter.startAngle);
    if (modifiers.shift) { newRotation = snapAngle(newRotation, Math.PI / 12); }
    this._state.rotation = newRotation;
    this._onChange();
  }

  private _handleSkew(docPoint: Point): void {
    const inter = this._interaction;
    if (inter.type !== 'skewing') return;
    const dx = docPoint.x - inter.startPoint.x;
    const dy = docPoint.y - inter.startPoint.y;
    if (inter.edge === 'n' || inter.edge === 's') {
      const sign = inter.edge === 'n' ? -1 : 1;
      this._state.skewX = Math.max(-89, Math.min(89, inter.startSkewX + sign * dx * 0.5));
    } else {
      const sign = inter.edge === 'w' ? -1 : 1;
      this._state.skewY = Math.max(-89, Math.min(89, inter.startSkewY + sign * dy * 0.5));
    }
    this._onChange();
  }

  private _handlePerspective(docPoint: Point): void {
    const inter = this._interaction;
    if (inter.type !== 'perspective') return;
    const dx = docPoint.x - inter.startPoint.x;
    const dy = docPoint.y - inter.startPoint.y;
    this._perspectiveCorners[inter.corner] = { x: dx, y: dy };
    this._onChange();
  }

  // --- Rendering ---

  renderPreview(): void {
    const ctx = this._previewCanvas.getContext('2d')!;
    const w = this._previewCanvas.width;
    const h = this._previewCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(this._pan.x, this._pan.y);
    ctx.scale(this._zoom, this._zoom);

    const corners = this._perspectiveActive
      ? getPerspectiveDestCorners(this._state, this._perspectiveCorners)
      : [
          localToDoc({ x: 0, y: 0 }, this._state),
          localToDoc({ x: this._state.width, y: 0 }, this._state),
          localToDoc({ x: this._state.width, y: this._state.height }, this._state),
          localToDoc({ x: 0, y: this._state.height }, this._state),
        ];

    ctx.save();
    ctx.lineWidth = 1 / this._zoom;
    ctx.setLineDash([6 / this._zoom, 6 / this._zoom]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineDashOffset = 0;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineDashOffset = 4 / this._zoom;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    drawHandles(ctx, this._state, this._handleConfig, this._zoom);
    drawRotationHandleUI(ctx, this._state, this._handleConfig, this._zoom);
    drawCommitCancelButtons(ctx, this._state, this._handleConfig, this._zoom);

    ctx.restore();
  }

  /**
   * Draws the transformed content for preview. Given `fullResolutionIn`, the
   * part inside it is drawn exactly as `commit` would write it; a perspective
   * warp may then be left out beyond it, so pass the target's whole area.
   */
  renderTransformed(ctx: CanvasRenderingContext2D, fullResolutionIn?: TransformRect): void {
    if (fullResolutionIn) this._render(ctx, fullResolutionIn, Infinity);
    else this._render(ctx, null, this._warpPixelBudget());
  }

  /** Draws the transformed content; a perspective warp limited as in `_getWarp`. */
  private _render(ctx: CanvasRenderingContext2D, clip: TransformRect | null, maxWarpPixels: number): void {
    if (this._perspectiveActive) {
      const warp = this._getWarp(clip, maxWarpPixels);
      if (!warp) return;
      if (warp.canvas.width === warp.w) {
        ctx.drawImage(warp.canvas, warp.x, warp.y);
      } else {
        // Scaled back up, a reduced-resolution warp's edge pixels reach past the quad's bounds.
        const b = this._getSnapshotBounds();
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.x, b.y, b.w, b.h);
        ctx.clip();
        ctx.drawImage(warp.canvas, warp.x, warp.y, warp.w, warp.h);
        ctx.restore();
      }
    } else {
      const matrix = composeMatrix(this._state);
      ctx.save();
      ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.drawImage(this._sourceCanvas, 0, 0, this._state.width, this._state.height);
      ctx.restore();
    }
  }

  /** Most pixels the preview warp may compute right now (see WARP_PREVIEW_PIXELS). */
  private _warpPixelBudget(): number {
    return this._interaction.type === 'idle' ? WARP_PREVIEW_PIXELS : WARP_DRAG_PIXELS;
  }

  /**
   * The perspective-warped source on a canvas, with the document rectangle it
   * covers: at least the part of the warp inside `clip` (all of it if null),
   * at full resolution unless that would take more than `maxPixels`.
   */
  private _getWarp(
    clip: TransformRect | null, maxPixels: number,
  ): { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null {
    const dstCorners = getPerspectiveDestCorners(this._state, this._perspectiveCorners);
    let { x, y, w, h } = this._getSnapshotBounds();
    if (clip) {
      const right = Math.min(x + w, clip.x + clip.w), bottom = Math.min(y + h, clip.y + clip.h);
      x = Math.max(x, clip.x);
      y = Math.max(y, clip.y);
      w = right - x;
      h = bottom - y;
    }
    if (w <= 0 || h <= 0) return null;
    // A reduced-resolution warp is the same warp of a quad scaled down, drawn
    // scaled back up. Rounding it out to whole pixels can take it past the
    // budget, so it shrinks until it fits.
    let scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
    let sx: number, sy: number, sw: number, sh: number;
    for (;;) {
      sx = Math.floor(x * scale);
      sy = Math.floor(y * scale);
      sw = Math.ceil((x + w) * scale) - sx;
      sh = Math.ceil((y + h) * scale) - sy;
      if (sw * sh <= maxPixels) break;
      scale *= Math.sqrt(maxPixels / (sw * sh));
    }
    const key = dstCorners.map(c => `${c.x},${c.y}`).join(';');
    for (const cache of [this._warpCache, this._draftWarpCache]) {
      if (cache && cache.key === key && cache.scale >= scale && cache.x <= x && cache.y <= y
        && cache.x + cache.w >= x + w && cache.y + cache.h >= y + h) {
        return cache;
      }
    }
    const cache = scale === 1 ? this._warpCache : this._draftWarpCache;
    const scaled = scale === 1
      ? dstCorners
      : dstCorners.map(c => ({ x: c.x * scale, y: c.y * scale })) as typeof dstCorners;
    // Reuse the canvas; its backing store is reallocated only on a size change.
    const canvas = cache?.canvas ?? document.createElement('canvas');
    if (canvas.width !== sw || canvas.height !== sh) {
      canvas.width = sw;
      canvas.height = sh;
    }
    canvas.getContext('2d')!.putImageData(
      warpPerspective(this._sourceImageData, scaled, { x: sx, y: sy, w: sw, h: sh }), 0, 0,
    );
    const warp = { key, canvas, x: sx / scale, y: sy / scale, w: sw / scale, h: sh / scale, scale };
    if (scale === 1) this._warpCache = warp;
    else this._draftWarpCache = warp;
    return warp;
  }

  /**
   * The transformed content on a canvas of its own bounds — only the part
   * inside `clip` if given, null if none of it is. A perspective warp is at
   * full resolution (unclipped, unless larger than WARP_SNAPSHOT_PIXELS).
   */
  snapshot(): { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number };
  snapshot(clip: TransformRect): { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null;
  snapshot(clip?: TransformRect): { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null {
    const bounds = this._getSnapshotBounds();
    if (clip) {
      const right = Math.min(bounds.x + bounds.w, clip.x + clip.w);
      const bottom = Math.min(bounds.y + bounds.h, clip.y + clip.h);
      bounds.x = Math.max(bounds.x, clip.x);
      bounds.y = Math.max(bounds.y, clip.y);
      bounds.w = right - bounds.x;
      bounds.h = bottom - bounds.y;
      if (bounds.w <= 0 || bounds.h <= 0) return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = bounds.w;
    canvas.height = bounds.h;
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.translate(-bounds.x, -bounds.y);
    this._render(ctx, clip ?? null, clip ? Infinity : WARP_SNAPSHOT_PIXELS);
    ctx.restore();
    return { canvas, ...bounds };
  }

  // --- Lifecycle ---

  commit(layerCanvas: HTMLCanvasElement): void {
    const ctx = layerCanvas.getContext('2d')!;
    if (this._perspectiveActive) {
      // Only what lands on the layer: the full warp of a corner dragged far
      // outside the document could be too large a canvas to allocate.
      const warp = this._getWarp({ x: 0, y: 0, w: layerCanvas.width, h: layerCanvas.height }, Infinity);
      if (warp) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(warp.canvas, warp.x, warp.y);
        ctx.restore();
      }
    } else {
      const matrix = composeMatrix(this._state);
      ctx.save();
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.drawImage(this._sourceCanvas, 0, 0, this._state.width, this._state.height);
      ctx.restore();
    }
  }

  cancel(): ImageData {
    return this._sourceImageData;
  }

  hasChanged(): boolean {
    const s = this._state;
    const i = this._initialState;
    return s.x !== i.x || s.y !== i.y || s.width !== i.width || s.height !== i.height ||
      s.rotation !== i.rotation || s.skewX !== i.skewX || s.skewY !== i.skewY ||
      s.scaleX !== i.scaleX || s.scaleY !== i.scaleY || this._perspectiveActive;
  }

  getState(): Readonly<TransformState> { return this._state; }
  getSourceRect(): Readonly<TransformRect> { return this._sourceRect; }
  getBounds(): { x: number; y: number; w: number; h: number } { return this._getSnapshotBounds(); }

  // --- Viewport ---

  updateViewport(zoom: number, pan: Point): void {
    this._zoom = zoom;
    this._pan = pan;
    this.renderPreview();
  }

  getCursor(docPoint: Point): string {
    const buttons = getCommitCancelPositions(this._state, this._handleConfig, this._zoom);
    const commitDist = Math.hypot(docPoint.x - buttons.commitCenter.x, docPoint.y - buttons.commitCenter.y);
    if (commitDist <= buttons.buttonRadius) return 'pointer';
    const cancelDist = Math.hypot(docPoint.x - buttons.cancelCenter.x, docPoint.y - buttons.cancelCenter.y);
    if (cancelDist <= buttons.buttonRadius) return 'pointer';
    return getCursorForPoint(docPoint, this._state, this._handleConfig, this._zoom);
  }

  // --- Private helpers ---

  private _onChange(): void {
    this.renderPreview();
  }

  private _getSnapshotBounds(): { x: number; y: number; w: number; h: number } {
    const corners = this._perspectiveActive
      ? getPerspectiveDestCorners(this._state, this._perspectiveCorners)
      : [
          localToDoc({ x: 0, y: 0 }, this._state),
          localToDoc({ x: this._state.width, y: 0 }, this._state),
          localToDoc({ x: this._state.width, y: this._state.height }, this._state),
          localToDoc({ x: 0, y: this._state.height }, this._state),
        ];
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    const x = Math.floor(Math.min(...xs));
    const y = Math.floor(Math.min(...ys));
    const w = Math.max(1, Math.ceil(Math.max(...xs)) - x);
    const h = Math.max(1, Math.ceil(Math.max(...ys)) - y);
    return { x, y, w, h };
  }

  dispose(): void {
    // Release the backing stores now rather than whenever this is collected.
    for (const cache of [this._warpCache, this._draftWarpCache]) {
      if (cache) cache.canvas.width = cache.canvas.height = 0;
    }
    this._warpCache = this._draftWarpCache = null;
  }
}

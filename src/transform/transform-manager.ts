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
 * A preview warp larger than this (4096², about the most iOS Safari allows a
 * canvas) is only rendered where the target context can show it.
 */
const MAX_WARP_PIXELS = 4096 * 4096;

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
   * source) fully determine every pixel, so any region of it is reused as
   * long as it covers what is needed. Commit draws from this same canvas, so
   * what was previewed is what lands on the layer.
   */
  private _warpCache: {
    key: string; canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number;
  } | null = null;

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

  /** Changes whenever `renderTransformed` would draw something different. */
  get renderKey(): string {
    const s = this._state;
    const p = this._perspectiveActive ? this._perspectiveCorners : null;
    return JSON.stringify([s.x, s.y, s.width, s.height, s.rotation, s.skewX, s.skewY, s.scaleX, s.scaleY, p]);
  }

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

  renderTransformed(ctx: CanvasRenderingContext2D): void {
    if (this._perspectiveActive) {
      const warp = this._getWarp(this._visibleRegion(ctx));
      if (warp) ctx.drawImage(warp.canvas, warp.x, warp.y);
    } else {
      const matrix = composeMatrix(this._state);
      ctx.save();
      ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.drawImage(this._sourceCanvas, 0, 0, this._state.width, this._state.height);
      ctx.restore();
    }
  }

  /**
   * Where `ctx` can draw, in document space, if the whole warp would be too
   * large a canvas; otherwise null, so the whole warp is rendered and cached.
   */
  private _visibleRegion(ctx: CanvasRenderingContext2D): TransformRect | null {
    const bounds = this._getSnapshotBounds();
    if (bounds.w * bounds.h <= MAX_WARP_PIXELS) return null;
    const { a, b, c, d, e, f } = ctx.getTransform();
    const det = a * d - b * c;
    if (!det) return bounds;
    const { width, height } = ctx.canvas;
    const pts = [[0, 0], [width, 0], [width, height], [0, height]].map(([px, py]) => ({
      x: (d * (px - e) - c * (py - f)) / det,
      y: (a * (py - f) - b * (px - e)) / det,
    }));
    const x = Math.floor(Math.min(...pts.map(p => p.x)));
    const y = Math.floor(Math.min(...pts.map(p => p.y)));
    return {
      x, y,
      w: Math.ceil(Math.max(...pts.map(p => p.x))) - x,
      h: Math.ceil(Math.max(...pts.map(p => p.y))) - y,
    };
  }

  /**
   * The perspective-warped source on a canvas at its document position,
   * covering at least the part of the warp inside `clip` (all of it if null).
   */
  private _getWarp(clip: TransformRect | null): { canvas: HTMLCanvasElement; x: number; y: number } | null {
    const dstCorners = getPerspectiveDestCorners(this._state, this._perspectiveCorners);
    const bounds = this._getSnapshotBounds();
    let { x, y, w, h } = bounds;
    if (clip) {
      const right = Math.min(x + w, clip.x + clip.w), bottom = Math.min(y + h, clip.y + clip.h);
      x = Math.max(x, clip.x);
      y = Math.max(y, clip.y);
      w = right - x;
      h = bottom - y;
    }
    if (w <= 0 || h <= 0) return null;
    const key = dstCorners.map(c => `${c.x},${c.y}`).join(';');
    const cache = this._warpCache;
    if (cache && cache.key === key && cache.x <= x && cache.y <= y
      && cache.x + cache.w >= x + w && cache.y + cache.h >= y + h) {
      return cache;
    }
    // Reuse the canvas; its backing store is reallocated only on a size change.
    const canvas = cache?.canvas ?? document.createElement('canvas');
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.getContext('2d')!.putImageData(
      warpPerspective(this._sourceImageData, dstCorners, { x, y, w, h }), 0, 0,
    );
    this._warpCache = { key, canvas, x, y, w, h };
    return this._warpCache;
  }

  snapshot(): { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number } {
    const bounds = this._getSnapshotBounds();
    const canvas = document.createElement('canvas');
    canvas.width = bounds.w;
    canvas.height = bounds.h;
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.translate(-bounds.x, -bounds.y);
    this.renderTransformed(ctx);
    ctx.restore();
    return { canvas, ...bounds };
  }

  // --- Lifecycle ---

  commit(layerCanvas: HTMLCanvasElement): void {
    const ctx = layerCanvas.getContext('2d')!;
    if (this._perspectiveActive) {
      // Only what lands on the layer: the full warp of a corner dragged far
      // outside the document could be too large a canvas to allocate.
      const warp = this._getWarp({ x: 0, y: 0, w: layerCanvas.width, h: layerCanvas.height });
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
    // Release the backing store now rather than whenever this is collected.
    if (this._warpCache) this._warpCache.canvas.width = this._warpCache.canvas.height = 0;
    this._warpCache = null;
  }
}

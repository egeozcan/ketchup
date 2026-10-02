import type { Point } from '../types.js';
import {
  type HandleConfig, type TransformState, type TransformInteraction,
  type PerspectiveCorners, type TransformRect,
  HANDLE_CONFIG_DESKTOP, HANDLE_CONFIG_TOUCH, MIN_TRANSFORM_SIZE,
} from './transform-types.js';
import {
  composeMatrix, docToLocal, localToDoc, getTransformCenter,
  snapAngle, getPerspectiveDestCorners, warpPerspective,
} from './transform-math.js';
import { canWarpOnGpu, releaseGpuSource, warpPerspectiveGpu } from './perspective-gl.js';
import {
  hitTestHandle, hitTestRotationHandle, isInsideTransform,
  getCommitCancelPositions,
  drawHandles, drawRotationHandle as drawRotationHandleUI, drawCommitCancelButtons, getCursorForPoint,
  getHandleCursor, getDocHandlePositions, getRotationHandlePos,
} from './transform-handles.js';

/**
 * The most pixels a preview warp computes, at rest and while a handle is being
 * dragged (on the GPU or the CPU). Larger warps are previewed at reduced
 * resolution: at rest, only past 4096² (about the most iOS Safari allows a
 * canvas); while dragging, sooner, to keep frames fast. Commit always warps at
 * full resolution.
 */
const WARP_PREVIEW_PIXELS = 4096 * 4096;
const WARP_DRAG_PIXELS = 1024 * 1024;
const WARP_GPU_DRAG_PIXELS = 2048 * 2048;
/** Copies of the float are full resolution unless absurdly large (corners dragged far off). */
const WARP_SNAPSHOT_PIXELS = 8192 * 8192;

interface WarpCache {
  key: string; canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number; scale: number;
}

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;

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
    // The box itself, about its middle, as a handle resize does, so X and Y
    // keep describing it (scale only carries a flip); a warp stretches with it.
    const s = this._state, k = v / this.width;
    s.x += (s.width - s.width * k) / 2;
    s.width *= k;
    for (const corner of CORNERS) this._perspectiveCorners[corner].x *= k;
    this._onChange();
  }

  get height(): number { return Math.abs(this._state.height * this._state.scaleY); }
  set height(v: number) {
    if (v <= 0) return;
    const s = this._state, k = v / this.height;
    s.y += (s.height - s.height * k) / 2;
    s.height *= k;
    for (const corner of CORNERS) this._perspectiveCorners[corner].y *= k;
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

  get touchMode(): boolean { return this._handleConfig === HANDLE_CONFIG_TOUCH; }

  setTouchMode(touch: boolean): void {
    this._handleConfig = touch ? HANDLE_CONFIG_TOUCH : HANDLE_CONFIG_DESKTOP;
    this.renderPreview();
  }

  // --- Pointer event handlers ---

  /**
   * `slop`: how far (viewport pixels) a press outside may move and still be a
   * click that commits; the layout's own (by default) fits a mouse or finger,
   * a pen drifts more than a mouse.
   */
  onPointerDown(docPoint: Point, modifiers: { shift: boolean; ctrl: boolean; alt: boolean }, slop?: number): boolean {
    const button = this.buttonAt(docPoint);
    if (button) {
      this.pressButton(button);
      return true;
    }

    if (hitTestRotationHandle(docPoint, this._getCorners(), this._handleConfig, this._zoom)) {
      const center = getTransformCenter(this._state);
      const startAngle = Math.atan2(docPoint.y - center.y, docPoint.x - center.x);
      this._interaction = { type: 'rotating', startAngle, startRotation: this._state.rotation };
      return true;
    }

    const handle = hitTestHandle(docPoint, this._getCorners(), this._handleConfig, this._zoom);
    if (handle) {
      if (modifiers.ctrl && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
        this._perspectiveActive = true;
        this._interaction = {
          type: 'perspective', corner: handle, startPoint: docPoint,
          startOffset: { ...this._perspectiveCorners[handle] },
        };
      } else if (modifiers.ctrl && (handle === 'n' || handle === 'e' || handle === 's' || handle === 'w')) {
        this._interaction = {
          type: 'skewing', edge: handle, startPoint: docPoint,
          startSkewX: this._state.skewX, startSkewY: this._state.skewY,
        };
      } else {
        this._interaction = {
          type: 'resizing', handle,
          origin: { point: docPoint, state: { ...this._state } },
        };
      }
      return true;
    }

    if (isInsideTransform(docPoint, this._getCorners())) {
      this._interaction = { type: 'moving', startPoint: docPoint, startX: this._state.x, startY: this._state.y };
      return true;
    }

    this._interaction = { type: 'outside-pending', startPoint: docPoint, slop: slop ?? this._handleConfig.outsideDragThreshold };
    return true;
  }

  /** Returns whether the transform changed (it doesn't while merely hovering). */
  onPointerMove(docPoint: Point, modifiers: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    switch (this._interaction.type) {
      case 'moving': this._handleMove(docPoint, modifiers); return true;
      case 'resizing': this._handleResize(docPoint, modifiers); return true;
      case 'rotating': this._handleRotate(docPoint, modifiers); return true;
      case 'skewing': this._handleSkew(docPoint); return true;
      case 'perspective': this._handlePerspective(docPoint); return true;
      case 'outside-pending': {
        const dx = docPoint.x - this._interaction.startPoint.x;
        const dy = docPoint.y - this._interaction.startPoint.y;
        const distVp = Math.sqrt(dx * dx + dy * dy) * this._zoom;
        if (distVp > this._interaction.slop) {
          const center = getTransformCenter(this._state);
          const startAngle = Math.atan2(
            this._interaction.startPoint.y - center.y,
            this._interaction.startPoint.x - center.x,
          );
          this._interaction = { type: 'rotating', startAngle, startRotation: this._state.rotation };
          this._handleRotate(docPoint, modifiers);
          return true;
        }
        return false;
      }
    }
    return false;
  }

  onPointerUp(docPoint: Point): 'commit' | 'cancel-button' | 'commit-button' | null {
    const inter = this._interaction;
    this._interaction = { type: 'idle' };
    // A button acts only when both pressed and released on it: a drag that
    // merely ends over one (they follow the corners) must not commit or
    // throw away the transform.
    if (inter.type === 'button') {
      const onIt = Math.hypot(docPoint.x - inter.center.x, docPoint.y - inter.center.y) <= inter.radius;
      return onIt ? `${inter.button}-button` : null;
    }
    if (inter.type === 'outside-pending') {
      // Pressed just beside a button and released on it: a click on it.
      const button = this.hitTestButton(docPoint);
      return button ? `${button}-button` : 'commit';
    }
    return null;
  }

  /** The commit or cancel button at a point, as drawn now. */
  hitTestButton(docPoint: Point): 'commit' | 'cancel' | null {
    return this.buttonAt(docPoint)?.button ?? null;
  }

  /** The commit or cancel button at a point, as drawn now, with where it is. */
  buttonAt(docPoint: Point): { button: 'commit' | 'cancel'; center: Point; radius: number } | null {
    const { commitCenter, cancelCenter, buttonRadius } = this.getButtons();
    if (Math.hypot(docPoint.x - commitCenter.x, docPoint.y - commitCenter.y) <= buttonRadius) {
      return { button: 'commit', center: commitCenter, radius: buttonRadius };
    }
    if (Math.hypot(docPoint.x - cancelCenter.x, docPoint.y - cancelCenter.y) <= buttonRadius) {
      return { button: 'cancel', center: cancelCenter, radius: buttonRadius };
    }
    return null;
  }

  /**
   * Starts a press on a button found by `buttonAt` (perhaps before the layout
   * moved: a typed value applied by this very press); its release must land
   * on the button where it was.
   */
  pressButton(found: { button: 'commit' | 'cancel'; center: Point; radius: number }): void {
    this._interaction = { type: 'button', ...found };
  }

  /**
   * Where ✓ and ✗ are: out from the top-right corner as shown, or, where that
   * is off screen (a phone has no Escape key) or over a handle, out from
   * another corner; inside the float at a corner when it is big enough on
   * screen to leave its handles and middle clear; else pulled onscreen from
   * any of those to where they are clear; failing all, where they cover least.
   */
  getButtons(): { commitCenter: Point; cancelCenter: Point; buttonRadius: number } {
    const b = this._placeButtons();
    // ✓ then ✗ reading left to right, as they usually sit (from a left-hand
    // corner, or on a float turned around, they'd come out the other way).
    const { commitCenter: c, cancelCenter: x } = b;
    return x.x < c.x - Math.abs(x.y - c.y) ? { ...b, commitCenter: x, cancelCenter: c } : b;
  }

  private _placeButtons(): { commitCenter: Point; cancelCenter: Point; buttonRadius: number } {
    type Buttons = { commitCenter: Point; cancelCenter: Point; buttonRadius: number };
    const corners = this._getCorners();
    const config = this._handleConfig, zoom = this._zoom;
    const order = [1, 0, 2, 3] as const;
    const outside = order.map(corner => getCommitCancelPositions(corners, config, zoom, corner));
    const r = outside[0].buttonRadius;
    // On touch, kept back from the screen's edges too: a finger there is
    // taken by the toolbar beside the canvas.
    const m = r + (this.touchMode ? 12 / zoom : 0);
    const x0 = -this._pan.x / zoom + m, y0 = -this._pan.y / zoom + m;
    const x1 = Math.max(x0, (this._previewCanvas.width - this._pan.x) / zoom - m);
    const y1 = Math.max(y0, (this._previewCanvas.height - this._pan.y) / zoom - m);
    const fits = (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    // Buttons are hit first, so none may cover a drawn handle, the rotation
    // handle or the float's middle (to move it by).
    const center = {
      x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
      y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
    };
    const keepClear = [
      ...Object.values(getDocHandlePositions(corners)), getRotationHandlePos(corners, config, zoom), center,
    ];
    const reach = r + config.size / 2 / zoom;
    const clearance = (b: Buttons) => Math.min(...[b.commitCenter, b.cancelCenter]
      .flatMap(c => keepClear.map(t => Math.hypot(t.x - c.x, t.y - c.y))));
    const usable = (b: Buttons) => fits(b.commitCenter) && fits(b.cancelCenter) && clearance(b) >= reach;
    // Mirrored into the float through their corner, for a float too big on
    // screen to leave room outside it.
    const inside = outside.map((b, i): Buttons => {
      const c = corners[order[i]];
      const mirror = (p: Point) => ({ x: 2 * c.x - p.x, y: 2 * c.y - p.y });
      return { commitCenter: mirror(b.commitCenter), cancelCenter: mirror(b.cancelCenter), buttonRadius: r };
    });
    // Pulled onto the screen, both by the same shift so they stay side by side.
    const pull = (b: Buttons): Buttons => {
      const shift = (v: number, w: number, lo: number, hi: number) => {
        const dv = Math.min(Math.max(v, lo), hi) - v, dw = Math.min(Math.max(w, lo), hi) - w;
        return Math.abs(dv) > Math.abs(dw) ? dv : dw;
      };
      const sx = shift(b.commitCenter.x, b.cancelCenter.x, x0, x1);
      const sy = shift(b.commitCenter.y, b.cancelCenter.y, y0, y1);
      return {
        commitCenter: { x: b.commitCenter.x + sx, y: b.commitCenter.y + sy },
        cancelCenter: { x: b.cancelCenter.x + sx, y: b.cancelCenter.y + sy },
        buttonRadius: r,
      };
    };
    const pulled = [...outside, ...inside].map(pull);
    const found = [...outside, ...inside, ...pulled].find(usable);
    if (found) return found;
    // Nowhere clear (a tiny float wedged into a corner of the screen): on
    // screen wherever covers least.
    return pulled.reduce((best, b) => (clearance(b) > clearance(best) ? b : best));
  }

  /**
   * Ends a gesture whose pointer was cancelled, leaving the transform where it
   * got to, or (`revert`, as when the finger turns out to start a pinch) where
   * it was when grabbed. Returns whether one was in progress.
   */
  cancelInteraction(revert = false): boolean {
    const inter = this._interaction;
    if (inter.type === 'idle') return false;
    this._interaction = { type: 'idle' };
    if (revert) {
      const s = this._state;
      switch (inter.type) {
        case 'moving': s.x = inter.startX; s.y = inter.startY; break;
        case 'resizing': if (inter.origin.state) Object.assign(s, inter.origin.state); break;
        case 'rotating': s.rotation = inter.startRotation; break;
        case 'skewing': s.skewX = inter.startSkewX; s.skewY = inter.startSkewY; break;
        case 'perspective': this._perspectiveCorners[inter.corner] = { ...inter.startOffset }; break;
      }
      this._onChange();
    }
    return true;
  }

  // --- Private interaction handlers ---

  private _handleMove(docPoint: Point, modifiers: { shift: boolean }): void {
    const inter = this._interaction;
    if (inter.type !== 'moving') return;
    // Whole pixels, as the Move tool moves: a fractional offset would
    // resample (blur) everything on commit.
    let dx = Math.round(docPoint.x - inter.startPoint.x);
    let dy = Math.round(docPoint.y - inter.startPoint.y);
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
    const start = origin.state;
    // In the float's own space as grabbed, where the opposite edge stays put.
    const from = docToLocal(origin.point, start), to = docToLocal(docPoint, start);
    const dx = to.x - from.x, dy = to.y - from.y;
    // The new extent, negative once dragged past the opposite edge (a flip).
    let newW = start.width, newH = start.height;
    if (handle.includes('e')) newW = start.width + dx;
    if (handle.includes('w')) newW = start.width - dx;
    if (handle.includes('s')) newH = start.height + dy;
    if (handle.includes('n')) newH = start.height - dy;
    if (modifiers.shift && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
      const aspect = start.width / start.height;
      if (Math.abs(newW / newH) > aspect) newH = (newH < 0 ? -1 : 1) * Math.abs(newW) / aspect;
      else newW = (newW < 0 ? -1 : 1) * Math.abs(newH) * aspect;
    }
    const minSize = MIN_TRANSFORM_SIZE / this._zoom;
    if (Math.abs(newW) < minSize) newW = newW < 0 ? -minSize : minSize;
    if (Math.abs(newH) < minSize) newH = newH < 0 ? -minSize : minSize;
    // The new box's middle in that space: half the new extent from the
    // anchored edge (or the old middle along an axis not being resized).
    const mid = localToDoc({
      x: handle.includes('w') ? start.width - newW / 2 : handle.includes('e') ? newW / 2 : start.width / 2,
      y: handle.includes('n') ? start.height - newH / 2 : handle.includes('s') ? newH / 2 : start.height / 2,
    }, start);
    // composeMatrix pivots on the middle, so placing that keeps everything else.
    this._state.width = Math.abs(newW);
    this._state.height = Math.abs(newH);
    this._state.scaleX = newW < 0 ? -start.scaleX : start.scaleX;
    this._state.scaleY = newH < 0 ? -start.scaleY : start.scaleY;
    this._state.x = mid.x - this._state.width / 2;
    this._state.y = mid.y - this._state.height / 2;
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
    // From where the corner was when grabbed, not where it started out; the
    // offset is in the float's own space, so the corner follows the pointer.
    const from = docToLocal(inter.startPoint, this._state), to = docToLocal(docPoint, this._state);
    this._perspectiveCorners[inter.corner] = {
      x: inter.startOffset.x + to.x - from.x,
      y: inter.startOffset.y + to.y - from.y,
    };
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

    const corners = this._getCorners();

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

    drawHandles(ctx, corners, this._handleConfig, this._zoom);
    drawRotationHandleUI(ctx, corners, this._handleConfig, this._zoom);
    drawCommitCancelButtons(ctx, this.getButtons(), this._zoom);

    ctx.restore();
  }

  /**
   * Draws the transformed content for preview. Given `fullResolutionIn`, the
   * part inside it is drawn exactly as `commit` would write it; a perspective
   * warp may then be left out beyond it, so pass the target's whole area.
   */
  renderTransformed(ctx: CanvasRenderingContext2D, fullResolutionIn?: TransformRect): void {
    if (fullResolutionIn) this._render(ctx, fullResolutionIn, Infinity);
    // Only a perspective warp has a budget (checking it may set up the GPU).
    else this._render(ctx, null, this._perspectiveActive ? this._warpPixelBudget() : Infinity);
  }

  /** Draws the transformed content; a perspective warp limited as in `_getWarp`. */
  private _render(ctx: CanvasRenderingContext2D, clip: TransformRect | null, maxWarpPixels: number): void {
    if (this._perspectiveActive) {
      const warp = this._getWarp(clip, maxWarpPixels);
      if (!warp) return;
      if (warp.scale === 1) {
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
      const matrix = this._matrix();
      ctx.save();
      ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.drawImage(this._sourceCanvas, 0, 0, this._state.width, this._state.height);
      ctx.restore();
    }
  }

  /** Most pixels the preview warp may compute right now (see WARP_PREVIEW_PIXELS). */
  private _warpPixelBudget(): number {
    const { type } = this._interaction;
    if (type === 'idle' || type === 'button' || type === 'outside-pending') return WARP_PREVIEW_PIXELS;
    return canWarpOnGpu(this._sourceImageData) ? WARP_GPU_DRAG_PIXELS : WARP_DRAG_PIXELS;
  }

  /**
   * The perspective-warped source on a canvas, with the document rectangle it
   * covers: at least the part of the warp inside `clip` (all of it if null),
   * at full resolution unless that would take more than `maxPixels`.
   */
  private _getWarp(clip: TransformRect | null, maxPixels: number): WarpCache | null {
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
    const ctx = canvas.getContext('2d')!;
    const region = { x: sx, y: sy, w: sw, h: sh };
    if (!warpPerspectiveGpu(this._sourceImageData, scaled, region, ctx)) {
      ctx.putImageData(warpPerspective(this._sourceImageData, scaled, region), 0, 0);
    }
    const warp = { key, canvas, x: sx / scale, y: sy / scale, w: sw / scale, h: sh / scale, scale };
    if (scale === 1) {
      this._warpCache = warp;
      // A draft (always of the whole float) is no longer needed once this
      // covers the whole float too, as when a drag ends.
      const draft = this._draftWarpCache;
      if (draft && draft.key === key && warp.x <= bounds.x && warp.y <= bounds.y
        && warp.x + warp.w >= bounds.x + bounds.w && warp.y + warp.h >= bounds.y + bounds.h) {
        draft.canvas.width = draft.canvas.height = 0;
        this._draftWarpCache = null;
      }
    } else {
      this._draftWarpCache = warp;
    }
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
      const matrix = this._matrix();
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
    const corners = this._getCorners();
    // While dragging, what is being dragged decides, wherever the pointer is.
    const inter = this._interaction;
    switch (inter.type) {
      case 'moving': return 'move';
      case 'rotating': return 'grabbing';
      case 'resizing': return getHandleCursor(inter.handle, corners);
      case 'skewing': return getHandleCursor(inter.edge, corners);
      case 'perspective': return getHandleCursor(inter.corner, corners);
      case 'button': return 'pointer';
    }
    if (this.hitTestButton(docPoint)) return 'pointer';
    return getCursorForPoint(docPoint, this._getCorners(), this._handleConfig, this._zoom);
  }

  // --- Private helpers ---

  private _onChange(): void {
    this.renderPreview();
  }

  /**
   * The matrix the float is drawn and committed with: `composeMatrix`, moved
   * by under half a pixel so a float turned a whole number of quarter turns,
   * unskewed and of whole-pixel size, lands on whole pixels and is copied,
   * not resampled (a 111×70 float turned 90° about its middle has half-pixel
   * corners).
   */
  private _matrix(): DOMMatrix {
    const s = this._state;
    const m = composeMatrix(s);
    const quarters = s.rotation / (Math.PI / 2);
    const w = Math.abs(s.width * s.scaleX), h = Math.abs(s.height * s.scaleY);
    if (s.skewX !== 0 || s.skewY !== 0 || Math.abs(quarters - Math.round(quarters)) > 1e-9
      || Math.abs(w - Math.round(w)) > 1e-9 || Math.abs(h - Math.round(h)) > 1e-9) return m;
    const xs = [m.e, m.a * s.width + m.e, m.c * s.height + m.e, m.a * s.width + m.c * s.height + m.e];
    const ys = [m.f, m.b * s.width + m.f, m.d * s.height + m.f, m.b * s.width + m.d * s.height + m.f];
    const left = Math.min(...xs), top = Math.min(...ys);
    // Halves always round up, whatever floating-point error lands them on.
    const snap = (v: number) => Math.floor(v + 0.5 + 1e-7);
    m.e += snap(left) - left;
    m.f += snap(top) - top;
    return m;
  }

  /** The corners as shown (top-left, top-right, bottom-right, bottom-left), perspective included. */
  private _getCorners(): [Point, Point, Point, Point] {
    if (this._perspectiveActive) return getPerspectiveDestCorners(this._state, this._perspectiveCorners);
    // Where the pixels are drawn, so the outline, handles and bounds match them.
    const m = this._matrix(), { width: w, height: h } = this._state;
    const at = (x: number, y: number): Point => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
  }

  /** What a press at a point would grab, as laid out now. */
  hitKind(docPoint: Point): string {
    const button = this.buttonAt(docPoint);
    if (button) return button.button;
    const corners = this._getCorners();
    if (hitTestRotationHandle(docPoint, corners, this._handleConfig, this._zoom)) return 'rotate';
    return hitTestHandle(docPoint, corners, this._handleConfig, this._zoom)
      ?? (isInsideTransform(docPoint, corners) ? 'inside' : 'outside');
  }

  private _getSnapshotBounds(): { x: number; y: number; w: number; h: number } {
    const corners = this._getCorners();
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    // Within a millionth of a pixel of a whole one is on it (a quarter turn's
    // cosine is not quite 0), or the bounds grow a row of nothing.
    const x = Math.floor(Math.min(...xs) + 1e-6);
    const y = Math.floor(Math.min(...ys) + 1e-6);
    const w = Math.max(1, Math.ceil(Math.max(...xs) - 1e-6) - x);
    const h = Math.max(1, Math.ceil(Math.max(...ys) - 1e-6) - y);
    return { x, y, w, h };
  }

  dispose(): void {
    // Release the backing stores now rather than whenever this is collected.
    for (const cache of [this._warpCache, this._draftWarpCache]) {
      if (cache) cache.canvas.width = cache.canvas.height = 0;
    }
    this._warpCache = this._draftWarpCache = null;
    releaseGpuSource(this._sourceImageData);
  }
}

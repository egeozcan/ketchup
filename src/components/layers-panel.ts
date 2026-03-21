import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Layer } from '../types.js';

@customElement('layers-panel')
export class LayersPanel extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 0.8125rem;
      color: #ddd;
      user-select: none;
    }

    /* ── Panel (expanded) ─────────────────────── */
    .panel {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }

    .panel.collapsed {
    }

    /* ── Collapsed strip ──────────────────────── */
    .collapsed-strip {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 32px;
      height: 100%;
      padding-top: 8px;
      gap: 4px;
    }

    .expand-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #bbb;
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0;
    }

    .expand-btn:hover {
      background: #444;
      color: #fff;
    }

    .vertical-label {
      writing-mode: vertical-rl;
      text-orientation: mixed;
      color: #888;
      font-size: 0.6875rem;
      letter-spacing: 0.05em;
      margin-top: 6px;
    }

    /* ── Header ───────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-bottom: 1px solid #444;
      flex-shrink: 0;
    }

    .header-title {
      font-weight: 600;
      font-size: 0.8125rem;
    }

    .collapse-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #aaa;
      cursor: pointer;
      font-size: 0.6875rem;
      padding: 2px 6px;
      white-space: nowrap;
    }

    .collapse-btn:hover {
      background: #444;
      color: #fff;
    }

    /* ── Layer list ────────────────────────────── */
    .layer-list {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: #555 transparent;
    }

    /* ── Layer row ─────────────────────────────── */
    .layer-row {
      position: relative;
      display: flex;
      flex-direction: column;
      padding: 6px 8px;
      min-height: 44px;
      background: #3a3a3a;
      border-bottom: 1px solid #333;
      cursor: pointer;
      transition: background 0.1s ease;
      touch-action: none;
    }

    .layer-row.dragging {
      opacity: 0.4;
    }

    .layer-row.drop-above::before {
      content: '';
      position: absolute;
      top: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: #5b8cf7;
    }

    .layer-row.drop-below::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: #5b8cf7;
    }

    .layer-row:hover {
      background: #424242;
    }

    .layer-row.active {
      background: #3a3a5c;
    }

    .layer-row-main {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 24px;
      cursor: grab;
    }

    .layer-row-main:active {
      cursor: grabbing;
    }

    /* ── Visibility button ─────────────────────── */
    .vis-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #bbb;
      cursor: pointer;
      padding: 0;
      flex-shrink: 0;
    }

    .vis-btn:hover {
      background: #555;
      color: #fff;
    }

    .vis-btn.hidden {
      color: #666;
    }

    .vis-btn svg {
      width: 14px;
      height: 14px;
    }

    /* ── Layer thumbnail ──────────────────────── */
    .layer-thumb {
      width: 48px;
      height: 36px;
      border-radius: 3px;
      border: 1px solid #555;
      flex-shrink: 0;
    }

    /* ── Layer name ─────────────────────────────── */
    .layer-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.75rem;
      line-height: 22px;
    }

    .layer-name-input {
      flex: 1;
      min-width: 0;
      font-size: 0.75rem;
      background: #222;
      border: 1px solid #5b8cf7;
      border-radius: 3px;
      color: #ddd;
      padding: 1px 4px;
      outline: none;
      font-family: inherit;
    }

    /* ── Reorder buttons ───────────────────────── */
    .reorder-btns {
      display: flex;
      flex-direction: column;
      gap: 0px;
      flex-shrink: 0;
    }

    .reorder-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 12px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: #888;
      cursor: pointer;
      font-size: 0.5rem;
      padding: 0;
      line-height: 1;
    }

    .reorder-btn:hover:not(:disabled) {
      background: #555;
      color: #fff;
    }

    .reorder-btn:disabled {
      opacity: 0.25;
      cursor: default;
    }

    /* ── Opacity slider ────────────────────────── */
    .opacity-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      padding-left: 26px;
    }

    .opacity-row input[type="range"] {
      flex: 1;
      height: 4px;
      accent-color: #5b8cf7;
      min-width: 0;
    }

    .opacity-value {
      font-size: 0.6875rem;
      color: #aaa;
      min-width: 28px;
      text-align: right;
    }

    /* ── Action bar ────────────────────────────── */
    .action-bar {
      display: flex;
      justify-content: center;
      gap: 6px;
      padding: 6px 8px;
      border-top: 1px solid #444;
      flex-shrink: 0;
    }

    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #bbb;
      cursor: pointer;
      font-size: 0.6875rem;
      padding: 4px 10px;
      font-family: inherit;
      transition: all 0.15s ease;
    }

    .action-btn:hover:not(:disabled) {
      background: #444;
      color: #fff;
    }

    .action-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }

    .action-btn svg {
      width: 14px;
      height: 14px;
    }

    /* ── Context menu ──────────────────────────── */
    .context-menu {
      position: fixed;
      z-index: 300;
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 4px 0;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .context-menu-item {
      display: block;
      width: 100%;
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: #ddd;
      font-size: 0.8125rem;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
    }

    .context-menu-item:hover:not(:disabled) {
      background: #5b8cf7;
      color: #fff;
    }

    .context-menu-item:disabled {
      color: #666;
      cursor: default;
    }

    /* ── Dropdown menu ─────────────────────────── */
    .action-bar-wrapper {
      position: relative;
    }

    .dropdown-menu {
      position: absolute;
      bottom: 100%;
      right: 0;
      margin-bottom: 4px;
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 4px 0;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      z-index: 300;
    }

    .dropdown-menu button {
      display: block;
      width: 100%;
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: #ddd;
      font-size: 0.8125rem;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
    }

    .dropdown-menu button:hover:not(:disabled) {
      background: #5b8cf7;
      color: #fff;
    }

    .dropdown-menu button:disabled {
      color: #666;
      cursor: default;
    }

    /* ── Mobile bottom sheet ───────────────────── */
    .sheet-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 200;
    }

    .sheet-backdrop.open {
      display: block;
    }

    .sheet {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      max-height: 90vh;
      background: #2c2c2c;
      border-radius: 16px 16px 0 0;
      z-index: 201;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease;
      transform: translateY(100%);
      will-change: transform;
      padding-bottom: env(safe-area-inset-bottom);
    }

    .sheet-handle {
      display: flex;
      justify-content: center;
      padding: 8px 0;
      cursor: grab;
      touch-action: none;
    }

    .sheet-handle-bar {
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: #666;
    }

    .sheet-content {
      flex: 1;
      overflow-y: auto;
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
    }

    .rename-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #888;
      cursor: pointer;
      padding: 0;
      flex-shrink: 0;
    }

    .rename-btn:hover {
      background: #444;
      color: #ddd;
    }
  `;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  private _floatDetail: { tempCanvas: HTMLCanvasElement; rect: { x: number; y: number; w: number; h: number }; layerId: string; rotation?: number } | null = null;

  private _onComposited = (e: Event) => {
    this._floatDetail = (e as CustomEvent).detail;
    this._updateThumbnails();
  };

  private _onDocClick = () => {
    this._closeContextMenu();
    this._dropdownOpen = false;
  };

  private _onDocKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this._closeContextMenu();
      this._dropdownOpen = false;
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    // composited event bubbles from sibling drawing-canvas through the shared shadow root
    (this.getRootNode() as ShadowRoot | Document).addEventListener('composited', this._onComposited);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('click', this._onDocClick);
    document.addEventListener('keydown', this._onDocKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    (this.getRootNode() as ShadowRoot | Document).removeEventListener('composited', this._onComposited);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('click', this._onDocClick);
    document.removeEventListener('keydown', this._onDocKeyDown);
  }

  @state() private _sheetOpen = false;
  @state() private _sheetY = 0;
  private _sheetDragging = false;
  private _syncingSheet = false;
  private _sheetDragStartY = 0;
  private _sheetDragStartTranslate = 0;
  private _sheetSnapHalf = 0;
  private _sheetSnapFull = 0;
  private _sheetDragTimestamps: { y: number; t: number }[] = [];

  @state() private _contextMenuOpen = false;
  @state() private _contextMenuX = 0;
  @state() private _contextMenuY = 0;
  @state() private _dropdownOpen = false;

  /** The layer id currently in rename mode */
  @state() private _editingLayerId: string | null = null;

  /** The layer id currently being dragged */
  @state() private _draggedLayerId: string | null = null;

  private _dragPointerId: number | null = null;
  private _dragStartY = 0;
  private _dragCurrentY = 0;
  private _dragThreshold = 5;
  private _dragActivated = false;

  /** Track opacity value before drag for undo */
  private _opacityBefore: number | null = null;

  // ── SVG icons ──────────────────────────────

  private _eyeOpen = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

  private _eyeClosed = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  private _plusIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  private _trashIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

  // ── Visibility toggle ──────────────────────

  private _toggleVisibility(layer: Layer, e: Event) {
    e.stopPropagation();
    this.ctx.setLayerVisibility(layer.id, !layer.visible);
  }

  // ── Inline rename ──────────────────────────

  private _startRename(layerId: string, e: Event) {
    e.stopPropagation();
    this._editingLayerId = layerId;
  }

  private _commitRename(layerId: string, input: HTMLInputElement) {
    if (this._editingLayerId !== layerId) return;
    const newName = input.value.trim();
    if (newName && newName !== this._getLayerById(layerId)?.name) {
      this.ctx.renameLayer(layerId, newName);
    }
    this._editingLayerId = null;
  }

  private _onRenameKeyDown(layerId: string, e: KeyboardEvent) {
    // Stop all keydown events from reaching the app-level shortcut handler
    // (Backspace/Delete triggers deleteSelection, Ctrl+Z triggers undo, etc.)
    e.stopPropagation();
    if (e.key === 'Enter') {
      this._commitRename(layerId, e.target as HTMLInputElement);
    } else if (e.key === 'Escape') {
      this._editingLayerId = null;
    }
  }

  private _onRenameBlur(layerId: string, e: FocusEvent) {
    this._commitRename(layerId, e.target as HTMLInputElement);
  }

  // ── Reorder ────────────────────────────────

  private _moveUp(layer: Layer, e: Event) {
    e.stopPropagation();
    const layers = this.ctx.state.layers;
    const idx = layers.findIndex(l => l.id === layer.id);
    if (idx < layers.length - 1) {
      this.ctx.reorderLayer(layer.id, idx + 1);
    }
  }

  private _moveDown(layer: Layer, e: Event) {
    e.stopPropagation();
    const layers = this.ctx.state.layers;
    const idx = layers.findIndex(l => l.id === layer.id);
    if (idx > 0) {
      this.ctx.reorderLayer(layer.id, idx - 1);
    }
  }

  // ── Pointer-based reorder ─────────────────

  private _onReorderPointerDown(layer: Layer, e: PointerEvent) {
    if (e.button !== 0) return;
    this._draggedLayerId = layer.id;
    this._dragPointerId = e.pointerId;
    this._dragStartY = e.clientY;
    this._dragCurrentY = e.clientY;
    this._dragActivated = false;
    this._dragTarget = e.currentTarget as HTMLElement;
  }

  private _dragTarget: HTMLElement | null = null;

  private _onReorderPointerMove(e: PointerEvent) {
    if (this._dragPointerId !== e.pointerId || !this._draggedLayerId) return;
    this._dragCurrentY = e.clientY;

    if (!this._dragActivated) {
      if (Math.abs(this._dragCurrentY - this._dragStartY) < this._dragThreshold) return;
      this._dragActivated = true;
      if (this._dragTarget) {
        this._dragTarget.setPointerCapture(e.pointerId);
      }
    }

    this._clearDropIndicators();
    const rows = this.shadowRoot?.querySelectorAll('.layer-row');
    if (!rows) return;

    for (const row of rows) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (this._dragCurrentY >= rect.top && this._dragCurrentY <= rect.bottom) {
        const midY = rect.top + rect.height / 2;
        if (this._dragCurrentY < midY) {
          row.classList.add('drop-above');
        } else {
          row.classList.add('drop-below');
        }
        break;
      }
    }
  }

  private _onReorderPointerUp(e: PointerEvent) {
    if (this._dragPointerId !== e.pointerId) return;

    const draggedId = this._draggedLayerId;
    if (!draggedId || !this._dragActivated) {
      this._clearDragState();
      return;
    }

    const rows = this.shadowRoot?.querySelectorAll('.layer-row');
    if (!rows) {
      this._clearDragState();
      return;
    }

    let targetId: string | null = null;
    let dropAbove = false;

    for (const row of rows) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (this._dragCurrentY >= rect.top && this._dragCurrentY <= rect.bottom) {
        targetId = (row as HTMLElement).dataset.layerId ?? null;
        const midY = rect.top + rect.height / 2;
        dropAbove = this._dragCurrentY < midY;
        break;
      }
    }

    if (targetId && targetId !== draggedId) {
      const layers = this.ctx.state.layers;
      const targetArrayIdx = layers.findIndex(l => l.id === targetId);
      if (targetArrayIdx !== -1) {
        let newArrayIdx = dropAbove ? targetArrayIdx + 1 : targetArrayIdx;
        const draggedArrayIdx = layers.findIndex(l => l.id === draggedId);
        if (draggedArrayIdx < newArrayIdx) newArrayIdx -= 1;
        newArrayIdx = Math.max(0, Math.min(layers.length - 1, newArrayIdx));
        if (draggedArrayIdx !== newArrayIdx) {
          this.ctx.reorderLayer(draggedId, newArrayIdx);
        }
      }
    }

    this._clearDragState();
  }

  private _onReorderPointerCancel(_e: PointerEvent) {
    this._clearDragState();
  }

  private _clearDropIndicators() {
    const rows = this.shadowRoot?.querySelectorAll('.layer-row');
    rows?.forEach(row => row.classList.remove('drop-above', 'drop-below'));
  }

  private _clearDragState() {
    this._draggedLayerId = null;
    this._dragPointerId = null;
    this._dragActivated = false;
    this._dragTarget = null;
    this._clearDropIndicators();
  }

  // ── Mobile bottom sheet ─────────────────────

  openSheet() {
    this._sheetSnapFull = 0;
    this._sheetY = 0;
    this._sheetOpen = true;
    this.updateComplete.then(() => this._measureSnaps());
  }

  private _measureSnaps() {
    const sheet = this.shadowRoot?.querySelector('.sheet') as HTMLElement;
    const h = sheet ? sheet.offsetHeight : window.innerHeight * 0.9;
    this._sheetSnapHalf = Math.floor(h * 0.5);
  }

  closeSheet() {
    this._sheetOpen = false;
    this._sheetY = 0;
    if (!this._syncingSheet && this.ctx?.state.layersPanelOpen) {
      this.ctx.toggleLayersPanel();
    }
  }

  private _onResize = () => {
    if (this._sheetOpen && !this._sheetDragging) {
      this._recalcSnapPoints();
    }
  };

  private _recalcSnapPoints() {
    const sheet = this.shadowRoot?.querySelector('.sheet') as HTMLElement;
    const h = sheet ? sheet.offsetHeight : window.innerHeight * 0.9;
    const oldSnapHalf = this._sheetSnapHalf;
    this._sheetSnapFull = 0;
    this._sheetSnapHalf = Math.floor(h * 0.5);
    if (oldSnapHalf > 0) {
      if (this._sheetY === oldSnapHalf) {
        this._sheetY = this._sheetSnapHalf;
      } else if (this._sheetY === this._sheetSnapFull) {
        // already correct
      } else {
        const distToHalf = Math.abs(this._sheetY - this._sheetSnapHalf);
        const distToFull = Math.abs(this._sheetY - this._sheetSnapFull);
        this._sheetY = distToHalf < distToFull ? this._sheetSnapHalf : this._sheetSnapFull;
      }
    }
  }

  private _onSheetHandlePointerDown(e: PointerEvent) {
    this._sheetDragging = true;
    this._sheetDragStartY = e.clientY;
    this._sheetDragStartTranslate = this._sheetY;
    this._sheetDragTimestamps = [{ y: e.clientY, t: Date.now() }];
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  private _onSheetHandlePointerMove(e: PointerEvent) {
    if (!this._sheetDragging) return;
    const dy = e.clientY - this._sheetDragStartY;
    const newY = Math.max(this._sheetSnapFull, this._sheetDragStartTranslate + dy);
    this._sheetY = newY;
    this._sheetDragTimestamps.push({ y: e.clientY, t: Date.now() });
    if (this._sheetDragTimestamps.length > 5) this._sheetDragTimestamps.shift();
  }

  private _onSheetHandlePointerUp(_e: PointerEvent) {
    if (!this._sheetDragging) return;
    this._sheetDragging = false;

    const samples = this._sheetDragTimestamps;
    let velocity = 0;
    if (samples.length >= 2) {
      const last = samples[samples.length - 1];
      const prev = samples[samples.length - 2];
      const dt = last.t - prev.t;
      if (dt > 0) velocity = (last.y - prev.y) / dt;
    }

    const dismissThreshold = window.innerHeight * 0.75;
    if (this._sheetY > dismissThreshold || velocity > 0.5) {
      this.closeSheet();
      return;
    }

    const distToHalf = Math.abs(this._sheetY - this._sheetSnapHalf);
    const distToFull = Math.abs(this._sheetY - this._sheetSnapFull);
    this._sheetY = distToHalf < distToFull ? this._sheetSnapHalf : this._sheetSnapFull;
  }

  private _onSheetHandlePointerCancel(_e: PointerEvent) {
    if (!this._sheetDragging) return;
    this._sheetDragging = false;
    const distToHalf = Math.abs(this._sheetY - this._sheetSnapHalf);
    const distToFull = Math.abs(this._sheetY - this._sheetSnapFull);
    this._sheetY = distToHalf < distToFull ? this._sheetSnapHalf : this._sheetSnapFull;
  }

  // ── Opacity ────────────────────────────────

  private _onOpacityPointerDown(layer: Layer) {
    this._opacityBefore = layer.opacity;
  }

  private _onOpacityInput(layerId: string, e: Event) {
    // Capture the "before" value on the first input event if pointerdown
    // didn't fire (keyboard-driven slider changes skip pointerdown).
    if (this._opacityBefore === null) {
      const layer = this._getLayerById(layerId);
      if (layer) this._opacityBefore = layer.opacity;
    }
    const value = Number((e.target as HTMLInputElement).value) / 100;
    this.ctx.setLayerOpacity(layerId, value);
  }

  private _onOpacityChange(layerId: string, e: Event) {
    const after = Number((e.target as HTMLInputElement).value) / 100;
    const before = this._opacityBefore;
    this._opacityBefore = null;
    if (before !== null && before !== after) {
      this.dispatchEvent(new CustomEvent('commit-opacity', {
        bubbles: true,
        composed: true,
        detail: { layerId, before, after },
      }));
    }
  }

  // ── Context menu ───────────────────────────

  private _onContextMenu(e: MouseEvent, layerId: string) {
    e.preventDefault();
    this._selectLayer(layerId);
    this._contextMenuX = e.clientX;
    this._contextMenuY = e.clientY;
    this._contextMenuOpen = true;
  }

  private _closeContextMenu() {
    this._contextMenuOpen = false;
  }

  // ── Helpers ────────────────────────────────

  private _getLayerById(id: string): Layer | undefined {
    return this.ctx.state.layers.find(l => l.id === id);
  }

  private _selectLayer(id: string) {
    this.ctx.setActiveLayer(id);
  }

  // ── Render ─────────────────────────────────

  override render() {
    if (!this._ctx.value) return html``;

    if (this.ctx.isMobile) {
      return this._renderMobileSheet();
    }

    const { layersPanelOpen } = this.ctx.state;

    if (!layersPanelOpen) {
      return html`
        <div class="panel collapsed">
          <div class="collapsed-strip">
            <button
              class="expand-btn"
              title="Show layers"
              @click=${() => this.ctx.toggleLayersPanel()}
            >&#9654;</button>
            <span class="vertical-label">Layers</span>
          </div>
        </div>
      `;
    }

    return html`
      <div class="panel">
        ${this._renderLayersList()}
      </div>
    `;
  }

  private _renderMobileSheet() {
    const sheetStyle = this._sheetOpen
      ? `transform: translateY(${this._sheetY}px);${this._sheetDragging ? 'transition:none;' : ''}`
      : `transform: translateY(100%);`;

    return html`
      <div
        class="sheet-backdrop ${this._sheetOpen ? 'open' : ''}"
        @click=${() => this.closeSheet()}
      ></div>
      <div
        class="sheet ${this._sheetOpen ? 'open' : ''}"
        style=${sheetStyle}
      >
        <div
          class="sheet-handle"
          @pointerdown=${(e: PointerEvent) => this._onSheetHandlePointerDown(e)}
          @pointermove=${(e: PointerEvent) => this._onSheetHandlePointerMove(e)}
          @pointerup=${(e: PointerEvent) => this._onSheetHandlePointerUp(e)}
          @pointercancel=${(e: PointerEvent) => this._onSheetHandlePointerCancel(e)}
        >
          <div class="sheet-handle-bar"></div>
        </div>
        <div class="sheet-content">
          ${this._renderLayersList()}
        </div>
      </div>
    `;
  }

  private _renderLayersList() {
    const { layers, activeLayerId } = this.ctx.state;
    // Reverse order: top of list = highest z-index = last in array
    const reversed = [...layers].reverse();

    return html`
      <div class="header">
        <span class="header-title">Layers</span>
        <button
          class="collapse-btn"
          title="Hide layers"
          @click=${() => this.ctx.toggleLayersPanel()}
        >&#9664; hide</button>
      </div>

      <div class="layer-list">
        ${reversed.map(layer => this._renderLayerRow(layer, layers, activeLayerId))}
      </div>

      ${this._contextMenuOpen ? html`
        <div
          class="context-menu"
          style="left:${this._contextMenuX}px;top:${this._contextMenuY}px"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <button
            class="context-menu-item"
            ?disabled=${layers.findIndex(l => l.id === activeLayerId) === 0}
            @click=${() => { this.ctx.mergeLayerDown(activeLayerId); this._closeContextMenu(); }}
          >Merge Down</button>
          <button
            class="context-menu-item"
            ?disabled=${layers.filter(l => l.visible).length < 2}
            @click=${() => { this.ctx.mergeVisibleLayers(); this._closeContextMenu(); }}
          >Merge Visible</button>
          <button
            class="context-menu-item"
            ?disabled=${layers.length <= 1}
            @click=${() => { this.ctx.flattenImage(); this._closeContextMenu(); }}
          >Flatten Image</button>
        </div>
      ` : nothing}

      <div class="action-bar-wrapper">
        ${this._dropdownOpen ? html`
          <div class="dropdown-menu" @click=${(e: Event) => e.stopPropagation()}>
            <button
              ?disabled=${layers.findIndex(l => l.id === activeLayerId) === 0}
              @click=${() => { this.ctx.mergeLayerDown(activeLayerId); this._dropdownOpen = false; }}
            >Merge Down</button>
            <button
              ?disabled=${layers.filter(l => l.visible).length < 2}
              @click=${() => { this.ctx.mergeVisibleLayers(); this._dropdownOpen = false; }}
            >Merge Visible</button>
            <button
              ?disabled=${layers.length <= 1}
              @click=${() => { this.ctx.flattenImage(); this._dropdownOpen = false; }}
            >Flatten Image</button>
          </div>
        ` : nothing}
        <div class="action-bar">
          <button
            class="action-btn"
            title="Add layer"
            @click=${() => this.ctx.addLayer()}
          >${this._plusIcon} Add</button>
          <button
            class="action-btn"
            title="Delete layer"
            ?disabled=${layers.length <= 1}
            @click=${() => this.ctx.deleteLayer(activeLayerId)}
          >${this._trashIcon} Delete</button>
          <button
            class="action-btn"
            title="More actions"
            @click=${(e: Event) => { e.stopPropagation(); this._dropdownOpen = !this._dropdownOpen; }}
          >&#8943;</button>
        </div>
      </div>
    `;
  }

  private _renderLayerRow(layer: Layer, layers: Layer[], activeLayerId: string) {
    const isActive = layer.id === activeLayerId;
    const idx = layers.findIndex(l => l.id === layer.id);
    const isTop = idx === layers.length - 1;
    const isBottom = idx === 0;
    const isEditing = this._editingLayerId === layer.id;

    return html`
      <div
        class="layer-row ${isActive ? 'active' : ''} ${this._draggedLayerId === layer.id ? 'dragging' : ''}"
        data-layer-id=${layer.id}
        @click=${() => this._selectLayer(layer.id)}
        @contextmenu=${(e: MouseEvent) => this._onContextMenu(e, layer.id)}
        @pointerdown=${(e: PointerEvent) => this._onReorderPointerDown(layer, e)}
        @pointermove=${(e: PointerEvent) => this._onReorderPointerMove(e)}
        @pointerup=${(e: PointerEvent) => this._onReorderPointerUp(e)}
        @pointercancel=${(e: PointerEvent) => this._onReorderPointerCancel(e)}
      >
        <div
          class="layer-row-main"
        >
          <button
            class="vis-btn ${layer.visible ? '' : 'hidden'}"
            title=${layer.visible ? 'Hide layer' : 'Show layer'}
            @click=${(e: Event) => this._toggleVisibility(layer, e)}
          >
            ${layer.visible ? this._eyeOpen : this._eyeClosed}
          </button>

          <canvas class="layer-thumb" width="48" height="36"></canvas>

          ${isEditing
            ? html`<input
                class="layer-name-input"
                .value=${layer.name}
                @keydown=${(e: KeyboardEvent) => this._onRenameKeyDown(layer.id, e)}
                @blur=${(e: FocusEvent) => this._onRenameBlur(layer.id, e)}
                @click=${(e: Event) => e.stopPropagation()}
                ${this._autoFocusDirective()}
              />`
            : html`<span
                class="layer-name"
                @dblclick=${(e: Event) => this._startRename(layer.id, e)}
              >${layer.name}</span>`
          }

          ${this.ctx.isMobile ? html`
            <button
              class="rename-btn"
              title="Rename"
              @click=${(e: Event) => { e.stopPropagation(); this._startRename(layer.id, e); }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/>
              </svg>
            </button>
          ` : ''}

          <div class="reorder-btns">
            <button
              class="reorder-btn"
              title="Move up"
              ?disabled=${isTop}
              @click=${(e: Event) => this._moveUp(layer, e)}
            >&#9650;</button>
            <button
              class="reorder-btn"
              title="Move down"
              ?disabled=${isBottom}
              @click=${(e: Event) => this._moveDown(layer, e)}
            >&#9660;</button>
          </div>
        </div>

        ${isActive
          ? html`
            <div class="opacity-row">
              <input
                type="range"
                min="0"
                max="100"
                .value=${String(Math.round(layer.opacity * 100))}
                @pointerdown=${() => this._onOpacityPointerDown(layer)}
                @input=${(e: Event) => this._onOpacityInput(layer.id, e)}
                @change=${(e: Event) => this._onOpacityChange(layer.id, e)}
              />
              <span class="opacity-value">${Math.round(layer.opacity * 100)}%</span>
            </div>
          `
          : nothing}
      </div>
    `;
  }

  /**
   * Returns a lit directive-like callback that focuses the input
   * after it is rendered. We use updated() instead of a real directive
   * to keep things simple.
   */
  private _autoFocusDirective() {
    // We schedule focus for the next microtask so the element is in the DOM.
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.layer-name-input');
      if (input) {
        input.focus();
        input.select();
      }
    });
    return nothing;
  }

  // ── Thumbnails ──────────────────────────────

  override updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (this.ctx?.isMobile && !this._syncingSheet) {
      this._syncingSheet = true;
      if (this.ctx.state.layersPanelOpen && !this._sheetOpen) {
        this.openSheet();
      } else if (!this.ctx.state.layersPanelOpen && this._sheetOpen) {
        this.closeSheet();
      }
      this._syncingSheet = false;
    }
    this._updateThumbnails();
  }

  private _updateThumbnails() {
    const layers = this._ctx.value?.state.layers ?? [];
    const thumbnails = this.shadowRoot?.querySelectorAll<HTMLCanvasElement>('.layer-thumb');
    if (!thumbnails) return;

    const reversed = [...layers].reverse();
    thumbnails.forEach((thumb, i) => {
      const layer = reversed[i];
      if (!layer) return;
      const ctx = thumb.getContext('2d')!;
      ctx.clearRect(0, 0, thumb.width, thumb.height);
      // Mini checkerboard to show transparency
      this._drawMiniCheckerboard(ctx, thumb.width, thumb.height);
      // Scale layer content to thumbnail
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.canvas, 0, 0, thumb.width, thumb.height);
      // Draw floating selection content onto the active layer's thumbnail
      if (this._floatDetail && layer.id === this._floatDetail.layerId) {
        const { tempCanvas, rect, rotation } = this._floatDetail;
        const cw = layer.canvas.width;
        const ch = layer.canvas.height;
        const sx = (rect.x / cw) * thumb.width;
        const sy = (rect.y / ch) * thumb.height;
        const sw = (rect.w / cw) * thumb.width;
        const sh = (rect.h / ch) * thumb.height;
        if (rotation) {
          const cx = sx + sw / 2;
          const cy = sy + sh / 2;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rotation);
          ctx.drawImage(tempCanvas, -sw / 2, -sh / 2, sw, sh);
          ctx.restore();
        } else {
          ctx.drawImage(tempCanvas, sx, sy, sw, sh);
        }
      }
      ctx.globalAlpha = 1.0;
    });
  }

  private _drawMiniCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const size = 4;
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#ffffff' : '#e0e0e0';
        ctx.fillRect(x, y, size, size);
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'layers-panel': LayersPanel;
  }
}

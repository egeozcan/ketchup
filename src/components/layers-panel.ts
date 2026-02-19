import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { Layer } from '../types.js';

@customElement('layers-panel')
export class LayersPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 0.8125rem;
      color: #ddd;
      user-select: none;
    }

    /* ── Panel (expanded) ─────────────────────── */
    .panel {
      display: flex;
      flex-direction: column;
      width: 200px;
      height: 100%;
      background: #2c2c2c;
      border-left: 1px solid #444;
      transition: width 0.2s ease;
      overflow: hidden;
    }

    .panel.collapsed {
      width: 32px;
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
      background: #3a3a3a;
      border-bottom: 1px solid #333;
      cursor: pointer;
      transition: background 0.1s ease;
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
  `;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  private _onComposited = () => this._updateThumbnails();

  override connectedCallback() {
    super.connectedCallback();
    // composited event bubbles from sibling drawing-canvas through the shared shadow root
    (this.getRootNode() as ShadowRoot | Document).addEventListener('composited', this._onComposited);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    (this.getRootNode() as ShadowRoot | Document).removeEventListener('composited', this._onComposited);
  }

  /** The layer id currently in rename mode */
  @state() private _editingLayerId: string | null = null;

  /** The layer id currently being dragged */
  @state() private _draggedLayerId: string | null = null;

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

  // ── Drag-and-drop reorder ─────────────────

  private _onDragStart(layer: Layer, e: DragEvent) {
    this._draggedLayerId = layer.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', layer.id);
    }
  }

  private _onDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    const row = (e.target as HTMLElement).closest('.layer-row') as HTMLElement | null;
    if (!row) return;

    // Clear existing indicators on all rows
    this._clearDropIndicators();

    // Determine if cursor is in top or bottom half of row
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      row.classList.add('drop-above');
    } else {
      row.classList.add('drop-below');
    }
  }

  private _onDragLeave(e: DragEvent) {
    const row = (e.target as HTMLElement).closest('.layer-row') as HTMLElement | null;
    if (row) {
      row.classList.remove('drop-above', 'drop-below');
    }
  }

  private _onDrop(e: DragEvent) {
    e.preventDefault();
    const draggedId = this._draggedLayerId;
    if (!draggedId) return;

    const row = (e.target as HTMLElement).closest('.layer-row') as HTMLElement | null;
    if (!row) return;

    const targetId = row.dataset.layerId;
    if (!targetId || targetId === draggedId) {
      this._clearDragState();
      return;
    }

    const layers = this.ctx.state.layers;

    // Determine if dropping above or below the target in the visual list
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const dropAbove = e.clientY < midY;

    // The visual list is reversed: visual index 0 = array index (layers.length - 1)
    const targetArrayIdx = layers.findIndex(l => l.id === targetId);
    if (targetArrayIdx === -1) {
      this._clearDragState();
      return;
    }

    // "Above" in the visual list (higher z-index) = higher array index
    // "Below" in the visual list (lower z-index) = lower array index
    let newArrayIdx: number;
    if (dropAbove) {
      // Drop above target in visual list = place after target in array
      newArrayIdx = targetArrayIdx + 1;
    } else {
      // Drop below target in visual list = place before target in array
      newArrayIdx = targetArrayIdx;
    }

    // Adjust: if dragged item was before the target in the array,
    // removing it shifts indices down by one
    const draggedArrayIdx = layers.findIndex(l => l.id === draggedId);
    if (draggedArrayIdx < newArrayIdx) {
      newArrayIdx -= 1;
    }

    // Clamp to valid range
    newArrayIdx = Math.max(0, Math.min(layers.length - 1, newArrayIdx));

    if (draggedArrayIdx !== newArrayIdx) {
      this.ctx.reorderLayer(draggedId, newArrayIdx);
    }

    this._clearDragState();
  }

  private _onDragEnd() {
    this._clearDragState();
  }

  private _clearDropIndicators() {
    const rows = this.shadowRoot?.querySelectorAll('.layer-row');
    rows?.forEach(row => row.classList.remove('drop-above', 'drop-below'));
  }

  private _clearDragState() {
    this._draggedLayerId = null;
    this._clearDropIndicators();
  }

  // ── Opacity ────────────────────────────────

  private _onOpacityPointerDown(layer: Layer) {
    this._opacityBefore = layer.opacity;
  }

  private _onOpacityInput(layerId: string, e: Event) {
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
    const { layers, activeLayerId, layersPanelOpen } = this.ctx.state;

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

    // Reverse order: top of list = highest z-index = last in array
    const reversed = [...layers].reverse();

    return html`
      <div class="panel">
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
        @dragover=${(e: DragEvent) => this._onDragOver(e)}
        @dragleave=${(e: DragEvent) => this._onDragLeave(e)}
        @drop=${(e: DragEvent) => this._onDrop(e)}
        @dragend=${() => this._onDragEnd()}
      >
        <div
          class="layer-row-main"
          draggable="true"
          @dragstart=${(e: DragEvent) => this._onDragStart(layer, e)}
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

  override updated() {
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
      if (layer.visible) {
        ctx.globalAlpha = layer.opacity;
      }
      ctx.drawImage(layer.canvas, 0, 0, thumb.width, thumb.height);
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

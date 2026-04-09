import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { ToolType } from '../types.js';
import { toolIcons, toolLabels, toolShortcuts, actionIcons, CHILD_TOOLS } from './tool-icons.js';
import './tool-settings.js';

const toolGroups: ToolType[][] = [
  ['select', 'move', 'crop', 'hand'],
  ['pencil', 'eraser'],
  ['line', 'rectangle', 'circle', 'triangle'],
  ['fill', 'stamp', 'text', 'eyedropper'],
];

/** Bright, kid-friendly color palette with accessible names */
const childColors: { hex: string; name: string }[] = [
  { hex: '#000000', name: 'Black' },
  { hex: '#ffffff', name: 'White' },
  { hex: '#ff3b30', name: 'Red' },
  { hex: '#ff9500', name: 'Orange' },
  { hex: '#ffcc00', name: 'Yellow' },
  { hex: '#34c759', name: 'Green' },
  { hex: '#00c7be', name: 'Teal' },
  { hex: '#007aff', name: 'Blue' },
  { hex: '#5856d6', name: 'Indigo' },
  { hex: '#af52de', name: 'Purple' },
  { hex: '#ff2d55', name: 'Pink' },
  { hex: '#a2845e', name: 'Brown' },
];

/** Size presets for child mode */
const childSizes = [
  { label: 'S', value: 4 },
  { label: 'M', value: 16 },
  { label: 'L', value: 40 },
];

@customElement('app-toolbar')
export class AppToolbar extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: #2c2c2c;
      padding: 8px;
      gap: 4px;
      width: 60px;
      box-sizing: border-box;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #555 transparent;
    }

    .group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .separator {
      height: 1px;
      background: #555;
      margin: 4px 2px;
    }

    button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #bbb;
      cursor: pointer;
      padding: 10px;
      transition: all 0.15s ease;
    }

    button:hover {
      background: #444;
      color: #fff;
    }

    button.active {
      background: #5b8cf7;
      color: #fff;
    }

    button:disabled {
      opacity: 0.3;
      cursor: default;
    }

    button:disabled:hover {
      background: transparent;
      color: #bbb;
    }

    button svg {
      width: 20px;
      height: 20px;
    }

    .action-group {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* ── Mobile bottom bar ─────────────────────── */
    :host([mobile]) {
      flex-direction: row;
      width: 100%;
      height: 48px;
      padding: 4px 8px;
      padding-bottom: calc(4px + env(safe-area-inset-bottom));
      align-items: center;
      justify-content: space-between;
      overflow: visible;
      border-top: 1px solid #444;
      touch-action: manipulation;
    }

    :host([mobile][child-mode]) {
      height: auto;
      padding: 8px 8px;
      padding-bottom: calc(8px + env(safe-area-inset-bottom));
      justify-content: center;
    }

    :host([mobile]) .group {
      flex-direction: row;
    }

    :host([mobile]) .separator {
      width: 1px;
      height: 24px;
      margin: 0 4px;
    }

    :host([mobile]) .action-group {
      flex-direction: row;
      margin-top: 0;
      margin-left: auto;
    }

    .popover {
      display: none;
    }

    :host([mobile]) .popover {
      display: flex;
      flex-direction: column;
      position: absolute;
      bottom: calc(52px + env(safe-area-inset-bottom));
      left: 8px;
      right: 8px;
      background: #2c2c2c;
      border: 1px solid #555;
      border-radius: 12px;
      padding: 8px;
      gap: 8px;
      z-index: 100;
      touch-action: manipulation;
      box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
    }

    .popover-backdrop {
      display: none;
    }

    :host([mobile]) .popover-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 99;
    }

    .popover .sub-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding-bottom: 8px;
      border-bottom: 1px solid #444;
    }

    .popover-divider {
      height: 1px;
      background: #444;
    }

    .popover-label {
      font-size: 0.7rem;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0 4px;
    }

    .popover .project-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 40vh;
      overflow-y: auto;
    }

    .popover .project-item {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #bbb;
      font-size: 0.85rem;
      text-align: left;
      cursor: pointer;
    }

    .popover .project-item:hover {
      background: #444;
    }

    .popover .project-item.current {
      background: #3a3a3a;
      color: #fff;
    }

    .popover .project-item .check {
      width: 16px;
      flex-shrink: 0;
      color: #5b8cf7;
    }

    .popover button.menu-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: auto;
      padding: 10px;
      font-size: 0.85rem;
      text-align: left;
      border-radius: 6px;
    }

    .popover button.menu-btn svg {
      flex-shrink: 0;
    }

    /* ── Child Mode ───────────────────────────── */
    .child-bar {
      display: flex;
      flex-direction: column;
      width: 100%;
      gap: 6px;
    }

    .child-colors {
      display: flex;
      justify-content: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .child-color-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 3px solid transparent;
      padding: 0;
      cursor: pointer;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }

    .child-color-btn:hover {
      transform: scale(1.15);
    }

    .child-color-btn.active {
      border-color: #fff;
      box-shadow: 0 0 0 2px #5b8cf7;
      transform: scale(1.15);
    }

    .child-tools-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      flex-wrap: wrap;
    }

    .child-tool-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border: none;
      border-radius: 14px;
      background: #3a3a3a;
      color: #ccc;
      cursor: pointer;
      padding: 0;
      transition: all 0.15s ease;
    }

    .child-tool-btn svg {
      width: 22px;
      height: 22px;
    }

    .child-tool-btn:hover {
      background: #555;
      color: #fff;
    }

    .child-tool-btn.active {
      background: #5b8cf7;
      color: #fff;
    }

    .child-tool-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }

    .child-size-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 48px;
      border: none;
      border-radius: 14px;
      background: #3a3a3a;
      color: #ccc;
      font-size: 0.85rem;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
      transition: all 0.15s ease;
    }

    .child-size-btn:hover {
      background: #555;
      color: #fff;
    }

    .child-size-btn.active {
      background: #ff9500;
      color: #fff;
    }

    .child-sep {
      width: 1px;
      height: 32px;
      background: #555;
      margin: 0 2px;
      flex-shrink: 0;
    }

    .child-color-picker {
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 50%;
      padding: 0;
      cursor: pointer;
      background: none;
    }
  `;

  @state() private _popoverGroup: number | null = null;
  @state() private _isFullscreen = false;
  private _lastToolPerGroup = new Map<number, ToolType>();

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  private _onFullscreenChange = () => {
    this._isFullscreen = !!document.fullscreenElement;
  };

  private _toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
    this._closePopover();
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
  }

  override willUpdate() {
    this.toggleAttribute('mobile', this.ctx?.isMobile ?? false);
    this.toggleAttribute('child-mode', this.ctx?.state?.childMode ?? false);
    const activeTool = this.ctx?.state?.activeTool;
    if (activeTool) {
      const groupIndex = toolGroups.findIndex(g => g.includes(activeTool));
      if (groupIndex !== -1) {
        this._lastToolPerGroup.set(groupIndex, activeTool);
      }
    }
    if (this.ctx?.state?.layersPanelOpen && this._popoverGroup !== null) {
      this._popoverGroup = null;
    }
  }

  private _selectTool(tool: ToolType) {
    this.ctx.setTool(tool);
  }

  override render() {
    if (!this._ctx.value) return html``;
    const { activeTool } = this.ctx.state;

    if (this.ctx.isMobile) {
      return this._renderMobile(activeTool);
    }

    return html`
      ${toolGroups.map(
        (group, i) => html`
          ${i > 0 ? html`<div class="separator"></div>` : ''}
          <div class="group">
            ${group.map(
              (tool) => html`
                <button
                  class=${activeTool === tool ? 'active' : ''}
                  title=${`${toolLabels[tool]} (${toolShortcuts[tool]})`}
                  @click=${() => this._selectTool(tool)}
                >
                  ${toolIcons[tool]}
                </button>
              `,
            )}
          </div>
        `,
      )}

      <div class="action-group">
        <div class="separator"></div>
        <button
          title="Undo"
          ?disabled=${!this.ctx.canUndo}
          @click=${() => this.ctx.undo()}
        >
          ${actionIcons.undo}
        </button>
        <button
          title="Redo"
          ?disabled=${!this.ctx.canRedo}
          @click=${() => this.ctx.redo()}
        >
          ${actionIcons.redo}
        </button>
        <button title="Save" @click=${() => this.ctx.saveCanvas()}>
          ${actionIcons.save}
        </button>
        <button title="Clear canvas" @click=${() => this.ctx.clearCanvas()}>
          ${actionIcons.clear}
        </button>
      </div>
    `;
  }

  private _closestChildSize(brushSize: number): number {
    let best = childSizes[0].value;
    let bestDist = Math.abs(brushSize - best);
    for (const s of childSizes) {
      const d = Math.abs(brushSize - s.value);
      if (d < bestDist) { bestDist = d; best = s.value; }
    }
    return best;
  }

  private _confirmClearCanvas() {
    if (confirm('Clear the whole drawing?')) {
      this.ctx.clearCanvas();
    }
  }

  private _renderChildMode(activeTool: ToolType) {
    const strokeColor = this.ctx.state.strokeColor;
    const brushSize = this.ctx.state.brush.size;
    const activeSize = this._closestChildSize(brushSize);

    return html`
      <div class="child-bar">
        <div class="child-colors">
          ${childColors.map(c => html`
            <button
              class="child-color-btn ${strokeColor === c.hex ? 'active' : ''}"
              style="background:${c.hex}${c.hex === '#ffffff' ? ';box-shadow:inset 0 0 0 1px #666' : ''}"
              aria-label=${c.name}
              @click=${() => this.ctx.setStrokeColor(c.hex)}
            ></button>
          `)}
          <input
            type="color"
            class="child-color-picker"
            .value=${strokeColor}
            @input=${(e: Event) => this.ctx.setStrokeColor((e.target as HTMLInputElement).value)}
            title="Pick color"
          />
        </div>

        <div class="child-tools-row">
          <button
            class="child-tool-btn"
            title="Undo"
            ?disabled=${!this.ctx.canUndo}
            @click=${() => this.ctx.undo()}
          >${actionIcons.undo}</button>
          <button
            class="child-tool-btn"
            title="Redo"
            ?disabled=${!this.ctx.canRedo}
            @click=${() => this.ctx.redo()}
          >${actionIcons.redo}</button>

          <div class="child-sep"></div>

          ${CHILD_TOOLS.map(tool => html`
            <button
              class="child-tool-btn ${activeTool === tool ? 'active' : ''}"
              title=${toolLabels[tool]}
              @click=${() => this._selectTool(tool)}
            >${toolIcons[tool]}</button>
          `)}

          <div class="child-sep"></div>

          ${childSizes.map(s => html`
            <button
              class="child-size-btn ${activeSize === s.value ? 'active' : ''}"
              title="${s.label} brush"
              @click=${() => this.ctx.setBrushSize(s.value)}
            >${s.label}</button>
          `)}

          <div class="child-sep"></div>

          <button
            class="child-tool-btn"
            title="Save"
            @click=${() => this.ctx.saveCanvas()}
          >${actionIcons.save}</button>
          <button
            class="child-tool-btn"
            title="Clear canvas"
            @click=${() => this._confirmClearCanvas()}
          >${actionIcons.clear}</button>
          <button
            class="child-tool-btn"
            title="Exit Child Mode"
            @click=${() => this.ctx.setChildMode(false)}
          >${actionIcons.exitChildMode}</button>
        </div>
      </div>
    `;
  }

  private _renderMobile(activeTool: ToolType) {
    if (this.ctx.state.childMode) {
      return this._renderChildMode(activeTool);
    }

    return html`
      <!-- Undo/Redo at left -->
      <button
        title="Undo"
        ?disabled=${!this.ctx.canUndo}
        @click=${() => this.ctx.undo()}
      >${actionIcons.undo}</button>
      <button
        title="Redo"
        ?disabled=${!this.ctx.canRedo}
        @click=${() => this.ctx.redo()}
      >${actionIcons.redo}</button>

      <div class="separator"></div>

      <!-- Tool groups: show one representative button per group -->
      ${toolGroups.map((group, i) => {
        const activeToolInGroup = group.find(t => t === activeTool);
        const displayTool = activeToolInGroup ?? group[0];
        const isActiveGroup = group.includes(activeTool);

        return html`
          <button
            class=${isActiveGroup ? 'active' : ''}
            title=${toolLabels[displayTool]}
            @click=${() => this._onMobileToolTap(group, i)}
          >${toolIcons[displayTool]}</button>
        `;
      })}

      <div class="separator"></div>

      <!-- Layers button -->
      <button
        title="Layers"
        @click=${() => { this._closePopover(); this.ctx.toggleLayersPanel(); }}
      >${html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`}</button>

      <!-- More actions -->
      <button
        title="More"
        @click=${() => this._onMobileMoreTap()}
      ><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>

      <!-- Popover -->
      ${this._popoverGroup !== null ? html`
        <div class="popover-backdrop" @click=${() => this._closePopover()}></div>
        <div class="popover">
          ${this._renderPopoverContent(activeTool)}
        </div>
      ` : ''}
    `;
  }

  private _onMobileToolTap(group: ToolType[], groupIndex: number) {
    const { activeTool } = this.ctx.state;
    const isActiveGroup = group.includes(activeTool);

    if (isActiveGroup) {
      const newGroup = this._popoverGroup === groupIndex ? null : groupIndex;
      this._popoverGroup = newGroup;
      // Close layers sheet when opening a popover (mutual exclusion)
      if (newGroup !== null && this.ctx.state.layersPanelOpen) {
        this.ctx.toggleLayersPanel();
      }
    } else {
      this.ctx.setTool(this._lastToolPerGroup.get(groupIndex) ?? group[0]);
      this._popoverGroup = null;
    }
  }

  private _onMobileMoreTap() {
    const newGroup = this._popoverGroup === -1 ? null : -1;
    this._popoverGroup = newGroup;
    if (newGroup !== null && this.ctx.state.layersPanelOpen) {
      this.ctx.toggleLayersPanel();
    }
  }

  private _closePopover() {
    this._popoverGroup = null;
  }

  private _renderPopoverContent(activeTool: ToolType) {
    if (this._popoverGroup === -1) {
      return html`
        <span class="popover-label">Projects</span>
        <div class="project-list">
          ${this.ctx.projectList.map(p => html`
            <button
              class="project-item ${p.id === this.ctx.currentProject?.id ? 'current' : ''}"
              @click=${() => { this.ctx.switchProject(p.id); this._closePopover(); }}
            >
              <span class="check">${p.id === this.ctx.currentProject?.id ? '\u2713' : ''}</span>
              ${p.name}
            </button>
          `)}
        </div>
        <button class="menu-btn" @click=${() => { this.ctx.createProject('Untitled', 800, 600); this._closePopover(); }}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Project
        </button>
        <div class="popover-divider"></div>
        <button class="menu-btn" title="Save" @click=${() => { this.ctx.saveCanvas(); this._closePopover(); }}>${actionIcons.save} Save</button>
        <button class="menu-btn" title="Clear canvas" @click=${() => { this.ctx.clearCanvas(); this._closePopover(); }}>${actionIcons.clear} Clear</button>
        <div class="popover-divider"></div>
        <button class="menu-btn" @click=${this._toggleFullscreen}>
          ${this._isFullscreen
            ? html`<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 2v3H2M14 5h-3V2M11 14v-3h3M2 11h3v3"/></svg>`
            : html`<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>`
          }
          ${this._isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        </button>
        <div class="popover-divider"></div>
        <button class="menu-btn" @click=${() => { this.ctx.setChildMode(true); this._closePopover(); }}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          Child Mode
        </button>
      `;
    }

    const group = toolGroups[this._popoverGroup!];
    if (!group) return html``;

    return html`
      ${group.length > 1 ? html`
        <div class="sub-tools">
          ${group.map(tool => html`
            <button
              class=${activeTool === tool ? 'active' : ''}
              title=${toolLabels[tool]}
              @click=${() => { this.ctx.setTool(tool); this._lastToolPerGroup.set(this._popoverGroup!, tool); }}
            >${toolIcons[tool]}</button>
          `)}
        </div>
      ` : ''}
      <tool-settings></tool-settings>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-toolbar': AppToolbar;
  }
}

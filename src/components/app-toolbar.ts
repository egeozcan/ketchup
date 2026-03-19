import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { ToolType } from '../types.js';
import { toolIcons, toolLabels, toolShortcuts, actionIcons } from './tool-icons.js';
import './tool-settings.js';

const toolGroups: ToolType[][] = [
  ['select', 'move', 'crop', 'hand'],
  ['pencil', 'marker', 'eraser'],
  ['line', 'rectangle', 'circle', 'triangle'],
  ['fill', 'stamp', 'text'],
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
  `;

  @state() private _popoverGroup: number | null = null;
  private _lastToolPerGroup = new Map<number, ToolType>();

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  override willUpdate() {
    this.toggleAttribute('mobile', this.ctx?.isMobile ?? false);
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

  private _renderMobile(activeTool: ToolType) {
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
        <button title="Save" @click=${() => { this.ctx.saveCanvas(); this._closePopover(); }}>${actionIcons.save} Save</button>
        <button title="Clear canvas" @click=${() => { this.ctx.clearCanvas(); this._closePopover(); }}>${actionIcons.clear} Clear</button>
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

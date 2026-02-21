import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import type { ToolType } from '../types.js';
import { toolIcons, toolLabels, actionIcons } from './tool-icons.js';

const toolGroups: ToolType[][] = [
  ['select', 'move', 'hand'],
  ['pencil', 'marker', 'eraser'],
  ['line', 'rectangle', 'circle', 'triangle'],
  ['fill', 'stamp'],
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
      width: 52px;
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
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #bbb;
      cursor: pointer;
      padding: 6px;
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
  `;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  private _selectTool(tool: ToolType) {
    this.ctx.setTool(tool);
  }

  override render() {
    if (!this._ctx.value) return html``;
    const { activeTool } = this.ctx.state;

    return html`
      ${toolGroups.map(
        (group, i) => html`
          ${i > 0 ? html`<div class="separator"></div>` : ''}
          <div class="group">
            ${group.map(
              (tool) => html`
                <button
                  class=${activeTool === tool ? 'active' : ''}
                  title=${toolLabels[tool]}
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
}

declare global {
  interface HTMLElementTagNameMap {
    'app-toolbar': AppToolbar;
  }
}

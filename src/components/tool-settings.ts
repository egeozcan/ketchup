import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import { getRecentStamps, addStamp, deleteStamp, type StampEntry } from '../stamp-store.js';

const presetColors = [
  '#000000', '#ffffff', '#ff0000', '#ff6600', '#ffcc00',
  '#33cc33', '#0099ff', '#6633ff', '#cc33cc', '#996633',
  '#ff9999', '#ffcc99', '#ffff99', '#99ff99', '#99ccff',
  '#cc99ff', '#cccccc', '#666666',
];

@customElement('tool-settings')
export class ToolSettings extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      background: #333;
      padding: 6px 16px;
      gap: 16px;
      color: #ddd;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      flex-wrap: wrap;
      min-height: 44px;
    }

    .section {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    label {
      color: #aaa;
      white-space: nowrap;
    }

    .color-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      max-width: 200px;
    }

    .color-swatch {
      width: 18px;
      height: 18px;
      border-radius: 3px;
      border: 2px solid transparent;
      cursor: pointer;
      padding: 0;
      box-sizing: border-box;
    }

    .color-swatch:hover {
      border-color: #888;
    }

    .color-swatch.active {
      border-color: #5b8cf7;
    }

    input[type="color"] {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 4px;
      padding: 0;
      cursor: pointer;
      background: none;
    }

    input[type="range"] {
      width: 100px;
      accent-color: #5b8cf7;
    }

    .size-value {
      min-width: 24px;
      text-align: center;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      color: #aaa;
    }

    .checkbox-label input {
      accent-color: #5b8cf7;
    }

    .stamp-btn {
      background: #5b8cf7;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
    }

    .stamp-btn:hover {
      background: #4a7be6;
    }

    .stamp-preview {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      border: 1px solid #555;
      object-fit: contain;
      background: #222;
    }

    .separator {
      width: 1px;
      height: 24px;
      background: #555;
    }

    .stamp-row {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      max-width: 400px;
      padding: 2px 0;
      align-items: center;
    }

    .stamp-thumb-wrap {
      position: relative;
      flex-shrink: 0;
    }

    .stamp-thumb {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      border: 2px solid transparent;
      object-fit: contain;
      background: #222;
      cursor: pointer;
      display: block;
    }

    .stamp-thumb:hover {
      border-color: #888;
    }

    .stamp-thumb.active {
      border-color: #5b8cf7;
    }

    .stamp-delete {
      display: none;
      position: absolute;
      top: -4px;
      right: -4px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #555;
      color: #ddd;
      border: none;
      font-size: 9px;
      line-height: 14px;
      text-align: center;
      cursor: pointer;
      padding: 0;
    }

    .stamp-thumb-wrap:hover .stamp-delete {
      display: block;
    }

    .stamp-delete:hover {
      background: #e55;
    }
  `;

  @state() private _recentStamps: StampEntry[] = [];
  @state() private _activeStampId: string | null = null;
  private _thumbUrls = new Map<string, string>();

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._loadStamps();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const url of this._thumbUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._thumbUrls.clear();
  }

  private async _loadStamps() {
    this._recentStamps = await getRecentStamps();
    // Revoke old URLs
    for (const [id, url] of this._thumbUrls) {
      if (!this._recentStamps.some((s) => s.id === id)) {
        URL.revokeObjectURL(url);
        this._thumbUrls.delete(id);
      }
    }
    // Create new URLs
    for (const s of this._recentStamps) {
      if (!this._thumbUrls.has(s.id)) {
        this._thumbUrls.set(s.id, URL.createObjectURL(s.blob));
      }
    }
  }

  private _onStrokeColor(e: Event) {
    this.ctx.setStrokeColor((e.target as HTMLInputElement).value);
  }

  private _onFillColor(e: Event) {
    this.ctx.setFillColor((e.target as HTMLInputElement).value);
  }

  private _onBrushSize(e: Event) {
    this.ctx.setBrushSize(Number((e.target as HTMLInputElement).value));
  }

  private _onUseFill(e: Event) {
    this.ctx.setUseFill((e.target as HTMLInputElement).checked);
  }

  private _uploadStamp() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const entry = await addStamp(file);
      await this._loadStamps();
      const url = this._thumbUrls.get(entry.id);
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        this.ctx.setStampImage(img);
        this._activeStampId = entry.id;
      };
      img.src = url;
    };
    input.click();
  }

  private _selectStamp(entry: StampEntry) {
    const url = this._thumbUrls.get(entry.id);
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      this.ctx.setStampImage(img);
      this._activeStampId = entry.id;
    };
    img.src = url;
  }

  private async _deleteStamp(entry: StampEntry, e: Event) {
    e.stopPropagation();
    await deleteStamp(entry.id);
    if (this._activeStampId === entry.id) {
      this._activeStampId = null;
      this.ctx.setStampImage(null);
    }
    await this._loadStamps();
  }

  private _showsShapeOptions(): boolean {
    const t = this.ctx.state.activeTool;
    return t === 'rectangle' || t === 'circle' || t === 'triangle';
  }

  override render() {
    if (!this._ctx.value) return html``;
    const { strokeColor, fillColor, useFill, brushSize, activeTool, stampImage } = this.ctx.state;

    return html`
      <div class="section">
        <label>Color</label>
        <input
          type="color"
          .value=${strokeColor}
          @input=${this._onStrokeColor}
          title="Stroke color"
        />
        <div class="color-grid">
          ${presetColors.map(
            (c) => html`
              <button
                class="color-swatch ${strokeColor === c ? 'active' : ''}"
                style="background:${c}"
                title=${c}
                @click=${() => this.ctx.setStrokeColor(c)}
              ></button>
            `,
          )}
        </div>
      </div>

      <div class="separator"></div>

      <div class="section">
        <label>Size</label>
        <input
          type="range"
          min="1"
          max="50"
          .value=${String(brushSize)}
          @input=${this._onBrushSize}
        />
        <span class="size-value">${brushSize}</span>
      </div>

      ${this._showsShapeOptions()
        ? html`
            <div class="separator"></div>
            <div class="section">
              <label class="checkbox-label">
                <input type="checkbox" .checked=${useFill} @change=${this._onUseFill} />
                Fill
              </label>
              ${useFill
                ? html`
                    <input
                      type="color"
                      .value=${fillColor}
                      @input=${this._onFillColor}
                      title="Fill color"
                    />
                  `
                : ''}
            </div>
          `
        : ''}

      ${activeTool === 'stamp'
        ? html`
            <div class="separator"></div>
            <div class="section">
              ${this._recentStamps.length > 0
                ? html`
                    <div class="stamp-row">
                      ${this._recentStamps.map(
                        (s) => html`
                          <div class="stamp-thumb-wrap">
                            <img
                              class="stamp-thumb ${this._activeStampId === s.id ? 'active' : ''}"
                              src=${this._thumbUrls.get(s.id) ?? ''}
                              alt="stamp"
                              @click=${() => this._selectStamp(s)}
                            />
                            <button
                              class="stamp-delete"
                              @click=${(e: Event) => this._deleteStamp(s, e)}
                              title="Remove stamp"
                            >&times;</button>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : ''}
              <button class="stamp-btn" @click=${this._uploadStamp}>Upload Image</button>
              ${stampImage
                ? html`<img class="stamp-preview" .src=${stampImage.src} alt="stamp" />`
                : ''}
            </div>
          `
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-settings': ToolSettings;
  }
}

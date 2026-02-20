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
      padding: 0.375rem 1rem;
      gap: 1rem;
      color: #ddd;
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
      flex-wrap: wrap;
      min-height: 2.75rem;
    }

    .section {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    label {
      color: #aaa;
      white-space: nowrap;
    }

    .color-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.1875rem;
      max-width: 12.5rem;
    }

    .color-swatch {
      width: 1.125rem;
      height: 1.125rem;
      border-radius: 0.1875rem;
      border: 0.125rem solid transparent;
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
      width: 1.75rem;
      height: 1.75rem;
      border: none;
      border-radius: 0.25rem;
      padding: 0;
      cursor: pointer;
      background: none;
    }

    input[type="range"] {
      width: 6.25rem;
      accent-color: #5b8cf7;
    }

    .size-value {
      min-width: 1.5rem;
      text-align: center;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 0.25rem;
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
      border-radius: 0.25rem;
      padding: 0.25rem 0.625rem;
      cursor: pointer;
      font-size: 0.75rem;
    }

    .stamp-btn:hover {
      background: #4a7be6;
    }

    .stamp-preview {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.25rem;
      border: 0.0625rem solid #555;
      object-fit: contain;
      background: #222;
    }

    .separator {
      width: 0.0625rem;
      height: 1.5rem;
      background: #555;
    }

    .stamp-row {
      display: flex;
      gap: 0.25rem;
      overflow-x: auto;
      overflow-y: hidden;
      max-width: 25rem;
      padding: 0.125rem 0;
      align-items: center;
      scrollbar-width: none;
    }

    .stamp-row::-webkit-scrollbar {
      display: none;
    }

    .stamp-thumb-wrap {
      position: relative;
      flex-shrink: 0;
      overflow: hidden;
      border-radius: 0.25rem;
    }

    .stamp-thumb {
      width: 2.75rem;
      height: 2.75rem;
      border-radius: 0.25rem;
      border: 0.125rem solid transparent;
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
      top: 0.0625rem;
      right: 0.0625rem;
      width: 0.875rem;
      height: 0.875rem;
      border-radius: 50%;
      background: #555;
      color: #ddd;
      border: none;
      font-size: 0.5625rem;
      line-height: 0.875rem;
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

    .project-section {
      position: relative;
    }

    .project-dropdown-wrap {
      position: relative;
    }

    .project-name-btn {
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 0.25rem;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
      font-size: 0.8125rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      max-width: 12rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .project-name-btn:hover {
      background: #555;
    }

    .dropdown-arrow {
      font-size: 0.625rem;
      opacity: 0.7;
    }

    .project-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 0.25rem;
      background: #3a3a3a;
      border: 1px solid #555;
      border-radius: 0.375rem;
      min-width: 14rem;
      max-height: 20rem;
      overflow-y: auto;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      padding: 0.25rem 0;
    }

    .project-item {
      display: flex;
      align-items: center;
      padding: 0.375rem 0.5rem;
      gap: 0.25rem;
    }

    .project-item.active {
      background: #4a4a4a;
    }

    .project-item-name {
      flex: 1;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0.125rem 0;
    }

    .project-item-name:hover {
      color: #fff;
    }

    .project-item-action {
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      padding: 0.125rem 0.25rem;
      font-size: 0.75rem;
      border-radius: 0.125rem;
      line-height: 1;
      width: auto;
      height: auto;
    }

    .project-item-action:hover {
      color: #ddd;
      background: #555;
    }

    .project-item-action.delete:hover {
      color: #ff6666;
    }

    .project-rename-input {
      flex: 1;
      background: #2a2a2a;
      border: 1px solid #5b8cf7;
      border-radius: 0.1875rem;
      color: #ddd;
      padding: 0.125rem 0.25rem;
      font-size: 0.8125rem;
      outline: none;
    }

    .project-dropdown-divider {
      height: 1px;
      background: #555;
      margin: 0.25rem 0;
    }

    .project-new-btn {
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      color: #5b8cf7;
      cursor: pointer;
      padding: 0.375rem 0.5rem;
      font-size: 0.8125rem;
      height: auto;
      border-radius: 0;
    }

    .project-new-btn:hover {
      background: #4a4a4a;
      color: #7aa8ff;
    }

    .saving-indicator {
      color: #888;
      font-size: 0.75rem;
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
  `;

  @state() private _recentStamps: StampEntry[] = [];
  @state() private _activeStampId: string | null = null;
  @state() private _projectDropdownOpen = false;
  @state() private _renamingProjectId: string | null = null;
  private _thumbUrls = new Map<string, string>();
  private _lastProjectId: string | null = null;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Stamps loaded on first willUpdate when projectId is available
  }

  override willUpdate() {
    const projectId = this._ctx.value?.currentProject?.id ?? null;
    if (projectId && projectId !== this._lastProjectId) {
      this._lastProjectId = projectId;
      this._activeStampId = null;
      // Revoke stale thumb URLs from previous project
      for (const url of this._thumbUrls.values()) {
        URL.revokeObjectURL(url);
      }
      this._thumbUrls.clear();
      this._loadStamps(projectId);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._closeDropdown();
    for (const url of this._thumbUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._thumbUrls.clear();
  }

  private async _loadStamps(projectId: string) {
    const stamps = await getRecentStamps(projectId);
    // Guard against race: project may have changed while awaiting
    if (this._lastProjectId !== projectId) return;
    this._recentStamps = stamps;
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
    const projectId = this._ctx.value?.currentProject?.id;
    if (!projectId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      // Re-read projectId at resolution time in case user switched projects
      const currentProjectId = this._ctx.value?.currentProject?.id;
      if (!currentProjectId) return;
      const entry = await addStamp(currentProjectId, file);
      await this._loadStamps(currentProjectId);
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
    const projectId = this._ctx.value?.currentProject?.id;
    if (!projectId) return;
    await deleteStamp(entry.id);
    if (this._activeStampId === entry.id) {
      this._activeStampId = null;
      this.ctx.setStampImage(null);
    }
    await this._loadStamps(projectId);
  }

  private _closeDropdown() {
    if (this._projectDropdownOpen) {
      this._projectDropdownOpen = false;
      document.removeEventListener('click', this._onDocumentClick);
    }
  }

  private _toggleProjectDropdown() {
    if (this._projectDropdownOpen) {
      this._closeDropdown();
    } else {
      this._projectDropdownOpen = true;
      document.addEventListener('click', this._onDocumentClick);
    }
  }

  private _onSelectProject(id: string) {
    this._closeDropdown();
    this.ctx.switchProject(id);
  }

  private _onNewProject() {
    this._closeDropdown();
    this.ctx.createProject('Untitled');
  }

  private _onDeleteProject(e: Event, id: string) {
    e.stopPropagation();
    if (confirm('Delete this project? This cannot be undone.')) {
      this._closeDropdown();
      this.ctx.deleteProject(id);
    }
  }

  private _startRename(e: Event, id: string) {
    e.stopPropagation();
    this._renamingProjectId = id;
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector('.project-rename-input') as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private _onRenameKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter') {
      this._commitRename(e, id);
    } else if (e.key === 'Escape') {
      this._renamingProjectId = null;
    }
  }

  private _commitRename(e: Event, id: string) {
    const input = e.target as HTMLInputElement;
    const name = input.value.trim();
    if (name) {
      this.ctx.renameProject(id, name);
    }
    this._renamingProjectId = null;
  }

  private _onDocumentClick = (e: MouseEvent) => {
    if (this._projectDropdownOpen) {
      const path = e.composedPath();
      const dropdown = this.shadowRoot?.querySelector('.project-dropdown-wrap');
      if (dropdown && !path.includes(dropdown)) {
        this._closeDropdown();
      }
    }
  };

  private _showsShapeOptions(): boolean {
    const t = this.ctx.state.activeTool;
    return t === 'rectangle' || t === 'circle' || t === 'triangle';
  }

  override render() {
    if (!this._ctx.value) return html``;
    const { strokeColor, fillColor, useFill, brushSize, activeTool, stampImage } = this.ctx.state;

    return html`
      <div class="section project-section">
        <div class="project-dropdown-wrap">
          <button class="project-name-btn" @click=${this._toggleProjectDropdown}>
            ${this.ctx.currentProject?.name ?? 'Untitled'}
            <span class="dropdown-arrow">&#9662;</span>
          </button>
          ${this._projectDropdownOpen ? html`
            <div class="project-dropdown">
              ${this.ctx.projectList.map(p => html`
                <div class="project-item ${p.id === this.ctx.currentProject?.id ? 'active' : ''}">
                  ${this._renamingProjectId === p.id ? html`
                    <input
                      class="project-rename-input"
                      .value=${p.name}
                      @keydown=${(e: KeyboardEvent) => this._onRenameKeydown(e, p.id)}
                      @blur=${(e: FocusEvent) => this._commitRename(e, p.id)}
                    />
                  ` : html`
                    <span class="project-item-name" @click=${() => this._onSelectProject(p.id)}>
                      ${p.name}
                    </span>
                    <button class="project-item-action" title="Rename" @click=${(e: Event) => this._startRename(e, p.id)}>&#9998;</button>
                    <button class="project-item-action delete" title="Delete" @click=${(e: Event) => this._onDeleteProject(e, p.id)}>&#10005;</button>
                  `}
                </div>
              `)}
              <div class="project-dropdown-divider"></div>
              <button class="project-new-btn" @click=${this._onNewProject}>+ New Project</button>
            </div>
          ` : ''}
        </div>
        ${this.ctx.saving ? html`<span class="saving-indicator">Saving...</span>` : ''}
      </div>
      <div class="separator"></div>

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
          max="150"
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

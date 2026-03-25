import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ContextConsumer } from '@lit/context';
import { drawingContext, type DrawingContextValue } from '../contexts/drawing-context.js';
import { storageBackendContext, projectServiceContext } from '../storage/storage-context.js';
import type { StampEntry } from '../storage/types.js';
import type { PressureCurveName, TipShape, OrientationMode } from '../engine/types.js';
import { BRUSH_PRESETS } from '../engine/brush-presets.js';

const documentPresets = [
  { label: '800 \u00d7 600', width: 800, height: 600 },
  { label: '1024 \u00d7 768', width: 1024, height: 768 },
  { label: '1280 \u00d7 720 (HD)', width: 1280, height: 720 },
  { label: '1920 \u00d7 1080 (Full HD)', width: 1920, height: 1080 },
  { label: '2560 \u00d7 1440 (QHD)', width: 2560, height: 1440 },
  { label: 'A4 Portrait (794 \u00d7 1123)', width: 794, height: 1123 },
  { label: 'A4 Landscape (1123 \u00d7 794)', width: 1123, height: 794 },
  { label: 'Square 1024', width: 1024, height: 1024 },
];

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
      column-gap: 1rem;
      row-gap: 0.25rem;
      color: #ddd;
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
      flex-wrap: wrap;
      min-height: 2.75rem;
      position: relative;
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
      max-width: 15rem;
    }

    .color-swatch {
      width: 1.5rem;
      height: 1.5rem;
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
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      background: #5b8cf7;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      padding: 6px;
      flex-shrink: 0;
    }

    .stamp-btn svg {
      width: 15px;
      height: 15px;
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

    .stamp-line {
      flex-basis: 100%;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-left: -0.5rem;
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
      position: absolute;
      top: 0.75rem;
      right: 1rem;
      color: #888;
      width: 1.25rem;
      height: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .saving-indicator svg {
      width: 100%;
      height: 100%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      100% { transform: rotate(360deg); }
    }

    dialog {
      background: #3a3a3a;
      border: 1px solid #555;
      border-radius: 0.5rem;
      color: #ddd;
      padding: 1.25rem;
      min-width: 18rem;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      font-family: system-ui, sans-serif;
      font-size: 0.8125rem;
    }

    dialog::backdrop {
      background: rgba(0,0,0,0.5);
    }

    .dialog-title {
      font-size: 1rem;
      font-weight: 600;
      margin: 0 0 1rem 0;
    }

    .dialog-field {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin-bottom: 0.75rem;
    }

    .dialog-field label {
      color: #aaa;
      font-size: 0.75rem;
    }

    .dialog-field input[type="text"] {
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 0.25rem;
      color: #ddd;
      padding: 0.375rem 0.5rem;
      font-size: 0.8125rem;
      outline: none;
    }

    .dialog-field input[type="text"]:focus {
      border-color: #5b8cf7;
    }

    .dialog-presets {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin-bottom: 0.5rem;
    }

    .dialog-preset-btn {
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 0.25rem;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
      font-size: 0.75rem;
      height: auto;
    }

    .dialog-preset-btn:hover {
      background: #555;
    }

    .dialog-preset-btn.active {
      border-color: #5b8cf7;
      color: #5b8cf7;
    }

    .dialog-size-row {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .dialog-size-input {
      width: 5rem;
      background: #2a2a2a;
      border: 1px solid #555;
      border-radius: 0.25rem;
      color: #ddd;
      padding: 0.375rem 0.5rem;
      font-size: 0.8125rem;
      text-align: center;
      outline: none;
    }

    .dialog-size-input:focus {
      border-color: #5b8cf7;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .dialog-cancel-btn {
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 0.25rem;
      padding: 0.375rem 0.75rem;
      cursor: pointer;
      font-size: 0.8125rem;
    }

    .dialog-cancel-btn:hover {
      background: #555;
    }

    .dialog-create-btn {
      background: #5b8cf7;
      color: white;
      border: none;
      border-radius: 0.25rem;
      padding: 0.375rem 0.75rem;
      cursor: pointer;
      font-size: 0.8125rem;
    }

    .dialog-create-btn:hover {
      background: #4a7be6;
    }

    .font-select {
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 0.25rem;
      padding: 0.25rem 0.375rem;
      font-size: 0.8125rem;
      cursor: pointer;
    }

    .font-size-input {
      width: 3.5rem;
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 0.25rem;
      padding: 0.25rem 0.375rem;
      font-size: 0.8125rem;
      text-align: center;
    }

    .font-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.75rem;
      height: 1.75rem;
      background: #444;
      color: #ddd;
      border: 1px solid #555;
      border-radius: 0.25rem;
      cursor: pointer;
      font-size: 0.8125rem;
      padding: 0;
    }

    .font-toggle.active {
      background: #5b8cf7;
      color: #fff;
      border-color: #5b8cf7;
    }

    /* Preset gallery */
    .preset-grid {
      display: grid;
      grid-template-columns: repeat(5, 42px);
      gap: 0.25rem;
    }

    .preset-thumb-btn {
      width: 42px;
      height: 42px;
      padding: 0;
      border: 2px solid transparent;
      border-radius: 0.25rem;
      background: #222;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .preset-thumb-btn:hover {
      border-color: #888;
    }

    .preset-thumb-btn.active {
      border-color: #5b8cf7;
    }

    .preset-thumb-btn svg {
      width: 32px;
      height: 32px;
    }

    /* Pill-button shape selector */
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }

    .pill-btn {
      background: #444;
      color: #bbb;
      border: 1px solid #555;
      border-radius: 1rem;
      padding: 0.15rem 0.5rem;
      cursor: pointer;
      font-size: 0.75rem;
      white-space: nowrap;
      height: auto;
    }

    .pill-btn:hover {
      background: #555;
      color: #ddd;
    }

    .pill-btn.active {
      background: #5b8cf7;
      color: #fff;
      border-color: #5b8cf7;
    }

    /* Dimmed control */
    .dimmed {
      opacity: 0.4;
      pointer-events: none;
    }

    /* ── Inside mobile popover ─────────────────── */
    :host([mobile]) {
      flex-direction: column;
      align-items: flex-start;
      padding: 0;
      min-height: 0;
      background: transparent;
      touch-action: manipulation;
    }

    :host([mobile]) .section {
      width: 100%;
    }

    :host([mobile]) .separator {
      display: none;
    }

    :host([mobile]) input[type="range"] {
      width: 100%;
    }
  `;

  @state() private _recentStamps: StampEntry[] = [];
  @state() private _activeStampId: string | null = null;
  @state() private _projectDropdownOpen = false;
  @state() private _advancedOpen = false;
  @state() private _renamingProjectId: string | null = null;
  @state() private _newProjectName = 'Untitled';
  @state() private _newProjectWidth = '800';
  @state() private _newProjectHeight = '600';
  private _thumbUrls = new Map<string, string>();
  private _lastProjectId: string | null = null;

  private _ctx = new ContextConsumer(this, {
    context: drawingContext,
    subscribe: true,
  });

  private _storageCtx = new ContextConsumer(this, { context: storageBackendContext, subscribe: true });
  private _serviceCtx = new ContextConsumer(this, { context: projectServiceContext, subscribe: true });

  private get ctx(): DrawingContextValue {
    return this._ctx.value!;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Stamps loaded on first willUpdate when projectId is available
  }

  override willUpdate() {
    this.toggleAttribute('mobile', this._ctx.value?.isMobile ?? false);
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
    const backend = this._storageCtx.value;
    if (!backend) return;
    const stamps = await backend.stamps.list(projectId);
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
    // Create new URLs (fetch blobs in parallel)
    await Promise.all(stamps.map(async (s) => {
      if (!this._thumbUrls.has(s.id)) {
        const blob = await backend.blobs.get(s.blobRef);
        this._thumbUrls.set(s.id, URL.createObjectURL(blob));
      }
    }));
    // _thumbUrls is a plain Map — mutating it doesn't schedule a Lit update.
    // Re-assign _recentStamps to trigger a rerender so <img src> bindings pick
    // up the newly populated URLs.
    if (this._lastProjectId === projectId) {
      this._recentStamps = [...this._recentStamps];
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
    input.multiple = true;
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      // Re-read projectId at resolution time in case user switched projects
      const currentProjectId = this._ctx.value?.currentProject?.id;
      if (!currentProjectId) return;
      const service = this._serviceCtx.value;
      if (!service) return;
      const MAX_STAMP_SIZE = 10 * 1024 * 1024; // 10MB
      const MAX_STAMP_DIMENSION = 4096;
      let lastEntry: StampEntry | null = null;
      for (const file of files) {
        if (file.size > MAX_STAMP_SIZE) {
          console.warn('Stamp file too large, skipping:', file.name);
          continue;
        }
        try {
          const bitmap = await createImageBitmap(file);
          if (bitmap.width > MAX_STAMP_DIMENSION || bitmap.height > MAX_STAMP_DIMENSION) {
            bitmap.close();
            console.warn('Stamp dimensions too large, skipping:', file.name);
            continue;
          }
          bitmap.close();
        } catch {
          console.warn('Invalid image file, skipping:', file.name);
          continue;
        }
        lastEntry = await service.addStamp(currentProjectId, file);
      }
      await this._loadStamps(currentProjectId);
      if (!lastEntry) return;
      const url = this._thumbUrls.get(lastEntry.id);
      if (!url) return;
      const capturedProjectId = this._lastProjectId;
      const img = new Image();
      img.onload = () => {
        if (this._lastProjectId !== capturedProjectId) return;
        this.ctx.setStampImage(img);
        this._activeStampId = lastEntry!.id;
      };
      img.src = url;
    };
    input.click();
  }

  private _selectStamp(entry: StampEntry) {
    const url = this._thumbUrls.get(entry.id);
    if (!url) return;
    const capturedProjectId = this._lastProjectId;
    const img = new Image();
    img.onload = () => {
      if (this._lastProjectId !== capturedProjectId) return;
      this.ctx.setStampImage(img);
      this._activeStampId = entry.id;
    };
    img.src = url;
  }

  private async _deleteStamp(entry: StampEntry, e: Event) {
    e.stopPropagation();
    const projectId = this._ctx.value?.currentProject?.id;
    if (!projectId) return;
    const backend = this._storageCtx.value;
    if (!backend) return;
    await backend.stamps.delete(entry.id);
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
    this._newProjectName = 'Untitled';
    this._newProjectWidth = '800';
    this._newProjectHeight = '600';
    const dialog = this.shadowRoot?.querySelector('.new-project-dialog') as HTMLDialogElement | null;
    dialog?.showModal();
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector('.new-project-name-input') as HTMLInputElement | null;
      if (input) { input.focus(); input.select(); }
    });
  }

  private _cancelNewProject() {
    const dialog = this.shadowRoot?.querySelector('.new-project-dialog') as HTMLDialogElement | null;
    dialog?.close();
  }

  private _confirmNewProject() {
    const name = this._newProjectName.trim() || 'Untitled';
    const w = parseInt(this._newProjectWidth);
    const h = parseInt(this._newProjectHeight);
    if (!w || !h || w <= 0 || h <= 0 || w > 8192 || h > 8192) return;
    const dialog = this.shadowRoot?.querySelector('.new-project-dialog') as HTMLDialogElement | null;
    dialog?.close();
    this.ctx.createProject(name, w, h);
  }

  private _selectNewProjectPreset(preset: { width: number; height: number }) {
    this._newProjectWidth = String(preset.width);
    this._newProjectHeight = String(preset.height);
  }

  private _onNewProjectKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      this._confirmNewProject();
    }
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
    e.stopPropagation();
    if (e.key === 'Enter') {
      this._commitRename(e, id);
    } else if (e.key === 'Escape') {
      this._renamingProjectId = null;
    }
  }

  private _commitRename(e: Event, id: string) {
    if (this._renamingProjectId !== id) return;
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

  private _presetSvg(presetId: string) {
    // Return an inline SVG icon representing each brush preset's tip shape
    switch (presetId) {
      case 'round':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="10" fill="#ccc"/>
        </svg>`;
      case 'soft-round':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs><radialGradient id="sg"><stop offset="0%" stop-color="#ddd"/><stop offset="100%" stop-color="#555"/></radialGradient></defs>
          <circle cx="16" cy="16" r="12" fill="url(#sg)"/>
        </svg>`;
      case 'flat':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="6" y="11" width="20" height="10" rx="2" fill="#ccc"/>
        </svg>`;
      case 'chisel':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <polygon points="6,22 26,22 22,10 10,10" fill="#ccc"/>
        </svg>`;
      case 'calligraphy':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="16" cy="16" rx="12" ry="5" transform="rotate(-45 16 16)" fill="#ccc"/>
        </svg>`;
      case 'fan':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="16" y1="24" x2="6" y2="8" stroke="#ccc" stroke-width="1.5"/>
          <line x1="16" y1="24" x2="10" y2="7" stroke="#ccc" stroke-width="1.5"/>
          <line x1="16" y1="24" x2="14" y2="7" stroke="#ccc" stroke-width="1.5"/>
          <line x1="16" y1="24" x2="18" y2="7" stroke="#ccc" stroke-width="1.5"/>
          <line x1="16" y1="24" x2="22" y2="7" stroke="#ccc" stroke-width="1.5"/>
          <line x1="16" y1="24" x2="26" y2="8" stroke="#ccc" stroke-width="1.5"/>
        </svg>`;
      case 'splatter':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="3" fill="#ccc"/>
          <circle cx="8" cy="10" r="1.5" fill="#aaa"/>
          <circle cx="24" cy="10" r="2" fill="#aaa"/>
          <circle cx="10" cy="23" r="2" fill="#aaa"/>
          <circle cx="23" cy="22" r="1.5" fill="#aaa"/>
          <circle cx="7" cy="17" r="1" fill="#888"/>
          <circle cx="25" cy="16" r="1" fill="#888"/>
          <circle cx="16" cy="7" r="1.5" fill="#888"/>
          <circle cx="17" cy="25" r="1" fill="#888"/>
        </svg>`;
      case 'dry-brush':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="8" y1="16" x2="24" y2="16" stroke="#ccc" stroke-width="3" stroke-dasharray="2 2"/>
          <line x1="8" y1="13" x2="24" y2="13" stroke="#999" stroke-width="1.5" stroke-dasharray="3 3"/>
          <line x1="8" y1="19" x2="24" y2="19" stroke="#999" stroke-width="1.5" stroke-dasharray="2 4"/>
        </svg>`;
      case 'wet-brush':
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs><radialGradient id="wg"><stop offset="0%" stop-color="#aaddff"/><stop offset="100%" stop-color="#446688"/></radialGradient></defs>
          <ellipse cx="16" cy="16" rx="11" ry="8" fill="url(#wg)"/>
        </svg>`;
      default:
        return html`<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="8" fill="#888"/>
        </svg>`;
    }
  }

  override render() {
    if (!this._ctx.value) return html``;
    const state = this.ctx.state;
    const { strokeColor, fillColor, useFill, activeTool, stampImage, brush } = state;
    const brushSize = brush.size;

    const isMobile = this.ctx.isMobile;

    return html`
      ${!isMobile ? html`
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
        </div>
        <div class="separator"></div>

        <div class="section" style="color:#888;font-size:0.75rem;">
          ${this.ctx.state.documentWidth} \u00d7 ${this.ctx.state.documentHeight}
        </div>
        <div class="separator"></div>
      ` : ''}

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

      ${(activeTool === 'pencil' || activeTool === 'eraser') ? html`
        <div class="separator"></div>
        <div class="section">
          <div class="preset-grid">
            ${BRUSH_PRESETS.map(preset => html`
              <button
                class="preset-thumb-btn ${state.activePreset === preset.id && !state.isPresetModified ? 'active' : ''}"
                title=${preset.name}
                @click=${() => this.ctx.selectPreset(preset.id)}
              >${this._presetSvg(preset.id)}</button>
            `)}
          </div>
        </div>
        <div class="separator"></div>
        <div class="section">
          <label>Opacity</label>
          <input type="range" min="0" max="100" .value=${String(Math.round(brush.opacity * 100))}
            @input=${(e: Event) => this.ctx.setBrush({ opacity: Number((e.target as HTMLInputElement).value) / 100 })} />
          <span class="size-value">${Math.round(brush.opacity * 100)}%</span>
        </div>
        <div class="section">
          <label>Flow</label>
          <input type="range" min="1" max="100" .value=${String(Math.round(brush.flow * 100))}
            @input=${(e: Event) => this.ctx.setBrush({ flow: Number((e.target as HTMLInputElement).value) / 100 })} />
          <span class="size-value">${Math.round(brush.flow * 100)}%</span>
        </div>
        <div class="section">
          <label>Hardness</label>
          <input type="range" min="0" max="100" .value=${String(Math.round(brush.hardness * 100))}
            @input=${(e: Event) => this.ctx.setBrush({ hardness: Number((e.target as HTMLInputElement).value) / 100 })} />
          <span class="size-value">${Math.round(brush.hardness * 100)}%</span>
        </div>
        <div class="section">
          <label>Spacing</label>
          <input type="range" min="5" max="100" .value=${String(Math.round(brush.spacing * 100))}
            @input=${(e: Event) => this.ctx.setBrush({ spacing: Number((e.target as HTMLInputElement).value) / 100 })} />
          <span class="size-value">${Math.round(brush.spacing * 100)}%</span>
        </div>
        <div class="separator"></div>
        <div class="section">
          <label class="checkbox-label">
            <input type="checkbox" .checked=${brush.pressureSize}
              @change=${(e: Event) => this.ctx.setBrush({ pressureSize: (e.target as HTMLInputElement).checked })} />
            Pressure Size
          </label>
        </div>
        <div class="section">
          <label class="checkbox-label">
            <input type="checkbox" .checked=${brush.pressureOpacity}
              @change=${(e: Event) => this.ctx.setBrush({ pressureOpacity: (e.target as HTMLInputElement).checked })} />
            Pressure Opacity
          </label>
        </div>
        ${(brush.pressureSize || brush.pressureOpacity) ? html`
        <div class="section">
          <label>Curve</label>
          <select class="font-select" .value=${brush.pressureCurve}
            @change=${(e: Event) => this.ctx.setBrush({ pressureCurve: (e.target as HTMLSelectElement).value as PressureCurveName })}>
            <option value="linear">Linear</option>
            <option value="light">Light</option>
            <option value="heavy">Heavy</option>
          </select>
        </div>
        ` : nothing}
        <div class="separator"></div>
        ${this._advancedOpen ? html`
          <div class="section" style="flex-wrap:wrap;gap:0.5rem;">
            <label style="flex-basis:100%;cursor:pointer;" @click=${() => { this._advancedOpen = false; }}>Advanced &#9650;</label>
            <div class="section">
              <label>Tip</label>
              <div class="pill-row">
                ${(['round', 'flat', 'chisel', 'calligraphy', 'fan', 'splatter'] as TipShape[]).map(shape => html`
                  <button
                    class="pill-btn ${brush.tip.shape === shape ? 'active' : ''}"
                    @click=${() => this.ctx.setBrushTip({ shape })}
                  >${shape.charAt(0).toUpperCase() + shape.slice(1)}</button>
                `)}
              </div>
            </div>
            <div class="section ${brush.tip.shape === 'round' ? 'dimmed' : ''}">
              <label>Aspect</label>
              <input type="range" min="1" max="6" step="0.5" .value=${String(brush.tip.aspect)}
                @input=${(e: Event) => this.ctx.setBrushTip({ aspect: Number((e.target as HTMLInputElement).value) })} />
              <span class="size-value">${brush.tip.aspect}</span>
            </div>
            <div class="section">
              <label>${brush.tip.orientation === 'direction' ? 'Offset' : 'Angle'}</label>
              <input type="range" min="0" max="360" .value=${String(brush.tip.angle)}
                @input=${(e: Event) => this.ctx.setBrushTip({ angle: Number((e.target as HTMLInputElement).value) })} />
              <span class="size-value">${brush.tip.angle}&deg;</span>
            </div>
            <div class="section">
              <label>Orient</label>
              <select class="font-select" .value=${brush.tip.orientation}
                @change=${(e: Event) => this.ctx.setBrushTip({ orientation: (e.target as HTMLSelectElement).value as OrientationMode })}>
                <option value="fixed">Fixed</option>
                <option value="direction">Direction</option>
              </select>
            </div>
            ${(brush.tip.shape === 'fan' || brush.tip.shape === 'splatter') ? html`
              <div class="section">
                <label>Bristles</label>
                <input type="range" min="1" max="20" .value=${String(brush.tip.bristles ?? 8)}
                  @input=${(e: Event) => this.ctx.setBrushTip({ bristles: Number((e.target as HTMLInputElement).value) })} />
                <span class="size-value">${brush.tip.bristles ?? 8}</span>
              </div>
              <div class="section">
                <label>Spread</label>
                <input type="range" min="0" max="200" .value=${String(Math.round((brush.tip.spread ?? 1) * (brush.tip.shape === 'fan' ? 1 : 100)))}
                  @input=${(e: Event) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    this.ctx.setBrushTip({ spread: brush.tip.shape === 'fan' ? v : v / 100 });
                  }} />
                <span class="size-value">${brush.tip.shape === 'fan' ? (brush.tip.spread ?? 120) : Math.round((brush.tip.spread ?? 0.8) * 100) + '%'}</span>
              </div>
            ` : nothing}
            <div class="section">
              <label>Depletion</label>
              <input type="range" min="0" max="100" .value=${String(Math.round(brush.ink.depletion * 100))}
                @input=${(e: Event) => this.ctx.setBrushInk({ depletion: Number((e.target as HTMLInputElement).value) / 100 })} />
              <span class="size-value">${Math.round(brush.ink.depletion * 100)}%</span>
            </div>
            ${brush.ink.depletion > 0 ? html`
              <div class="section">
                <label>Depl. Len</label>
                <input type="range" min="100" max="2000" .value=${String(brush.ink.depletionLength)}
                  @input=${(e: Event) => this.ctx.setBrushInk({ depletionLength: Number((e.target as HTMLInputElement).value) })} />
                <span class="size-value">${brush.ink.depletionLength}px</span>
              </div>
            ` : nothing}
            <div class="section">
              <label>Buildup</label>
              <input type="range" min="0" max="100" .value=${String(Math.round(brush.ink.buildup * 100))}
                @input=${(e: Event) => this.ctx.setBrushInk({ buildup: Number((e.target as HTMLInputElement).value) / 100 })} />
              <span class="size-value">${Math.round(brush.ink.buildup * 100)}%</span>
            </div>
            <div class="section">
              <label>Wetness</label>
              <input type="range" min="0" max="100" .value=${String(Math.round(brush.ink.wetness * 100))}
                @input=${(e: Event) => this.ctx.setBrushInk({ wetness: Number((e.target as HTMLInputElement).value) / 100 })} />
              <span class="size-value">${Math.round(brush.ink.wetness * 100)}%</span>
            </div>
          </div>
        ` : html`
          <div class="section">
            <label style="cursor:pointer;" @click=${() => { this._advancedOpen = true; }}>Advanced &#9660;</label>
          </div>
        `}
      ` : nothing}

      ${activeTool === 'eyedropper' ? html`
        <div class="section">
          <label class="checkbox-label">
            <input type="checkbox" .checked=${state.eyedropperSampleAll}
              @change=${(e: Event) => this.ctx.setEyedropperSampleAll((e.target as HTMLInputElement).checked)} />
            Sample all layers
          </label>
        </div>
      ` : nothing}

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

      ${activeTool === 'crop'
        ? html`
            <div class="separator"></div>
            <div class="section">
              <label>Ratio</label>
              <select
                .value=${this.ctx.state.cropAspectRatio}
                @change=${(e: Event) => this.ctx.setCropAspectRatio((e.target as HTMLSelectElement).value)}
                style="background:#444;color:#ddd;border:1px solid #555;border-radius:0.25rem;padding:0.25rem 0.375rem;font-size:0.8125rem;cursor:pointer;"
              >
                <option value="free">Free</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="3:2">3:2</option>
                <option value="16:9">16:9</option>
                <option value="3:4">3:4</option>
                <option value="2:3">2:3</option>
                <option value="9:16">9:16</option>
              </select>
            </div>
          `
        : ''}

      ${activeTool === 'text'
        ? html`
            <div class="separator"></div>
            <div class="section">
              <label>Font</label>
              <select
                class="font-select"
                .value=${this.ctx.state.fontFamily}
                @change=${(e: Event) => this.ctx.setFontFamily((e.target as HTMLSelectElement).value)}
              >
                <option value="sans-serif">Sans-serif</option>
                <option value="serif">Serif</option>
                <option value="monospace">Monospace</option>
                <option value="Arial">Arial</option>
                <option value="Georgia">Georgia</option>
                <option value="Courier New">Courier New</option>
                <option value="Verdana">Verdana</option>
                <option value="Times New Roman">Times New Roman</option>
              </select>
            </div>
            <div class="section">
              <label>Size</label>
              <input
                class="font-size-input"
                type="number"
                min="8"
                max="200"
                .value=${String(this.ctx.state.fontSize)}
                @change=${(e: Event) => this.ctx.setFontSize(Number((e.target as HTMLInputElement).value))}
              />
            </div>
            <div class="section">
              <button
                class="font-toggle ${this.ctx.state.fontBold ? 'active' : ''}"
                title="Bold"
                @click=${() => this.ctx.setFontBold(!this.ctx.state.fontBold)}
              ><strong>B</strong></button>
              <button
                class="font-toggle ${this.ctx.state.fontItalic ? 'active' : ''}"
                title="Italic"
                @click=${() => this.ctx.setFontItalic(!this.ctx.state.fontItalic)}
              ><em>I</em></button>
            </div>
          `
        : ''}

      ${activeTool === 'stamp'
        ? html`
            <div class="stamp-line">
              <button class="stamp-btn" @click=${this._uploadStamp} title="Upload Image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </button>
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
              ${stampImage
            ? html`<img class="stamp-preview" .src=${stampImage.src} alt="stamp" />`
            : ''}
            </div>
          `
        : ''}

      ${this.ctx.saving
        ? html`
            <div class="saving-indicator" aria-label="Saving">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
              </svg>
            </div>
          `
        : ''}

      <dialog class="new-project-dialog" @keydown=${this._onNewProjectKeydown}>
        <p class="dialog-title">New Project</p>
        <div class="dialog-field">
          <label>Name</label>
          <input
            type="text"
            class="new-project-name-input"
            .value=${this._newProjectName}
            @input=${(e: Event) => { this._newProjectName = (e.target as HTMLInputElement).value; }}
          />
        </div>
        <div class="dialog-field">
          <label>Canvas Size</label>
          <div class="dialog-presets">
            ${documentPresets.map(p => html`
              <button
                class="dialog-preset-btn ${String(p.width) === this._newProjectWidth && String(p.height) === this._newProjectHeight ? 'active' : ''}"
                @click=${() => this._selectNewProjectPreset(p)}
              >${p.label}</button>
            `)}
          </div>
          <div class="dialog-size-row">
            <input
              class="dialog-size-input"
              type="number"
              min="1"
              max="8192"
              .value=${this._newProjectWidth}
              @input=${(e: Event) => { this._newProjectWidth = (e.target as HTMLInputElement).value; }}
            />
            <span>\u00d7</span>
            <input
              class="dialog-size-input"
              type="number"
              min="1"
              max="8192"
              .value=${this._newProjectHeight}
              @input=${(e: Event) => { this._newProjectHeight = (e.target as HTMLInputElement).value; }}
            />
          </div>
        </div>
        <div class="dialog-actions">
          <button class="dialog-cancel-btn" @click=${this._cancelNewProject}>Cancel</button>
          <button class="dialog-create-btn" @click=${this._confirmNewProject}>Create</button>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-settings': ToolSettings;
  }
}

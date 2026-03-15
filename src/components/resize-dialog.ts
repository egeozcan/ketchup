import { LitElement, html, css } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('resize-dialog')
export class ResizeDialog extends LitElement {
  static override styles = css`
    dialog {
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #555;
      border-radius: 8px;
      padding: 24px;
      max-width: 400px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.5);
    }
    p {
      margin: 0 0 16px;
      line-height: 1.5;
    }
    .buttons {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    button {
      padding: 8px 16px;
      border-radius: 4px;
      border: 1px solid #555;
      background: #3a3a3a;
      color: #e0e0e0;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover {
      background: #4a4a4a;
    }
    button.primary {
      background: #4a90d9;
      border-color: #4a90d9;
    }
    button.primary:hover {
      background: #5aa0e9;
    }
  `;

  private _dialog: HTMLDialogElement | null = null;
  private _resolve: ((scale: boolean) => void) | null = null;

  show(imgW: number, imgH: number, canvasW: number, canvasH: number): Promise<boolean> {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._imgW = imgW;
      this._imgH = imgH;
      this._canvasW = canvasW;
      this._canvasH = canvasH;
      this.requestUpdate();
      this.updateComplete.then(() => {
        this._dialog = this.renderRoot.querySelector('dialog');
        this._dialog?.showModal();
      });
    });
  }

  private _imgW = 0;
  private _imgH = 0;
  private _canvasW = 0;
  private _canvasH = 0;

  private _onScale() {
    this._dialog?.close();
    this._resolve?.(true);
    this._resolve = null;
  }

  private _onKeep() {
    this._dialog?.close();
    this._resolve?.(false);
    this._resolve = null;
  }

  override render() {
    // Pressing Escape on the native dialog fires a 'cancel' event;
    // we treat it as "Keep original size" (the non-destructive default).
    return html`
      <dialog @cancel=${(e: Event) => { e.preventDefault(); this._onKeep(); }}>
        <p>
          This image (${this._imgW}&times;${this._imgH}) is larger than the canvas
          (${this._canvasW}&times;${this._canvasH}). Would you like to scale it to fit?
        </p>
        <div class="buttons">
          <button @click=${this._onKeep}>Keep original size</button>
          <button class="primary" @click=${this._onScale}>Scale to fit</button>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'resize-dialog': ResizeDialog;
  }
}

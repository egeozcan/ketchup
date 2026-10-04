import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { focusEditor } from '../utils/focus-editor.js';

export interface ConfirmOptions {
  message: string;
  /** The button that goes ahead (default "OK"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Going ahead loses something: the button reads as a warning. */
  danger?: boolean;
}

/**
 * The editor's own yes/no question, in place of `window.confirm()`: a modal
 * `<dialog>` in the editor's shadow tree (so it shows embedded, and other
 * tabs aren't frozen by it). Escape, or closing it any other way, answers no;
 * Cancel has focus first, since going ahead usually loses something.
 */
@customElement('confirm-dialog')
export class ConfirmDialog extends LitElement {
  static override styles = css`
    dialog {
      box-sizing: border-box;
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #555;
      border-radius: 8px;
      padding: 20px 24px;
      max-width: min(400px, calc(100vw - 32px));
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
      flex-wrap: wrap;
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
    button:focus-visible {
      outline: 2px solid #8bbcf0;
      outline-offset: 2px;
    }
    button.primary {
      background: #4a90d9;
      border-color: #4a90d9;
      color: #fff;
    }
    button.primary:hover {
      background: #5aa0e9;
    }
    button.danger {
      background: #c0392b;
      border-color: #c0392b;
      color: #fff;
    }
    button.danger:hover {
      background: #d64535;
    }
  `;

  @state() private _options: ConfirmOptions | null = null;
  private _resolve: ((ok: boolean) => void) | null = null;
  /** What had focus before the question, given it back after. */
  private _returnFocus: HTMLElement | null = null;

  /** Asks; resolves true for the confirm button, false for anything else. A question still open is answered no. */
  show(options: ConfirmOptions): Promise<boolean> {
    this._answer(false);
    this._returnFocus = deepActiveElement();
    this._options = options;
    return new Promise((resolve) => {
      this._resolve = resolve;
      void this.updateComplete.then(() => {
        const dialog = this._dialog;
        if (!dialog || this._resolve !== resolve) return;
        if (!this.isConnected) { this._answer(false); return; }
        if (!dialog.open) dialog.showModal();
        dialog.querySelector<HTMLButtonElement>('button.cancel')?.focus();
      });
    });
  }

  /** Whether a question is waiting for an answer. */
  get open(): boolean {
    return this._resolve !== null;
  }

  /** Closes an open question unanswered (what it was about went away); `show` resolves false. */
  dismiss() {
    this._answer(false);
  }

  private get _dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector('dialog');
  }

  private _answer(ok: boolean) {
    const resolve = this._resolve;
    if (!resolve) return;
    this._resolve = null;
    const dialog = this._dialog;
    const hadFocus = !!dialog && dialog.contains(deepActiveElement());
    if (dialog?.open) dialog.close();
    // Focus goes back where it was, or, if that went away (a menu closed),
    // to the editor, whose shortcuts would otherwise not hear the keyboard.
    if (hadFocus) {
      const back = this._returnFocus;
      if (back?.isConnected) back.focus({ preventScroll: true });
      if (!back?.isConnected || deepActiveElement() !== back) focusEditor(this);
    }
    this._returnFocus = null;
    resolve(ok);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Out of the document, what it asked about is no longer on screen.
    this._answer(false);
  }

  override render() {
    const o = this._options;
    // Escape fires 'cancel'; 'close' covers the browser closing it some other
    // way (one that arrives after the next question opened is the last one's).
    // Keys typed in it are its own, not the app's shortcuts.
    return html`
      <dialog
        aria-labelledby="message"
        @cancel=${(e: Event) => { e.preventDefault(); this._answer(false); }}
        @close=${(e: Event) => { if (!(e.target as HTMLDialogElement).open) this._answer(false); }}
        @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
      >
        <p id="message">${o?.message ?? ''}</p>
        <div class="buttons">
          <button class="cancel" @click=${() => this._answer(false)}>${o?.cancelLabel ?? 'Cancel'}</button>
          <button class=${o?.danger ? 'danger' : 'primary'} @click=${() => this._answer(true)}>${o?.confirmLabel ?? 'OK'}</button>
        </div>
      </dialog>
    `;
  }
}

/** The focused element, looking into shadow roots. */
function deepActiveElement(): HTMLElement | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el instanceof HTMLElement ? el : null;
}

declare global {
  interface HTMLElementTagNameMap {
    'confirm-dialog': ConfirmDialog;
  }
}

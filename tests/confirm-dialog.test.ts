import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/confirm-dialog.ts';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { AppToolbar } from '../src/components/app-toolbar.ts';
import { keyIsForEditorOf } from '../src/utils/focus-editor.ts';
import { makeAppCanvasStub } from './helpers.ts';

/** jsdom has no modal dialogs: enough of one for the tests (close fires later, as in browsers). */
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as any;
  if (!Object.getOwnPropertyDescriptor(proto, 'open')) {
    Object.defineProperty(proto, 'open', { get() { return this.hasAttribute('open'); }, configurable: true });
  }
  if (!proto.showModal) {
    proto.showModal = function () { this.setAttribute('open', ''); };
    proto.close = function () {
      if (!this.open) return;
      this.removeAttribute('open');
      setTimeout(() => this.dispatchEvent(new Event('close')), 0);
    };
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function shown(promise: Promise<boolean>, dialog: ConfirmDialog) {
  await dialog.updateComplete;
  await new Promise(r => setTimeout(r, 0));
  return { promise, el: dialog.shadowRoot!.querySelector('dialog')! };
}

describe('confirm-dialog', () => {
  async function make() {
    const dialog = document.createElement('confirm-dialog') as ConfirmDialog;
    document.body.append(dialog);
    await dialog.updateComplete;
    return dialog;
  }

  it('answers yes from the confirm button, with Cancel focused first', async () => {
    const dialog = await make();
    const { promise, el } = await shown(dialog.show({ message: 'Clear?', confirmLabel: 'Clear', danger: true }), dialog);
    expect(el.open).toBe(true);
    expect(el.textContent).toContain('Clear?');
    const [cancel, ok] = el.querySelectorAll('button');
    expect(dialog.shadowRoot!.activeElement).toBe(cancel);
    expect(ok.textContent).toBe('Clear');
    expect(ok.className).toBe('danger');
    ok.click();
    await expect(promise).resolves.toBe(true);
    expect(el.open).toBe(false);
  });

  it('answers no from Cancel, Escape (cancel), or a dismissal', async () => {
    const dialog = await make();
    let { promise, el } = await shown(dialog.show({ message: 'a' }), dialog);
    el.querySelector<HTMLButtonElement>('button.cancel')!.click();
    await expect(promise).resolves.toBe(false);

    ({ promise, el } = await shown(dialog.show({ message: 'b' }), dialog));
    const cancel = new Event('cancel', { cancelable: true });
    el.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await expect(promise).resolves.toBe(false);

    ({ promise } = await shown(dialog.show({ message: 'c' }), dialog));
    dialog.dismiss();
    await expect(promise).resolves.toBe(false);
    expect(dialog.open).toBe(false);
  });

  it('answers an open question no when another is asked, and a stale close event leaves the new one open', async () => {
    const dialog = await make();
    const first = dialog.show({ message: 'first' });
    await dialog.updateComplete;
    const second = dialog.show({ message: 'second' });
    await expect(first).resolves.toBe(false);
    const { el } = await shown(second, dialog);
    // The first one's close event, arriving now, isn't an answer to this.
    el.dispatchEvent(new Event('close'));
    expect(dialog.open).toBe(true);
    el.querySelectorAll('button')[1].click();
    await expect(second).resolves.toBe(true);
  });

  it('keeps its keys from the app and from menus behind it', async () => {
    const dialog = await make();
    const { promise, el } = await shown(dialog.show({ message: 'q' }), dialog);
    const heard = vi.fn();
    document.body.addEventListener('keydown', heard);
    el.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(heard).not.toHaveBeenCalled();
    dialog.dismiss();
    await promise;
  });

  it('answers no when taken out of the document', async () => {
    const dialog = await make();
    const { promise } = await shown(dialog.show({ message: 'q' }), dialog);
    dialog.remove();
    await expect(promise).resolves.toBe(false);
  });
});

describe('keyIsForEditorOf with a question open', () => {
  it('leaves a key typed in the editor\'s own open dialog to the dialog', () => {
    const editor = document.createElement('drawing-app-test-host');
    const root = editor.attachShadow({ mode: 'open' });
    // editorOf goes by the tag name.
    Object.defineProperty(editor, 'localName', { value: 'drawing-app' });
    const menu = document.createElement('div');
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const button = document.createElement('button');
    dialog.append(button);
    root.append(menu, dialog);
    document.body.append(editor);
    const key = (path: EventTarget[]) => ({ key: 'Escape', target: path[0], composedPath: () => path }) as unknown as KeyboardEvent;

    expect(keyIsForEditorOf(menu, key([button, dialog, root, editor, document.body]))).toBe(false);
    expect(keyIsForEditorOf(menu, key([menu, root, editor, document.body]))).toBe(true);
    // A host's dialog around the editor isn't the editor's question.
    const hostDialog = document.createElement('dialog');
    hostDialog.setAttribute('open', '');
    expect(keyIsForEditorOf(menu, key([menu, root, editor, hostDialog, document.body]))).toBe(true);
  });
});

describe('questions the app asks', () => {
  it('asks in its own dialog before discarding unsaved work on a switch, and stays on no', async () => {
    const app = new DrawingApp();
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });
    vi.spyOn(app as any, '_hasUnsavedWork').mockReturnValue(true);
    const ask = vi.spyOn(app as any, '_confirm').mockResolvedValue(false);
    const native = vi.spyOn(window, 'confirm');
    const request = ++(app as any)._switchRequest;
    await expect((app as any)._beginSwitch(request)).resolves.toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Discard', danger: true }));
    expect(native).not.toHaveBeenCalled();
    expect((app as any)._switching).toBe(false);

    ask.mockResolvedValue(true);
    const next = ++(app as any)._switchRequest;
    await expect((app as any)._beginSwitch(next)).resolves.toBe(true);
  });

  it('does not go on with a switch if the tab was taken over while it asked', async () => {
    const app = new DrawingApp();
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });
    vi.spyOn(app as any, '_hasUnsavedWork').mockReturnValue(true);
    vi.spyOn(app as any, '_confirm').mockImplementation(async () => {
      (app as any)._stranded = true;
      return true;
    });
    const request = ++(app as any)._switchRequest;
    await expect((app as any)._beginSwitch(request)).resolves.toBe(false);
  });

  it('clears the drawing only once the question is answered yes', async () => {
    const toolbar = new AppToolbar();
    let answer!: (ok: boolean) => void;
    const ctx = {
      confirm: vi.fn(() => new Promise<boolean>(r => { answer = r; })),
      clearCanvas: vi.fn(),
    };
    Object.defineProperty(toolbar, 'ctx', { configurable: true, value: ctx });
    const done = (toolbar as any)._confirmClearCanvas();
    expect(ctx.clearCanvas).not.toHaveBeenCalled();
    answer(true);
    await done;
    expect(ctx.clearCanvas).toHaveBeenCalledWith(true);
  });

  it('dismisses an open question when a new document is opened', () => {
    const app = new DrawingApp();
    Object.defineProperty(app, 'canvas', { configurable: true, value: makeAppCanvasStub() });
    const dismiss = vi.fn();
    Object.defineProperty(app, '_confirmDialog', { configurable: true, value: { dismiss } });
    (app as any)._markSaved();
    expect(dismiss).toHaveBeenCalled();
  });
});

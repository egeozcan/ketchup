import { describe, expect, it, vi } from 'vitest';
import { NavigatorPanel } from '../src/components/navigator-panel.ts';
import { ToolSettings } from '../src/components/tool-settings.ts';
import { focusEditor } from '../src/utils/focus-editor.ts';

describe('keyboard in panels', () => {
  it('hands focus to the editor from a control nested in another component (the phone toolbar\'s settings)', () => {
    const app = document.createElement('div');
    app.tabIndex = 0;
    document.body.append(app);
    const toolbar = document.createElement('div');
    app.attachShadow({ mode: 'open' }).append(toolbar);
    const settings = document.createElement('div');
    toolbar.attachShadow({ mode: 'open' }).append(settings);
    const field = document.createElement('input');
    settings.attachShadow({ mode: 'open' }).append(field);
    field.focus();

    expect(focusEditor(field)).toBe(true);
    expect(document.activeElement).toBe(app);
    expect(app.shadowRoot!.activeElement).toBeNull();
    app.remove();
  });

  it('keeps the zoom as it was when Escape leaves the navigator\'s zoom field', () => {
    const panel = new NavigatorPanel();
    const commit = vi.spyOn(panel as any, '_commitZoomInput').mockImplementation(() => {});
    const input = document.createElement('input');
    for (const key of ['Escape', 'Enter']) {
      (panel as any)._editingZoom = true;
      (panel as any)._onZoomInputKeydown({ key, target: input, stopPropagation() {}, preventDefault() {} });
      (panel as any)._onZoomInputBlur();
    }
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('lets Escape close an open dropdown without reaching the app, which would cancel a float', () => {
    const settings = new ToolSettings();
    (settings as any)._projectDropdownOpen = true;
    const open = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (settings as any)._onDropdownEscape(open);
    expect(open.stopPropagation).toHaveBeenCalled();
    // Nor is it a host dialog's close request.
    expect(open.preventDefault).toHaveBeenCalled();
    expect((settings as any)._projectDropdownOpen).toBe(false);

    const closed = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (settings as any)._onDropdownEscape(closed);
    expect(closed.stopPropagation).not.toHaveBeenCalled();
  });
});

describe('keyboard leaving panel fields', () => {
  function inEditor() {
    const app = document.createElement('div');
    app.tabIndex = 0;
    document.body.append(app);
    const root = app.attachShadow({ mode: 'open' });
    return { app, root };
  }

  it('hands focus to the editor when a project rename ends by key, and lets its Escape through the dropdown', () => {
    for (const key of ['Enter', 'Escape']) {
      const { app, root } = inEditor();
      const settings = new ToolSettings();
      root.append(settings);
      const input = document.createElement('input');
      settings.shadowRoot!.append(input);
      input.value = 'Renamed';
      input.focus();
      Object.defineProperty(settings, 'ctx', { value: { renameProject: vi.fn() } });
      (settings as any)._projectDropdownOpen = true;
      (settings as any)._renamingProjectId = 'p1';

      const esc = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
      (settings as any)._onDropdownEscape(esc);
      expect(esc.stopPropagation, key).not.toHaveBeenCalled();

      (settings as any)._onRenameKeydown({ key, target: input, stopPropagation() {}, preventDefault() {} }, 'p1');
      expect(document.activeElement, key).toBe(app);
      expect(root.activeElement, key).toBeNull();
      app.remove();
    }
  });
});

describe('focusEditor', () => {
  it('stops at the editor: a focusable wrapper around it doesn\'t hear its shortcuts', () => {
    const wrapper = document.createElement('div');
    wrapper.tabIndex = 0;
    document.body.append(wrapper);
    const editor = document.createElement('drawing-app');
    wrapper.attachShadow({ mode: 'open' }).append(editor);
    const field = document.createElement('input');
    editor.attachShadow({ mode: 'open' }).append(field);
    field.focus();

    expect(focusEditor(field)).toBe(false);
    expect(wrapper.shadowRoot!.activeElement).toBe(editor);
    wrapper.remove();
  });
});

describe('Escape on the phone\'s popovers and sheet', () => {
  it('closes the toolbar\'s popover without reaching the app, which would cancel a float', async () => {
    const { AppToolbar } = await import('../src/components/app-toolbar.ts');
    const toolbar = new AppToolbar();
    (toolbar as any)._popoverGroup = -1;
    const esc = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (toolbar as any)._onPopoverEscape(esc);
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(esc.preventDefault).toHaveBeenCalled();
    expect((toolbar as any)._popoverGroup).toBeNull();
  });

  it('closes the layers sheet, unless a layer name is being edited in it', async () => {
    const { LayersPanel } = await import('../src/components/layers-panel.ts');
    const panel = new LayersPanel();
    Object.defineProperty(panel, 'ctx', { value: { state: { layersPanelOpen: false } } });
    (panel as any)._sheetOpen = true;
    (panel as any)._editingLayerId = 'l1';
    const renaming = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (panel as any)._onDocKeyDown(renaming);
    expect(renaming.stopPropagation).not.toHaveBeenCalled();
    expect((panel as any)._sheetOpen).toBe(true);

    (panel as any)._editingLayerId = null;
    const esc = { key: 'Escape', stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (panel as any)._onDocKeyDown(esc);
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(esc.preventDefault).toHaveBeenCalled();
    expect((panel as any)._sheetOpen).toBe(false);
  });
});

describe('keys and the editor they are for', () => {
  it('finds the editor through a host component\'s shadow root', async () => {
    const { containsAcrossShadows, keyIsForEditorOf } = await import('../src/utils/focus-editor.ts');
    const host = document.createElement('div');
    document.body.append(host);
    const editor = document.createElement('drawing-app');
    host.attachShadow({ mode: 'open' }).append(editor);
    const toolbar = document.createElement('div');
    editor.attachShadow({ mode: 'open' }).append(toolbar);
    try {
      expect(document.body.contains(editor)).toBe(false);
      expect(containsAcrossShadows(document.body, editor)).toBe(true);
      expect(containsAcrossShadows(editor, document.body)).toBe(false);

      const keyOn = (target: EventTarget, path: EventTarget[]) => ({ target, composedPath: () => path }) as unknown as KeyboardEvent;
      // Inside it, or with nothing focused: its.
      expect(keyIsForEditorOf(toolbar, keyOn(editor, [editor, host.shadowRoot!, host, document.body]))).toBe(true);
      expect(keyIsForEditorOf(toolbar, keyOn(document.body, [document.body]))).toBe(true);
      // A host page's field, or another editor: not.
      const field = document.createElement('input');
      expect(keyIsForEditorOf(toolbar, keyOn(field, [field, document.body]))).toBe(false);
    } finally {
      host.remove();
    }
  });
});

describe('panels moved with the editor', () => {
  it('leaves a scale question unanswered when moved, to ask again on its return', async () => {
    const { ResizeDialog } = await import('../src/components/resize-dialog.ts');
    const dialog = new ResizeDialog();
    let answered = false;
    void dialog.show(600, 500, 400, 300).then(() => { answered = true; });
    dialog.disconnectedCallback();
    await new Promise(r => setTimeout(r, 0));
    expect(answered).toBe(false);
  });

  it('keeps an open colour or brush panel from taking Escape typed for another editor or the page', () => {
    const settings = new ToolSettings();
    (settings as any)._openPanel = 'color';
    const wrapper = document.createElement('div');
    const editor = document.createElement('drawing-app');
    wrapper.append(editor);
    editor.attachShadow({ mode: 'open' }).append(settings);
    const field = document.createElement('input');
    const esc = { key: 'Escape', target: field, composedPath: () => [field, document.body], stopPropagation: vi.fn(), preventDefault: vi.fn() };
    (settings as any)._onPanelEscape(esc);
    expect(esc.stopPropagation).not.toHaveBeenCalled();
    expect((settings as any)._openPanel).toBe('color');
  });

  it('loads its stamp thumbnails again when it comes back', () => {
    const settings = new ToolSettings();
    (settings as any)._lastProjectId = 'p1';
    settings.disconnectedCallback();
    expect((settings as any)._lastProjectId).toBeNull();
  });
});

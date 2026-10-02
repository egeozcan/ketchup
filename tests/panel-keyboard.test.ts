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
      (panel as any)._onZoomInputKeydown({ key, target: input, stopPropagation() {} });
      (panel as any)._onZoomInputBlur();
    }
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('lets Escape close an open dropdown without reaching the app, which would cancel a float', () => {
    const settings = new ToolSettings();
    (settings as any)._projectDropdownOpen = true;
    const open = { key: 'Escape', stopPropagation: vi.fn() };
    (settings as any)._onDropdownEscape(open);
    expect(open.stopPropagation).toHaveBeenCalled();
    expect((settings as any)._projectDropdownOpen).toBe(false);

    const closed = { key: 'Escape', stopPropagation: vi.fn() };
    (settings as any)._onDropdownEscape(closed);
    expect(closed.stopPropagation).not.toHaveBeenCalled();
  });
});

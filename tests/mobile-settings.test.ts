import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextProvider } from '@lit/context';
import { AppToolbar } from '../src/components/app-toolbar.ts';
import { drawingContext, type DrawingContextValue } from '../src/contexts/drawing-context.ts';
import { makeState } from './helpers.ts';

afterEach(() => document.body.replaceChildren());

async function renderMobileToolbar(contextOverrides: Partial<DrawingContextValue>) {
  const host = document.createElement('div');
  new ContextProvider(host, {
    context: drawingContext,
    initialValue: {
      state: makeState({ layersPanelOpen: false }),
      isMobile: true,
      projectList: [],
      ...contextOverrides,
    } as DrawingContextValue,
  });
  const toolbar = new AppToolbar();
  host.append(toolbar);
  document.body.append(host);
  await toolbar.updateComplete;
  toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[title="More"]')!.click();
  await toolbar.updateComplete;
  return toolbar;
}

describe('Mobile tool settings access', () => {
  it('exposes Child Mode from the More menu', async () => {
    const setChildMode = vi.fn();
    const toolbar = await renderMobileToolbar({ setChildMode });
    const childModeButton = Array.from(toolbar.shadowRoot!.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Child Mode');
    expect(childModeButton).toBeDefined();

    childModeButton!.click();
    expect(setChildMode).toHaveBeenCalledWith(true);
  });

  it('opens the current brush settings from More and applies edits', async () => {
    const setStrokeColor = vi.fn();
    const setBrushSize = vi.fn();
    const setBrush = vi.fn();
    const toolbar = await renderMobileToolbar({
        state: makeState({ activeTool: 'pencil', layersPanelOpen: false }),
        setStrokeColor,
        setBrushSize,
        setBrush,
    });

    const settingsButton = Array.from(toolbar.shadowRoot!.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Tool settings');
    expect(settingsButton, 'More must expose a labeled settings entry').toBeDefined();
    settingsButton!.click();
    await toolbar.updateComplete;
    const settings = toolbar.shadowRoot!.querySelector('tool-settings')!;
    expect(settings).not.toBeNull();
    await settings.updateComplete;

    const edit = (label: string, value: string) => {
      const input = settings.shadowRoot!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      expect(input, label).not.toBeNull();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    edit('Stroke color', '#0099ff');
    edit('Brush size', '24');
    edit('Brush opacity', '60');
    edit('Brush flow', '40');
    edit('Brush hardness', '20');
    expect(setStrokeColor).toHaveBeenCalledWith('#0099ff');
    expect(setBrushSize).toHaveBeenCalledWith(24);
    expect(setBrush).toHaveBeenCalledWith({ opacity: 0.6 });
    expect(setBrush).toHaveBeenCalledWith({ flow: 0.4 });
    expect(setBrush).toHaveBeenCalledWith({ hardness: 0.2 });
  });

  it('exposes crop apply and cancel actions through the existing shortcuts', async () => {
    const toolbar = await renderMobileToolbar({
      state: makeState({ activeTool: 'crop', layersPanelOpen: false }),
    });
    const shortcutKeys: string[] = [];
    toolbar.parentElement!.addEventListener('keydown', (event) => {
      shortcutKeys.push(event.key);
    });

    const openToolSettings = async () => {
      const settingsButton = Array.from(toolbar.shadowRoot!.querySelectorAll('button'))
        .find(button => button.textContent?.trim() === 'Tool settings');
      expect(settingsButton).toBeDefined();
      settingsButton!.click();
      await toolbar.updateComplete;
    };

    await openToolSettings();
    const applyButton = Array.from(toolbar.shadowRoot!.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Apply crop');
    expect(applyButton).toBeDefined();
    applyButton!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
    }));
    applyButton!.click();
    await toolbar.updateComplete;

    expect(shortcutKeys).toEqual(['Enter']);
    expect(toolbar.shadowRoot!.querySelector('#mobile-tool-popover')).toBeNull();

    toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[title="More"]')!.click();
    await toolbar.updateComplete;
    await openToolSettings();
    const cancelButton = Array.from(toolbar.shadowRoot!.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Cancel crop');
    expect(cancelButton).toBeDefined();
    cancelButton!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
    }));
    cancelButton!.click();
    await toolbar.updateComplete;

    expect(shortcutKeys).toEqual(['Enter', 'Escape']);
    expect(toolbar.shadowRoot!.querySelector('#mobile-tool-popover')).toBeNull();
  });
});

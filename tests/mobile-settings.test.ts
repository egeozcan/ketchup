import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextProvider } from '@lit/context';
import { AppToolbar } from '../src/components/app-toolbar.ts';
import { drawingContext, type DrawingContextValue } from '../src/contexts/drawing-context.ts';
import { makeState } from './helpers.ts';

afterEach(() => document.body.replaceChildren());

describe('Mobile tool settings access', () => {
  it('opens the current brush settings from More and applies edits', async () => {
    const host = document.createElement('div');
    const setStrokeColor = vi.fn();
    const setBrushSize = vi.fn();
    const setBrush = vi.fn();
    new ContextProvider(host, {
      context: drawingContext,
      initialValue: {
        state: makeState({ activeTool: 'pencil', layersPanelOpen: false }),
        isMobile: true,
        projectList: [],
        setStrokeColor,
        setBrushSize,
        setBrush,
      } as unknown as DrawingContextValue,
    });
    const toolbar = new AppToolbar();
    host.append(toolbar);
    document.body.append(host);
    await toolbar.updateComplete;
    toolbar.shadowRoot!.querySelector<HTMLButtonElement>('button[title="More"]')!.click();
    await toolbar.updateComplete;

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
});

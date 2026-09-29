import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextProvider } from '@lit/context';
import { ToolSettings } from '../src/components/tool-settings.ts';
import { drawingContext, type DrawingContextValue } from '../src/contexts/drawing-context.ts';
import { makeState } from './helpers.ts';

afterEach(() => document.body.replaceChildren());

async function renderDesktopSettings(contextOverrides: Partial<DrawingContextValue> = {}) {
  const host = document.createElement('div');
  const provider = new ContextProvider(host, {
    context: drawingContext,
    initialValue: {
      state: makeState({ activeTool: 'pencil' }),
      isMobile: false,
      projectList: [],
      saving: false,
      setStrokeColor: vi.fn(),
      setBrush: vi.fn(),
      ...contextOverrides,
    } as DrawingContextValue,
  });
  const settings = new ToolSettings();
  host.append(settings);
  document.body.append(host);
  await settings.updateComplete;
  const root = settings.shadowRoot!;
  const click = async (selector: string) => {
    root.querySelector<HTMLButtonElement>(selector)!.click();
    await settings.updateComplete;
  };
  return { settings, root, click, provider };
}

describe('Desktop settings bar panels', () => {
  it('keeps secondary brush controls in a Brush settings panel', async () => {
    const setBrush = vi.fn();
    const { root, click } = await renderDesktopSettings({ setBrush });

    // Primary controls stay in the bar.
    expect(root.querySelector('input[aria-label="Brush size"]')).not.toBeNull();
    expect(root.querySelector('input[aria-label="Brush opacity"]')).not.toBeNull();
    // Secondary ones wait behind the panel trigger.
    expect(root.querySelector('input[aria-label="Brush flow"]')).toBeNull();
    expect(root.textContent).not.toContain('Stylus Size');

    await click('button[aria-label="Brush settings"]');
    const trigger = root.querySelector('button[aria-label="Brush settings"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const flow = root.querySelector<HTMLInputElement>('.brush-panel input[aria-label="Brush flow"]')!;
    expect(flow).not.toBeNull();
    expect(root.querySelector('.brush-panel')!.textContent).toContain('Stylus Size');

    flow.value = '40';
    flow.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setBrush).toHaveBeenCalledWith({ flow: 0.4 });
  });

  it('opens the color panel with presets and a custom picker', async () => {
    const setStrokeColor = vi.fn();
    const { root, click } = await renderDesktopSettings({ setStrokeColor });

    expect(root.querySelector('.color-swatch')).toBeNull();
    await click('button[aria-label="Color"]');

    const swatches = root.querySelectorAll<HTMLButtonElement>('.color-panel .color-swatch');
    expect(swatches.length).toBeGreaterThan(0);
    swatches[1].click();
    expect(setStrokeColor).toHaveBeenCalled();
    expect(root.querySelector('.color-panel input[aria-label="Stroke color"]')).not.toBeNull();
  });

  it('shows one panel at a time and closes on outside press or Escape', async () => {
    const { settings, root, click } = await renderDesktopSettings();

    await click('button[aria-label="Color"]');
    await click('button[aria-label="Brush settings"]');
    expect(root.querySelector('.color-panel')).toBeNull();
    expect(root.querySelector('.brush-panel')).not.toBeNull();

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    await settings.updateComplete;
    expect(root.querySelector('.brush-panel')).toBeNull();

    await click('button[aria-label="Color"]');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true });
    root.querySelector('.color-swatch')!.dispatchEvent(escape);
    await settings.updateComplete;
    expect(root.querySelector('.color-panel')).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('button[aria-label="Color"]'));
  });

  it('closes an open panel when the tool no longer offers it', async () => {
    const { settings, root, click, provider } = await renderDesktopSettings();
    await click('button[aria-label="Brush settings"]');
    expect(root.querySelector('.brush-panel')).not.toBeNull();

    provider.setValue({
      ...provider.value,
      state: makeState({ activeTool: 'fill' }),
    } as DrawingContextValue);
    await settings.updateComplete;
    await settings.updateComplete;

    expect((settings as any)._openPanel).toBeNull();
  });
});

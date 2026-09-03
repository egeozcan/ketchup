import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { ToolSettings } from '../src/components/tool-settings.ts';
import type { TipShape } from '../src/engine/types.ts';
import { makeState } from './helpers.ts';

function renderBrushSettings(
  shape: TipShape,
  activeTool: 'pencil' | 'eraser' = 'pencil',
  brushOverrides: { flow?: number; pressureOpacity?: boolean } = {},
  setBrushTip = vi.fn(),
): HTMLElement {
  const settings = new ToolSettings();
  (settings as any)._advancedOpen = true;
  (settings as any)._ctx = {
    value: {
      state: makeState({ activeTool, brush: { ...brushOverrides, tip: { shape } } }),
      isMobile: true,
      setStrokeColor: vi.fn(),
      setBrushSize: vi.fn(),
      setBrush: vi.fn(),
      setBrushTip,
      setBrushInk: vi.fn(),
      selectPreset: vi.fn(),
    },
  };
  const container = document.createElement('div');
  render(settings.render(), container);
  return container;
}

describe('ToolSettings keyboard handling', () => {
  it('stops propagation while renaming projects', () => {
    const settings = new ToolSettings();
    (settings as any)._renamingProjectId = 'project-1';
    const event = {
      key: 'Escape',
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    (settings as any)._onRenameKeydown(event, 'project-1');

    expect((event.stopPropagation as any)).toHaveBeenCalledTimes(1);
    expect((settings as any)._renamingProjectId).toBeNull();
  });

  it('stops propagation in new project dialog and confirms on Enter', () => {
    const settings = new ToolSettings();
    const confirmSpy = vi.fn();
    (settings as any)._confirmNewProject = confirmSpy;
    const event = {
      key: 'Enter',
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    (settings as any)._onNewProjectKeydown(event);

    expect((event.stopPropagation as any)).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ToolSettings brush controls', () => {
  it('renders only controls supported by the selected tip shape', () => {
    const round = renderBrushSettings('round').textContent ?? '';
    expect(round).not.toContain('Aspect');
    expect(round).not.toContain('Orient');

    const flat = renderBrushSettings('flat').textContent ?? '';
    expect(flat).toContain('Aspect');
    expect(flat).toContain('Angle');
    expect(flat).toContain('Orient');
    expect(flat).not.toContain('Bristles');

    const fan = renderBrushSettings('fan').textContent ?? '';
    expect(fan).not.toContain('Aspect');
    expect(fan).toContain('Angle');
    expect(fan).toContain('Orient');
    expect(fan).toContain('Bristles');
    expect(fan).toContain('Spread');

    const splatter = renderBrushSettings('splatter').textContent ?? '';
    expect(splatter).not.toContain('Aspect');
    expect(splatter).toContain('Angle');
    expect(splatter).toContain('Bristles');
    expect(splatter).toContain('Spread');
  });

  it('hides paint-only controls from the eraser', () => {
    const eraser = renderBrushSettings('flat', 'eraser', { flow: 0.5 }).textContent ?? '';

    expect(eraser).not.toContain('Color');
    expect(eraser).not.toContain('Wetness');
    expect(eraser).toContain('Opacity');
    expect(eraser).toContain('Flow');
    expect(eraser).toContain('Hardness');
    expect(eraser).toContain('Depletion');
    expect(eraser).toContain('Buildup');
  });

  it('identifies pressure controls as stylus-specific', () => {
    const controls = renderBrushSettings('round').textContent ?? '';

    expect(controls).toContain('Stylus Size');
    expect(controls).toContain('Stylus Opacity');
    expect(controls).toContain('Stylus Curve');
    expect(controls).not.toContain('Pressure Size');
  });

  it('only exposes buildup when it can alter stamp flow', () => {
    const saturated = renderBrushSettings('round').textContent ?? '';
    const lowerFlow = renderBrushSettings('round', 'pencil', { flow: 0.5 }).textContent ?? '';
    const pressureFlow = renderBrushSettings('round', 'pencil', { pressureOpacity: true }).textContent ?? '';

    expect(saturated).not.toContain('Buildup');
    expect(lowerFlow).toContain('Buildup');
    expect(pressureFlow).toContain('Buildup');
  });

  it('does not reset custom tip values when the active shape is clicked again', () => {
    const setBrushTip = vi.fn();
    const controls = renderBrushSettings('flat', 'pencil', {}, setBrushTip);
    const buttons = Array.from(controls.querySelectorAll('button'));

    buttons.find(button => button.textContent?.trim() === 'Flat')!.click();
    expect(setBrushTip).not.toHaveBeenCalled();

    buttons.find(button => button.textContent?.trim() === 'Fan')!.click();
    expect(setBrushTip).toHaveBeenCalledWith({
      shape: 'fan',
      aspect: 1,
      angle: 0,
      orientation: 'direction',
      bristles: 8,
      spread: 120,
    });
  });
});

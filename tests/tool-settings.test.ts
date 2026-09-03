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

describe('ToolSettings stamp controls', () => {
  function renderStampSettings() {
    const settings = new ToolSettings();
    const state = makeState({ activeTool: 'stamp', activeStampId: 'stamp-1', stampSize: 120 });
    const setStampSize = vi.fn();
    (settings as any)._ctx = {
      value: {
        state,
        isMobile: true,
        saving: false,
        setBrushSize: vi.fn(),
        setStampSize,
        setStampImage: vi.fn(),
      },
    };
    (settings as any)._recentStamps = [
      { id: 'stamp-1', projectId: 'project-1', blobRef: 'blob-1', createdAt: 1 },
    ];
    (settings as any)._thumbUrls = new Map([['stamp-1', 'blob:thumbnail-1']]);
    const container = document.createElement('div');
    render(settings.render(), container, { host: settings });
    return { settings, container, setStampSize };
  }

  it('shows stamp-specific sizing without an irrelevant color palette', () => {
    const { container } = renderStampSettings();

    expect(container.textContent).toContain('Stamp size');
    expect(container.querySelector('input[type="range"]')?.getAttribute('aria-label')).toBe('Stamp size');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Stamp size in pixels"]')?.value).toBe('120');
    expect(container.textContent).not.toContain('Color');
  });

  it('allows precise stamp sizing with a numeric pixel input', () => {
    const { container, setStampSize } = renderStampSettings();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Stamp size in pixels"]')!;

    input.value = '333';
    input.dispatchEvent(new Event('change'));

    expect(setStampSize).toHaveBeenCalledWith(333);
  });

  it('uses keyboard-accessible labeled buttons and preserves the selected id', () => {
    const { container } = renderStampSettings();
    const select = container.querySelector<HTMLButtonElement>('button[aria-label="Select recent stamp 1"]');
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Delete recent stamp 1"]');

    expect(select).not.toBeNull();
    expect(select?.getAttribute('aria-pressed')).toBe('true');
    expect(remove).not.toBeNull();
    expect(container.querySelector('.stamp-preview')).toBeNull();
  });

  it('does not revoke shared thumbnail URLs when a mobile popover unmounts', () => {
    const settings = new ToolSettings();
    (settings as any)._thumbUrls = new Map([['stamp-1', 'blob:thumbnail-1']]);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    settings.disconnectedCallback();

    expect(revoke).not.toHaveBeenCalled();
  });

  it('clears the previous project stamp actions before loading the next project', () => {
    const settings = new ToolSettings();
    (settings as any)._lastProjectId = 'project-1';
    (settings as any)._recentStamps = [
      { id: 'stamp-1', projectId: 'project-1', blobRef: 'blob-1', createdAt: 1 },
    ];
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool: 'stamp' }),
        currentProject: { id: 'project-2' },
        isMobile: false,
      },
    };
    const loadStamps = vi.spyOn(settings as any, '_loadStamps').mockResolvedValue(undefined);

    settings.willUpdate();

    expect((settings as any)._recentStamps).toEqual([]);
    expect(loadStamps).toHaveBeenCalledWith('project-2');
  });

  it('rejects stale select and delete actions from another project', async () => {
    const settings = new ToolSettings();
    const getBlob = vi.fn();
    const deleteStamp = vi.fn();
    const setStampImage = vi.fn();
    (settings as any)._lastProjectId = 'project-2';
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool: 'stamp' }),
        currentProject: { id: 'project-2' },
        setStampImage,
      },
    };
    (settings as any)._storageCtx = {
      value: {
        blobs: { get: getBlob },
        stamps: { delete: deleteStamp },
      },
    };
    const stale = { id: 'stamp-1', projectId: 'project-1', blobRef: 'blob-1', createdAt: 1 };

    await (settings as any)._selectStamp(stale);
    await (settings as any)._deleteStamp(stale, { stopPropagation: vi.fn() });

    expect(getBlob).not.toHaveBeenCalled();
    expect(deleteStamp).not.toHaveBeenCalled();
    expect(setStampImage).not.toHaveBeenCalled();
  });
});

import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { ToolSettings } from '../src/components/tool-settings.ts';
import type { TipShape } from '../src/engine/types.ts';
import { makeState } from './helpers.ts';

function renderBrushSettings(
  shape: TipShape,
  activeTool: 'pencil' | 'eraser' = 'pencil',
  brushOverrides: { flow?: number; pressureOpacity?: boolean; pressureSize?: boolean; dynamics?: { flowVelocity?: number; minSize?: number; tilt?: number } } = {},
  setBrushTip = vi.fn(),
  setBrushDynamics = vi.fn(),
  setBrushJitter = vi.fn(),
): HTMLElement {
  const settings = new ToolSettings();
  (settings as any)._ctx = {
    value: {
      state: makeState({ activeTool, brush: { ...brushOverrides, tip: { shape } } }),
      isMobile: true,
      setStrokeColor: vi.fn(),
      setBrushSize: vi.fn(),
      setBrush: vi.fn(),
      setBrushTip,
      setBrushInk: vi.fn(),
      setBrushDynamics,
      setBrushJitter,
      selectPreset: vi.fn(),
    },
  };
  // Every page in turn, so a test sees the whole sheet as one.
  const container = document.createElement('div');
  for (const page of ['stroke', 'tip', 'stylus', 'shape', 'scatter', 'color', 'texture', 'ink']) {
    (settings as any)._brushPage = page;
    const part = document.createElement('div');
    render(settings.render(), part);
    container.append(part);
  }
  return container;
}

describe('ToolSettings keyboard handling', () => {
  it('stops propagation while renaming projects', () => {
    const settings = new ToolSettings();
    (settings as any)._renamingProjectId = 'project-1';
    const event = {
      key: 'Escape',
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    (settings as any)._onRenameKeydown(event, 'project-1');

    expect((event.stopPropagation as any)).toHaveBeenCalledTimes(1);
    // Nor is it a host dialog's close request.
    expect((event.preventDefault as any)).toHaveBeenCalled();
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
  it('sets scatter from its controls once the group is opened', () => {
    const setBrushScatter = vi.fn();
    const settings = new ToolSettings();
    (settings as any)._brushPage = 'scatter';
    (settings as any)._ctx = { value: { state: makeState({ activeTool: 'pencil' }), isMobile: true, setBrushScatter } };
    const container = document.createElement('div');
    render(settings.render(), container);
    for (const [label, key, raw, value] of [['Scatter', 'amount', '250', 2.5], ['Count', 'count', '7', 7], ['Count jitter', 'countJitter', '40', 0.4]] as const) {
      const input = container.querySelector(`input[aria-label="${label} scatter"]`) as HTMLInputElement;
      input.value = raw;
      input.dispatchEvent(new Event('input'));
      expect(setBrushScatter).toHaveBeenLastCalledWith({ [key]: value });
    }
    const both = container.querySelector('input[aria-label="Both axes"]') as HTMLInputElement;
    both.checked = true;
    both.dispatchEvent(new Event('change'));
    expect(setBrushScatter).toHaveBeenLastCalledWith({ bothAxes: true });
  });

  it('sets colour dynamics from its controls once the group is opened, and hides the group from the eraser', () => {
    const setBrushColorDynamics = vi.fn();
    const settings = new ToolSettings();
    (settings as any)._brushPage = 'color';
    (settings as any)._ctx = { value: { state: makeState({ activeTool: 'pencil' }), isMobile: true, setBrushColorDynamics } };
    const container = document.createElement('div');
    render(settings.render(), container);
    for (const [label, key, raw, value] of [['Hue', 'hue', '60', 0.6], ['Purity', 'purity', '-40', -0.4], ['FG/BG', 'fgBg', '25', 0.25]] as const) {
      const input = container.querySelector(`input[aria-label="${label} color"]`) as HTMLInputElement;
      input.value = raw;
      input.dispatchEvent(new Event('input'));
      expect(setBrushColorDynamics).toHaveBeenLastCalledWith({ [key]: value });
    }
    const setFillColor = vi.fn();
    (settings as any)._ctx = { value: { state: makeState({ activeTool: 'pencil' }), isMobile: true, setBrushColorDynamics, setFillColor } };
    render(settings.render(), container);
    const fill = container.querySelector('input[aria-label="Fill colour"]') as HTMLInputElement;
    fill.value = '#00ff00';
    fill.dispatchEvent(new Event('input'));
    expect(setFillColor).toHaveBeenCalledWith('#00ff00');
    const perTip = container.querySelector('input[aria-label="Per tip color"]') as HTMLInputElement;
    perTip.checked = false;
    perTip.dispatchEvent(new Event('change'));
    expect(setBrushColorDynamics).toHaveBeenLastCalledWith({ perTip: false });

    (settings as any)._ctx = { value: { state: makeState({ activeTool: 'eraser' }), isMobile: true, setBrushColorDynamics } };
    const erased = document.createElement('div');
    render(settings.render(), erased);
    expect(erased.querySelector('input[aria-label="Hue color"]')).toBeNull();
  });

  it('sets jitter from its sliders once the group is opened', () => {
    const setBrushJitter = vi.fn();
    const settings = new ToolSettings();
    (settings as any)._brushPage = 'shape';
    (settings as any)._ctx = { value: { state: makeState({ activeTool: 'pencil' }), isMobile: true, setBrushJitter } };
    const container = document.createElement('div');
    render(settings.render(), container);
    for (const [label, key] of [['Size', 'size'], ['Angle', 'angle'], ['Roundness', 'roundness'], ['Flow', 'flow']]) {
      const input = container.querySelector(`input[aria-label="${label} jitter"]`) as HTMLInputElement;
      input.value = '40';
      input.dispatchEvent(new Event('input'));
      expect(setBrushJitter).toHaveBeenLastCalledWith({ [key]: 0.4 });
    }
  });


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

    const speedFlow = renderBrushSettings('round', 'pencil', { dynamics: { flowVelocity: -0.5 } }).textContent ?? '';

    expect(saturated).not.toContain('Buildup');
    expect(lowerFlow).toContain('Buildup');
    expect(pressureFlow).toContain('Buildup');
    expect(speedFlow).toContain('Buildup');
  });

  it('sets speed dynamics from their sliders, as -1..1', () => {
    const setBrushDynamics = vi.fn();
    const controls = renderBrushSettings('round', 'pencil', { dynamics: { flowVelocity: -0.5 } }, vi.fn(), setBrushDynamics);
    const size = controls.querySelector<HTMLInputElement>('input[aria-label="Size by speed"]')!;
    const flow = controls.querySelector<HTMLInputElement>('input[aria-label="Flow by speed"]')!;
    expect(flow.value).toBe('-50');
    expect(controls.textContent).toContain('-50%');

    size.value = '30';
    size.dispatchEvent(new Event('input'));

    expect(setBrushDynamics).toHaveBeenCalledWith({ sizeVelocity: 0.3 });
  });

  it('offers a minimum size only with stylus size, and sets it as a share', () => {
    expect(renderBrushSettings('round', 'pencil', { pressureSize: false }).querySelector('input[aria-label="Minimum size"]')).toBeNull();

    const setBrushDynamics = vi.fn();
    const controls = renderBrushSettings('round', 'pencil', { pressureSize: true, dynamics: { minSize: 0.25 } }, vi.fn(), setBrushDynamics);
    const min = controls.querySelector<HTMLInputElement>('input[aria-label="Minimum size"]')!;
    expect(min.value).toBe('25');
    min.value = '40';
    min.dispatchEvent(new Event('input'));
    expect(setBrushDynamics).toHaveBeenCalledWith({ minSize: 0.4 });
  });

  it('sets tilt dynamics from the Stylus Tilt slider', () => {
    const setBrushDynamics = vi.fn();
    const controls = renderBrushSettings('round', 'pencil', { dynamics: { tilt: 0.6 } }, vi.fn(), setBrushDynamics);
    const tilt = controls.querySelector<HTMLInputElement>('input[aria-label="Stylus tilt"]')!;
    expect(tilt.value).toBe('60');
    tilt.value = '25';
    tilt.dispatchEvent(new Event('input'));
    expect(setBrushDynamics).toHaveBeenCalledWith({ tilt: 0.25 });
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

describe('ToolSettings airbrush', () => {
  function render_(airbrush: boolean, airbrushRate = 20, activeTool: 'pencil' | 'eraser' = 'pencil') {
    const setBrush = vi.fn();
    const settings = new ToolSettings();
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool, brush: { airbrush, airbrushRate } }),
        isMobile: true,
        setBrush, setBrushTip: vi.fn(), setBrushInk: vi.fn(), setBrushDynamics: vi.fn(), setBrushJitter: vi.fn(), selectPreset: vi.fn(),
      },
    };
    const container = document.createElement('div');
    render(settings.render(), container);
    return { container, setBrush };
  }

  it('toggles the airbrush and shows its rate only while on', () => {
    const off = render_(false);
    const toggle = off.container.querySelector<HTMLInputElement>('input[aria-label="Airbrush"]')!;
    expect(toggle.checked).toBe(false);
    expect(off.container.querySelector('input[aria-label="Airbrush rate"]')).toBeNull();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(off.setBrush).toHaveBeenCalledWith({ airbrush: true });

    const on = render_(true, 35);
    const rate = on.container.querySelector<HTMLInputElement>('input[aria-label="Airbrush rate"]')!;
    expect(rate.value).toBe('35');
    rate.value = '50';
    rate.dispatchEvent(new Event('input'));
    expect(on.setBrush).toHaveBeenCalledWith({ airbrushRate: 50 });
  });

  it('is offered to the eraser too', () => {
    expect(render_(false, 20, 'eraser').container.querySelector('input[aria-label="Airbrush"]')).not.toBeNull();
  });
});

describe('ToolSettings fades', () => {
  function render_(fade = {}) {
    const setBrushFade = vi.fn();
    const settings = new ToolSettings();
    (settings as any)._brushPage = 'shape';
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool: 'pencil', brush: { fade, pressureSize: false } }),
        isMobile: true,
        setBrush: vi.fn(), setBrushTip: vi.fn(), setBrushInk: vi.fn(), setBrushDynamics: vi.fn(), setBrushJitter: vi.fn(), setBrushFade, selectPreset: vi.fn(),
      },
    };
    const container = document.createElement('div');
    render(settings.render(), container);
    return { container, setBrushFade };
  }

  it('sets the taper and size fade lengths, in pixels', () => {
    const { container, setBrushFade } = render_({ taperStart: 30, sizeLength: 0 });
    const taper = container.querySelector<HTMLInputElement>('input[aria-label="Taper start"]')!;
    const fade = container.querySelector<HTMLInputElement>('input[aria-label="Size fade"]')!;
    expect(taper.value).toBe('30');
    expect(fade.value).toBe('0');
    fade.value = '400';
    fade.dispatchEvent(new Event('input'));
    expect(setBrushFade).toHaveBeenLastCalledWith({ sizeLength: 400 });
    taper.value = '0';
    taper.dispatchEvent(new Event('input'));
    expect(setBrushFade).toHaveBeenLastCalledWith({ taperStart: 0 });
  });

  it('shows the minimum size they shrink toward even without stylus size', () => {
    expect(render_().container.querySelector('input[aria-label="Minimum size"]')).toBeNull();
    expect(render_({ taperStart: 20 }).container.querySelector('input[aria-label="Minimum size"]')).not.toBeNull();
  });
});

describe('ToolSettings texture', () => {
  function render_(texture = {}, activeTool: 'pencil' | 'eraser' = 'pencil') {
    const setBrushTexture = vi.fn();
    const settings = new ToolSettings();
    (settings as any)._brushPage = 'texture';
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool, brush: { texture } }),
        isMobile: true,
        setBrush: vi.fn(), setBrushTip: vi.fn(), setBrushInk: vi.fn(), setBrushDynamics: vi.fn(), setBrushJitter: vi.fn(), setBrushTexture, selectPreset: vi.fn(),
      },
    };
    const container = document.createElement('div');
    render(settings.render(), container);
    return { container, setBrushTexture };
  }

  it('sets the pattern, mode, scale, depth and the switches', () => {
    const { container, setBrushTexture } = render_({ pattern: 'paper', scale: 1.5, depth: 0.4, perTip: true });
    const pattern = container.querySelector<HTMLSelectElement>('select[aria-label="Texture pattern"]')!;
    expect(Array.from(pattern.options).map(o => o.value)).toEqual(['none', 'paper', 'canvas', 'noise', 'charcoal']);
    pattern.value = 'canvas';
    pattern.dispatchEvent(new Event('change'));
    expect(setBrushTexture).toHaveBeenLastCalledWith({ pattern: 'canvas' });
    const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Texture mode"]')!;
    mode.value = 'height';
    mode.dispatchEvent(new Event('change'));
    expect(setBrushTexture).toHaveBeenLastCalledWith({ mode: 'height' });
    const scale = container.querySelector<HTMLInputElement>('input[aria-label="Scale texture"]')!;
    const depth = container.querySelector<HTMLInputElement>('input[aria-label="Depth texture"]')!;
    expect(scale.value).toBe('150');
    expect(depth.value).toBe('40');
    depth.value = '90';
    depth.dispatchEvent(new Event('input'));
    expect(setBrushTexture).toHaveBeenLastCalledWith({ depth: 0.9 });
    const invert = container.querySelector<HTMLInputElement>('input[aria-label="Invert texture"]')!;
    invert.checked = true;
    invert.dispatchEvent(new Event('change'));
    expect(setBrushTexture).toHaveBeenLastCalledWith({ invert: true });
  });

  it('offers depth by pressure only for texture on each tip, and for the eraser too', () => {
    expect(render_({ perTip: false }).container.querySelector('input[aria-label="Depth by pressure texture"]')).toBeNull();
    expect(render_({ perTip: true }).container.querySelector('input[aria-label="Depth by pressure texture"]')).not.toBeNull();
    expect(render_({}, 'eraser').container.querySelector('select[aria-label="Texture pattern"]')).not.toBeNull();
  });
});

describe('ToolSettings brush pages', () => {
  function mount(activeTool: 'pencil' | 'eraser' = 'pencil', brush = {}) {
    const settings = new ToolSettings();
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool, brush }),
        isMobile: true,
        setBrush: vi.fn(), setBrushTip: vi.fn(), setBrushInk: vi.fn(), setBrushDynamics: vi.fn(), setBrushJitter: vi.fn(), selectPreset: vi.fn(),
      },
    };
    const container = document.createElement('div');
    const draw = () => render(settings.render(), container);
    draw();
    return { settings, container, draw };
  }
  const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  it('shows one page at a time, starting on Stroke', () => {
    const { settings, container, draw } = mount();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Stroke');
    expect(container.querySelector('input[aria-label="Brush flow"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Spacing"]')).toBeNull();
    tabs(container).find(t => t.textContent!.includes('Tip'))!.click();
    expect((settings as any)._brushPage).toBe('tip');
    draw();
    expect(container.querySelector('input[aria-label="Spacing"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Brush flow"]')).toBeNull();
  });

  it('has no Color page for the eraser, and falls back to Stroke from it', () => {
    const { settings, container, draw } = mount('eraser');
    expect(tabs(container).map(t => t.textContent!.trim())).not.toContain('Color');
    (settings as any)._brushPage = 'color';
    draw();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('Stroke');
  });

  it('marks pages whose settings are in use', () => {
    const { container } = mount('pencil', { scatter: { amount: 1, bothAxes: false, count: 1, countJitter: 0 } });
    const dotted = tabs(container).filter(t => t.querySelector('.page-dot')).map(t => t.textContent!.trim());
    expect(dotted).toContain('Scatter');
    expect(dotted).not.toContain('Texture');
    expect(dotted).not.toContain('Color');
  });

  it('moves between pages with the arrow keys, wrapping around', () => {
    const { settings } = mount();
    const ids = ['stroke', 'tip', 'stylus'];
    const key = (k: string) => (settings as any)._onBrushTabKey(new KeyboardEvent('keydown', { key: k }), ids);
    key('ArrowDown');
    expect((settings as any)._brushPage).toBe('tip');
    key('ArrowUp');
    key('ArrowUp');
    expect((settings as any)._brushPage).toBe('stylus');
    key('Home');
    expect((settings as any)._brushPage).toBe('stroke');
    key('End');
    expect((settings as any)._brushPage).toBe('stylus');
  });
});

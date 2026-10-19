import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { ToolSettings } from '../src/components/tool-settings.ts';
import { getDefaultTipDescriptor } from '../src/engine/brush-capabilities.ts';
import type { BrushPreset } from '../src/engine/types.ts';
import { BRUSH_PRESETS } from '../src/engine/brush-presets.ts';
import type { BrushTipMeta } from '../src/storage/types.ts';
import { makeBrush, makeState } from './helpers.ts';

const tip: BrushTipMeta = {
  id: 'tip-1', name: 'Leaf', width: 8, height: 4, spacing: 0.25, createdAt: 1,
  thumb: { width: 2, height: 2, alpha: Uint8Array.from([0, 255, 128, 0]) },
};
const custom: BrushPreset = {
  id: 'user-1', name: 'Leafy', category: 'custom',
  descriptor: makeBrush({ tip: { ...getDefaultTipDescriptor('image'), imageId: 'tip-1' } }),
};

function mount(over: Record<string, unknown> = {}, state: Parameters<typeof makeState>[0] = {}, dropdown = false) {
  const settings = new ToolSettings();
  (settings as any)._brushPage = 'tip';
  (settings as any)._brushDropdownOpen = dropdown;
  const ctx = {
    state: makeState({ activeTool: 'pencil', ...state }),
    isMobile: true,
    setStrokeColor: vi.fn(), setBrushSize: vi.fn(), setBrush: vi.fn(), setBrushTip: vi.fn(), setBrushInk: vi.fn(),
    setBrushDynamics: vi.fn(), setBrushJitter: vi.fn(), selectPreset: vi.fn(),
    userTips: [tip], userPresets: [custom],
    selectUserTip: vi.fn(), deleteUserTip: vi.fn(async () => {}), deleteUserPreset: vi.fn(async () => {}),
    deleteUserGroup: vi.fn(async () => {}), importBrushFile: vi.fn(async () => ({ ok: true, message: '' })),
    defineBrushFromFile: vi.fn(async () => null), defineBrushFromSelection: vi.fn(async () => null),
    ...over,
  };
  (settings as any)._ctx = { value: ctx };
  const container = document.createElement('div');
  render(settings.render(), container);
  return { container, ctx, settings };
}

describe('custom brushes in tool settings', () => {
  it('hides the hardness slider for a sampled tip and shows it otherwise', () => {
    const sampled = mount({}, { brush: { tip: { ...getDefaultTipDescriptor('image'), imageId: 'tip-1' } } });
    expect(sampled.container.querySelector('[aria-label="Brush hardness"]')).toBeNull();
    expect(mount().container.querySelector('[aria-label="Brush hardness"]')).not.toBeNull();
  });

  it('lists library tips, picks and deletes them', () => {
    const { container, ctx } = mount();
    const pick = container.querySelector<HTMLButtonElement>('button.tip-pick')!;
    pick.click();
    expect(ctx.selectUserTip).toHaveBeenCalledWith('tip-1');
    container.querySelector<HTMLButtonElement>('button.tip-delete')!.click();
    expect(ctx.deleteUserTip).toHaveBeenCalledWith('tip-1');
  });

  it('marks the tip the brush paints with', () => {
    const { container } = mount({}, { brush: { tip: { ...getDefaultTipDescriptor('image'), imageId: 'tip-1' } } });
    expect(container.querySelector('button.tip-pick')!.classList.contains('active')).toBe(true);
  });

  it('works for a context that has no library', () => {
    const { container } = mount({ userTips: undefined, userPresets: undefined });
    expect(container.querySelector('button.tip-pick')).toBeNull();
  });

  it('defines a brush from a chosen image file and reports why it could not', async () => {
    const defineBrushFromFile = vi.fn(async () => 'Nothing to paint.');
    const { container, settings } = mount({ defineBrushFromFile });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['x'], 'leaf.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    await (settings as any)._defineFromFile({ target: input } as unknown as Event);
    expect(defineBrushFromFile).toHaveBeenCalledWith(file, 'leaf.png');
    expect((settings as any)._tipMessage).toBe('Nothing to paint.');
    expect((settings as any)._tipMessageError).toBe(true);
  });

  it('lists custom presets under "Custom" in the picker, with delete, and selects them', () => {
    const { container, ctx } = mount({}, {}, true);
    const headings = [...container.querySelectorAll('.brush-dropdown-heading')].map(h => h.textContent!.trim());
    // Built-in presets sit under their categories, the user's own after them.
    expect(headings).toEqual(['Basic', 'Artistic', 'Effects', 'Custom']);
    const rows = [...container.querySelectorAll<HTMLElement>('.brush-dropdown-row')];
    expect(rows).toHaveLength(BRUSH_PRESETS.length + 1);
    // Only the custom one can be deleted.
    expect(container.querySelectorAll('.brush-dropdown-delete')).toHaveLength(1);
    rows.at(-1)!.querySelector<HTMLButtonElement>('.brush-dropdown-item')!.click();
    expect(ctx.selectPreset).toHaveBeenCalledWith('user-1');
    container.querySelector<HTMLButtonElement>('.brush-dropdown-delete')!.click();
    expect(ctx.deleteUserPreset).toHaveBeenCalledWith('user-1');
  });

  it('shows each preset\'s tip next to its stroke, the same image for the same tip', () => {
    const { container } = mount({}, {}, true);
    const rows = [...container.querySelectorAll<HTMLElement>('.brush-dropdown-row')];
    const tips = rows.map(r => r.querySelector<HTMLImageElement>('img.tip-thumb'));
    expect(tips.every(t => t && t.src.startsWith('data:image/png'))).toBe(true);
    // Every row's tip thumbnail precedes its stroke preview.
    expect(rows.every(r => r.querySelectorAll('img')[0].classList.contains('tip-thumb'))).toBe(true);
    const again = mount({}, {}, true).container.querySelector<HTMLImageElement>('img.tip-thumb')!;
    expect(again.src).toBe(tips[0]!.src);
  });

  it('names the active custom preset on the picker button', () => {
    const { container } = mount({}, { activePreset: 'user-1' });
    expect(container.querySelector('.brush-dropdown-btn span')!.textContent).toBe('Leafy');
  });

  it('offers to define a brush from the selection while a selection is transformed', () => {
    const defineBrushFromSelection = vi.fn(async () => null);
    const settings = new ToolSettings();
    (settings as any)._ctx = { value: {
      state: makeState({ activeTool: 'select' }), transformActive: true, defineBrushFromSelection,
      getTransformValues: () => ({ x: 0, y: 0, width: 10, height: 10, rotation: 0, skewX: 0, skewY: 0, flipH: false, flipV: false }),
    } };
    const container = document.createElement('div');
    render(settings.render(), container);
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Define brush')!;
    button.click();
    expect(defineBrushFromSelection).toHaveBeenCalled();
  });

  it('shows a deleted active preset as a modified custom brush, not as Round', () => {
    const { container } = mount({}, { activePreset: 'user-gone', isPresetModified: false });
    expect(container.querySelector('.brush-dropdown-btn span')!.textContent).toBe('Custom *');
  });

  it('asks the app to load the open picker\'s tips on every render', () => {
    const loadUserTips = vi.fn();
    mount({ loadUserTips }, {}, true);
    expect(loadUserTips).toHaveBeenCalled();
    loadUserTips.mockClear();
    mount({ loadUserTips }, {}, false);
    expect(loadUserTips).not.toHaveBeenCalled();
  });

  describe('imported brush groups', () => {
    const imported: BrushPreset = { ...custom, id: 'imp-1', name: 'Dots', group: 'Chalk Set' };
    const importedTip: BrushTipMeta = { ...tip, id: 'tip-imp', group: 'Chalk Set' };

    it('lists a group closed under its own heading, opens it on a click and loads its tips', () => {
      const loadUserTips = vi.fn();
      const { container, settings, ctx } = mount({ userPresets: [custom, imported], userTips: [tip, importedTip], loadUserTips }, {}, true);
      const toggle = container.querySelector<HTMLButtonElement>('.group-toggle')!;
      expect(toggle.textContent).toContain('Chalk Set (1)');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelectorAll('.brush-dropdown-row')).toHaveLength(BRUSH_PRESETS.length + 1);
      toggle.click();
      expect(loadUserTips).toHaveBeenLastCalledWith(['Chalk Set']);
      render(settings.render(), container);
      expect(container.querySelectorAll('.brush-dropdown-row')).toHaveLength(BRUSH_PRESETS.length + 2);
      container.querySelector<HTMLButtonElement>('.group-heading .brush-dropdown-delete')!.click();
      expect(ctx.deleteUserGroup).toHaveBeenCalledWith('Chalk Set');
    });

    it('keeps imported tips out of the tip grid', () => {
      const { container } = mount({ userPresets: [], userTips: [importedTip] });
      expect(container.querySelector('button.tip-pick')).toBeNull();
    });

    it('imports a chosen .abr file and shows the result', async () => {
      const importBrushFile = vi.fn(async () => ({ ok: true, message: 'Imported 3 brushes' }));
      const { container, settings } = mount({ importBrushFile });
      const input = container.querySelector<HTMLInputElement>('input[accept=".abr"]')!;
      const file = new File(['x'], 'a.abr');
      Object.defineProperty(input, 'files', { value: [file] });
      await (settings as any)._importBrushes({ target: input } as unknown as Event);
      expect(importBrushFile).toHaveBeenCalledWith(file, expect.any(Function));
      expect((settings as any)._tipMessage).toBe('Imported 3 brushes');
      expect((settings as any)._tipMessageError).toBe(false);
      expect((settings as any)._importProgress).toBeNull();
    });
  });
});

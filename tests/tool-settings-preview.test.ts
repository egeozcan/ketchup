import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { makeState } from './helpers.ts';

const engineCalls = vi.hoisted(() => ({
  begin: vi.fn(),
  stroke: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('../src/engine/stamp-stroke.js', async importOriginal => ({
  tiltStretch: (await importOriginal<typeof import('../src/engine/stamp-stroke.js')>()).tiltStretch,
  StampStrokeEngine: class {
    begin(...args: unknown[]) { engineCalls.begin(...args); }
    stroke(...args: unknown[]) { engineCalls.stroke(...args); }
    commit(...args: unknown[]) { engineCalls.commit(...args); }
  },
}));

import { ToolSettings } from '../src/components/tool-settings.ts';

function renderSettings(activeTool: 'pencil' | 'eraser') {
  const settings = new ToolSettings();
  (settings as any)._ctx = {
    value: {
      state: makeState({ activeTool }),
      isMobile: true,
      setStrokeColor: vi.fn(),
      setBrushSize: vi.fn(),
      setBrush: vi.fn(),
      setBrushTip: vi.fn(),
      setBrushInk: vi.fn(),
      selectPreset: vi.fn(),
    },
  };
  render(settings.render(), document.createElement('div'));
}

describe('ToolSettings brush previews', () => {
  it('renders the active preview in the current tool mode', () => {
    engineCalls.begin.mockClear();
    renderSettings('eraser');
    expect(engineCalls.begin).toHaveBeenCalledWith(
      expect.anything(),
      '#cccccc',
      true,
      160,
      48,
      // Seeded, so jitter doesn't reroll the thumbnail on every change.
      { seed: 1 },
    );
  });

  it('keeps the scatter ratio in the active preview, shrinking the dab to fit', () => {
    const sizes: number[] = [];
    for (const amount of [1, 5]) {
      engineCalls.begin.mockClear();
      const settings = new ToolSettings();
      (settings as any)._ctx = { value: { state: makeState({ activeTool: 'pencil', isPresetModified: true, brush: { size: 12, scatter: { amount } } }), isMobile: true } };
      render(settings.render(), document.createElement('div'));
      // The preset thumbnails render too; the only ones scattering this much belong to the active brush.
      const call = engineCalls.begin.mock.calls.find(c => c[0].scatter.amount === amount && c[0].scatter.count === 1);
      expect(call).toBeDefined();
      sizes.push(call![0].size);
    }
    expect(sizes[1]).toBeLessThan(sizes[0]);
  });
});

import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { makeState } from './helpers.ts';

const engineCalls = vi.hoisted(() => ({
  begin: vi.fn(),
  stroke: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('../src/engine/stamp-stroke.js', () => ({
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
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ToolSettings } from '../src/components/tool-settings.ts';

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

  it('stops propagation in custom size inputs and applies on Enter', () => {
    const settings = new ToolSettings();
    const applySpy = vi.fn();
    (settings as any)._applyCustomSize = applySpy;
    const event = {
      key: 'Enter',
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    (settings as any)._onCustomSizeKeydown(event);

    expect((event.stopPropagation as any)).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });
});

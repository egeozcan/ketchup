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

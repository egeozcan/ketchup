import { render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import { AppToolbar } from '../src/components/app-toolbar.ts';
import { ToolSettings } from '../src/components/tool-settings.ts';
import { drawShapePreview, isShapeTool, SHAPE_TOOLS } from '../src/tools/shapes.ts';
import type { ShapeType } from '../src/types.ts';
import { makeState } from './helpers.ts';

function makeToolbarContext(activeTool: ReturnType<typeof makeState>['activeTool']) {
  return {
    state: makeState({ activeTool }),
    isMobile: false,
    canUndo: false,
    canRedo: false,
    setTool: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    saveCanvas: vi.fn(),
    clearCanvas: vi.fn(),
  };
}

describe('combined shapes tool', () => {
  it('renders one shared desktop toolbar item for all geometric shapes', () => {
    const toolbar = new AppToolbar();
    const ctx = makeToolbarContext('pencil');
    (toolbar as any)._ctx = { value: ctx };
    const container = document.createElement('div');

    render(toolbar.render(), container, { host: toolbar });

    expect(container.querySelectorAll('button[aria-label="Shapes"]')).toHaveLength(1);
    expect(container.querySelector('button[title^="Line ("]')).toBeNull();
    expect(container.querySelector('button[title^="Rectangle ("]')).toBeNull();

    container.querySelector<HTMLButtonElement>('button[aria-label="Shapes"]')!.click();
    expect(ctx.setTool).toHaveBeenCalledWith('rectangle');
  });

  it('reopens the last selected shape from the shared toolbar item', () => {
    const toolbar = new AppToolbar();
    const ctx = makeToolbarContext('star');
    (toolbar as any)._ctx = { value: ctx };
    (toolbar as any).willUpdate();
    ctx.state = makeState({ activeTool: 'pencil' });
    const container = document.createElement('div');

    render(toolbar.render(), container, { host: toolbar });
    container.querySelector<HTMLButtonElement>('button[aria-label="Shapes"]')!.click();

    expect(ctx.setTool).toHaveBeenCalledWith('star');
  });

  it('offers every shape in tool options and changes the active shape there', () => {
    const settings = new ToolSettings();
    const setTool = vi.fn();
    (settings as any)._ctx = {
      value: {
        state: makeState({ activeTool: 'rectangle' }),
        isMobile: true,
        setTool,
      },
    };
    const container = document.createElement('div');

    render(settings.render(), container, { host: settings });

    const options = container.querySelectorAll<HTMLButtonElement>('button[data-shape]');
    expect(options).toHaveLength(SHAPE_TOOLS.length);
    expect(Array.from(options, option => option.dataset.shape)).toEqual([...SHAPE_TOOLS]);
    expect(container.querySelector('button[data-shape="rectangle"]')?.getAttribute('aria-pressed')).toBe('true');

    container.querySelector<HTMLButtonElement>('button[data-shape="heart"]')!.click();
    expect(setTool).toHaveBeenCalledWith('heart');
  });
});

describe('additional shape drawing', () => {
  const expectedPathSegments: Record<Exclude<ShapeType, 'line' | 'rectangle' | 'circle' | 'triangle'>, number> = {
    diamond: 3,
    pentagon: 4,
    hexagon: 5,
    star: 9,
    heart: 0,
    arrow: 6,
  };

  it('recognizes all registered shapes', () => {
    for (const shape of SHAPE_TOOLS) {
      expect(isShapeTool(shape)).toBe(true);
    }
    expect(isShapeTool('pencil')).toBe(false);
  });

  it.each(Object.entries(expectedPathSegments) as [keyof typeof expectedPathSegments, number][])(
    'draws and fills the %s shape',
    (shape, lineSegments) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      const stroke = vi.spyOn(ctx, 'stroke');
      const fill = vi.spyOn(ctx, 'fill');
      const lineTo = vi.spyOn(ctx, 'lineTo');
      const curves = vi.spyOn(ctx, 'bezierCurveTo');

      drawShapePreview(ctx, shape, { x: 90, y: 80 }, { x: 10, y: 20 }, '#123456', '#abcdef', true, 4);

      expect(stroke).toHaveBeenCalledOnce();
      expect(fill).toHaveBeenCalledOnce();
      expect(lineTo).toHaveBeenCalledTimes(lineSegments);
      expect(curves).toHaveBeenCalledTimes(shape === 'heart' ? 4 : 0);
    },
  );
});

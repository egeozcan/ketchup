import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingApp } from '../src/components/drawing-app.ts';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { attachCanvasElements, makeAppCanvasStub, makeCanvas, makeLayer, makeState } from './helpers.ts';

function setupCanvas() {
  const canvas = new DrawingCanvas();
  const layer = makeLayer(100, 100);
  (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id }) } };
  attachCanvasElements(canvas, 100, 100);
  (canvas as any).composite = vi.fn();
  (canvas as any).requestUpdate = vi.fn();
  return { canvas, layer };
}

function float() {
  return new TransformManager(new ImageData(10, 10), { x: 20, y: 20, w: 10, h: 10 }, makeCanvas(100, 100), 1, { x: 0, y: 0 });
}

describe('a float meeting other operations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is committed before a crop, so the crop never keeps the hole it left', () => {
    const { canvas, layer } = setupCanvas();
    (canvas as any)._transformManager = float();
    (canvas as any)._cropRectValue = { x: 0, y: 0, w: 50, h: 50 };
    const order: string[] = [];
    vi.spyOn(canvas, 'commitTransform').mockImplementation(() => { order.push('commit'); (canvas as any)._transformManager = null; });
    vi.spyOn(layer.canvas.getContext('2d')!, 'getImageData').mockImplementation(((x: number, y: number, w: number, h: number) => {
      order.push('snapshot');
      return new ImageData(w, h);
    }) as CanvasRenderingContext2D['getImageData']);

    canvas.commitCrop();

    expect(order[0]).toBe('commit');
    expect(order).toContain('snapshot');
  });

  it('pastes the internal copy when the system clipboard never got it', async () => {
    const { canvas } = setupCanvas();
    const read = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { read } });
    const pasteSelection = vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});
    (canvas as any)._systemClipboardWrite = Promise.resolve(false);

    await canvas.paste();

    expect(pasteSelection).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('waits for its own copy to reach the system clipboard before reading it', async () => {
    const { canvas } = setupCanvas();
    let settle!: (ok: boolean) => void;
    (canvas as any)._systemClipboardWrite = new Promise<boolean>(r => { settle = r; });
    const read = vi.fn(async () => []);
    vi.stubGlobal('navigator', { clipboard: { read } });
    vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});

    const pasting = canvas.paste();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    settle(true);
    await pasting;
    expect(read).toHaveBeenCalled();
  });

  it('reads the system clipboard again once the window has lost focus', async () => {
    const { canvas } = setupCanvas();
    (canvas as any)._systemClipboardWrite = Promise.resolve(false);
    (canvas as any)._onWindowBlur();
    const read = vi.fn(async () => []);
    vi.stubGlobal('navigator', { clipboard: { read } });
    vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});

    await canvas.paste();

    expect(read).toHaveBeenCalled();
  });

  it('lets Undo cancel a selection as soon as it is lifted', () => {
    const { canvas } = setupCanvas();
    const notify = vi.spyOn(canvas as any, '_notifyHistory');
    canvas.selectAllCanvas();
    expect(canvas.isTransformActive()).toBe(true);
    expect(notify).toHaveBeenCalled();
  });
});

describe('touches, missed releases and context menus', () => {
  function setupTool(activeTool: string) {
    const canvas = new DrawingCanvas();
    const layer = makeLayer(100, 100);
    const stampImage = document.createElement('img');
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id, activeTool, stampImage } as any) } };
    attachCanvasElements(canvas, 100, 100);
    (canvas as any).composite = vi.fn();
    (canvas as any).requestUpdate = vi.fn();
    const stamp = vi.spyOn(canvas as any, '_createStampAsTransform').mockImplementation(() => {});
    return { canvas, stamp };
  }
  const touch = (pointerId: number, clientX: number, clientY: number) =>
    ({ button: 0, pointerId, clientX, clientY, pointerType: 'touch', preventDefault() {} }) as unknown as PointerEvent;

  it('places a stamp when a tap lifts, not when it lands', () => {
    const { canvas, stamp } = setupTool('stamp');
    (canvas as any)._onPointerDown(touch(1, 40, 40));
    expect(stamp).not.toHaveBeenCalled();
    (canvas as any)._onPointerUp(touch(1, 42, 41));
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(stamp.mock.calls[0].slice(1, 3)).toEqual([40, 40]);
    // Nothing left counted as down.
    expect(canvas.isGestureActive()).toBe(false);
  });

  it('leaves no stamp or fill behind a two-finger pinch', () => {
    for (const tool of ['stamp', 'fill']) {
      const { canvas, stamp } = setupTool(tool);
      const fill = vi.spyOn(canvas as any, '_captureBeforeDraw');
      (canvas as any)._onPointerDown(touch(1, 40, 40));
      (canvas as any)._onPointerDown(touch(2, 70, 70));
      (canvas as any)._onPointerUp(touch(2, 80, 80));
      (canvas as any)._onPointerUp(touch(1, 30, 30));
      expect(stamp, tool).not.toHaveBeenCalled();
      expect(fill, tool).not.toHaveBeenCalled();
    }
  });

  it('ends a gesture whose mouse release was never seen', () => {
    const { canvas } = setupTool('select');
    (canvas as any)._transformManager = float();
    (canvas as any)._onPointerDown({ button: 0, pointerId: 1, clientX: 25, clientY: 25, pointerType: 'mouse' } as PointerEvent);
    expect((canvas as any)._transformManager._interaction.type).not.toBe('idle');
    (canvas as any)._onPointerMove({ buttons: 0, pointerId: 1, clientX: 30, clientY: 30, pointerType: 'mouse' } as PointerEvent);
    expect((canvas as any)._transformManager._interaction.type).toBe('idle');
    expect(canvas.isGestureActive()).toBe(false);
  });

  it('keeps the context menu away from a transform (Ctrl+click on macOS)', () => {
    const { canvas } = setupTool('select');
    const event = { preventDefault: vi.fn() };
    (canvas as any)._onContextMenu(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    (canvas as any)._transformManager = float();
    (canvas as any)._onContextMenu(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('drops an armed crop when a float starts over it', () => {
    const { canvas } = setupTool('crop');
    (canvas as any)._cropRectValue = { x: 0, y: 0, w: 50, h: 50 };
    (canvas as any)._clipboard = new ImageData(4, 4);
    (canvas as any)._clipboardOrigin = { x: 0, y: 0 };
    canvas.pasteSelection();
    expect((canvas as any)._cropRectValue).toBeNull();
  });

  it('removes a pasted image\'s layer on Delete, as Escape does', () => {
    const { canvas } = setupTool('select');
    (canvas as any)._transformManager = float();
    (canvas as any)._floatIsExternalImage = true;
    const cancelExternal = vi.spyOn(canvas, 'cancelExternalFloat').mockImplementation(() => {});
    canvas.deleteSelection();
    expect(cancelExternal).toHaveBeenCalled();
  });

  it('does not ask for a save just because a float started', () => {
    const app = new DrawingApp();
    const markDirty = vi.spyOn(app as any, '_markDirty').mockImplementation(() => {});
    vi.spyOn(app as any, '_reportModified').mockImplementation(() => {});
    (app as any)._onHistoryChange(new CustomEvent('history-change', { detail: { canUndo: true, canRedo: false, stackChanged: false } }));
    expect(markDirty).not.toHaveBeenCalled();
    (app as any)._onHistoryChange(new CustomEvent('history-change', { detail: { canUndo: true, canRedo: false, stackChanged: true } }));
    expect(markDirty).toHaveBeenCalled();
  });
});

describe('app shortcuts and layer changes with a float', () => {
  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = new DrawingApp();
    const canvas = makeAppCanvasStub(overrides);
    Object.defineProperty(app, 'canvas', { configurable: true, value: canvas });
    return { app, canvas };
  }
  const key = (k: string) => ({
    key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    preventDefault: vi.fn(), composedPath: () => [],
  }) as unknown as KeyboardEvent;

  it('duplicates the active float under any tool, without committing it first', () => {
    const { app, canvas } = makeApp({ isTransformActive: vi.fn(() => true) });
    (app as any)._state = { ...(app as any)._state, activeTool: 'stamp' };

    (app as any)._onKeyDown(key('d'));

    expect(canvas.clearSelection).not.toHaveBeenCalled();
    expect(canvas.duplicateInPlace).toHaveBeenCalled();
    expect((app as any)._state.activeTool).toBe('select');
  });

  it('ignores float shortcuts in the middle of a pointer gesture', () => {
    const { app, canvas } = makeApp({ isGestureActive: vi.fn(() => true), isTransformActive: vi.fn(() => true) });
    for (const k of ['v', 't', 'x', 'c', 'd', 'a']) (app as any)._onKeyDown(key(k));
    (app as any)._onKeyDown({ ...key('Delete'), ctrlKey: false });
    for (const op of ['paste', 'enterTransformMode', 'cutSelection', 'copySelection', 'duplicateInPlace', 'selectAll', 'deleteSelection']) {
      expect(canvas[op as keyof typeof canvas], op).not.toHaveBeenCalled();
    }
  });

  it('deletes an active float under any tool', () => {
    const { app, canvas } = makeApp({ isTransformActive: vi.fn(() => true) });
    (app as any)._state = { ...(app as any)._state, activeTool: 'pencil' };
    (app as any)._onKeyDown({ ...key('Delete'), ctrlKey: false });
    expect(canvas.deleteSelection).toHaveBeenCalled();
  });

  it('commits a pasted image before its layers are reordered or deleted', () => {
    const layers = ['a', 'b', 'c'].map(id => makeLayer(10, 10, { id }));
    for (const op of ['reorder', 'delete'] as const) {
      const { app, canvas } = makeApp({ hasExternalFloat: true });
      (app as any)._state = makeState({ layers, activeLayerId: layers[1].id });
      const ctx = (app as any)._buildContextValue();
      if (op === 'reorder') ctx.reorderLayer(layers[1].id, 0);
      else ctx.deleteLayer(layers[2].id);
      expect(canvas.commitTransform, op).toHaveBeenCalled();
    }
  });
});

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

  it('pastes nothing once something without an image was copied elsewhere', async () => {
    const { canvas } = setupCanvas();
    (canvas as any)._systemClipboardWrite = Promise.resolve(true);
    (canvas as any)._onWindowBlur();
    vi.stubGlobal('navigator', { clipboard: { read: vi.fn(async () => [{ types: ['text/plain'] }]) } });
    const pasteSelection = vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});

    await canvas.paste();

    expect(pasteSelection).not.toHaveBeenCalled();
  });

  it('pastes nothing after text was copied in a field, though the window never lost focus', async () => {
    const { canvas } = setupCanvas();
    (canvas as any)._systemClipboardWrite = Promise.resolve(true);
    (canvas as any)._onOtherCopy();
    vi.stubGlobal('navigator', { clipboard: { read: vi.fn(async () => [{ types: ['text/plain'] }]) } });
    const pasteSelection = vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});

    await canvas.paste();

    expect(pasteSelection).not.toHaveBeenCalled();
  });

  it('pastes the internal copy when the system clipboard can\'t be read', async () => {
    const { canvas } = setupCanvas();
    vi.stubGlobal('navigator', { clipboard: { read: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) } });
    const pasteSelection = vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});

    await canvas.paste();

    expect(pasteSelection).toHaveBeenCalled();
  });

  it('hands the keyboard back to the app when text is committed, so its shortcuts work', () => {
    const { canvas } = setupCanvas();
    const host = document.createElement('div');
    host.tabIndex = 0;
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const ta = document.createElement('textarea');
    root.append(ta);
    ta.focus();
    (canvas as any)._textAreaEl = ta;
    (canvas as any)._textEditing = true;
    Object.defineProperty(canvas, 'shadowRoot', { value: root });
    vi.spyOn(canvas, 'getRootNode').mockReturnValue(root);

    (canvas as any)._cancelText();

    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBeNull();
    host.remove();
  });

  it('hands focus to the app when a press on the canvas leaves a panel field (a touch drag focuses nothing)', () => {
    const { canvas } = setupCanvas();
    const host = document.createElement('div');
    host.tabIndex = 0;
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const field = document.createElement('input');
    root.append(field);
    field.focus();
    vi.spyOn(canvas, 'getRootNode').mockReturnValue(root);

    (canvas as any)._blurFocusedField();

    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBeNull();
    host.remove();
  });

  it('sets up its text field and size observer again when it comes back into the document', async () => {
    const { canvas } = setupCanvas();
    const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect() {} });
    const root = canvas.attachShadow({ mode: 'open' });
    (canvas as any).renderRoot = root;
    Object.defineProperty(canvas, 'hasUpdated', { value: true });
    vi.spyOn(canvas as any, '_resizeToFit').mockImplementation(() => {});

    canvas.connectedCallback();

    expect(root.contains((canvas as any)._textAreaEl)).toBe(true);
    expect(observe).toHaveBeenCalledWith(canvas);
    canvas.disconnectedCallback();
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

  it('places a stamp when a touch lifts, where it lifts (it is previewed under the finger)', () => {
    const { canvas, stamp } = setupTool('stamp');
    (canvas as any)._onPointerDown(touch(1, 40, 40));
    expect(stamp).not.toHaveBeenCalled();
    (canvas as any)._onPointerUp(touch(1, 72, 61));
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(stamp.mock.calls[0].slice(1, 3)).toEqual([72, 61]);
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

  it('forgets a finger that lifted off the canvas once a new touch begins', () => {
    const { canvas } = setupTool('pencil');
    // A pinch whose first finger lifted somewhere its release never reached.
    (canvas as any)._pointers.set(7, { x: 0, y: 0, type: 'touch' });
    (canvas as any)._onPointerDown({ ...touch(8, 40, 40), isPrimary: true });
    expect([...(canvas as any)._pointers.keys()]).toEqual([8]);
    expect((canvas as any)._pinching).toBe(false);
  });

  it('keeps hold of both pinch fingers, so their releases always arrive', () => {
    const { canvas } = setupTool('pencil');
    const capture = vi.spyOn(canvas.mainCanvas, 'setPointerCapture');
    (canvas as any)._onPointerDown(touch(1, 40, 40));
    (canvas as any)._onPointerDown(touch(2, 70, 70));
    expect(capture.mock.calls.map(c => c[0]).sort()).toEqual(expect.arrayContaining([1, 2]));
  });

  it('ignores a palm resting on the screen during a pen stroke', () => {
    const { canvas } = setupTool('pencil');
    const pen = { button: 0, pointerId: 5, clientX: 20, clientY: 20, pointerType: 'pen', isPrimary: true, pressure: 0.5, preventDefault() {} };
    (canvas as any)._onPointerDown(pen);
    (canvas as any)._onPointerDown({ ...touch(6, 60, 60), isPrimary: true });
    expect((canvas as any)._pinching).toBe(false);
    expect((canvas as any)._drawing).toBe(true);
    (canvas as any)._onPointerUp(touch(6, 60, 60));
    expect((canvas as any)._drawing).toBe(true);
  });

  it('puts a float back where it was grabbed when the finger turns out to start a pinch', () => {
    const { canvas } = setupTool('select');
    const tm = float();
    (canvas as any)._transformManager = tm;
    (canvas as any)._onPointerDown(touch(1, 23, 23));
    (canvas as any)._onPointerMove(touch(1, 33, 30));
    (canvas as any)._onPointerDown(touch(2, 80, 80));
    expect([tm.x, tm.y]).toEqual([20, 20]);
  });

  it('gives crop handles a finger-sized reach on touch', async () => {
    const { hitTestCropHandle } = await import('../src/tools/crop.ts');
    const rect = { x: 50, y: 50, w: 200, h: 150 };
    // 12 px outside the right edge's handle.
    expect(hitTestCropHandle(rect, { x: 262, y: 125 }, 1)).toBeNull();
    expect(hitTestCropHandle(rect, { x: 262, y: 125 }, 1, 20)).toBe('e');
  });

  it('keeps typing when a pinch starts outside the text box', () => {
    const { canvas } = setupTool('text');
    (canvas as any)._textEditing = true;
    (canvas as any)._textPosition = { x: 10, y: 10 };
    const commit = vi.spyOn(canvas as any, '_commitText').mockImplementation(() => {});
    (canvas as any)._onPointerDown(touch(1, 90, 90));
    (canvas as any)._onPointerDown(touch(2, 95, 60));
    (canvas as any)._onPointerUp(touch(2, 95, 60));
    (canvas as any)._onPointerUp(touch(1, 90, 90));
    expect(commit).not.toHaveBeenCalled();
    // A plain tap outside still commits, when it lifts.
    (canvas as any)._onPointerDown({ ...touch(3, 90, 90), isPrimary: true });
    (canvas as any)._onPointerUp(touch(3, 90, 90));
    expect(commit).toHaveBeenCalled();
  });

  it('keeps a crop rectangle when a pinch starts outside it', () => {
    const { canvas } = setupTool('crop');
    const rect = { x: 10, y: 10, w: 30, h: 30 };
    (canvas as any)._cropRectValue = { ...rect };
    (canvas as any)._onPointerDown(touch(1, 80, 80));
    (canvas as any)._onPointerDown(touch(2, 90, 90));
    expect((canvas as any)._cropRectValue).toEqual(rect);
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

  it('ends a gesture whose release was missed where it was last pressed, not where the mouse wandered', () => {
    const { canvas } = setupTool('select');
    const tm = new TransformManager(new ImageData(40, 40), { x: 20, y: 20, w: 40, h: 40 }, makeCanvas(100, 100), 1, { x: 0, y: 0 });
    (canvas as any)._transformManager = tm;
    const mouse = (buttons: number, clientX: number, clientY: number) =>
      ({ button: 0, buttons, pointerId: 1, clientX, clientY, pointerType: 'mouse', isPrimary: true, preventDefault() {} }) as unknown as PointerEvent;
    (canvas as any)._onPointerDown(mouse(1, 40, 40));
    (canvas as any)._onPointerMove(mouse(1, 50, 47));
    (canvas as any)._onPointerMove(mouse(0, 95, 90));
    expect([tm.x, tm.y]).toEqual([30, 27]);
  });

  it('takes a click on the ✗ as drawn as cancel, though a typed value it applies moves it', () => {
    const { canvas } = setupTool('select');
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(100, 100), 1, { x: 100, y: 100 });
    (canvas as any)._transformManager = tm;
    (canvas as any)._panX = 100;
    (canvas as any)._panY = 100;
    const { cancelCenter } = tm.getButtons();
    // A width typed in the panel, applied when the field blurs.
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    field.addEventListener('blur', () => { tm.width = 260; });
    const cancel = vi.spyOn(canvas, 'cancelTransform').mockImplementation(() => {});
    const commit = vi.spyOn(canvas, 'commitTransform').mockImplementation(() => {});
    const click = { button: 0, pointerId: 1, clientX: cancelCenter.x + 100, clientY: cancelCenter.y + 100, pointerType: 'mouse', isPrimary: true, preventDefault() {} } as unknown as PointerEvent;
    (canvas as any)._onPointerDown(click);
    (canvas as any)._onPointerUp(click);
    expect(tm.width).toBe(260);
    expect(cancel).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    field.remove();
  });

  it('lets a press act normally after a typed value that changed nothing under it', () => {
    const { canvas } = setupTool('select');
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(100, 100), 1, { x: 100, y: 100 });
    (canvas as any)._transformManager = tm;
    (canvas as any)._panX = 100;
    (canvas as any)._panY = 100;
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    // A full turn: nothing visibly moves.
    field.addEventListener('blur', () => { tm.rotation = 360; });
    const press = { button: 0, pointerId: 1, clientX: 150, clientY: 140, pointerType: 'mouse', isPrimary: true, preventDefault() {} } as unknown as PointerEvent;
    (canvas as any)._onPointerDown(press);
    expect((tm as any)._interaction.type).toBe('moving');
    field.remove();
  });

  it('pans with the hand tool over a float', () => {
    const { canvas } = setupTool('hand');
    (canvas as any)._transformManager = float();
    (canvas as any)._onPointerDown({ button: 0, pointerId: 1, clientX: 25, clientY: 25, pointerType: 'mouse', isPrimary: true, preventDefault() {} });
    expect((canvas as any)._panning).toBe(true);
    expect((canvas as any)._transformManager._interaction.type).toBe('idle');
  });

  it('takes a click on the ✓/✗ under the hand tool, and shows it pans everywhere else', () => {
    const { canvas } = setupTool('hand');
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(100, 100), 1, { x: 100, y: 100 });
    (canvas as any)._transformManager = tm;
    (canvas as any)._panX = 100;
    (canvas as any)._panY = 100;
    const { cancelCenter } = tm.getButtons();
    const cancel = vi.spyOn(canvas, 'cancelTransform').mockImplementation(() => {});
    const mouse = (buttons: number, clientX: number, clientY: number) =>
      ({ button: 0, buttons, pointerId: 1, clientX, clientY, pointerType: 'mouse', isPrimary: true, preventDefault() {} }) as unknown as PointerEvent;
    const style = (canvas as any).mainCanvas.style;

    (canvas as any)._onPointerMove(mouse(0, 150, 140));
    expect(style.cursor).toBe('grab');
    (canvas as any)._onPointerMove(mouse(0, cancelCenter.x + 100, cancelCenter.y + 100));
    expect(style.cursor).toBe('pointer');
    (canvas as any)._onPointerDown(mouse(1, cancelCenter.x + 100, cancelCenter.y + 100));
    expect((canvas as any)._panning).toBe(false);
    (canvas as any)._onPointerUp(mouse(0, cancelCenter.x + 100, cancelCenter.y + 100));
    expect(cancel).toHaveBeenCalled();
  });

  it('lets a pen or mouse hovering during a finger drag move nothing', () => {
    const { canvas } = setupTool('select');
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(400, 400), 1, { x: 100, y: 100 });
    (canvas as any)._transformManager = tm;
    (canvas as any)._panX = 100;
    (canvas as any)._panY = 100;
    (canvas as any)._onPointerDown({ ...touch(1, 150, 140), isPrimary: true });
    (canvas as any)._onPointerMove({ ...touch(1, 160, 150), buttons: 1 });
    (canvas as any)._onPointerMove({ button: -1, buttons: 0, pointerId: 7, clientX: 380, clientY: 20, pointerType: 'pen', isPrimary: true, preventDefault() {} });
    (canvas as any)._onPointerUp({ ...touch(1, 160, 150), buttons: 0 });
    expect([tm.x, tm.y]).toEqual([10, 10]);
  });

  it('gives a float the touch layout when a finger lands under the hand tool, and still pans', () => {
    const { canvas } = setupTool('hand');
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(400, 400), 1, { x: 100, y: 100 });
    (canvas as any)._transformManager = tm;
    (canvas as any)._panX = 100;
    (canvas as any)._panY = 100;
    (canvas as any)._onPointerDown({ ...touch(1, 150, 140), isPrimary: true });
    expect(tm.touchMode).toBe(true);
    expect((canvas as any)._panning).toBe(true);
  });

  it('only applies a value typed in the panel on a press off the float, so it shows before a commit', () => {
    const { canvas } = setupTool('select');
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(100, 100), 1, { x: 100, y: 100 });
    (canvas as any)._transformManager = tm;
    (canvas as any)._panX = 100;
    (canvas as any)._panY = 100;
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    field.addEventListener('blur', () => { tm.rotation = 30; });
    const commit = vi.spyOn(canvas, 'commitTransform').mockImplementation(() => {});
    const click = { button: 0, pointerId: 1, clientX: 380, clientY: 380, pointerType: 'mouse', isPrimary: true, preventDefault() {} } as unknown as PointerEvent;

    (canvas as any)._onPointerDown(click);
    (canvas as any)._onPointerUp(click);
    expect(tm.rotation).toBeCloseTo(30);
    expect(commit).not.toHaveBeenCalled();

    (canvas as any)._onPointerDown(click);
    (canvas as any)._onPointerUp(click);
    expect(commit).toHaveBeenCalled();
    field.remove();
  });

  it('lets a lifted palm\'s leave pass without ending the pen stroke', () => {
    const { canvas } = setupTool('pencil');
    const pen = { button: 0, pointerId: 5, clientX: 20, clientY: 20, pointerType: 'pen', isPrimary: true, pressure: 0.5, preventDefault() {} };
    (canvas as any)._onPointerDown(pen);
    (canvas as any)._onPointerDown({ ...touch(6, 60, 60), isPrimary: true });
    (canvas as any)._onPointerUp(touch(6, 60, 60));
    (canvas as any)._onPointerLeave(touch(6, 60, 60));
    expect((canvas as any)._drawing).toBe(true);
  });

  it('treats touches already down when a pen lands as a palm, not a pinch', () => {
    const { canvas } = setupTool('pencil');
    (canvas as any)._onPointerDown({ ...touch(6, 60, 60), isPrimary: true });
    const pen = { button: 0, pointerId: 5, clientX: 20, clientY: 20, pointerType: 'pen', isPrimary: true, pressure: 0.5, preventDefault() {} };
    (canvas as any)._onPointerDown(pen);
    expect((canvas as any)._pinching).toBe(false);
    expect((canvas as any)._drawing).toBe(true);
  });

  it('puts the text caret back when a press in the text turns out to start a pinch', () => {
    const { canvas } = setupTool('text');
    (canvas as any)._textEditing = true;
    (canvas as any)._textPosition = { x: 10, y: 10 };
    const ta = (canvas as any)._textAreaEl ?? document.createElement('textarea');
    (canvas as any)._textAreaEl = ta;
    ta.value = 'Hello world';
    ta.selectionStart = ta.selectionEnd = 11;
    vi.spyOn(canvas as any, '_getTextBoundingBox').mockReturnValue({ x: 0, y: 0, w: 100, h: 40 });
    vi.spyOn(canvas as any, '_pointToTextOffset').mockReturnValue(1);
    (canvas as any)._onPointerDown(touch(1, 15, 15));
    expect(ta.selectionStart).toBe(1);
    (canvas as any)._onPointerDown(touch(2, 60, 60));
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([11, 11]);
    expect((canvas as any)._textSelecting).toBe(false);
  });

  it('redraws the crop frame when the view moves', () => {
    const { canvas } = setupTool('crop');
    (canvas as any)._cropRectValue = { x: 10, y: 10, w: 30, h: 30 };
    const draw = vi.spyOn(canvas as any, '_drawCropPreview');
    canvas.setViewport(2, 40, 30);
    expect(draw).toHaveBeenCalled();
  });

  it('places nothing when a touch stamp is lifted off the canvas', () => {
    const { canvas, stamp } = setupTool('stamp');
    (canvas as any)._onPointerDown(touch(1, 40, 40));
    (canvas as any)._onPointerUp(touch(1, -30, 40));
    expect(stamp).not.toHaveBeenCalled();
  });

  it('drops a paste that lands while a gesture has begun', async () => {
    const { canvas } = setupTool('pencil');
    (canvas as any)._systemClipboardWrite = Promise.resolve(false);
    const pasteSelection = vi.spyOn(canvas, 'pasteSelection').mockImplementation(() => {});
    (canvas as any)._pointers.set(1, { x: 0, y: 0, type: 'mouse' });
    await canvas.paste();
    expect(pasteSelection).not.toHaveBeenCalled();
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

  it('keeps an active float when switching to the select tool, and Ctrl+T switches to it', () => {
    const { app, canvas } = makeApp({ isTransformActive: vi.fn(() => true) });
    (app as any)._state = { ...(app as any)._state, activeTool: 'pencil' };
    (app as any)._buildContextValue().setTool('select');
    expect(canvas.commitTransform).not.toHaveBeenCalled();
    expect(canvas.clearSelection).not.toHaveBeenCalled();

    const other = makeApp();
    (other.app as any)._state = { ...(other.app as any)._state, activeTool: 'pencil' };
    (other.app as any)._onKeyDown(key('t'));
    expect((other.app as any)._state.activeTool).toBe('select');
    expect(other.canvas.enterTransformMode).toHaveBeenCalled();
  });

  it('keeps a float when V switches to the select tool, and ends it for Child Mode\'s pencil', () => {
    const { app, canvas } = makeApp({ isTransformActive: vi.fn(() => true) });
    (app as any)._state = { ...(app as any)._state, activeTool: 'stamp' };
    (app as any)._onKeyDown({ ...key('v'), ctrlKey: false });
    expect((app as any)._state.activeTool).toBe('select');
    expect(canvas.clearSelection).not.toHaveBeenCalled();

    (app as any)._state = { ...(app as any)._state, activeTool: 'select' };
    (app as any)._buildContextValue().setChildMode(true);
    expect(canvas.commitTransform).toHaveBeenCalled();
    expect((app as any)._state.activeTool).toBe('pencil');
  });

  it('keeps a float when the hand tool is chosen, by toolbar or H, so it can be panned around', () => {
    const { app, canvas } = makeApp({ isTransformActive: vi.fn(() => true) });
    (app as any)._state = { ...(app as any)._state, activeTool: 'select' };
    (app as any)._buildContextValue().setTool('hand');
    (app as any)._state = { ...(app as any)._state, activeTool: 'select' };
    (app as any)._onKeyDown({ ...key('h'), ctrlKey: false });
    expect((app as any)._state.activeTool).toBe('hand');
    expect(canvas.commitTransform).not.toHaveBeenCalled();
    expect(canvas.clearSelection).not.toHaveBeenCalled();
  });

  it('takes keys pressed with nothing focused, unless the user last clicked away from it or it can\'t take focus', () => {
    const { app } = makeApp();
    const handled = vi.fn();
    (app as any)._onKeyDown = handled;
    let takesFocus = true;
    vi.spyOn(app, 'focus').mockImplementation(() => {});
    const active = vi.spyOn(document, 'activeElement', 'get').mockImplementation(() => (takesFocus ? app : document.body));
    // What holds the editor (the page's body, or a host's dialog), not connected here.
    const holder = document.createElement('div');
    holder.append(app);
    const stray = { ...key('z'), target: holder, defaultPrevented: false } as unknown as KeyboardEvent;
    try {
      // Focus fell from something inside (a button disabled under it, say).
      (app as any)._onDocumentFocusIn({ composedPath: () => [app] });
      (app as any)._onStrayKeyDown(stray);
      expect(handled).toHaveBeenCalledTimes(1);
      // Tab goes on from where focus was.
      (app as any)._onStrayKeyDown({ ...stray, key: 'Tab' });
      expect(handled).toHaveBeenCalledTimes(1);
      // Hidden or inert: the page's keys aren't its.
      takesFocus = false;
      (app as any)._onStrayKeyDown(stray);
      expect(handled).toHaveBeenCalledTimes(1);
      takesFocus = true;

      (app as any)._onDocumentPointerDown({ composedPath: () => [document.body] });
      (app as any)._onStrayKeyDown(stray);
      expect(handled).toHaveBeenCalledTimes(1);

      (app as any)._onDocumentPointerDown({ composedPath: () => [app] });
      (app as any)._onStrayKeyDown({ ...stray, target: document.createElement('input') });
      expect(handled).toHaveBeenCalledTimes(1);
      // Focus moved into another editor by keyboard: not this one's either.
      (app as any)._onDocumentFocusIn({ composedPath: () => [document.createElement('drawing-app')] });
      (app as any)._onStrayKeyDown(stray);
      expect(handled).toHaveBeenCalledTimes(1);
    } finally {
      active.mockRestore();
    }
  });
  it('commits work in progress when taken out of the document, before it would be let go of', () => {
    const { app, canvas } = makeApp({ isTransformActive: vi.fn(() => true) });
    app.disconnectedCallback();
    expect(canvas.clearSelection).toHaveBeenCalled();
  });

  it('heeds a dialog or field inside itself, not a host page\'s dialog around it', () => {
    const { app } = makeApp();
    const hostDialog = document.createElement('dialog');
    hostDialog.setAttribute('open', '');
    const ownDialog = document.createElement('dialog');
    ownDialog.setAttribute('open', '');
    const keyIn = (...path: EventTarget[]) => ({ composedPath: () => path }) as unknown as KeyboardEvent;
    expect((app as any)._isTextEntryTarget(keyIn(app, hostDialog, document.body))).toBe(false);
    expect((app as any)._isTextEntryTarget(keyIn(ownDialog, app, hostDialog))).toBe(true);
    expect((app as any)._isTextEntryTarget(keyIn(document.createElement('input'), app))).toBe(true);
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

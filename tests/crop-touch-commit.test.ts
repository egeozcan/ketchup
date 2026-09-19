import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextProvider } from '@lit/context';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { drawingContext, type DrawingContextValue } from '../src/contexts/drawing-context.ts';
import { makeLayer, makeState } from './helpers.ts';

/**
 * Touch devices have no Enter key, so the crop must be committable from the
 * canvas itself. These tests drive the crop gesture the way a finger does and
 * assert the on-canvas Apply/Cancel buttons appear and work.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function touchEvent(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  return event as PointerEvent;
}

async function mountCropCanvas(width = 800, height = 600) {
  const host = document.createElement('div');
  const layer = makeLayer(width, height);
  const state = makeState({
    activeTool: 'crop',
    layers: [layer],
    activeLayerId: layer.id,
    documentWidth: width,
    documentHeight: height,
  });
  new ContextProvider(host, {
    context: drawingContext,
    initialValue: { state, isMobile: true, projectList: [] } as unknown as DrawingContextValue,
  });
  const canvas = new DrawingCanvas();
  host.append(canvas);
  document.body.append(host);
  await canvas.updateComplete;

  const main = canvas.shadowRoot!.querySelector<HTMLCanvasElement>('#main')!;
  main.width = width;
  main.height = height;
  // jsdom reports a zero-sized element; pin the viewport so document
  // coordinates match client coordinates.
  (canvas as any)._zoom = 1;
  (canvas as any)._panX = 0;
  (canvas as any)._panY = 0;
  (canvas as any)._invalidateCanvasRect();
  Object.defineProperty(main, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(main, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(main, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width, height }),
  });

  return { canvas, layer, main };
}

async function dragCrop(
  canvas: DrawingCanvas,
  main: HTMLCanvasElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  main.dispatchEvent(touchEvent('pointerdown', from.x, from.y));
  main.dispatchEvent(touchEvent('pointermove', to.x, to.y));
  main.dispatchEvent(touchEvent('pointerup', to.x, to.y));
  await canvas.updateComplete;
}

function cropButton(canvas: DrawingCanvas, label: string) {
  return Array.from(canvas.shadowRoot!.querySelectorAll<HTMLButtonElement>('.crop-actions button'))
    .find(button => button.textContent?.trim() === label);
}

describe('committing a crop without a keyboard', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('shows Apply and Cancel on the canvas once a touch drag defines a rect', async () => {
    const { canvas, main } = await mountCropCanvas();
    expect(cropButton(canvas, 'Apply')).toBeUndefined();

    await dragCrop(canvas, main, { x: 100, y: 100 }, { x: 300, y: 250 });

    expect((canvas as any)._cropRect).toMatchObject({ x: 100, y: 100, w: 200, h: 150 });
    expect(cropButton(canvas, 'Apply')).toBeDefined();
    expect(cropButton(canvas, 'Cancel')).toBeDefined();
  });

  it('crops the document when Apply is tapped', async () => {
    const { canvas, layer, main } = await mountCropCanvas();
    const commits: CustomEvent[] = [];
    canvas.addEventListener('crop-commit', e => commits.push(e as CustomEvent));

    await dragCrop(canvas, main, { x: 100, y: 100 }, { x: 300, y: 250 });
    cropButton(canvas, 'Apply')!.click();
    await canvas.updateComplete;

    expect(commits).toHaveLength(1);
    expect(commits[0].detail).toEqual({ width: 200, height: 150 });
    expect(layer.canvas.width).toBe(200);
    expect(layer.canvas.height).toBe(150);
    expect((canvas as any)._cropRect).toBeNull();
    expect(cropButton(canvas, 'Apply')).toBeUndefined();
  });

  it('drops the rect when Cancel is tapped', async () => {
    const { canvas, layer, main } = await mountCropCanvas();

    await dragCrop(canvas, main, { x: 100, y: 100 }, { x: 300, y: 250 });
    cropButton(canvas, 'Cancel')!.click();
    await canvas.updateComplete;

    expect((canvas as any)._cropRect).toBeNull();
    expect(layer.canvas.width).toBe(800);
    expect(cropButton(canvas, 'Cancel')).toBeUndefined();
  });

  it('keeps the actions hidden mid-drag and for a degenerate rect', async () => {
    const { canvas, main } = await mountCropCanvas();

    main.dispatchEvent(touchEvent('pointerdown', 100, 100));
    main.dispatchEvent(touchEvent('pointermove', 300, 250));
    await canvas.updateComplete;
    expect(cropButton(canvas, 'Apply')).toBeUndefined();

    main.dispatchEvent(touchEvent('pointerup', 300, 250));
    await canvas.updateComplete;
    expect(cropButton(canvas, 'Apply')).toBeDefined();

    // A tap that defines no area leaves nothing to commit.
    await dragCrop(canvas, main, { x: 400, y: 400 }, { x: 400, y: 400 });
    expect((canvas as any)._cropRect).toBeNull();
    expect(cropButton(canvas, 'Apply')).toBeUndefined();
  });

  it('keeps the rect committable when a pinch interrupts the drag', async () => {
    const { canvas, main } = await mountCropCanvas();

    // Drag the rect out leftwards/upwards so it has negative extents, then let
    // a second finger cancel the gesture.
    main.dispatchEvent(touchEvent('pointerdown', 300, 250));
    main.dispatchEvent(touchEvent('pointermove', 100, 100));
    await canvas.updateComplete;
    (canvas as any)._cancelCurrentTool(1);
    await canvas.updateComplete;

    expect((canvas as any)._cropRect).toMatchObject({ x: 100, y: 100, w: 200, h: 150 });
    expect(cropButton(canvas, 'Apply')).toBeDefined();
    expect(() => cropButton(canvas, 'Apply')!.click()).not.toThrow();
    await canvas.updateComplete;
    expect((canvas as any)._cropRect).toBeNull();
  });
});

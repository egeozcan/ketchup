import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { getDocHandlePositions, getRotationHandlePos, isInsideTransform } from '../src/transform/transform-handles.ts';
import { HANDLE_CONFIG_DESKTOP } from '../src/transform/transform-types.ts';
import { attachCanvasElements, makeCanvas, makeLayer, makeState } from './helpers.ts';

const none = { shift: false, ctrl: false, alt: false };
const ctrl = { shift: false, ctrl: true, alt: false };

function makeManager() {
  // A 100×80 float at the document's origin, at zoom 1.
  return new TransformManager(
    new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(300, 300), 1, { x: 0, y: 0 },
  );
}

function drag(tm: TransformManager, from: { x: number; y: number }, to: { x: number; y: number }, modifiers = ctrl) {
  tm.onPointerDown(from, modifiers);
  tm.onPointerMove(to, modifiers);
  tm.onPointerUp(to);
}

describe('perspective corners', () => {
  it('continues a re-grabbed corner from where it was left', () => {
    const tm = makeManager();
    drag(tm, { x: 100, y: 80 }, { x: 130, y: 100 });
    expect((tm as any)._perspectiveCorners.se).toEqual({ x: 30, y: 20 });

    // Grabbed again where it now is, and moved a little further.
    drag(tm, { x: 130, y: 100 }, { x: 125, y: 110 });
    expect((tm as any)._perspectiveCorners.se).toEqual({ x: 25, y: 30 });
  });

  it('puts the handles on the warped corners and halfway along the warped edges', () => {
    const tm = makeManager();
    drag(tm, { x: 100, y: 80 }, { x: 130, y: 100 });
    const positions = getDocHandlePositions((tm as any)._getCorners());
    expect(positions.se).toEqual({ x: 130, y: 100 });
    expect(positions.e).toEqual({ x: 115, y: 50 });
    expect(positions.s).toEqual({ x: 65, y: 90 });
    expect(positions.nw).toEqual({ x: 0, y: 0 });

    // Where the corner used to be is now just inside the float: a move, not a corner.
    tm.onPointerDown({ x: 100, y: 80 }, ctrl);
    expect((tm as any)._interaction.type).toBe('moving');
    tm.onPointerUp({ x: 100, y: 80 });
  });

  it('keeps the commit button and rotation handle clear of corners and edges dragged outward', () => {
    const tm = makeManager();
    // Out along the diagonal, where the commit button sat for the unwarped corner.
    drag(tm, { x: 100, y: 0 }, { x: 125, y: -25 });
    tm.onPointerDown({ x: 125, y: -25 }, ctrl);
    expect((tm as any)._interaction.type).toBe('perspective');
    expect(tm.onPointerUp({ x: 125, y: -25 })).toBeNull();

    // Both top corners up to where the rotation handle was: the top edge's
    // middle is a handle again, not the rotation handle.
    const flat = makeManager();
    drag(flat, { x: 0, y: 0 }, { x: 0, y: -30 });
    drag(flat, { x: 100, y: 0 }, { x: 100, y: -30 });
    flat.onPointerDown({ x: 50, y: -30 }, ctrl);
    expect((flat as any)._interaction.type).toBe('skewing');
  });

  it('keeps the rotation handle off the crossing of a symmetric bow-tie', () => {
    // The top and bottom corners on the right swapped: both edges' middles are the centre.
    const pos = getRotationHandlePos(
      [{ x: 0, y: 0 }, { x: 100, y: 80 }, { x: 100, y: 0 }, { x: 0, y: 80 }], HANDLE_CONFIG_DESKTOP, 1,
    );
    expect(Math.hypot(pos.x - 50, pos.y - 40)).toBeCloseTo(HANDLE_CONFIG_DESKTOP.rotationStemLength);
  });

  it('grabs the nearest of handles that have come together', () => {
    const tm = makeManager();
    // The bottom-right corner almost onto the bottom-left one.
    drag(tm, { x: 100, y: 80 }, { x: 3, y: 80 });
    tm.onPointerDown({ x: 0, y: 80 }, ctrl);
    expect((tm as any)._interaction).toMatchObject({ type: 'perspective', corner: 'sw' });
  });

  it('moves the float by its warped outline', () => {
    const tm = makeManager();
    drag(tm, { x: 100, y: 80 }, { x: 160, y: 140 });
    // Outside the original box, inside the warp.
    expect(tm.getCursor({ x: 120, y: 110 })).toBe('move');
    tm.onPointerDown({ x: 120, y: 110 }, none);
    expect((tm as any)._interaction.type).toBe('moving');
  });

  it('fills a self-intersecting outline by nonzero winding', () => {
    const bowTie = [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 40, y: 0 }, { x: 0, y: 30 }] as const;
    expect(isInsideTransform({ x: 5, y: 15 }, [...bowTie])).toBe(true);
    expect(isInsideTransform({ x: 35, y: 15 }, [...bowTie])).toBe(true);
    expect(isInsideTransform({ x: 20, y: 5 }, [...bowTie])).toBe(false);
  });

  it('reports a change only when the pointer moves something', () => {
    const tm = makeManager();
    expect(tm.onPointerMove({ x: 50, y: 40 }, none)).toBe(false);
    // Pressed outside: nothing happens until the pointer has moved a few pixels.
    tm.onPointerDown({ x: 200, y: 200 }, none);
    expect(tm.onPointerMove({ x: 201, y: 200 }, none)).toBe(false);
    expect(tm.onPointerMove({ x: 220, y: 200 }, none)).toBe(true);
    tm.onPointerUp({ x: 220, y: 200 });
    tm.onPointerDown({ x: 50, y: 40 }, none);
    expect(tm.onPointerMove({ x: 55, y: 40 }, none)).toBe(true);
  });
});

describe('pointer moves during a transform', () => {
  function setup() {
    const canvas = new DrawingCanvas();
    const layer = makeLayer(300, 300);
    (canvas as any)._ctx = { value: { state: makeState({ layers: [layer], activeLayerId: layer.id }) } };
    attachCanvasElements(canvas, 300, 300);
    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;
    (canvas as any)._transformManager = makeManager();
    const schedule = vi.spyOn(canvas, 'scheduleComposite');
    return { canvas, schedule };
  }

  it('does not recomposite while merely hovering', () => {
    const { canvas, schedule } = setup();
    (canvas as any)._onPointerMove({ clientX: 50, clientY: 40, pointerId: 1 } as PointerEvent);
    (canvas as any)._onPointerMove({ clientX: 60, clientY: 45, pointerId: 1 } as PointerEvent);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('recomposites a drag without redrawing thumbnails, which show only the layer', () => {
    const { canvas, schedule } = setup();
    (canvas as any)._samplingDirty = false;
    (canvas as any)._onPointerDown({ button: 0, clientX: 50, clientY: 40, pointerId: 1 } as PointerEvent);
    (canvas as any)._onPointerMove({ clientX: 60, clientY: 45, pointerId: 1 } as PointerEvent);
    expect(schedule).toHaveBeenCalledWith(false);
    // The sampling buffer merges the float in, so it is out of date.
    expect((canvas as any)._samplingDirty).toBe(true);
  });
});

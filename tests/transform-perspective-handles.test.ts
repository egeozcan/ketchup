import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { TransformManager } from '../src/transform/transform-manager.ts';
import {
  getCommitCancelPositions, getDocHandlePositions, getRotationHandlePos, isInsideTransform,
} from '../src/transform/transform-handles.ts';
import { HANDLE_CONFIG_DESKTOP, HANDLE_CONFIG_TOUCH } from '../src/transform/transform-types.ts';
import { attachCanvasElements, makeCanvas, makeLayer, makeState } from './helpers.ts';
import type { Point } from '../src/types.ts';

const none = { shift: false, ctrl: false, alt: false };
const ctrl = { shift: false, ctrl: true, alt: false };

function makeManager() {
  // A 100×80 float at the document's origin, at zoom 1, in from the screen's
  // edges so ✓/✗ sit at their usual place.
  return new TransformManager(
    new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(400, 400), 1, { x: 100, y: 100 },
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

  it('turns, flips and scales a warp with the rest of the transform', () => {
    const tm = makeManager();
    // Narrow the top: corners in, as a Ctrl-drag would.
    drag(tm, { x: 0, y: 0 }, { x: 20, y: 0 });
    drag(tm, { x: 100, y: 0 }, { x: 80, y: 0 });
    const round = (ps: { x: number; y: number }[]) => ps.map(p => [Math.round(p.x * 1e6) / 1e6 || 0, Math.round(p.y * 1e6) / 1e6 || 0]);
    expect(round((tm as any)._getCorners())).toEqual([[20, 0], [80, 0], [100, 80], [0, 80]]);

    // Mirrored about the centre: still narrow at the top.
    tm.flipH = true;
    expect(round((tm as any)._getCorners())).toEqual([[80, 0], [20, 0], [0, 80], [100, 80]]);
    tm.flipH = false;

    // Upside down: narrow at the bottom.
    tm.rotation = 180;
    expect(round((tm as any)._getCorners())).toEqual([[80, 80], [20, 80], [0, 0], [100, 0]]);
    tm.rotation = 0;

    // Typed in twice as wide: the taper doubles with it.
    tm.width = 200;
    expect(round((tm as any)._getCorners())).toEqual([[-10, 0], [110, 0], [150, 80], [-50, 80]]);

    // Dragged: the grabbed edge follows the pointer and the other side stays.
    const dragged = makeManager();
    drag(dragged, { x: 0, y: 0 }, { x: 20, y: 0 });
    drag(dragged, { x: 100, y: 0 }, { x: 80, y: 0 });
    // The right edge's handle, halfway down the warped right edge, out by 100.
    drag(dragged, { x: 90, y: 40 }, { x: 190, y: 40 }, none);
    expect(round((dragged as any)._getCorners())).toEqual([[20, 0], [180, 0], [200, 80], [0, 80]]);
  });

  it('keeps the opposite edge still when resizing a turned, flipped, skewed or scaled float', () => {
    const states: [string, (tm: TransformManager) => void][] = [
      ['rotated 90°', tm => { tm.rotation = 90; }],
      ['rotated 180°', tm => { tm.rotation = 180; }],
      ['flipped', tm => { tm.flipH = true; }],
      ['scaled', tm => { tm.width = 200; }],
      ['skewed', tm => { tm.skewX = 30; }],
    ];
    for (const [label, setup] of states) {
      for (const handle of ['se', 'e', 'n'] as const) {
        const tm = makeManager();
        setup(tm);
        const corners = () => (tm as any)._getCorners() as { x: number; y: number }[];
        const at = getDocHandlePositions(corners() as any)[handle];
        const opposite = { se: 0, e: 0, n: 2 }[handle];
        const fixed = corners()[opposite];
        const to = { x: at.x + 23, y: at.y + 17 };
        tm.onPointerDown(at, none);
        // Several steps, as a real drag makes.
        for (let i = 1; i <= 5; i++) tm.onPointerMove({ x: at.x + 23 * i / 5, y: at.y + 17 * i / 5 }, none);
        tm.onPointerUp(to);
        const after = corners();
        expect(after[opposite].x, `${label} ${handle}`).toBeCloseTo(fixed.x, 6);
        expect(after[opposite].y, `${label} ${handle}`).toBeCloseTo(fixed.y, 6);
        if (handle === 'se') {
          // A corner handle lands on the pointer.
          expect(after[2].x, `${label} ${handle}`).toBeCloseTo(to.x, 6);
          expect(after[2].y, `${label} ${handle}`).toBeCloseTo(to.y, 6);
        }
      }
    }
  });

  it('flips a float dragged past its opposite edge, in place', () => {
    const tm = makeManager();
    // The right edge (x = 100) dragged to x = -60: 60 wide, mirrored, left of 0.
    tm.onPointerDown({ x: 100, y: 40 }, none);
    tm.onPointerMove({ x: 40, y: 40 }, none);
    tm.onPointerMove({ x: -60, y: 40 }, none);
    tm.onPointerUp({ x: -60, y: 40 });
    expect(tm.flipH).toBe(true);
    expect(tm.width).toBeCloseTo(60, 6);
    expect(tm.getBounds()).toEqual({ x: -60, y: 0, w: 60, h: 80 });
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

  it('keeps the rotation handle on the top side of a float under 2 px tall, flipped or not', () => {
    for (const flipV of [false, true]) {
      const tm = makeManager();
      tm.height = 1;
      tm.flipV = flipV;
      const corners = (tm as any)._getCorners();
      const top = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
      const bottom = { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 };
      const pos = getRotationHandlePos(corners, HANDLE_CONFIG_DESKTOP, 1);
      // Out from the top edge, away from the bottom one.
      expect(Math.sign(pos.y - top.y), `flipV ${flipV}`).toBe(Math.sign(top.y - bottom.y));
    }
  });

  it('acts on a button only when pressed and released on it', () => {
    const tm = makeManager();
    const { cancelCenter } = getCommitCancelPositions((tm as any)._getCorners(), HANDLE_CONFIG_DESKTOP, 1);
    // A corner drag that ends over the cancel button keeps the transform.
    tm.onPointerDown({ x: 100, y: 80 }, ctrl);
    tm.onPointerMove(cancelCenter, ctrl);
    expect(tm.onPointerUp(cancelCenter)).toBeNull();
    // Pressed on a button and released off it: nothing. (The buttons follow
    // the corners, so where they are now.)
    const { commitCenter: commitNow } = getCommitCancelPositions((tm as any)._getCorners(), HANDLE_CONFIG_DESKTOP, 1);
    tm.onPointerDown(commitNow, none);
    expect(tm.onPointerMove({ x: 0, y: 0 }, none)).toBe(false);
    expect(tm.onPointerUp({ x: 0, y: 0 })).toBeNull();
    // Pressed and released on it.
    tm.onPointerDown(commitNow, none);
    expect(tm.onPointerUp(commitNow)).toBe('commit-button');
  });

  it('takes a press just beside a button and a release on it as a click on it', () => {
    const tm = makeManager();
    const { cancelCenter, buttonRadius } = getCommitCancelPositions((tm as any)._getCorners(), HANDLE_CONFIG_DESKTOP, 1);
    tm.onPointerDown({ x: cancelCenter.x + buttonRadius + 1, y: cancelCenter.y }, none);
    expect(tm.onPointerUp({ x: cancelCenter.x + buttonRadius - 1, y: cancelCenter.y })).toBe('cancel-button');
  });

  it('keeps the commit button off the rotation handle of a narrow float', () => {
    const tm = makeManager();
    tm.width = 8;
    tm.height = 200;
    const corners = (tm as any)._getCorners();
    const { commitCenter } = getCommitCancelPositions(corners, HANDLE_CONFIG_DESKTOP, 1);
    tm.onPointerDown(getRotationHandlePos(corners, HANDLE_CONFIG_DESKTOP, 1), none);
    expect((tm as any)._interaction.type).toBe('rotating');
    tm.onPointerUp({ x: 0, y: 0 });
    tm.onPointerDown(commitCenter, none);
    expect((tm as any)._interaction.type).toBe('button');
  });

  it('shows the cursor of what is dragged, pointing the way the handle lies', () => {
    const tm = makeManager();
    // Turned a quarter: the top handle is on the left, so it resizes sideways.
    tm.rotation = 90;
    const n = getDocHandlePositions((tm as any)._getCorners()).n;
    expect(tm.getCursor(n)).toBe('ew-resize');
    tm.onPointerDown(n, none);
    tm.onPointerMove({ x: n.x - 40, y: n.y + 300 }, none);
    // Far from any handle, still the dragged handle's cursor.
    expect(tm.getCursor({ x: n.x - 40, y: n.y + 300 })).toBe('ew-resize');
    tm.onPointerUp({ x: 0, y: 0 });
  });

  it('never puts ✓ or ✗ over a handle or the rotation handle, however the float is turned', () => {
    for (const config of [HANDLE_CONFIG_DESKTOP, HANDLE_CONFIG_TOUCH]) {
      for (const [w, h] of [[300, 250], [60, 300], [300, 60]]) {
        for (const flips of [[false, false], [true, false], [false, true], [true, true]]) {
          for (let deg = 0; deg < 360; deg += 5) {
            const tm = makeManager();
            tm.width = w;
            tm.height = h;
            [tm.flipH, tm.flipV] = flips;
            tm.rotation = deg;
            const corners = (tm as any)._getCorners();
            const { commitCenter, cancelCenter, buttonRadius } = getCommitCancelPositions(corners, config, 1);
            const targets = [...Object.values(getDocHandlePositions(corners)), getRotationHandlePos(corners, config, 1)];
            for (const t of targets) {
              for (const b of [commitCenter, cancelCenter]) {
                expect(Math.hypot(t.x - b.x, t.y - b.y), `${w}×${h} ${flips} ${deg}°`).toBeGreaterThan(buttonRadius);
              }
            }
          }
        }
      }
    }
  });

  it('points corner cursors diagonally whatever the float\'s proportions', () => {
    for (const [w, h] of [[300, 30], [40, 200]]) {
      const tm = makeManager();
      tm.width = w;
      tm.height = h;
      const corners = (tm as any)._getCorners();
      const pos = getDocHandlePositions(corners);
      expect(tm.getCursor(pos.nw), `${w}×${h}`).toBe('nwse-resize');
      expect(tm.getCursor(pos.ne), `${w}×${h}`).toBe('nesw-resize');
    }
  });

  it('acts on a button that moved between press and release (a typed value applied on blur)', () => {
    const tm = makeManager();
    const { commitCenter } = getCommitCancelPositions((tm as any)._getCorners(), HANDLE_CONFIG_DESKTOP, 1);
    tm.onPointerDown(commitCenter, none);
    tm.width = 200;
    expect(tm.onPointerUp(commitCenter)).toBe('commit-button');
  });

  it('moves by whole pixels, so a commit does not resample', () => {
    const tm = makeManager();
    tm.onPointerDown({ x: 50, y: 40 }, none);
    tm.onPointerMove({ x: 63.65, y: 47.3 }, none);
    tm.onPointerUp({ x: 63.65, y: 47.3 });
    expect([tm.x, tm.y]).toEqual([14, 7]);
  });

  it('resizes the box itself about its middle for a typed size, so X and Y stay its top-left', () => {
    const tm = makeManager();
    tm.width = 200;
    expect([tm.x, tm.width]).toEqual([-50, 200]);
    expect(tm.getBounds()).toMatchObject({ x: -50, w: 200 });
    tm.x = 0;
    expect(tm.getBounds()).toMatchObject({ x: 0, w: 200 });
  });

  it('takes a drifting finger outside the float as a tap, which commits', () => {
    const tm = makeManager();
    tm.setTouchMode(true);
    tm.onPointerDown({ x: 200, y: 200 }, none);
    expect(tm.onPointerMove({ x: 207, y: 204 }, none)).toBe(false);
    expect(tm.onPointerUp({ x: 207, y: 204 })).toBe('commit');
  });

  it('leaves a middle to move a float by when it is small on screen', () => {
    for (const touch of [false, true]) {
      const tm = new TransformManager(new ImageData(12, 12), { x: 0, y: 0, w: 12, h: 12 }, makeCanvas(300, 300), 1, { x: 0, y: 0 });
      tm.setTouchMode(touch);
      tm.onPointerDown({ x: 6, y: 6 }, none);
      expect((tm as any)._interaction.type, touch ? 'touch' : 'mouse').toBe('moving');
    }
  });

  it('puts ✗ level with ✓ beside an upright float', () => {
    const tm = makeManager();
    const { commitCenter, cancelCenter } = getCommitCancelPositions((tm as any)._getCorners(), HANDLE_CONFIG_DESKTOP, 1);
    expect(cancelCenter.y).toBeCloseTo(commitCenter.y, 9);
    expect(cancelCenter.x).toBeGreaterThan(commitCenter.x);
  });

  it('outlines a quarter-turned float where its pixels land, so its bounds are its size', () => {
    const tm = new TransformManager(new ImageData(111, 70), { x: 100, y: 100, w: 111, h: 70 }, makeCanvas(400, 400), 1, { x: 0, y: 0 });
    for (const deg of [90, 270]) {
      tm.rotation = deg;
      expect(tm.getBounds(), `${deg}°`).toMatchObject({ w: 70, h: 111 });
    }
  });

  it('commits a pen tap outside that drifts a little, rather than rotating', () => {
    const tm = makeManager();
    tm.onPointerDown({ x: 250, y: 250 }, none, 10);
    expect(tm.onPointerMove({ x: 257, y: 254 }, none)).toBe(false);
    expect(tm.onPointerUp({ x: 257, y: 254 })).toBe('commit');
  });

  it('lands a float turned by quarter turns on whole pixels, whatever its sides\' parity', () => {
    const tm = new TransformManager(new ImageData(111, 70), { x: 100, y: 100, w: 111, h: 70 }, makeCanvas(400, 400), 1, { x: 0, y: 0 });
    for (const deg of [90, 180, 270]) {
      tm.rotation = deg;
      const m = (tm as any)._matrix() as DOMMatrix;
      for (const [x, y] of [[0, 0], [111, 0], [0, 70], [111, 70]]) {
        const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
        expect(Math.abs(px - Math.round(px)), `${deg}°`).toBeLessThan(1e-9);
        expect(Math.abs(py - Math.round(py)), `${deg}°`).toBeLessThan(1e-9);
      }
    }
  });

  it('keeps ✓ and ✗ on screen, inside the float if need be', () => {
    // The float's top-right corner at the screen's top-right.
    const tm = new TransformManager(new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(100, 300), 1, { x: 0, y: 0 });
    const { commitCenter, cancelCenter, buttonRadius: r } = tm.getButtons();
    for (const c of [commitCenter, cancelCenter]) {
      expect(c.x - r).toBeGreaterThanOrEqual(0);
      expect(c.x + r).toBeLessThanOrEqual(100);
      expect(c.y - r).toBeGreaterThanOrEqual(0);
    }
    // And they still work where they are drawn.
    tm.onPointerDown(cancelCenter, none);
    expect(tm.onPointerUp(cancelCenter)).toBe('cancel-button');
  });

  it('keeps ✓ and ✗ on screen and off the handles and middle, wherever the float is on screen', () => {
    for (const config of [HANDLE_CONFIG_DESKTOP, HANDLE_CONFIG_TOUCH]) {
      for (const size of [40, 60, 100, 160]) {
        for (const [fx, fy] of [[0, 0], [400 - size, 0], [0, 400 - size], [400 - size, 400 - size], [150, 0], [400 - size, 150], [150, 150]]) {
          for (const deg of [0, 30, 90, 180]) {
            const tm = new TransformManager(new ImageData(size, size), { x: fx, y: fy, w: size, h: size }, makeCanvas(400, 400), 1, { x: 0, y: 0 });
            tm.setTouchMode(config === HANDLE_CONFIG_TOUCH);
            tm.rotation = deg;
            const corners = (tm as any)._getCorners();
            // A float itself partly off screen may leave no room at all.
            if (!corners.every((c: Point) => c.x >= 0 && c.x <= 400 && c.y >= 0 && c.y <= 400)) continue;
            const { commitCenter, cancelCenter, buttonRadius: r } = tm.getButtons();
            const at = `${config.shape} ${size}px at ${fx},${fy} ${deg}°`;
            const middle = { x: corners.reduce((a: number, c: Point) => a + c.x, 0) / 4, y: corners.reduce((a: number, c: Point) => a + c.y, 0) / 4 };
            for (const b of [commitCenter, cancelCenter]) {
              expect(b.x - r >= 0 && b.x + r <= 400 && b.y - r >= 0 && b.y + r <= 400, `${at} on screen`).toBe(true);
              for (const t of [...Object.values(getDocHandlePositions(corners)), getRotationHandlePos(corners, config, 1), middle]) {
                expect(Math.hypot(t.x - b.x, t.y - b.y), `${at} clear`).toBeGreaterThanOrEqual(r + config.size / 2 - 1e-9);
              }
            }
          }
        }
      }
    }
  });

  it('grabs a thin float\'s end handles from inside along its length', () => {
    const tm = new TransformManager(new ImageData(300, 10), { x: 0, y: 0, w: 300, h: 10 }, makeCanvas(600, 300), 1, { x: 100, y: 100 });
    tm.onPointerDown({ x: 296.5, y: 5 }, none);
    expect((tm as any)._interaction).toMatchObject({ type: 'resizing', handle: 'e' });
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

  it('keeps the transform cursor through updates of the context mid-drag', () => {
    const { canvas } = setup();
    (canvas as any)._onPointerDown({ button: 0, clientX: 100, clientY: 80, pointerId: 1 } as PointerEvent);
    (canvas as any)._onPointerMove({ clientX: 120, clientY: 90, pointerId: 1 } as PointerEvent);
    (canvas as any).willUpdate(new Map());
    expect(canvas.mainCanvas.style.cursor).toBe('nwse-resize');
  });

  it('pans with the middle button during a transform, and stops on release', () => {
    const { canvas } = setup();
    (canvas as any)._onPointerDown({ button: 1, clientX: 50, clientY: 40, pointerId: 2, preventDefault() {} } as unknown as PointerEvent);
    (canvas as any)._onPointerMove({ clientX: 80, clientY: 60, pointerId: 2 } as PointerEvent);
    expect([(canvas as any)._panX, (canvas as any)._panY]).toEqual([30, 20]);
    (canvas as any)._onPointerUp({ clientX: 80, clientY: 60, pointerId: 2 } as PointerEvent);
    expect((canvas as any)._panning).toBe(false);
    // The float didn't move.
    expect((canvas as any)._transformManager.x).toBe(0);
  });

  it('takes a first touch on the ✗ drawn for the mouse as a tap on it', () => {
    const { canvas } = setup();
    const tm = (canvas as any)._transformManager as TransformManager;
    const { cancelCenter } = getCommitCancelPositions((tm as any)._getCorners(), HANDLE_CONFIG_DESKTOP, 1);
    const cancel = vi.spyOn(canvas, 'cancelTransform').mockImplementation(() => {});
    const touch = { button: 0, clientX: cancelCenter.x, clientY: cancelCenter.y, pointerId: 3, pointerType: 'touch' };
    (canvas as any)._onPointerDown(touch as PointerEvent);
    (canvas as any)._onPointerUp(touch as PointerEvent);
    expect(cancel).toHaveBeenCalled();
  });

  it('shows the transform cursor on the canvas, whose own cursor would hide the host\'s', () => {
    const { canvas } = setup();
    (canvas as any)._onPointerMove({ clientX: 50, clientY: 40, pointerId: 1 } as PointerEvent);
    expect(canvas.mainCanvas.style.cursor).toBe('move');
    (canvas as any)._onPointerMove({ clientX: 100, clientY: 80, pointerId: 1 } as PointerEvent);
    expect(canvas.mainCanvas.style.cursor).toBe('nwse-resize');
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

describe('✓/✗ order', () => {
  it('reads ✓ then ✗ left to right, from a left-hand corner or on a float turned around', () => {
    // Turned half way round: the top-right corner is at the bottom left.
    const turned = makeManager();
    turned.rotation = 180;
    // Against the screen's right edge: they sit out from a left-hand corner.
    const edge = new TransformManager(
      new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(400, 400), 1, { x: 290, y: 150 },
    );
    for (const tm of [turned, edge, makeManager()]) {
      const { commitCenter, cancelCenter } = tm.getButtons();
      expect(cancelCenter.x).toBeGreaterThan(commitCenter.x);
    }
  });
});

describe('✓/✗ with little room', () => {
  // A 60px float turned 45°, 6px in from the top-right corner of a phone screen.
  function wedged() {
    const tm = new TransformManager(
      new ImageData(60, 60), { x: 0, y: 0, w: 60, h: 60 }, makeCanvas(390, 844), 1, { x: 311.6, y: 18.4 },
    );
    tm.rotation = 45;
    tm.setTouchMode(true);
    return tm;
  }

  it('finds a spot clear of the middle and every handle when the usual ones are off screen', () => {
    const tm = wedged();
    const corners = (tm as any)._getCorners();
    const targets = { middle: { x: 30, y: 30 }, ...getDocHandlePositions(corners) };
    for (const [name, p] of Object.entries(targets)) {
      expect(['commit', 'cancel'], name).not.toContain(tm.hitKind(p));
    }
  });

  it('keeps them back from the screen edges on touch, where the toolbar takes a finger', () => {
    // Where ✗ would usually go, its edge is 3px from the screen's.
    const pan = { x: 190, y: 400 };
    const tm = new TransformManager(
      new ImageData(100, 80), { x: 0, y: 0, w: 100, h: 80 }, makeCanvas(390, 844), 1, pan,
    );
    tm.setTouchMode(true);
    const { commitCenter, cancelCenter, buttonRadius: r } = tm.getButtons();
    for (const c of [commitCenter, cancelCenter]) {
      const x = c.x + pan.x, y = c.y + pan.y;
      expect(Math.min(x - r, 390 - x - r, y - r, 844 - y - r)).toBeGreaterThanOrEqual(12);
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine, type PenTilt } from '../src/engine/stamp-stroke.ts';
import { normalizeDynamics } from '../src/engine/brush-presets.ts';
import { pointerTilt } from '../src/utils/pointer-pressure.ts';
import type { TipDescriptor } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

interface Dab {
  x: number;
  y: number;
  /** How far the dab's transform reaches a unit circle along a direction (1 = as untransformed). */
  along: (angle: number) => number;
}

/** Dabs with where they land and how they're stretched, read from the transform at each draw. */
function dabs(tilt: number, pens: PenTilt[], tip: Partial<TipDescriptor> = {}, stabilizerMs = 0): Dab[] {
  const out: Dab[] = [];
  const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 100) return;
    const m = this.getTransform();
    const cx = (args[1] as number) + (args[3] as number) / 2;
    const cy = (args[2] as number) + (args[4] as number) / 2;
    out.push({
      x: m.m11 * cx + m.m21 * cy + m.m41,
      y: m.m12 * cx + m.m22 * cy + m.m42,
      // The support of the mapped unit circle along u: |Mᵀu|.
      along: angle => {
        const ux = Math.cos(angle), uy = Math.sin(angle);
        return Math.hypot(m.m11 * ux + m.m12 * uy, m.m21 * ux + m.m22 * uy);
      },
    });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 10, spacing: 0.25, pressureSize: false, tip, dynamics: { tilt } }), '#000000', false, 1000, 200, { stabilizerMs });
  pens.forEach((pen, i) => engine.stroke(20 + i * 10, 100, 1, undefined, i * 4, pen));
  engine.commit(document.createElement('canvas').getContext('2d')!);
  spy.mockRestore();
  return out;
}

const repeat = (pen: PenTilt, n = 6) => Array.from({ length: n }, () => pen);

describe('tilt dynamics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stretch a dab along the way the pen leans, by how far it leans', () => {
    // Leaning 60° toward +y, across a stroke along x.
    const all = dabs(1, repeat({ tiltX: 0, tiltY: 60 }));
    const dab = all[all.length - 1];
    expect(dab.along(Math.PI / 2)).toBeCloseTo(1 + 2 * (60 / 90), 5);
    expect(dab.along(0)).toBeCloseTo(1, 5);
    // Still centred where it was.
    expect(dab.y).toBeCloseTo(100, 5);

    // Half the setting, half the extra length.
    const half = dabs(0.5, repeat({ tiltX: 0, tiltY: 60 }));
    expect(half[half.length - 1].along(Math.PI / 2)).toBeCloseTo(1 + 60 / 90, 5);
  });

  it('lean along a diagonal from both tilts', () => {
    const all = dabs(1, repeat({ tiltX: 45, tiltY: 45 }));
    const dab = all[all.length - 1];
    // tan 45° each way: the lean is atan(√2) from upright, toward 45°.
    const expected = 1 + 2 * (Math.atan(Math.SQRT2) / (Math.PI / 2));
    expect(dab.along(Math.PI / 4)).toBeCloseTo(expected, 5);
    expect(dab.along(-Math.PI / 4)).toBeCloseTo(1, 5);
  });

  it('leave dabs alone when off, or with the pen upright', () => {
    for (const all of [dabs(0, repeat({ tiltX: 0, tiltY: 60 })), dabs(1, repeat({ tiltX: 0, tiltY: 0 }))]) {
      for (const dab of all) {
        expect(dab.along(0)).toBeCloseTo(1, 9);
        expect(dab.along(Math.PI / 2)).toBeCloseTo(1, 9);
      }
    }
  });

  it('stretch along the lean whatever way a direction-following tip turns', () => {
    // A flat tip turned along a stroke heading +x: its own height runs along y.
    const all = dabs(1, repeat({ tiltX: 60, tiltY: 0 }), { shape: 'flat', aspect: 3, angle: 90, orientation: 'direction' });
    const dab = all[all.length - 1];
    // The tip's own axes are turned a quarter; the lean still stretches x only.
    expect(dab.along(0)).toBeCloseTo(1 + 2 * (60 / 90), 5);
    expect(dab.along(Math.PI / 2)).toBeCloseTo(1, 5);
  });

  it('carry tilt along the path, so dabs between two samples lean in between', () => {
    const pens = [...repeat({ tiltX: 0, tiltY: 0 }, 4), ...repeat({ tiltX: 0, tiltY: 60 }, 4)];
    const stretches = dabs(1, pens).map(d => d.along(Math.PI / 2));
    const between = stretches.filter(s => s > 1.05 && s < 2.28);
    expect(between.length).toBeGreaterThanOrEqual(3);
    // Rising, never back.
    for (let i = 1; i < stretches.length; i++) expect(stretches[i]).toBeGreaterThanOrEqual(stretches[i - 1] - 1e-9);
  });

  /**
   * Steps between neighbouring dabs, each in the frame of the dab before
   * (where its footprint is w × h about the origin), so (|qx|/w, |qy|/h)
   * inside the unit square (or, for ellipses, circle) means they touch.
   */
  function steps(brush: Parameters<typeof makeBrush>[0], feed: (engine: StampStrokeEngine) => void) {
    const dabs: { m: DOMMatrix; w: number; h: number }[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 200) return;
      dabs.push({ m: this.getTransform(), w: args[3] as number, h: args[4] as number });
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush(brush), '#000000', false, 2000, 400);
    feed(engine);
    engine.commit(document.createElement('canvas').getContext('2d')!);
    spy.mockRestore();
    return dabs.slice(1).map((next, i) => {
      const { m, w, h } = dabs[i];
      const dx = next.m.m41 - m.m41, dy = next.m.m42 - m.m42;
      const det = m.m11 * m.m22 - m.m21 * m.m12;
      return {
        x: Math.abs((m.m22 * dx - m.m21 * dy) / det) / w,
        y: Math.abs((-m.m12 * dx + m.m11 * dy) / det) / h,
        from: { x: m.m41, y: m.m42 },
      };
    });
  }

  it('keep bar dabs touching when a lean across them shears them', () => {
    // A long flat bar along the stroke, spaced wide, with a pen leaning
    // diagonally: stretched along 45°, each bar turns and thins across the
    // stroke, and at the upright spacing neighbours would no longer touch.
    const all = steps({
      size: 60, spacing: 0.6, pressureSize: false,
      tip: { shape: 'flat', aspect: 6, angle: 0, orientation: 'direction' },
      dynamics: { tilt: 1 },
    }, engine => {
      for (let i = 0; i <= 40; i++) engine.stroke(20 + i * 20, 100, 1, undefined, i * 4, { tiltX: 60, tiltY: 60 });
    });
    expect(all.length).toBeGreaterThan(10);
    for (const q of all) {
      expect(q.x).toBeLessThan(1);
      expect(q.y).toBeLessThan(1);
    }
  });

  it('space each bar dab by the way its own part of the stroke heads', () => {
    // The last sample turns the stroke diagonal while the spline is still
    // laying the level part before it.
    const all = steps({
      size: 60, spacing: 0.6, pressureSize: false,
      tip: { shape: 'flat', aspect: 6, angle: 0, orientation: 'fixed' },
      dynamics: { tilt: 1 },
    }, engine => {
      [[100, 200], [200, 200], [300, 200], [400, 300]].forEach(([x, y], i) =>
        engine.stroke(x, y, 1, undefined, i * 4, { tiltX: 60, tiltY: 60 }));
    });
    // The level run (a fixed bar on the diagonal after it gaps even upright,
    // spaced by its size rather than its reach that way).
    const level = all.filter(q => q.from.y < 201);
    expect(level.length).toBeGreaterThan(5);
    for (const q of level) {
      expect(q.x).toBeLessThan(1);
      expect(q.y).toBeLessThan(1);
    }
  });

  it('keep calligraphy dabs touching by their rounded ends', () => {
    const all = steps({
      size: 120, spacing: 0.9, pressureSize: false,
      tip: { shape: 'calligraphy', aspect: 6, angle: 0, orientation: 'fixed' },
      dynamics: { tilt: 0.25 },
    }, engine => {
      for (let i = 0; i <= 20; i++) engine.stroke(100 + i * 40, 200, 1, undefined, i * 4, { tiltX: 60, tiltY: 60 });
    });
    expect(all.length).toBeGreaterThan(5);
    for (const q of all) expect(Math.hypot(q.x, q.y)).toBeLessThan(1);
  });

  it('cover the stretched dab in the dirty bounds', () => {
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 10, pressureSize: false, dynamics: { tilt: 1 } }), '#000000', false, 1000, 200);
    engine.stroke(100, 100, 1, undefined, 0, { tiltX: 0, tiltY: 89 });
    const b = engine.getDirtyBounds()!;
    // Nearly flat: about three times as long, 15 px each way of the centre.
    expect(b.y).toBeLessThanOrEqual(100 - 14.5);
    expect(b.y + b.h).toBeGreaterThanOrEqual(100 + 14.5);
  });

  it('ignore tilt reported as not a number, and clamp a flat pen', () => {
    const nan = dabs(1, repeat({ tiltX: NaN, tiltY: NaN }));
    expect(nan[nan.length - 1].along(0)).toBeCloseTo(1, 9);
    const flat = dabs(1, repeat({ tiltX: 90, tiltY: 0 }));
    expect(flat[flat.length - 1].along(0)).toBeCloseTo(3, 2);
  });

  it('is stored clamped to 0..1', () => {
    expect(normalizeDynamics({ tilt: 3 }).tilt).toBe(1);
    expect(normalizeDynamics({ tilt: -1 }).tilt).toBe(0);
    expect(normalizeDynamics({}).tilt).toBe(0);
  });
});

describe('pointerTilt', () => {
  it('reads a pen tilt, and counts anything but a pen as upright', () => {
    expect(pointerTilt({ pointerType: 'pen', tiltX: 30, tiltY: -20 })).toEqual({ tiltX: 30, tiltY: -20 });
    expect(pointerTilt({ pointerType: 'mouse', tiltX: 30, tiltY: -20 })).toEqual({ tiltX: 0, tiltY: 0 });
    expect(pointerTilt({ pointerType: 'touch', tiltX: 30, tiltY: 0 })).toEqual({ tiltX: 0, tiltY: 0 });
  });

  it('works it out from altitude and azimuth where only they are given', () => {
    const lean45 = pointerTilt({ pointerType: 'pen', altitudeAngle: Math.PI / 4, azimuthAngle: 0 });
    expect(lean45.tiltX).toBeCloseTo(45);
    expect(lean45.tiltY).toBeCloseTo(0);
    const flatDown = pointerTilt({ pointerType: 'pen', altitudeAngle: 0, azimuthAngle: Math.PI / 2 });
    expect(flatDown.tiltY).toBeCloseTo(90);
    expect(Math.abs(flatDown.tiltX)).toBeLessThan(1e-6);
    const upright = pointerTilt({ pointerType: 'pen', altitudeAngle: Math.PI / 2, azimuthAngle: 1 });
    expect(Math.abs(upright.tiltX)).toBeLessThan(1e-6);
    expect(Math.abs(upright.tiltY)).toBeLessThan(1e-6);
    expect(pointerTilt({ pointerType: 'pen' })).toEqual({ tiltX: 0, tiltY: 0 });
  });
});

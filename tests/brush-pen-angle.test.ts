import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine, tiltAzimuth, type PenTilt } from '../src/engine/stamp-stroke.ts';
import { PathSmoother } from '../src/engine/path-smoother.ts';
import { Stabilizer } from '../src/engine/stabilizer.ts';
import { lerpDegrees, wrapDegrees } from '../src/engine/angle.ts';
import { copyDescriptor } from '../src/engine/brush-presets.ts';
import { pointerTwist } from '../src/utils/pointer-pressure.ts';
import type { OrientationMode, TipDescriptor } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

interface Dab {
  x: number;
  y: number;
  /** The dab's turn, in degrees (0..360), read from its transform. */
  turn: number;
  /** The matrix and the rectangle drawn through it. */
  m: DOMMatrix;
  w: number;
  h: number;
}

/** Dabs of a stroke along x, one pen sample per `step` px, with where they land and how they're turned. */
function strokeDabs(
  tip: Partial<TipDescriptor>,
  pens: (PenTilt | undefined)[],
  extra: { tilt?: number; spacing?: number; step?: number } = {},
): Dab[] {
  const out: Dab[] = [];
  const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 100) return;
    const m = this.getTransform();
    const w = args[3] as number, h = args[4] as number;
    const cx = (args[1] as number) + w / 2, cy = (args[2] as number) + h / 2;
    out.push({
      x: m.m11 * cx + m.m21 * cy + m.m41,
      y: m.m12 * cx + m.m22 * cy + m.m42,
      turn: wrapDegrees(Math.atan2(m.m12, m.m11) * 180 / Math.PI),
      m, w, h,
    });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({
    size: 10, spacing: extra.spacing ?? 0.25, pressureSize: false, tip, dynamics: { tilt: extra.tilt ?? 0 },
  }), '#000000', false, 1000, 200, { seed: 1 });
  const step = extra.step ?? 10;
  pens.forEach((pen, i) => engine.stroke(20 + i * step, 100, 1, undefined, i * 4, pen));
  engine.commit(document.createElement('canvas').getContext('2d')!);
  spy.mockRestore();
  return out;
}

const repeat = <T>(v: T, n = 8) => Array.from({ length: n }, () => v);
/** Turns compared on the circle, so 359.9999 equals 0. */
const near = (a: number, b: number, eps = 1e-6) => Math.abs(wrapDegrees(a - b + 180) - 180) < eps;

describe('angles on the circle', () => {
  it('lerps the short way round', () => {
    expect(lerpDegrees(359, 1, 0.5)).toBeCloseTo(0, 9);
    expect(lerpDegrees(1, 359, 0.25)).toBeCloseTo(0.5, 9);
    expect(lerpDegrees(90, 270, 0)).toBe(90);
    expect(lerpDegrees(10, 100, 0.5)).toBeCloseTo(55, 9);
    expect(wrapDegrees(-90)).toBe(270);
    expect(wrapDegrees(720)).toBe(0);
  });

  it('carries twist between samples without a sweep at the wrap', () => {
    const smoother = new PathSmoother();
    const stamps = [
      ...smoother.addPoint(0, 0, 1, 2, 0, { twist: 350 }),
      ...smoother.addPoint(40, 0, 1, 2, 10, { twist: 10 }),
      ...smoother.addPoint(80, 0, 1, 2, 20, { twist: 10 }),
      ...smoother.addPoint(120, 0, 1, 2, 30, { twist: 10 }),
    ];
    expect(stamps.length).toBeGreaterThan(10);
    for (const s of stamps) expect(Math.abs(wrapDegrees(s.twist + 180) - 180)).toBeLessThanOrEqual(10 + 1e-9);
    // It does move on, from one end to the other.
    expect(stamps[0].twist).toBe(350);
    expect(near(stamps[stamps.length - 1].twist, 10, 1e-6)).toBe(true);
  });

  it('reads the stabilized twist along the short arc', () => {
    const s = new Stabilizer();
    s.reset(50, 0);
    s.add(0, 0, 1, 0, 0, 0, 350);
    const seen: number[] = [];
    for (let i = 1; i <= 30; i++) seen.push(s.add(i * 4, 0, 1, i * 4, 0, 0, 10).twist);
    for (const t of seen) expect(Math.abs(wrapDegrees(t + 180) - 180)).toBeLessThanOrEqual(10 + 1e-9);
    const tail = s.catchUp();
    expect(near(tail[tail.length - 1].twist, 10)).toBe(true);
  });

  it('interpolates opposite-ish azimuths through the lean vector, not a sweep', () => {
    // Azimuth 10 to 350 degrees at the same lean: the midpoint leans toward 0.
    const rad = (d: number) => d * Math.PI / 180;
    const a = { x: 40 * Math.cos(rad(10)), y: 40 * Math.sin(rad(10)) };
    const b = { x: 40 * Math.cos(rad(350)), y: 40 * Math.sin(rad(350)) };
    const smoother = new PathSmoother();
    const stamps = [
      ...smoother.addPoint(0, 0, 1, 2, 0, { tiltX: a.x, tiltY: a.y }),
      ...smoother.addPoint(40, 0, 1, 2, 10, { tiltX: b.x, tiltY: b.y }),
    ];
    const mid = stamps[Math.floor(stamps.length / 2)];
    expect(tiltAzimuth(mid.tiltX, mid.tiltY)! * 180 / Math.PI).toBeCloseTo(0, 0);
  });
});

describe('pointerTwist', () => {
  it('is the pen\'s twist wrapped, and 0 for anything else', () => {
    expect(pointerTwist({ pointerType: 'pen', twist: 90 })).toBe(90);
    expect(pointerTwist({ pointerType: 'pen', twist: 370 })).toBe(10);
    expect(pointerTwist({ pointerType: 'pen' })).toBe(0);
    expect(pointerTwist({ pointerType: 'pen', twist: NaN })).toBe(0);
    expect(pointerTwist({ pointerType: 'mouse', twist: 90 })).toBe(0);
  });
});

describe('tip orientation from the pen', () => {
  afterEach(() => vi.restoreAllMocks());

  const flat = (orientation: OrientationMode, angle = 0): Partial<TipDescriptor> => ({ shape: 'flat', aspect: 3, angle, orientation });

  it('turns the dab toward where the pen leans, plus the offset', () => {
    const down = strokeDabs(flat('tilt'), repeat({ tiltX: 0, tiltY: 50 }));
    expect(down.length).toBeGreaterThan(5);
    for (const d of down) expect(near(d.turn, 90)).toBe(true);

    const left = strokeDabs(flat('tilt', 30), repeat({ tiltX: -50, tiltY: 0 }));
    for (const d of left) expect(near(d.turn, 180 + 30)).toBe(true);
  });

  it('turns the dab with the pen barrel, plus the offset', () => {
    const dabs = strokeDabs(flat('twist', 20), repeat({ tiltX: 0, tiltY: 0, twist: 100 }));
    expect(dabs.length).toBeGreaterThan(5);
    for (const d of dabs) expect(near(d.turn, 120)).toBe(true);
  });

  it('follows the pen as it changes, across the 360 wrap', () => {
    const pens = [350, 350, 355, 0, 5, 10, 10, 10].map(twist => ({ tiltX: 0, tiltY: 0, twist }));
    const dabs = strokeDabs(flat('twist'), pens);
    for (const d of dabs) expect(Math.abs(wrapDegrees(d.turn + 180) - 180)).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('turns a mouse\'s dabs by the offset only, as fixed does', () => {
    const fixed = strokeDabs(flat('fixed', 40), repeat(undefined));
    expect(fixed.length).toBeGreaterThan(5);
    for (const mode of ['tilt', 'twist'] as const) {
      const dabs = strokeDabs(flat(mode, 40), repeat(undefined));
      expect(dabs.map(d => [d.x, d.y, d.turn])).toEqual(fixed.map(d => [d.x, d.y, d.turn]));
    }
  });

  it('keeps its angle when the pen comes upright, and starts at the offset', () => {
    const pens = [...repeat({ tiltX: 0, tiltY: 0 }, 3), ...repeat({ tiltX: 0, tiltY: 60 }, 4), ...repeat({ tiltX: 0, tiltY: 0 }, 4)];
    const dabs = strokeDabs(flat('tilt', 10), pens);
    expect(near(dabs[0].turn, 10)).toBe(true);
    expect(near(dabs[dabs.length - 1].turn, 100)).toBe(true);
    // Never snaps back to the offset once the pen has led.
    const first = dabs.findIndex(d => near(d.turn, 100));
    for (const d of dabs.slice(first + 3)) expect(near(d.turn, 100)).toBe(true);
  });

  it('treats a barely leaning pen as upright', () => {
    expect(tiltAzimuth(0, 0)).toBeNull();
    expect(tiltAzimuth(0.2, 0.2)).toBeNull();
    expect(tiltAzimuth(0, 30)! * 180 / Math.PI).toBeCloseTo(90, 9);
    expect(tiltAzimuth(NaN, NaN)).toBeNull();
  });

  it('copies the new orientations with the descriptor and keeps old brushes working', () => {
    const brush = makeBrush({ tip: flat('twist', 15) });
    expect(copyDescriptor(brush).tip).toEqual(brush.tip);
    // A stored brush with an old mode strokes as before.
    for (const mode of ['fixed', 'direction'] as const) {
      const dabs = strokeDabs(flat(mode, 15), repeat(undefined));
      expect(dabs.length).toBeGreaterThan(5);
      expect(near(dabs[0].turn, 15)).toBe(true);
    }
    const dir = strokeDabs(flat('direction', 15), repeat(undefined));
    expect(near(dir[dir.length - 1].turn, 15)).toBe(true);
  });

  describe('spacing of a bar tip', () => {
    // Two copies of a centrally symmetric dab, pushed apart along x, touch up to
    // the distance at which the pushed offset leaves twice the (mapped) rectangle.
    function reachAlongX(d: Dab): number {
      // The dab-frame point that a unit push along x comes from: M⁻¹(1, 0).
      const det = d.m.m11 * d.m.m22 - d.m.m21 * d.m.m12;
      const ux = d.m.m22 / det, uy = -d.m.m12 / det;
      return Math.min(d.w / Math.abs(ux || 1e-12), d.h / Math.abs(uy || 1e-12));
    }

    const gap = (dabs: Dab[], i: number) => Math.hypot(dabs[i + 1].x - dabs[i].x, dabs[i + 1].y - dabs[i].y);

    // The lean shears the bar so its reach along the stroke shrinks (from about
    // 10 to 7 px here): the gap closes up by the same share, so dabs that touched
    // without the lean still do. A rotation taken from anywhere but the pen
    // (the tip's own offset, the stroke's direction) shears it differently.
    it.each([
      ['tilt', { tiltX: 60, tiltY: 60 }, 150],
      ['twist', { tiltX: 60, tiltY: 60, twist: 45 }, 150],
    ] as const)('closes up the gap of sheared %s dabs by the reach they lost', (mode, pen, offset) => {
      const tip = flat(mode, offset);
      const leaning = strokeDabs(tip, repeat(pen, 24), { tilt: 1, spacing: 0.35 });
      // Upright reach: the same turn without the stretch (tilt dynamics off).
      const plain = strokeDabs(tip, repeat(pen, 24), { tilt: 0, spacing: 0.35 });
      const kept = reachAlongX(leaning[8]) / reachAlongX(plain[8]);
      expect(kept).toBeLessThan(0.8);
      expect(kept).toBeGreaterThan(0.3);
      for (let i = 4; i < 14; i++) expect(gap(leaning, i)).toBeCloseTo(3.5 * kept, 1);
    });
  });
});

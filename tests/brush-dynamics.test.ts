import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine, type StrokeOptions } from '../src/engine/stamp-stroke.ts';
import { normalizeDynamics, NO_DYNAMICS } from '../src/engine/brush-presets.ts';
import type { BrushDynamics } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

interface Dab { x: number; w: number; alpha: number }

/**
 * Dabs of a straight stroke moving `step` document px every 4 ms, read off
 * drawImage itself (the canvas mock records the wrong size for scaled draws).
 * The stroke buffer going onto the layer is left out.
 */
function dabs(dynamics: Partial<BrushDynamics>, step: number, options: StrokeOptions = {}, size = 20): Dab[] {
  const out: Dab[] = [];
  const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 1000) return;
    out.push({ x: (args[1] as number) + (args[3] as number) / 2, w: args[3] as number, alpha: this.globalAlpha });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size, spacing: 0.25, flow: 1, pressureSize: false, pressureOpacity: false, dynamics }), '#000000', false, 4000, 100, options);
  for (let i = 0, t = 0; i <= 40; i++, t += 4) engine.stroke(10 + i * step, 50, 1, undefined, t);
  engine.commit(document.createElement('canvas').getContext('2d')!);
  spy.mockRestore();
  return out;
}

const steady = (all: Dab[]) => all[all.length - 1];

describe('speed dynamics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leave dabs alone when off', () => {
    expect(steady(dabs(NO_DYNAMICS, 1)).w).toBeCloseTo(20);
    expect(steady(dabs(NO_DYNAMICS, 16)).w).toBeCloseTo(20);
  });

  it('thin a fast stroke with negative size by speed, and thicken it with positive', () => {
    const slowThin = steady(dabs({ sizeVelocity: -1 }, 0.5)).w;
    const fastThin = steady(dabs({ sizeVelocity: -1 }, 12)).w;
    expect(fastThin).toBeLessThan(slowThin * 0.6);
    expect(slowThin).toBeGreaterThan(15);

    const slowThick = steady(dabs({ sizeVelocity: 1 }, 0.5)).w;
    const fastThick = steady(dabs({ sizeVelocity: 1 }, 12)).w;
    expect(fastThick).toBeGreaterThan(slowThick * 2);
    expect(fastThick).toBeLessThanOrEqual(20 + 1e-9);
  });

  it('lower flow on a fast stroke with negative flow by speed', () => {
    const slow = steady(dabs({ flowVelocity: -0.8 }, 0.5)).alpha;
    const fast = steady(dabs({ flowVelocity: -0.8 }, 12)).alpha;
    expect(slow).toBeGreaterThan(0.85);
    expect(fast).toBeLessThan(0.3);
  });

  it('go by speed on screen, so zooming in does not change how a gesture draws', () => {
    const atFit = steady(dabs({ sizeVelocity: -1 }, 2)).w;
    const zoomed = steady(dabs({ sizeVelocity: -1 }, 1, { viewScale: 2 })).w;
    // Close, not equal: the last dab can come from an earlier sample at half the step.
    expect(zoomed).toBeCloseTo(atFit, 1);
    expect(steady(dabs({ sizeVelocity: -1 }, 1)).w).toBeGreaterThan(atFit + 2);
  });

  it('do not take samples at the same time for a burst of speed', () => {
    const out: number[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      if (args.length === 5 && (args[0] as HTMLCanvasElement).width < 100) out.push(args[3] as number);
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, spacing: 0.25, pressureSize: false, dynamics: { sizeVelocity: -1 } }), '#000000', false, 400, 100);
    // Slow, then several coalesced samples sharing one timestamp.
    for (let i = 0, t = 0; i <= 20; i++, t += 4) engine.stroke(10 + i * 0.5, 50, 1, undefined, t);
    for (let i = 1; i <= 4; i++) engine.stroke(20 + i * 0.5, 50, 1, undefined, 80);
    engine.stroke(22.5, 50, 1, undefined, 84);
    engine.commit(document.createElement('canvas').getContext('2d')!);
    spy.mockRestore();
    expect(Math.min(...out)).toBeGreaterThan(15);
  });
});

describe('speed dynamics along the spline', () => {
  function widths(feed: (engine: StampStrokeEngine) => void): Dab[] {
    const out: Dab[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      if (args.length === 5 && (args[0] as HTMLCanvasElement).width < 100) {
        out.push({ x: (args[1] as number) + (args[3] as number) / 2, w: args[3] as number, alpha: 1 });
      }
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, spacing: 0.1, pressureSize: false, dynamics: { sizeVelocity: -1 } }), '#000000', false, 1000, 100);
    feed(engine);
    engine.commit(document.createElement('canvas').getContext('2d')!);
    spy.mockRestore();
    return out;
  }

  it('draws a fast segment at its own speed even when a pause comes before it is laid', () => {
    const all = widths(engine => {
      for (let i = 0, t = 0; i <= 30; i++, t += 4) engine.stroke(10 + i * 10, 50, 1, undefined, t);
      // Held still for a second, then a nudge: the spline lays the last fast
      // segment only now.
      engine.stroke(311, 50, 1, undefined, 1120);
    });
    // The spline lays 300→310 only once the sample after 310 is in.
    const fastEnd = all.filter(d => d.x > 300.5 && d.x < 309);
    expect(fastEnd.length).toBeGreaterThan(0);
    expect(Math.max(...fastEnd.map(d => d.w))).toBeLessThan(8);
  });

  it('counts a back-and-forth within one timestamp as speed', () => {
    const all = widths(engine => {
      for (let i = 0, t = 0; i <= 10; i++, t += 4) engine.stroke(100, 50, 1, undefined, t);
      for (let i = 0, t = 44; i < 20; i++, t += 4) {
        engine.stroke(110, 50, 1, undefined, t);
        engine.stroke(100, 50, 1, undefined, t);
      }
    });
    expect(all[all.length - 1].w).toBeLessThan(15);
  });
});

describe('minimum size', () => {
  function sizesAt(pressures: number[], minSize: number, pressureSize = true): number[] {
    const out: number[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      if (args.length === 5 && (args[0] as HTMLCanvasElement).width < 100) out.push(args[3] as number);
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, spacing: 0.1, pressureSize, pressureCurve: 'linear', dynamics: { minSize } }), '#000000', false, 1000, 100);
    pressures.forEach((p, i) => engine.stroke(10 + i * 20, 50, p, undefined, i * 4));
    engine.commit(document.createElement('canvas').getContext('2d')!);
    spy.mockRestore();
    return out;
  }

  it('keeps the lightest touch at a share of the size, and full pressure at full size', () => {
    const light = sizesAt([0.01, 0.01, 0.01], 0.3);
    expect(Math.min(...light)).toBeGreaterThan(6);
    expect(Math.max(...light)).toBeLessThan(6.5);
    expect(Math.max(...sizesAt([1, 1, 1], 0.3))).toBeCloseTo(20);
    // Half pressure lands halfway between.
    expect(sizesAt([0.5, 0.5, 0.5], 0.3)[0]).toBeCloseTo(13);
  });

  it('holds through a stabilized taper to the lift, catch-up included', () => {
    const out: number[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      if (args.length === 5 && (args[0] as HTMLCanvasElement).width < 100) out.push(args[3] as number);
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, spacing: 0.1, pressureSize: true, pressureCurve: 'heavy', dynamics: { minSize: 0.3 } }), '#000000', false, 1000, 100, { stabilizerMs: 100 });
    for (let i = 0; i <= 30; i++) engine.stroke(10 + i * 4, 50, Math.max(0.001, 1 - i / 30), undefined, i * 4);
    engine.stroke(130, 50, 0, undefined, 124);
    spy.mockRestore();
    expect(Math.min(...out)).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(out[out.length - 1]).toBeLessThan(6.5);
  });

  it('changes nothing without stylus size', () => {
    expect(sizesAt([0.2, 0.2], 0.5, false).every(w => Math.abs(w - 20) < 1e-9)).toBe(true);
  });
});

describe('normalizeDynamics', () => {
  it('clamps stored values and keeps defaults for missing or non-numbers', () => {
    expect(normalizeDynamics(undefined)).toEqual(NO_DYNAMICS);
    expect(normalizeDynamics({ sizeVelocity: -3, flowVelocity: NaN })).toEqual({ ...NO_DYNAMICS, sizeVelocity: -1 });
    expect(normalizeDynamics({ flowVelocity: 0.4, sizeVelocity: 'x' as unknown as number })).toEqual({ ...NO_DYNAMICS, flowVelocity: 0.4 });
    expect(normalizeDynamics({ minSize: -0.5 }).minSize).toBe(0);
    expect(normalizeDynamics({ minSize: 2 }).minSize).toBe(1);
    expect(normalizeDynamics({ minSize: 0.25 }).minSize).toBe(0.25);
  });
});

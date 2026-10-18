import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { Rng } from '../src/engine/rng.ts';
import { NO_JITTER, copyDescriptor, normalizeJitter } from '../src/engine/brush-presets.ts';
import type { BrushDescriptor } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

interface Dab { x: number; y: number; w: number; h: number; m: DOMMatrix }

afterEach(() => vi.restoreAllMocks());

/** The dabs of a straight stroke, as drawn (the stroke buffer going onto the layer is left out), and the stroke's dirty bounds. */
function run(brush: Partial<Parameters<typeof makeBrush>[0]>, seed: number | undefined, tilt = { tiltX: 0, tiltY: 0 }) {
  const dabs: Dab[] = [];
  const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    // A dry dab is drawn with 5 arguments, a wet-brush one (cropped from its tint canvas) with 9.
    if ((args.length !== 5 && args.length !== 9) || (args[0] as HTMLCanvasElement).width >= 200) return;
    const o = args.length === 9 ? 4 : 0;
    const m = this.getTransform();
    dabs.push({ x: args[1 + o] as number, y: args[2 + o] as number, w: args[3 + o] as number, h: args[4 + o] as number, m });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, spacing: 0.25, flow: 1, pressureSize: false, pressureOpacity: false, ...brush }), '#000000', false, 400, 100, { seed });
  for (let i = 0; i <= 20; i++) engine.stroke(20 + i * 15, 50, 1, undefined, i * 8, tilt);
  engine.commit(document.createElement('canvas').getContext('2d')!);
  // After the commit, which lays the stroke's last segment.
  const bounds = engine.getDirtyBounds();
  spy.mockRestore();
  return { dabs, bounds };
}

/** Where a dab's rectangle's corners land, in the buffer. */
function corners(d: Dab): { x: number; y: number }[] {
  return [[d.x, d.y], [d.x + d.w, d.y], [d.x, d.y + d.h], [d.x + d.w, d.y + d.h]].map(([px, py]) => ({
    x: d.m.m11 * px + d.m.m21 * py + d.m.m41,
    y: d.m.m12 * px + d.m.m22 * py + d.m.m42,
  }));
}

const centre = (d: Dab) => ({ x: d.m.m41 + d.x + d.w / 2, y: d.m.m42 + d.y + d.h / 2 });
const rotationOf = (d: Dab) => Math.atan2(d.m.m12, d.m.m11);
const yScaleOf = (d: Dab) => Math.hypot(d.m.m21, d.m.m22);

describe('Rng', () => {
  it('replays a seed and stays in [0, 1)', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const seqA = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(seqA);
    expect(Math.min(...seqA)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...seqA)).toBeLessThan(1);
  });
});

describe('brush jitter', () => {
  const jittered = { jitter: { size: 0.6, angle: 0.5, roundness: 0.7 } };

  it('draws the same stroke for the same seed and a different one otherwise', () => {
    const a = run(jittered, 7).dabs;
    expect(run(jittered, 7).dabs).toEqual(a);
    expect(run(jittered, 8).dabs).not.toEqual(a);
  });

  it('differs between strokes when no seed is given', () => {
    expect(run(jittered, undefined).dabs).not.toEqual(run(jittered, undefined).dabs);
  });

  it('leaves a stroke exactly as it was at zero jitter, whatever the seed', () => {
    const plain = run({}, 1);
    expect(run({ jitter: { ...NO_JITTER } }, 99)).toEqual(plain);
    // And for a rotated, direction-following tip.
    const flat = { tip: { shape: 'flat' as const, aspect: 3, angle: 20, orientation: 'direction' as const } };
    expect(run({ ...flat, jitter: { ...NO_JITTER } }, 5)).toEqual(run(flat, 6));
  });

  it('takes size off by up to the size jitter, never below a pixel', () => {
    const base = run({ size: 20 }, 3).dabs;
    const out = run({ size: 20, jitter: { ...NO_JITTER, size: 0.5 } }, 3).dabs;
    expect(out).toHaveLength(base.length);
    for (const d of out) {
      expect(d.w).toBeLessThanOrEqual(20 + 1e-9);
      expect(d.w).toBeGreaterThanOrEqual(10 - 1e-9);
    }
    expect(new Set(out.map(d => d.w.toFixed(3))).size).toBeGreaterThan(5);
    const tiny = run({ size: 2, jitter: { ...NO_JITTER, size: 1 } }, 3).dabs;
    for (const d of tiny) expect(d.w).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it('spaces dabs on the un-jittered size', () => {
    const base = run({}, 3).dabs.map(centre);
    const out = run({ jitter: { ...NO_JITTER, size: 1 } }, 3).dabs.map(centre);
    expect(out).toHaveLength(base.length);
    out.forEach((c, i) => {
      expect(c.x).toBeCloseTo(base[i].x);
      expect(c.y).toBeCloseTo(base[i].y);
    });
  });

  it('turns dabs about their own angle by up to half the range each way, without bending direction following', () => {
    const tip = { shape: 'flat' as const, aspect: 3, angle: 0, orientation: 'direction' as const };
    const base = run({ tip }, 4).dabs;
    const out = run({ tip, jitter: { ...NO_JITTER, angle: 0.25 } }, 4).dabs;
    expect(out).toHaveLength(base.length);
    const deltas = out.map((d, i) => {
      let dr = rotationOf(d) - rotationOf(base[i]);
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      return dr;
    });
    for (const dr of deltas) expect(Math.abs(dr)).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
    expect(Math.max(...deltas) - Math.min(...deltas)).toBeGreaterThan(0.3);
  });

  it('squashes dabs across their axis down to 1 - roundness', () => {
    const out = run({ jitter: { ...NO_JITTER, roundness: 0.6 } }, 9).dabs;
    for (const d of out) {
      expect(yScaleOf(d)).toBeLessThanOrEqual(1 + 1e-9);
      expect(yScaleOf(d)).toBeGreaterThanOrEqual(0.4 - 1e-9);
    }
    expect(new Set(out.map(d => yScaleOf(d).toFixed(3))).size).toBeGreaterThan(5);
  });

  it('keeps the dirty bounds over every jittered dab, with tilt too', () => {
    const brush = {
      size: 30,
      tip: { shape: 'flat' as const, aspect: 4, angle: 0, orientation: 'fixed' as const },
      dynamics: { tilt: 1 },
      jitter: { size: 0.3, angle: 1, roundness: 0.5 },
    };
    for (const seed of [1, 2, 3]) {
      const { dabs, bounds } = run(brush, seed, { tiltX: 50, tiltY: 20 });
      expect(bounds).not.toBeNull();
      // The bounds are clamped to the 400 × 100 document.
      for (const d of dabs) for (const raw of corners(d)) {
        const c = { x: Math.max(0, Math.min(400, raw.x)), y: Math.max(0, Math.min(100, raw.y)) };
        expect(c.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(c.y).toBeGreaterThanOrEqual(bounds!.y);
        expect(c.x).toBeLessThanOrEqual(bounds!.x + bounds!.w);
        expect(c.y).toBeLessThanOrEqual(bounds!.y + bounds!.h);
      }
    }
  });
});

describe('wet brush jitter', () => {
  const wet = { ink: { wetness: 0.5 } };
  const jitter = { size: 0.5, angle: 0.5, roundness: 0.6 };

  it('jitters size, angle and roundness like a dry dab', () => {
    const base = run(wet, 5).dabs;
    const out = run({ ...wet, jitter }, 5).dabs;
    expect(base.length).toBeGreaterThan(10);
    expect(out).toHaveLength(base.length);
    for (const d of out) {
      expect(d.w).toBeLessThanOrEqual(20 + 1e-9);
      expect(d.w).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(yScaleOf(d)).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(yScaleOf(d)).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(new Set(out.map(d => d.w.toFixed(3))).size).toBeGreaterThan(5);
    expect(new Set(out.map(d => yScaleOf(d).toFixed(3))).size).toBeGreaterThan(5);
    expect(new Set(out.map(d => rotationOf(d).toFixed(3))).size).toBeGreaterThan(5);
  });

  it('keeps the dirty bounds over the dabs', () => {
    const { dabs, bounds } = run({ ...wet, size: 30, jitter: { size: 0.3, angle: 1, roundness: 0.5 } }, 2);
    for (const d of dabs) for (const raw of corners(d)) {
      expect(raw.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(raw.x).toBeLessThanOrEqual(bounds!.x + bounds!.w);
    }
  });
});

describe('jitter random stream', () => {
  it('reads three values per dab, so one jitter does not shift another', () => {
    const only = (key: 'size' | 'angle' | 'roundness') => run({ jitter: { ...NO_JITTER, [key]: 1 } }, 11).dabs;
    const all = run({ jitter: { size: 1, angle: 1, roundness: 1 } }, 11).dabs;
    const rng = new Rng(11);
    const draws = all.map(() => [rng.next(), rng.next(), rng.next()]);
    // Each channel alone matches the same channel with the others on, and the sample the RNG gives that dab.
    only('roundness').forEach((d, i) => expect(yScaleOf(d)).toBeCloseTo(yScaleOf(all[i])));
    only('roundness').forEach((d, i) => expect(yScaleOf(d)).toBeCloseTo(1 - draws[i][2]));
    only('size').forEach((d, i) => expect(d.w).toBeCloseTo(all[i].w));
    only('size').forEach((d, i) => expect(d.w).toBeCloseTo(Math.max(1, 20 * (1 - draws[i][0]))));
    only('angle').forEach((d, i) => expect(rotationOf(d)).toBeCloseTo((draws[i][1] - 0.5) * 2 * Math.PI - 2 * Math.PI * Math.round(((draws[i][1] - 0.5) * 2 * Math.PI) / (2 * Math.PI))));
  });
});

describe('jitter descriptors', () => {
  it('normalizes stored jitter onto the defaults', () => {
    expect(normalizeJitter(undefined)).toEqual(NO_JITTER);
    expect(normalizeJitter({ size: 3, angle: -1, roundness: NaN })).toEqual({ size: 1, angle: 0, roundness: 0 });
    expect(normalizeJitter({ angle: 0.4, size: 'x' as unknown as number })).toEqual({ size: 0, angle: 0.4, roundness: 0 });
  });

  it('copies jitter deeply, and fills it in for a descriptor without any', () => {
    const d = makeBrush({ jitter: { size: 0.5 } });
    const c = copyDescriptor(d);
    expect(c.jitter).toEqual(d.jitter);
    expect(c.jitter).not.toBe(d.jitter);
    const old = { ...d } as Partial<BrushDescriptor>;
    delete old.jitter;
    expect(copyDescriptor(old as BrushDescriptor).jitter).toEqual(NO_JITTER);
  });

  it('runs a stored brush that has no jitter as an unjittered one', () => {
    const old = makeBrush() as Partial<BrushDescriptor>;
    delete old.jitter;
    const engine = new StampStrokeEngine();
    engine.begin(old as BrushDescriptor, '#000000', false, 100, 100);
    engine.stroke(50, 50, 1, undefined, 0);
    expect(engine.getDirtyBounds()).not.toBeNull();
  });
});

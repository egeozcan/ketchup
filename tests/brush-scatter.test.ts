import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { NO_SCATTER, copyDescriptor, getPresetById, normalizeScatter } from '../src/engine/brush-presets.ts';
import type { BrushDescriptor } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

interface Dab { cx: number; cy: number; w: number; h: number; alpha: number; rot: number }

afterEach(() => vi.restoreAllMocks());

const DOC_W = 400, DOC_H = 100;

/** The dabs of a stroke through `points` (spaced 15 apart in time order), as drawn, and the stroke's dirty bounds. */
function run(brush: Parameters<typeof makeBrush>[0], seed: number, points: [number, number][] = line()) {
  const dabs: Dab[] = [];
  vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 200) return;
    const m = this.getTransform();
    const w = args[3] as number, h = args[4] as number;
    dabs.push({ cx: m.m41 + (args[1] as number) + w / 2, cy: m.m42 + (args[2] as number) + h / 2, w, h, alpha: this.globalAlpha, rot: Math.atan2(m.m12, m.m11) });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, spacing: 0.25, flow: 1, pressureSize: false, pressureOpacity: false, ...brush }), '#000000', false, DOC_W, DOC_H, { seed });
  points.forEach(([x, y], i) => engine.stroke(x, y, 1, undefined, i * 8));
  engine.commit(document.createElement('canvas').getContext('2d')!);
  const bounds = engine.getDirtyBounds();
  vi.restoreAllMocks();
  return { dabs, bounds };
}

function line(x0 = 20, y0 = 50, dx = 15, dy = 0): [number, number][] {
  return Array.from({ length: 21 }, (_, i) => [x0 + i * dx, y0 + i * dy] as [number, number]);
}

describe('brush scatter', () => {
  const sprayed = { scatter: { amount: 1.5, bothAxes: true, count: 5, countJitter: 0.4 }, jitter: { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 } };

  it('draws the same stroke for the same seed and a different one otherwise', () => {
    const a = run(sprayed, 7).dabs;
    expect(run(sprayed, 7).dabs).toEqual(a);
    expect(run(sprayed, 8).dabs).not.toEqual(a);
  });

  it('is off by default and leaves a stroke exactly as it was', () => {
    const plain = run({ jitter: { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 } }, 4);
    expect(plain.dabs.length).toBeGreaterThan(20);
    expect(run({ jitter: { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 }, scatter: { ...NO_SCATTER } }, 4)).toEqual(plain);
    // A count of 1 with no distance changes nothing however the other fields are set.
    const idle = { scatter: { amount: 0, bothAxes: true, count: 1, countJitter: 1 } };
    expect(run({ ...idle, jitter: { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 } }, 4)).toEqual(plain);
  });

  it('lays count dabs per step, fewer with count jitter, and leaves the spacing alone', () => {
    const base = run({}, 2).dabs.length;
    expect(run({ scatter: { ...NO_SCATTER, count: 4 } }, 2).dabs).toHaveLength(base * 4);
    const some = run({ scatter: { ...NO_SCATTER, count: 4, countJitter: 0.7 } }, 2).dabs.length;
    expect(some).toBeGreaterThanOrEqual(base);
    expect(some).toBeLessThan(base * 4);
  });

  it('keeps the first dab of a step as the stroke drew it without scatter, jitter included', () => {
    const jitter = { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 };
    const base = run({ jitter }, 9).dabs;
    const out = run({ jitter, scatter: { ...NO_SCATTER, count: 3 } }, 9).dabs;
    expect(out.filter((_, i) => i % 3 === 0)).toEqual(base);
    // The extras roll values of their own.
    expect(out[1]).not.toEqual(out[0]);
    expect(out[1].w === out[0].w && out[1].alpha === out[0].alpha).toBe(false);
  });

  it('scatters only across the stroke unless both axes are on', () => {
    for (const [dx, dy] of [[15, 0], [11, 11], [0, 12]]) {
      const points = line(120, dx === 0 ? 5 : 20, dx, dy);
      const base = run({}, 5, points).dabs;
      const out = run({ scatter: { ...NO_SCATTER, amount: 1.5 } }, 5, points).dabs;
      expect(out).toHaveLength(base.length);
      const len = Math.hypot(dx, dy), hx = dx / len, hy = dy / len;
      let moved = 0;
      // The first dab has no heading yet and scatters both ways.
      for (let i = 1; i < out.length; i++) {
        const ox = out[i].cx - base[i].cx, oy = out[i].cy - base[i].cy;
        expect(Math.abs(ox * hx + oy * hy)).toBeLessThan(1e-6);
        const across = Math.abs(-ox * hy + oy * hx);
        expect(across).toBeLessThanOrEqual(1.5 * 20 + 1e-6);
        if (across > 1) moved++;
      }
      expect(moved).toBeGreaterThan(out.length / 2);
    }
    const base = run({}, 5).dabs;
    const both = run({ scatter: { ...NO_SCATTER, amount: 1.5, bothAxes: true } }, 5).dabs;
    expect(both.slice(1).some((d, i) => Math.abs(d.cx - base[i + 1].cx) > 1)).toBe(true);
  });

  it('does not change where the path puts its dabs or how far apart', () => {
    // Without scatter's own random draws the path is the same: with the offset
    // taken off every dab, the centres are the plain stroke's.
    const base = run({}, 3).dabs;
    const out = run({ scatter: { ...NO_SCATTER, amount: 0.0001 } }, 3).dabs;
    expect(out).toHaveLength(base.length);
    out.forEach((d, i) => { expect(d.cx).toBeCloseTo(base[i].cx, 2); expect(d.cy).toBeCloseTo(base[i].cy, 2); });
  });

  it('counts the scattered dabs in the dirty bounds, also past the document edge', () => {
    const { dabs, bounds } = run({ scatter: { ...NO_SCATTER, amount: 3, bothAxes: true, count: 6 } }, 11, line(10, 10, 12, 4));
    expect(bounds).not.toBeNull();
    let beyond = 0;
    for (const d of dabs) {
      const l = Math.max(0, d.cx - d.w / 2), r = Math.min(DOC_W, d.cx + d.w / 2);
      const t = Math.max(0, d.cy - d.h / 2), b = Math.min(DOC_H, d.cy + d.h / 2);
      if (d.cx < 0 || d.cy < 0) beyond++;
      if (r <= l || b <= t) continue;
      expect(l).toBeGreaterThanOrEqual(bounds!.x);
      expect(t).toBeGreaterThanOrEqual(bounds!.y);
      expect(r).toBeLessThanOrEqual(bounds!.x + bounds!.w);
      expect(b).toBeLessThanOrEqual(bounds!.y + bounds!.h);
    }
    expect(beyond).toBeGreaterThan(0);
  });

  it('clears what a scattered stroke wrote past the edge before the next stroke', () => {
    const engine = new StampStrokeEngine();
    const target = document.createElement('canvas').getContext('2d')!;
    const scatter = { ...NO_SCATTER, amount: 4, bothAxes: true, count: 8 };
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect');
    engine.begin(makeBrush({ size: 20, scatter }), '#000000', false, 100, 100, { seed: 1 });
    for (let i = 0; i < 10; i++) engine.stroke(5 + i * 3, 5, 1, undefined, i * 8);
    engine.commit(target);
    spy.mockClear();
    engine.begin(makeBrush({ size: 20 }), '#000000', false, 100, 100, { seed: 2 });
    // The second begin clears the first stroke's whole unclamped rect.
    const cleared = spy.mock.calls.map(c => c as number[]).filter(c => c[0] < 0 || c[1] < 0);
    expect(cleared.length).toBeGreaterThan(0);
  });

  it('leaves direction following to the path, scattered or not', () => {
    const flat = { tip: { shape: 'flat' as const, aspect: 3, angle: 0, orientation: 'direction' as const } };
    const points = Array.from({ length: 30 }, (_, i) => [30 + i * 10, 50 + 25 * Math.sin(i / 4)] as [number, number]);
    const base = run(flat, 6, points).dabs;
    const out = run({ ...flat, scatter: { ...NO_SCATTER, count: 3, amount: 1, bothAxes: true } }, 6, points).dabs;
    expect(new Set(base.map(d => d.rot.toFixed(3))).size).toBeGreaterThan(3);
    // Each dab of a step is turned along the path at that step, as the unscattered stroke turns it.
    out.forEach((d, i) => expect(d.rot).toBeCloseTo(base[Math.floor(i / 3)].rot, 6));
  });
});

describe('scatter in stored brushes', () => {
  it('defaults when absent and clamps what is stored', () => {
    expect(normalizeScatter(undefined)).toEqual(NO_SCATTER);
    expect(normalizeScatter({})).toEqual(NO_SCATTER);
    expect(normalizeScatter({ amount: 99, count: 40, countJitter: -1, bothAxes: true })).toEqual({ amount: 5, count: 16, countJitter: 0, bothAxes: true });
    expect(normalizeScatter({ amount: NaN, count: 2.6, countJitter: 'x' as unknown as number, bothAxes: 1 as unknown as boolean })).toEqual({ ...NO_SCATTER, count: 3 });
    expect(normalizeScatter({ count: 0 }).count).toBe(1);
  });

  it('copies a descriptor without scatter in with the defaults, sharing nothing', () => {
    const legacy = makeBrush() as Partial<BrushDescriptor>;
    delete legacy.scatter;
    expect(copyDescriptor(legacy as BrushDescriptor).scatter).toEqual(NO_SCATTER);
    const src = makeBrush({ scatter: { amount: 1, count: 3 } });
    const copy = copyDescriptor(src);
    expect(copy.scatter).toEqual(src.scatter);
    expect(copy.scatter).not.toBe(src.scatter);
  });

  it('ships a Spray preset that scatters', () => {
    const s = getPresetById('spray')!.descriptor.scatter;
    expect(s.amount).toBeGreaterThan(0);
    expect(s.count).toBeGreaterThan(1);
  });
});

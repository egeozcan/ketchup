import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { PathSmoother } from '../src/engine/path-smoother.ts';
import { BRUSH_PRESETS, MAX_FADE_LENGTH, NO_FADE, copyDescriptor, getDefaultDescriptor, getPresetById, normalizeFade } from '../src/engine/brush-presets.ts';
import type { BrushDescriptor, StampPoint } from '../src/engine/types.ts';
import { makeBrush } from './helpers.ts';

interface Dab { x: number; y: number; w: number; alpha: number }

afterEach(() => vi.restoreAllMocks());

const SPACING = 0.25;
/** Sample (x, pressure) pairs; pressure 0 lifts the pen, as stroke() reads it for a brush with pressure size. */
type Sample = [number, number];

function straight(n = 80, step = 5, x0 = 10): Sample[] {
  return Array.from({ length: n }, (_, i) => [x0 + i * step, 1] as Sample);
}

function run(brush: Parameters<typeof makeBrush>[0], samples: Sample[] = straight(), seed = 3, after?: (engine: StampStrokeEngine) => void): Dab[] {
  const out: Dab[] = [];
  vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 1000) return;
    const w = args[3] as number;
    out.push({ x: (args[1] as number) + w / 2, y: (args[2] as number) + (args[4] as number) / 2, w, alpha: this.globalAlpha });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, spacing: SPACING, flow: 1, pressureSize: false, pressureOpacity: false, ...brush }), '#000000', false, 4000, 200, { seed });
  samples.forEach(([x, p], i) => engine.stroke(x, 100, p, undefined, i * 8));
  after?.(engine);
  engine.commit(document.createElement('canvas').getContext('2d')!);
  vi.restoreAllMocks();
  return out;
}

const widths = (dabs: Dab[]) => dabs.map(d => d.w);

function expectNoGaps(dabs: Dab[]) {
  for (let i = 1; i < dabs.length; i++) {
    const dist = Math.hypot(dabs[i].x - dabs[i - 1].x, dabs[i].y - dabs[i - 1].y);
    // The walk lays the next dab where either dab's spacing runs out.
    expect(dist).toBeLessThanOrEqual(Math.max(1, SPACING * Math.min(dabs[i].w, dabs[i - 1].w)) + 0.05);
  }
}

describe('size fade in dabs', () => {
  it('shrinks with the number of dabs laid, whatever the spacing between them', () => {
    const near = widths(run({ spacing: 0.1, fade: { sizeLength: 10, sizeUnit: 'dabs', taperStart: 0 } }));
    const far = widths(run({ spacing: 0.5, fade: { sizeLength: 10, sizeUnit: 'dabs', taperStart: 0 } }));
    for (const w of [near, far]) {
      expect(w[0]).toBe(20);
      expect(w[10]).toBe(1);
      for (let i = 1; i < 11; i++) expect(w[i]).toBeLessThan(w[i - 1]);
    }
  });

  it('leaves no gaps when one pointer move lays many dabs, as the fade shrinks them', () => {
    const fade = { sizeLength: 4, sizeUnit: 'dabs' as const, taperStart: 0 };
    const dabs = run({ spacing: 0.25, dynamics: { sizeVelocity: 0, flowVelocity: 0, minSize: 0, tilt: 0 }, fade }, straight(4, 100));
    expect(dabs.length).toBeGreaterThan(8);
    expect(dabs[4].w).toBeLessThan(dabs[0].w);
    expectNoGaps(dabs);
  });

  it('is read from stored brushes only when asked for, and defaults to distance', () => {
    expect(normalizeFade({ sizeLength: 5 }).sizeUnit).toBe('distance');
    expect(normalizeFade({ sizeLength: 5, sizeUnit: 'dabs' }).sizeUnit).toBe('dabs');
    expect(normalizeFade({ sizeUnit: 'bogus' as never }).sizeUnit).toBe('distance');
    expect(copyDescriptor(getDefaultDescriptor()).fade.sizeUnit).toBe('distance');
  });
});

describe('start taper', () => {
  const taper = { fade: { sizeLength: 0, taperStart: 100 } };

  it('grows the dab from the minimum to full size over the taper length, never shrinking', () => {
    const w = widths(run(taper));
    expect(w[0]).toBe(1);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThanOrEqual(w[i - 1] - 1e-9);
    expect(w[w.length - 1]).toBeCloseTo(20);
    // Full only once the taper is over.
    const dabs = run(taper);
    for (const d of dabs) if (d.x - 10 < 90) expect(d.w).toBeLessThan(20);
    expect(dabs.find(d => d.x - 10 >= 100)!.w).toBeCloseTo(20);
  });

  it('eases in, so the tip is pointed rather than a cone', () => {
    const dabs = run({ fade: { sizeLength: 0, taperStart: 200 }, size: 100 });
    const at = (dist: number) => dabs.find(d => d.x - 10 >= dist)!.w;
    // Smoothstep: a quarter of the way is 16% of the size, not 25%.
    expect(at(50)).toBeGreaterThan(12);
    expect(at(50)).toBeLessThan(20);
    expect(at(100)).toBeGreaterThan(40);
    expect(at(100)).toBeLessThan(60);
  });

  it('shrinks the spacing with the dab, so a steep taper leaves no gaps', () => {
    const dabs = run({ size: 60, fade: { sizeLength: 0, taperStart: 24 } }, straight(60, 7));
    expect(dabs.length).toBeGreaterThan(30);
    expectNoGaps(dabs);
    expectNoGaps(run({ size: 60, fade: { sizeLength: 0, taperStart: 400 } }, straight(60, 7)));
  });

  it('meets the minimum size, which also floors the taper', () => {
    const w = widths(run({ ...taper, dynamics: { minSize: 0.5 } }));
    expect(w[0]).toBeCloseTo(10);
    expect(w[w.length - 1]).toBeCloseTo(20);
  });

  it('multiplies with pressure size, speed size and size jitter, never below a pixel', () => {
    const half = run({ ...taper, pressureSize: true }, straight().map(([x]) => [x, 0.5] as Sample));
    expect(half[half.length - 1].w).toBeCloseTo(10);
    expect(half[0].w).toBe(1);
    const jittered = run({ ...taper, jitter: { size: 0.5, angle: 0, roundness: 0, flow: 0 } });
    expect(Math.min(...widths(jittered))).toBeGreaterThanOrEqual(1);
    expect(jittered[jittered.length - 1].w).toBeLessThanOrEqual(20);
  });

  it('restarts at each contact after a pressure lift', () => {
    const first = straight(30);
    const second = straight(30, 5, 400);
    const samples: Sample[] = [...first, [first[first.length - 1][0], 0], ...second];
    const dabs = run({ ...taper, pressureSize: true }, samples);
    const before = dabs.filter(d => d.x < 300), after = dabs.filter(d => d.x >= 400);
    expect(before[before.length - 1].w).toBeGreaterThan(10);
    expect(after[0].w).toBe(1);
    expect(after[after.length - 1].w).toBeGreaterThan(10);
    expectNoGaps(after);
    // A taper alone asks for the lift as well, with no pressure dynamics on.
    const plain = run(taper, samples);
    expect(plain.filter(d => d.x >= 400)[0].w).toBe(1);
    expect(plain.filter(d => d.x > 156 && d.x < 400)).toHaveLength(0);
    // Without the lift there is no second taper.
    const joined = run({ ...taper, pressureSize: true }, [...first, ...second]);
    expect(joined.find(d => d.x >= 400)!.w).toBeGreaterThan(15);
  });
});

describe('size fade', () => {
  const fade = { fade: { sizeLength: 300, taperStart: 0 } };

  it('shrinks the dab steadily along the stroke to the minimum size', () => {
    const dabs = run(fade);
    const w = widths(dabs);
    expect(w[0]).toBeCloseTo(20);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThanOrEqual(w[i - 1] + 1e-9);
    // Linear in distance: halfway along it is half way down (to the 1px floor).
    const mid = dabs.find(d => d.x - 10 >= 150)!.w;
    expect(mid).toBeGreaterThan(9);
    expect(mid).toBeLessThan(12);
    expect(w[w.length - 1]).toBe(1);
    expectNoGaps(dabs);
  });

  it('stops at the share of the size the minimum sets', () => {
    const w = widths(run({ ...fade, dynamics: { minSize: 0.4 } }));
    expect(w[w.length - 1]).toBeCloseTo(8);
  });

  it('keeps going across a pressure lift, unlike the taper', () => {
    const first = straight(30);
    const second = straight(10, 5, 400);
    const samples: Sample[] = [...first, [first[first.length - 1][0], 0], ...second];
    const dabs = run({ fade: { sizeLength: 300, taperStart: 0 }, pressureSize: true }, samples);
    const before = dabs.filter(d => d.x < 300), after = dabs.filter(d => d.x >= 400);
    expect(after[0].w).toBeLessThan(before[0].w);
    expect(after[0].w).toBeLessThanOrEqual(before[before.length - 1].w + 1e-9);
    expect(after[0].w).toBeLessThan(12);
  });

  it('combines with the taper', () => {
    const dabs = run({ fade: { sizeLength: 400, taperStart: 60 } });
    const w = widths(dabs);
    expect(w[0]).toBe(1);
    expect(Math.max(...w)).toBeGreaterThan(14);
    expect(Math.max(...w)).toBeLessThan(20);
    expect(w[w.length - 1]).toBeLessThan(Math.max(...w));
    expectNoGaps(dabs);
  });
});

describe('fades and the rest of the stroke', () => {
  it('are off by default and leave a stroke exactly as it was', () => {
    const plain = run({});
    expect(new Set(widths(plain))).toEqual(new Set([20]));
    expect(run({ fade: { ...NO_FADE } })).toEqual(plain);
    const legacy = { ...getDefaultDescriptor(), size: 20, spacing: SPACING, pressureSize: false } as Partial<BrushDescriptor>;
    delete legacy.fade;
    expect(copyDescriptor(legacy as BrushDescriptor).fade).toEqual(NO_FADE);
  });

  it('draws the same stroke for the same seed', () => {
    const brush = { fade: { sizeLength: 200, taperStart: 40 }, jitter: { size: 0.4, angle: 0.5, roundness: 0.2, flow: 0.3 } };
    expect(run(brush, straight(), 5)).toEqual(run(brush, straight(), 5));
  });

  it('leave flow to ink depletion: no second flow fade', () => {
    const dabs = run({ fade: { sizeLength: 200, taperStart: 40 } });
    expect(new Set(dabs.map(d => d.alpha))).toEqual(new Set([1]));
  });

  it('lay held airbrush dabs at the size the stroke had, adding no distance', () => {
    const brush = { airbrush: true, airbrushRate: 20, flow: 0.5, fade: { sizeLength: 0, taperStart: 100 } };
    const dabs = run(brush, straight(12), 3, engine => { for (let t = 100; t <= 600; t += 50) engine.tick(t + 12 * 8); });
    const held = dabs.slice(-5);
    expect(held.length).toBe(5);
    expect(new Set(held.map(d => d.w)).size).toBe(1);
    expect(held[0].w).toBeLessThan(20);
  });

  it('writes pathDist on the smoother\'s stamps as the length walked', () => {
    const sm = new PathSmoother();
    const all: StampPoint[] = [];
    for (let i = 0; i < 12; i++) all.push(...sm.addPoint(10 + i * 7, 5, 1, 3, i * 8));
    all.push(...sm.flush(3));
    expect(all.length).toBeGreaterThan(20);
    all.forEach((s, i) => {
      expect(s.pathDist).toBeCloseTo(s.x - 10, 1);
      if (i) expect(s.pathDist).toBeGreaterThan(all[i - 1].pathDist);
    });
    sm.reset();
    expect(sm.pathLength()).toBe(0);
  });
});

describe('fade settings', () => {
  it('normalize stored values', () => {
    expect(normalizeFade(undefined)).toEqual(NO_FADE);
    expect(normalizeFade({})).toEqual(NO_FADE);
    expect(normalizeFade({ sizeLength: 300, taperStart: 20 })).toEqual({ sizeLength: 300, sizeUnit: 'distance', taperStart: 20 });
    expect(normalizeFade({ sizeLength: -5, taperStart: 1e9 })).toEqual({ sizeLength: 0, sizeUnit: 'distance', taperStart: MAX_FADE_LENGTH });
    expect(normalizeFade({ sizeLength: NaN, taperStart: 'x' as unknown as number })).toEqual(NO_FADE);
  });

  it('are copied deeply with the descriptor', () => {
    const a = copyDescriptor(makeBrush({ fade: { sizeLength: 5, taperStart: 6 } }));
    const b = copyDescriptor(a);
    b.fade.taperStart = 99;
    expect(a.fade.taperStart).toBe(6);
  });

  it('come with an Ink Pen preset and no other', () => {
    const pen = getPresetById('ink-pen')!;
    expect(pen.descriptor.fade.taperStart).toBeGreaterThan(0);
    expect(pen.descriptor.pressureSize).toBe(true);
    for (const p of BRUSH_PRESETS) if (p.id !== 'ink-pen') expect(p.descriptor.fade).toEqual(NO_FADE);
  });
});

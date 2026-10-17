import { describe, expect, it, vi } from 'vitest';
import { Stabilizer, normalizeStabilizer, stabilizerTimeConstant, MAX_STABILIZER_MS } from '../src/engine/stabilizer.ts';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { makeBrush } from './helpers.ts';

/** Lag behind a pointer moving at 1px/ms, 200 ms in, sampled every `dt` ms. */
function lagAt200ms(dt: number, tau: number): number {
  const s = new Stabilizer();
  s.reset(tau);
  let x = 0;
  for (let t = 0; t <= 200; t += dt) x = s.add(t, 0, 1, t).x;
  return 200 - x;
}

describe('Stabilizer', () => {
  it('trails by about the same distance at 60 Hz as at 240 Hz', () => {
    const at60 = lagAt200ms(1000 / 60, 60);
    const at240 = lagAt200ms(1000 / 240, 60);
    expect(at240).toBeGreaterThan(30);
    // A per-sample average would trail about four times as far at 60 Hz.
    expect(Math.abs(at60 - at240) / at240).toBeLessThan(0.25);
  });

  it('passes points straight through when off', () => {
    const s = new Stabilizer();
    s.reset(0);
    s.add(0, 0, 1, 0);
    expect(s.add(50, 7, 0.3, 4, 20, -10)).toEqual({ x: 50, y: 7, pressure: 0.3, tiltX: 20, tiltY: -10 });
    expect(s.catchUp()).toEqual([]);
  });

  it('catches up to where the pointer last was, once, in steps paced like the last move', () => {
    const s = new Stabilizer();
    s.reset(100);
    s.add(0, 0, 1, 0);
    const lagging = s.add(100, 0, 0.2, 10);
    expect(lagging.x).toBeLessThan(20);
    expect(lagging.pressure).toBeGreaterThan(0.8);

    const way = s.catchUp();
    expect(way[way.length - 1]).toMatchObject({ x: 100, y: 0 });
    expect(way[way.length - 1].pressure).toBeCloseTo(0.2);
    let prev = { x: lagging.x, t: 10 };
    for (const p of way) {
      expect(p.x - prev.x).toBeGreaterThan(0);
      expect(p.x - prev.x).toBeLessThanOrEqual(lagging.x + 1e-9);
      // About as quick as the last move (lagging.x px in 10 ms): a much slower
      // catch-up would read to buildup as a dark, lingering tail.
      const speed = (p.x - prev.x) / (p.timestamp - prev.t);
      expect(speed).toBeLessThanOrEqual(lagging.x / 10 + 1e-9);
      expect(speed).toBeGreaterThanOrEqual(lagging.x / 20);
      prev = { x: p.x, t: p.timestamp };
    }
    expect(s.catchUp()).toEqual([]);
  });

  it('gives the drawn point the pressure and tilt the pen had there, from the first sample on', () => {
    const s = new Stabilizer();
    s.reset(100);
    // Steady at 1 px/ms with pressure and tilt rising along x, at uneven
    // sample times.
    let t = 0;
    for (let i = 0; i < 80; i++, t += i % 3 === 0 ? 2 : 7) {
      const at = s.add(t, 0, t / 1000, t, t / 10, -t / 20);
      expect(at.pressure).toBeCloseTo(at.x / 1000, 9);
      expect(at.tiltX).toBeCloseTo(at.x / 10, 9);
      expect(at.tiltY).toBeCloseTo(-at.x / 20, 9);
    }
  });

  it('plays out what the pen did over the lag on catching up', () => {
    const s = new Stabilizer();
    s.reset(100);
    s.add(0, 0, 1, 0, 0, 0);
    s.add(100, 0, 0.5, 100, 60, -30);
    s.add(150, 0, 0.5, 150, 60, -30);
    s.add(200, 0, 0.2, 200, 80, 0);
    const way = s.catchUp();
    for (let i = 1; i < way.length; i++) expect(way[i].pressure).toBeLessThanOrEqual(way[i - 1].pressure);
    expect(way[way.length - 1]).toMatchObject({ x: 200, pressure: 0.2, tiltX: 80, tiltY: 0 });
  });

  it('starts afresh after a reset', () => {
    const s = new Stabilizer();
    s.reset(100);
    s.add(0, 0, 1, 0);
    s.add(100, 0, 1, 10);
    s.reset();
    expect(s.add(300, 40, 0.5, 20)).toEqual({ x: 300, y: 40, pressure: 0.5, tiltX: 0, tiltY: 0 });
  });

  it('maps the setting to a time constant, clamping and ignoring non-numbers', () => {
    expect(stabilizerTimeConstant(0)).toBe(0);
    expect(stabilizerTimeConstant(100)).toBe(MAX_STABILIZER_MS);
    expect(stabilizerTimeConstant(250)).toBe(MAX_STABILIZER_MS);
    expect(stabilizerTimeConstant(NaN)).toBe(0);
    expect(normalizeStabilizer(undefined, 20)).toBe(20);
    expect(normalizeStabilizer(-5)).toBe(0);
  });
});

describe('StampStrokeEngine with the stabilizer', () => {
  function drag(engine: StampStrokeEngine, from: number, to: number, t0: number, pressure = 1) {
    for (let x = from, t = t0; x <= to; x += 4, t += 4) engine.stroke(x, 10, pressure, undefined, t);
  }

  it('trails the pointer while drawing and finishes where it was let go', () => {
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 4, spacing: 0.25, pressureSize: false }), '#000000', false, 200, 20, { stabilizerMs: 100 });
    drag(engine, 5, 105, 0);
    const during = engine.getDirtyBounds()!;
    expect(during.x + during.w).toBeLessThan(90);

    engine.commit(document.createElement('canvas').getContext('2d')!);

    const after = engine.getDirtyBounds()!;
    expect(after.x + after.w).toBeGreaterThanOrEqual(105);
    expect(after.x + after.w).toBeLessThan(110);
  });

  it('finishes each part of a stroke where the pen lifted, without joining the next', () => {
    const engine = new StampStrokeEngine();
    const brush = makeBrush({ size: 4, spacing: 0.25, pressureSize: true, pressureCurve: 'linear' });
    engine.begin(brush, '#000000', false, 300, 20, { stabilizerMs: 100 });
    drag(engine, 5, 105, 0);
    engine.stroke(105, 10, 0, undefined, 104);

    const first = engine.getDirtyBounds()!;
    expect(first.x + first.w).toBeGreaterThanOrEqual(105);
    expect(first.x + first.w).toBeLessThan(110);

    // The next contact starts where it lands, with no line back to the lift.
    engine.stroke(250, 10, 1, undefined, 300);
    const ctx = (engine.getStrokePreview()!.canvas as HTMLCanvasElement).getContext('2d')!;
    const draws = ctx.__getDrawCalls().filter(event => event.type === 'drawImage');
    const xs = draws.map(event => (event.props as { dx: number }).dx + 2);
    expect(xs.filter(x => x > 110 && x < 248)).toEqual([]);
  });

  it('tapers where the pen did, not ahead of it, and down to the lift at the end', () => {
    const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
    const engine = new StampStrokeEngine();
    const brush = makeBrush({ size: 20, spacing: 0.1, pressureSize: true, pressureCurve: 'linear' });
    engine.begin(brush, '#000000', false, 400, 40, { stabilizerMs: 100 });
    // Full pressure to x=200, then a quick release to 0.2 over the last samples.
    for (let x = 0, t = 0; x <= 200; x += 4, t += 4) engine.stroke(x, 20, 1, undefined, t);
    for (let i = 1, t = 204; i <= 4; i++, t += 4) engine.stroke(200 + i * 4, 20, 1 - i * 0.2, undefined, t);
    const dab = (call: unknown[]) => ({ x: (call[1] as number) + (call[3] as number) / 2, w: call[3] as number });

    // The newest dab trails far behind the release and is still nearly full width.
    expect(dab(drawImage.mock.lastCall!).w).toBeGreaterThan(16);

    drawImage.mockClear();
    engine.commit(document.createElement('canvas').getContext('2d')!);
    const tail = drawImage.mock.calls.map(dab).filter(d => d.w < 19);
    drawImage.mockRestore();

    // The catch-up narrows toward the lift point, ending near its pressure
    // there (4 px at 0.2), and only where the pen tapered: short of x=200 it
    // was still at full pressure.
    const last = tail[tail.length - 1];
    expect(last.x).toBeGreaterThan(212);
    expect(last.w).toBeLessThan(6);
    expect(Math.min(...tail.map(d => d.w))).toBe(last.w);
    expect(tail.filter(d => d.x < 196)).toEqual([]);
  });

  it('reaches full pressure as soon after a light touchdown as the pen did', () => {
    const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
    const engine = new StampStrokeEngine();
    const brush = makeBrush({ size: 20, spacing: 0.1, pressureSize: true, pressureCurve: 'linear' });
    engine.begin(brush, '#000000', false, 1000, 100, { stabilizerMs: 120 });
    // 1 px/ms from x=100; pressure ramps 0.1 → 1 over the first 40 ms.
    for (let t = 0; t <= 300; t += 4) engine.stroke(100 + t, 50, Math.min(1, 0.1 + 0.9 * t / 40), undefined, t);
    const dabs = drawImage.mock.calls
      .filter(call => (call as unknown[]).length === 5 && (call[3] as number) <= 20)
      .map(call => ({ x: (call[1] as number) + (call[3] as number) / 2, w: call[3] as number }));
    drawImage.mockRestore();

    // The pen was at full pressure from x=140 on; a fixed delay would hold
    // the touchdown to about x=172.
    const past = dabs.filter(d => d.x > 145);
    expect(past.length).toBeGreaterThan(5);
    for (const d of past) expect(d.w).toBeGreaterThan(19.5);
  });

  it('catches up at the pace the stroke went, even when it crept', () => {
    const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
    const engine = new StampStrokeEngine();
    const brush = makeBrush({ size: 100, spacing: 0.1, pressureSize: false, dynamics: { sizeVelocity: 1 } });
    engine.begin(brush, '#000000', false, 1000, 300, { stabilizerMs: 120 });
    for (let i = 0; i <= 250; i++) engine.stroke(100 + i * 0.4, 150, 1, undefined, i * 4);
    const width = (call: unknown[]) => call[3] as number;
    const before = width(drawImage.mock.lastCall!);

    drawImage.mockClear();
    engine.commit(document.createElement('canvas').getContext('2d')!);
    const after = drawImage.mock.calls.filter(call => (call as unknown[]).length === 5 && width(call) < 100).map(width);
    drawImage.mockRestore();

    // Size by speed would show any speed the catch-up made up.
    expect(after.length).toBeGreaterThan(0);
    expect(Math.max(...after)).toBeLessThan(before * 1.1);
  });

  it('carries on forward when it catches up, never back over the stroke', () => {
    const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 4, spacing: 0.25, pressureSize: false }), '#000000', false, 400, 40, { stabilizerMs: 100 });
    for (let x = 50, t = 0; x <= 150; x += 10, t += 4) engine.stroke(x, 20, 1, undefined, t);
    const centre = (call: unknown[]) => (call[1] as number) + (call[3] as number) / 2;
    const before = drawImage.mock.calls.map(centre);

    drawImage.mockClear();
    engine.commit(document.createElement('canvas').getContext('2d')!);
    const after = drawImage.mock.calls.filter(call => (call[3] as number) < 10).map(centre);
    drawImage.mockRestore();

    let prev = before[before.length - 1];
    for (const x of after) {
      expect(x).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = x;
    }
    expect(prev).toBeGreaterThan(148);
  });

  it('reaches the end of a taper even when the full-size spacing is wide', () => {
    const engine = new StampStrokeEngine();
    const brush = makeBrush({ size: 100, spacing: 0.5, pressureSize: true, pressureCurve: 'linear' });
    engine.begin(brush, '#000000', false, 400, 300, { stabilizerMs: 100 });
    engine.stroke(5, 150, 1, undefined, 0);
    engine.stroke(125, 150, 0.01, undefined, 1);
    engine.commit(document.createElement('canvas').getContext('2d')!);

    const bounds = engine.getDirtyBounds()!;
    expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(124);
  });
});


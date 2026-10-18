import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { AIRBRUSH_MAX_CATCH_UP_MS, StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import {
  BRUSH_PRESETS, DEFAULT_AIRBRUSH_RATE, MAX_AIRBRUSH_RATE, MIN_AIRBRUSH_RATE, copyDescriptor, getDefaultDescriptor, normalizeAirbrushRate,
} from '../src/engine/brush-presets.ts';
import { PathSmoother } from '../src/engine/path-smoother.ts';
import { attachCanvasElements, makeBrush, makeLayer, makeState } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

interface Dab { cx: number; cy: number; w: number; alpha: number }

const DOC_W = 400, DOC_H = 100;

/** An engine mid-stroke, with every dab it draws collected. */
function start(brush: Parameters<typeof makeBrush>[0] = {}, options: { stabilizerMs?: number; seed?: number } = {}) {
  const dabs: Dab[] = [];
  vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 200) return;
    const m = this.getTransform();
    const w = args[3] as number, h = args[4] as number;
    dabs.push({ cx: m.m41 + (args[1] as number) + w / 2, cy: m.m42 + (args[2] as number) + h / 2, w, alpha: this.globalAlpha });
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, spacing: 0.25, flow: 0.2, pressureSize: false, pressureOpacity: false, airbrush: true, airbrushRate: 20, ...brush }),
    '#000000', false, DOC_W, DOC_H, { seed: options.seed ?? 3, stabilizerMs: options.stabilizerMs });
  return { engine, dabs };
}

/** Tick every `stepMs` from `from` to `to`; the dabs laid. */
function hold(engine: StampStrokeEngine, from: number, to: number, stepMs: number): number {
  let laid = 0;
  const n = Math.round((to - from) / stepMs);
  for (let i = 1; i <= n; i++) laid += engine.tick(from + i * stepMs);
  return laid;
}

describe('airbrush engine', () => {
  it('lays rate dabs a second at the held position', () => {
    const { engine, dabs } = start();
    engine.stroke(50, 50, 1, undefined, 0);
    expect(dabs).toHaveLength(1);
    expect(hold(engine, 0, 1000, 10)).toBe(20);
    expect(dabs).toHaveLength(21);
    expect(dabs.every(d => d.cx === 50 && d.cy === 50)).toBe(true);
  });

  it('lays the same at 60 Hz, 120 Hz and with a throttled tab', () => {
    const counts = [1000 / 60, 1000 / 120, 100, 200].map(step => {
      const { engine } = start({ airbrushRate: 30 });
      engine.stroke(50, 50, 1, undefined, 0);
      return hold(engine, 0, 3000, step);
    });
    // 3 s at 30/s, give or take the last unfinished dab of a frame grid.
    for (const c of counts) expect(c).toBeGreaterThanOrEqual(89);
    for (const c of counts) expect(c).toBeLessThanOrEqual(90);
  });

  it('carries a part of a dab to the next call instead of dropping it', () => {
    const { engine } = start({ airbrushRate: 20 });
    engine.stroke(50, 50, 1, undefined, 0);
    // 20 ms frames against a 50 ms interval: 0, 1, 0, 1, 1, ...
    expect(hold(engine, 0, 1000, 20)).toBe(20);
  });

  it('does nothing without airbrush, so a stroke is as it always was', () => {
    const plain = start({ airbrush: false });
    plain.engine.stroke(50, 50, 1, undefined, 0);
    expect(hold(plain.engine, 0, 1000, 10)).toBe(0);
    expect(plain.dabs).toHaveLength(1);
    expect(plain.engine.airbrushActive).toBe(false);

    const run = (extra: Parameters<typeof makeBrush>[0]) => {
      const { engine, dabs } = start(extra, { seed: 5 });
      for (let i = 0; i < 20; i++) engine.stroke(20 + i * 12, 50, 1, undefined, i * 16);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      return dabs;
    };
    // Tick or no tick, a brush with the airbrush off draws the same.
    expect(run({ airbrush: false, airbrushRate: 55 })).toEqual(run({ airbrush: false }));
  });

  it('lays nothing before a dab, after the stroke, or for a bad time', () => {
    const { engine } = start();
    expect(engine.tick(500)).toBe(0);
    engine.stroke(50, 50, 1, undefined, 100);
    expect(engine.tick(Number.NaN)).toBe(0);
    expect(engine.tick(100)).toBe(0);
    expect(engine.tick(50)).toBe(0);
    engine.commit(document.createElement('canvas').getContext('2d')!);
    expect(engine.tick(5000)).toBe(0);
    expect(engine.airbrushActive).toBe(false);
  });

  it('adds no density to a stroke that moves fast enough to lay a dab at least every interval', () => {
    const path = (engine: StampStrokeEngine, ticks: boolean) => {
      let t = 0;
      for (let i = 0; i < 40; i++) {
        t = i * 16;
        engine.stroke(20 + i * 8, 50, 1, undefined, t);
        // A frame between events, as the loop has.
        if (ticks) engine.tick(t + 8);
      }
    };
    const a = start();
    path(a.engine, false);
    const b = start();
    path(b.engine, true);
    expect(b.dabs).toEqual(a.dabs);
  });

  it('fills in between dabs of a slow stroke up to the rate, never past it', () => {
    // 1 px per 100 ms: movement lays a dab (5 px spacing) every half second, the timer 20 a second.
    const run = (airbrush: boolean) => {
      const { engine, dabs } = start({ airbrush });
      let t = 0;
      for (let i = 0; i <= 20; i++) {
        engine.stroke(20 + i, 50, 1, undefined, t);
        for (let k = 1; k <= 10; k++) engine.tick(t + k * 10);
        t += 100;
      }
      return dabs.length;
    };
    const plain = run(false), built = run(true);
    expect(plain).toBeLessThan(10);
    // The timer's one dab per 50 ms over 2 s on top of movement's own, no more.
    expect(built).toBeGreaterThan(plain);
    expect(built).toBeLessThanOrEqual(2000 / 50 + plain + 2);
  });

  it('keeps a slow stroke advancing and never past the sum of the timer\'s and the movement\'s density', () => {
    const run = (speedPxPerSec: number, airbrush: boolean) => {
      const { engine, dabs } = start({ size: 20, spacing: 0.25, flow: 0.2, airbrushRate: 20, airbrush });
      let x = 20;
      for (let t = 0; t <= 2000; t += 16) {
        engine.stroke(x, 50, 1, undefined, t);
        engine.tick(t + 8);
        x += speedPxPerSec * 0.016;
      }
      return { n: dabs.length, furthest: Math.max(...dabs.map(d => d.cx)) };
    };
    for (const v of [10, 40, 75, 100, 150]) {
      const built = run(v, true), plain = run(v, false);
      // The pen's way is covered: dabs reach (within a spacing of) where it went.
      expect(built.furthest).toBeGreaterThan(20 + v * 2 - 12);
      expect(built.n).toBeGreaterThanOrEqual(plain.n);
      // Timed dabs only add; at most one per interval.
      expect(built.n).toBeLessThanOrEqual(plain.n + 2000 / 50 + 1);
    }
  });

  it('owes at most a quarter second after a stall', () => {
    const { engine, dabs } = start({ airbrushRate: 40 });
    engine.stroke(50, 50, 1, undefined, 0);
    expect(engine.tick(60_000)).toBe(Math.floor(AIRBRUSH_MAX_CATCH_UP_MS / 1000 * 40));
    expect(dabs).toHaveLength(1 + 10);
    // The forgiven time is gone, not saved up.
    expect(engine.tick(60_000 + 10)).toBe(0);
    expect(hold(engine, 60_000, 61_000, 10)).toBe(40);
  });

  it('restarts the clock when movement lays a dab', () => {
    const { engine } = start();
    engine.stroke(50, 50, 1, undefined, 0);
    expect(engine.tick(49)).toBe(0);
    engine.stroke(80, 50, 1, undefined, 49);
    // The 50 ms is counted from 49 now, not from 0.
    expect(engine.tick(60)).toBe(0);
    expect(engine.tick(99)).toBe(1);
  });

  it('feeds held dabs through jitter, scatter and the stroke seed', () => {
    const rich = { jitter: { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 }, scatter: { amount: 1, bothAxes: true, count: 3, countJitter: 0 } };
    const go = (seed: number) => {
      const { engine, dabs } = start(rich, { seed });
      engine.stroke(100, 50, 1, undefined, 0);
      hold(engine, 0, 500, 10);
      return dabs;
    };
    const a = go(11);
    expect(go(11)).toEqual(a);
    expect(go(12)).not.toEqual(a);
    // 1 stroke dab + 10 held, 3 scattered each.
    expect(a).toHaveLength(33);
    expect(new Set(a.map(d => d.cx)).size).toBeGreaterThan(5);
  });

  it('marks the held dab as touched, for the preview and the history', () => {
    const { engine } = start({ size: 10 });
    engine.stroke(50, 50, 1, undefined, 0);
    engine.takePreviewDelta();
    expect(engine.takePreviewDelta()).toBeNull();
    engine.tick(60);
    expect(engine.takePreviewDelta()).not.toBeNull();
    expect(engine.getDirtyBounds()).not.toBeNull();
  });

  it('keeps the last dab\'s pressure, and a lift pauses it until the pen is down again', () => {
    const { engine, dabs } = start({ pressureSize: true, pressureOpacity: true, flow: 1 });
    engine.stroke(50, 50, 0.5, undefined, 0);
    engine.tick(100);
    expect(dabs).toHaveLength(3);
    expect(dabs[1].alpha).toBe(dabs[0].alpha);
    expect(dabs[1].w).toBe(dabs[0].w);

    engine.stroke(50, 50, 0, undefined, 110);
    expect(engine.tick(500)).toBe(0);
    expect(dabs).toHaveLength(3);

    engine.stroke(90, 50, 0.5, undefined, 600);
    expect(dabs).toHaveLength(4);
    expect(engine.tick(700)).toBe(2);
  });

  it('takes up pressure, tilt and twist the pen changes while it stands still', () => {
    const { engine, dabs } = start({ pressureSize: true, pressureOpacity: true, flow: 1, size: 40, tip: { orientation: 'twist', shape: 'flat', aspect: 3, angle: 0 } });
    engine.stroke(50, 50, 0.2, undefined, 0, { tiltX: 0, tiltY: 0, twist: 0 });
    const light = dabs[0];
    // Same spot, harder, the barrel turned.
    engine.stroke(50, 50, 0.9, undefined, 16, { tiltX: 0, tiltY: 0, twist: 90 });
    const n = dabs.length;
    hold(engine, 16, 316, 10);
    const held = dabs.slice(n);
    expect(held.length).toBe(6);
    for (const d of held) {
      expect(d.alpha).toBeGreaterThan(light.alpha);
      expect(d.w).toBeGreaterThan(light.w);
    }
  });

  it('walks the spline up to a pen that stops, so build-up lands where the pen is', () => {
    const { engine, dabs } = start({ size: 20, spacing: 0.25 });
    for (const [i, x] of [50, 80, 110].entries()) engine.stroke(x, 50, 1, undefined, i * 16);
    // The last segment is not walked yet: the dabs end at the second sample.
    expect(Math.max(...dabs.map(d => d.cx))).toBeLessThanOrEqual(80);
    const n = dabs.length;
    hold(engine, 32, 400, 10);
    const rest = dabs.slice(n);
    // The tail was laid as movement, then the held dabs sit at its end, within a spacing of the pen.
    expect(Math.max(...rest.map(d => d.cx))).toBeGreaterThan(105);
    expect(Math.max(...rest.map(d => d.cx))).toBeLessThanOrEqual(110);
    expect(rest.slice(-4).every(d => d.cx === rest[rest.length - 1].cx)).toBe(true);
    // Releasing adds nothing the hold hadn't laid.
    const before = dabs.length;
    engine.commit(document.createElement('canvas').getContext('2d')!);
    expect(dabs.length).toBe(before);
  });

  it('leaves a moving stroke\'s path alone: no samples are fed in between its events, only a quiet pen is settled', () => {
    const run = (ticks: boolean) => {
      const { engine, dabs } = start({ flow: 1, airbrushRate: 5 }, { stabilizerMs: 60 });
      for (let i = 0; i < 30; i++) {
        engine.stroke(20 + i * 6, 50 + 10 * Math.sin(i / 3), 1, undefined, i * 16);
        if (ticks) { engine.tick(i * 16 + 5); engine.tick(i * 16 + 11); }
      }
      return dabs;
    };
    expect(run(true)).toEqual(run(false));
  });

  it('commits a stopped stroke exactly as it held it, even at a narrow spacing', () => {
    const { engine, dabs } = start({ size: 4, spacing: 0.25 });
    for (const [i, x] of [50, 80, 110].entries()) engine.stroke(x, 50, 1, undefined, i * 16);
    hold(engine, 32, 400, 10);
    const n = dabs.length;
    const furthest = Math.max(...dabs.map(d => d.cx));
    engine.commit(document.createElement('canvas').getContext('2d')!);
    expect(dabs.length).toBe(n);
    expect(furthest).toBeLessThanOrEqual(110);
  });

  it('carries on from a settled stop as if it had not happened', () => {
    const xs = (settle: boolean) => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 1 });
      for (const [i, x] of [20, 40, 60, 80].entries()) engine.stroke(x, 50, 1, undefined, i * 16);
      if (settle) hold(engine, 48, 200, 10);
      const n = dabs.length;
      for (const [i, x] of [100, 120, 140].entries()) engine.stroke(x, 50, 1, undefined, 400 + i * 16);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      return dabs.slice(n).map(d => d.cx);
    };
    const after = xs(true);
    // Never backward, and it covers the rest of the way as an uninterrupted stroke does.
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThanOrEqual(after[i - 1] - 1e-6);
    expect(Math.max(...after)).toBeGreaterThan(135);
  });

  it('never lays a slow stroke\'s held dabs ahead of the path or draws it backward', () => {
    const { engine, dabs } = start({ size: 10, spacing: 0.5 });
    const xs: number[] = [];
    let t = 0;
    for (let i = 0; i < 12; i++) {
      engine.stroke(50 + i * 2, 50, 1, undefined, t);
      for (let k = 1; k <= 4; k++) engine.tick(t + k * 4);
      t += 16;
    }
    for (const d of dabs) xs.push(d.cx);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-6);
  });

  it('holds with a stabilizer at the pen\'s present pressure', () => {
    const { engine, dabs } = start({ pressureSize: true, pressureOpacity: true, flow: 1, size: 40 }, { stabilizerMs: 120 });
    engine.stroke(20, 50, 0.1, undefined, 0);
    for (let i = 1; i <= 5; i++) engine.stroke(20 + i * 4, 50, 0.1, undefined, i * 16);
    hold(engine, 80, 1500, 16);
    const light = dabs[dabs.length - 1];
    // Pressed harder at the same spot.
    engine.stroke(40, 50, 1, undefined, 1520);
    const n = dabs.length;
    hold(engine, 1520, 1720, 10);
    const held = dabs.slice(n);
    expect(held.length).toBeGreaterThan(0);
    for (const d of held) expect(d.alpha).toBeGreaterThan(light.alpha);
    expect(held[held.length - 1].w).toBeGreaterThan(light.w);
  });

  it('fades the speed a held dab sees toward rest', () => {
    const { engine, dabs } = start({ dynamics: { sizeVelocity: 1, flowVelocity: 0, minSize: 0, tilt: 0 }, size: 40 });
    // Fast enough to be at full speed, then still.
    for (let i = 0; i < 12; i++) engine.stroke(20 + i * 40, 50, 1, undefined, i * 10);
    const moving = dabs.length;
    const fast = dabs[moving - 1].w;
    hold(engine, 110, 600, 10);
    // The last nine are the clock's; before them the stopped pen's last stretch, laid as movement.
    const held = dabs.slice(-9).map(d => d.w);
    expect(dabs.length).toBeGreaterThan(moving + 9);
    expect(held[0]).toBeLessThan(fast + 1e-9);
    expect(held[held.length - 1]).toBeLessThan(held[0]);
  });

  describe('with a stabilizer', () => {
    it('builds up during slow movement as it does without one', () => {
      const run = (stabilizerMs: number | undefined) => {
        const { engine, dabs } = start({ size: 100, spacing: 0.25, airbrushRate: 20 }, { stabilizerMs });
        for (let i = 0; i <= 300; i++) {
          // 20 px/s, an event every 16 ms, a frame between.
          engine.stroke(20 + i * 0.32, 50, 1, undefined, i * 16);
          engine.tick(i * 16 + 8);
        }
        return dabs.length;
      };
      const free = run(undefined);
      expect(free).toBeGreaterThan(80);
      expect(run(120)).toBeGreaterThan(free * 0.8);
    });

    it('holds at the pen after a long stall between ticks, without overshooting it', () => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 1 }, { stabilizerMs: 120 });
      engine.stroke(20, 50, 1, undefined, 0);
      engine.stroke(140, 50, 1, undefined, 16);
      engine.tick(2000);
      engine.tick(2050);
      expect(Math.max(...dabs.map(d => d.cx))).toBeLessThanOrEqual(140.5);
    });

    it('never draws a stabilized stroke backward when a tick comes after a stall', () => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 1 }, { stabilizerMs: 120 });
      for (let i = 0; i <= 30; i++) engine.stroke(20 + i * 4, 50, 1, undefined, i * 4);
      engine.tick(2000);
      engine.tick(2050);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      const xs = dabs.map(d => d.cx);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 0.05);
      expect(Math.max(...xs)).toBeLessThanOrEqual(140.5);
    });

    it('does not backtrack after a stall following dense, fast input', () => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 1 }, { stabilizerMs: 120 });
      for (let i = 0; i <= 30; i++) engine.stroke(20 + i * 40, 50, 1, undefined, i);
      engine.tick(2000);
      engine.tick(2050);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      const xs = dabs.map(d => d.cx);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 0.05);
    });

    it('replays the pen\'s taper along a stall recovery instead of its end values', () => {
      const { engine, dabs } = start({ size: 20, spacing: 0.25, flow: 1, pressureSize: true }, { stabilizerMs: 120 });
      engine.stroke(20, 50, 1, undefined, 0);
      for (let i = 1; i <= 20; i++) engine.stroke(20 + i * 10, 50, 1 - i * 0.04, undefined, i * 4);
      const n = dabs.length;
      engine.tick(2000);
      engine.tick(2050);
      const w = dabs.slice(n).filter(d => d.cx > 60 && d.cx < 120).map(d => d.w);
      expect(w.length).toBeGreaterThan(5);
      // Pressure there was around .5..: dabs well over the end pressure's (.2) size.
      expect(Math.max(...w)).toBeGreaterThan(20 * 0.45);
    });

    it('releases cleanly before a stall recovery has settled', () => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 1 }, { stabilizerMs: 120 });
      for (let i = 0; i <= 30; i++) engine.stroke(20 + 4 * i, 50, 1, undefined, i);
      engine.tick(80);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      const xs = dabs.map(d => d.cx);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 0.05);
    });

    it('follows the pen again when it resumes after a hold settled the lag', () => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 1 }, { stabilizerMs: 120 });
      engine.stroke(20, 50, 1, undefined, 0);
      engine.stroke(140, 50, 1, undefined, 16);
      hold(engine, 16, 768, 16);
      const n = dabs.length;
      for (let i = 1; i <= 5; i++) engine.stroke(140 + i * 10, 50, 1, undefined, 768 + i * 16);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      expect(Math.max(...dabs.slice(n).map(d => d.cx))).toBeGreaterThan(180);
    });

    it('closes a lag under the dab spacing too, so a release adds nothing', () => {
      const { engine, dabs } = start({ size: 4, spacing: 0.25, flow: 0.2 }, { stabilizerMs: 120 });
      engine.stroke(50, 50, 1, undefined, 0);
      engine.stroke(50.9, 50, 1, undefined, 1000);
      hold(engine, 1000, 1050, 10);
      engine.stroke(51.05, 50, 1, undefined, 1100);
      hold(engine, 1100, 2000, 10);
      const n = dabs.length;
      engine.commit(document.createElement('canvas').getContext('2d')!);
      expect(dabs.length).toBe(n);
    });

    it('holds at the pen, not short of it, at a low zoom, so release adds nothing', () => {
      const dabs: number[] = [];
      vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        if (args.length !== 5 || (args[0] as HTMLCanvasElement).width >= 200) return;
        dabs.push(this.getTransform().m41 + (args[1] as number) + (args[3] as number) / 2);
      });
      const engine = new StampStrokeEngine();
      engine.begin(makeBrush({ size: 4, spacing: 0.25, flow: 0.2, airbrush: true, airbrushRate: 20, pressureSize: false, pressureOpacity: false }),
        '#000000', false, DOC_W, DOC_H, { seed: 1, stabilizerMs: 120, viewScale: 0.1 });
      for (let i = 0; i <= 6; i++) engine.stroke(100 + i * 5, 50, 1, undefined, i * 16);
      for (let t = 112; t <= 3000; t += 16) engine.tick(t);
      const n = dabs.length;
      // Within one spacing (1 px) of the pen at 130.
      expect(Math.max(...dabs)).toBeGreaterThanOrEqual(129);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      expect(dabs.length).toBe(n);
    });

    it('lets the drawn point close in on a stopped pen by movement, then holds', () => {
      const { engine, dabs } = start({ airbrushRate: 20, size: 10 }, { stabilizerMs: 120 });
      engine.stroke(20, 50, 1, undefined, 0);
      for (let i = 1; i <= 6; i++) engine.stroke(20 + i * 20, 50, 1, undefined, i * 16);
      const stab = (engine as any)._stabilizer;
      expect(stab.lag()).toBeGreaterThan(20);
      const before = dabs.length;

      // While it lags, time moves the stroke and the held position isn't piled on.
      let t = 96;
      const xs: number[] = [];
      while (stab.lag() > 0.25 && t < 8000) {
        t += 16;
        const n = dabs.length;
        engine.tick(t);
        for (let k = n; k < dabs.length; k++) xs.push(dabs[k].cx);
      }
      expect(t).toBeLessThan(6000);
      expect(dabs.length).toBeGreaterThan(before);
      expect(new Set(xs.map(x => Math.round(x))).size).toBe(xs.length);

      // Caught up: from here it is the clock that lays dabs, at the rate.
      const caught = dabs.length;
      const laid = hold(engine, t, t + 1000, 10);
      expect(laid).toBeGreaterThanOrEqual(19);
      expect(laid).toBeLessThanOrEqual(20);
      expect(dabs.length - caught).toBe(laid);
    });

    it('builds no backlog while it catches up', () => {
      const { engine } = start({ airbrushRate: 20, size: 10 }, { stabilizerMs: 120 });
      engine.stroke(20, 50, 1, undefined, 0);
      engine.stroke(200, 50, 1, undefined, 16);
      const stab = (engine as any)._stabilizer;
      let t = 16;
      while (stab.lag() > 0.25) { t += 16; engine.tick(t); }
      // Not a burst of everything the catch-up took.
      expect(engine.tick(t + 49)).toBe(0);
      expect(engine.tick(t + 50)).toBe(1);
    });
  });
});

describe('airbrush descriptor', () => {
  it('is off by default in every preset, at the default rate', () => {
    for (const p of BRUSH_PRESETS) {
      expect(p.descriptor.airbrush).toBe(false);
      expect(p.descriptor.airbrushRate).toBe(DEFAULT_AIRBRUSH_RATE);
    }
    expect(getDefaultDescriptor().airbrush).toBe(false);
  });

  it('copies and normalises older or malformed stored values', () => {
    const d = getDefaultDescriptor();
    const old = { ...d } as Record<string, unknown>;
    delete old.airbrush;
    delete old.airbrushRate;
    const loaded = copyDescriptor(old as never);
    expect(loaded.airbrush).toBe(false);
    expect(loaded.airbrushRate).toBe(DEFAULT_AIRBRUSH_RATE);
    expect(copyDescriptor({ ...d, airbrush: 'yes' as never }).airbrush).toBe(false);
    expect(copyDescriptor({ ...d, airbrush: true, airbrushRate: 40 })).toMatchObject({ airbrush: true, airbrushRate: 40 });
    expect(normalizeAirbrushRate(1)).toBe(MIN_AIRBRUSH_RATE);
    expect(normalizeAirbrushRate(500)).toBe(MAX_AIRBRUSH_RATE);
    for (const bad of [NaN, Infinity, '30', null, undefined]) expect(normalizeAirbrushRate(bad)).toBe(DEFAULT_AIRBRUSH_RATE);
  });
});

describe('airbrush loop in the canvas', () => {
  function setup(airbrush = true) {
    const canvas = new DrawingCanvas();
    const layers = [makeLayer(200, 100)];
    const state = makeState({ layers, activeLayerId: layers[0].id, documentWidth: 200, documentHeight: 100, activeTool: 'pencil', brush: { airbrush, flow: 0.3, size: 10, pressureSize: false, pressureOpacity: false } });
    (canvas as any)._ctx = { value: { state } };
    attachCanvasElements(canvas, 200, 100);
    (canvas as any).composite = vi.fn();
    (canvas as any).requestUpdate = vi.fn();
    (canvas as any)._panX = 0;
    (canvas as any)._panY = 0;
    (canvas as any)._zoom = 1;

    // Our own frame queue, so frames run when the test says.
    const queue = new Map<number, FrameRequestCallback>();
    let next = 1;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => { queue.set(next, cb); return next++; });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number) => { queue.delete(id); });
    const loop = () => [...queue.values()].filter(cb => cb === (canvas as any)._onAirbrushFrame);
    const frame = (now: number) => {
      const cb = [...queue].find(([, f]) => f === (canvas as any)._onAirbrushFrame);
      if (!cb) throw new Error('no airbrush frame pending');
      queue.delete(cb[0]);
      cb[1](now);
    };
    const ev = (x: number, t: number, extra: object = {}) =>
      ({ button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: 40, pointerType: 'mouse', isPrimary: true, pressure: 0.5, timeStamp: t, preventDefault() {}, ...extra }) as unknown as PointerEvent;
    return { canvas, state, loop, frame, ev };
  }

  it('runs while an airbrush stroke is down, lays held dabs and redoes the preview as a move does', () => {
    const { canvas, loop, frame, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    expect(loop()).toHaveLength(1);
    const tick = vi.spyOn((canvas as any)._engine, 'tick');
    const schedule = vi.spyOn(canvas, 'scheduleComposite');
    frame(20);
    expect(schedule).not.toHaveBeenCalled();
    frame(60);
    expect(tick).toHaveBeenLastCalledWith(60);
    expect(schedule).toHaveBeenCalledWith(false);
    expect(schedule).not.toHaveBeenCalledWith(true);
    // Another frame is already queued.
    expect(loop()).toHaveLength(1);
  });

  it('is not started for a brush without airbrush', () => {
    const { canvas, loop, ev } = setup(false);
    (canvas as any)._onPointerDown(ev(40, 0));
    expect(loop()).toHaveLength(0);
    (canvas as any)._onPointerUp(ev(40, 10));
    expect(loop()).toHaveLength(0);
  });

  it('stops on pointer up', () => {
    const { canvas, loop, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    (canvas as any)._onPointerUp(ev(40, 100));
    expect(loop()).toHaveLength(0);
    expect((canvas as any)._airbrushFrame).toBe(0);
  });

  it('lays the time owed up to the release when it comes before the next frame', () => {
    const { canvas, frame, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    frame(50);
    const tick = vi.spyOn((canvas as any)._engine, 'tick');
    (canvas as any)._onPointerUp(ev(40, 250));
    expect(tick).toHaveBeenCalledWith(250);
    // The frame at 50 laid one; 200 ms more at 20 a second is four.
    expect(tick.mock.results[0].value).toBe(4);
  });

  it('stops on pointer cancel', () => {
    const { canvas, loop, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    (canvas as any)._onPointerCancel({ pointerId: 1 } as PointerEvent);
    expect(loop()).toHaveLength(0);
  });

  it('stops when a pinch cancels the stroke', () => {
    const { canvas, loop, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    (canvas as any)._cancelCurrentTool(1, true);
    expect(loop()).toHaveLength(0);
  });

  it('stops when the tool changes, by the stroke being finalized and by its own check', () => {
    const a = setup();
    (a.canvas as any)._onPointerDown(a.ev(40, 0));
    a.canvas.clearSelection();
    expect(a.loop()).toHaveLength(0);

    const b = setup();
    (b.canvas as any)._onPointerDown(b.ev(40, 0));
    (b.state as any).activeTool = 'hand';
    b.frame(100);
    expect(b.loop()).toHaveLength(0);
  });

  it('stops on blur and comes back when the pen moves again', () => {
    const { canvas, loop, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    (canvas as any)._onWindowBlur();
    expect(loop()).toHaveLength(0);
    (canvas as any)._onPointerMove(ev(41, 30));
    expect(loop()).toHaveLength(1);
  });

  it('does not owe the time a blur spent, at the release or after the pen moves again', () => {
    const lay = (resume: boolean) => {
      const { canvas, ev } = setup();
      const tick = vi.spyOn((canvas as any)._engine, 'tick');
      (canvas as any)._onPointerDown(ev(40, 0));
      (canvas as any)._onWindowBlur();
      if (resume) (canvas as any)._onPointerMove(ev(40, 1000));
      (canvas as any)._onPointerUp(ev(40, 1040));
      return tick.mock.results.map(r => r.value as number).reduce((a, b) => a + b, 0);
    };
    expect(lay(false)).toBe(0);
    // Resumed at 1000: 40 ms is under a dab's time.
    expect(lay(true)).toBe(0);
  });

  it('stops when the element leaves the document', () => {
    const { canvas, loop, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    canvas.disconnectedCallback();
    expect(loop()).toHaveLength(0);
  });

  it('never queues two frames, however often it is asked to start', () => {
    const { canvas, loop, ev } = setup();
    (canvas as any)._onPointerDown(ev(40, 0));
    for (let i = 1; i < 5; i++) (canvas as any)._onPointerMove(ev(40 + i, i * 5));
    expect(loop()).toHaveLength(1);
  });

  it('pauses with a pressure lift when pressure drives the brush', () => {
    const { canvas, frame, ev } = setup();
    (canvas as any)._brushDescriptor.pressureSize = true;
    (canvas as any)._onPointerDown(ev(40, 0, { pointerType: 'pen', pressure: 0.5 }));
    (canvas as any)._onPointerMove(ev(40, 20, { pointerType: 'pen', pressure: 0 }));
    const tick = vi.spyOn((canvas as any)._engine, 'tick');
    frame(500);
    expect(tick).toHaveReturnedWith(0);
  });
});

describe('PathSmoother.settle', () => {
  const pts = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [10 + i * 17, 20 + (i % 2) * 6]);
  const lay = (n: number, settleAt: number | null) => {
    const sm = new PathSmoother();
    const out: number[] = [];
    pts(n).forEach(([x, y], i) => {
      out.push(...sm.addPoint(x, y, 1, 3, i * 16).map(s => Math.round(s.x * 1000)));
      if (settleAt === i + 1) {
        out.push(...sm.settle(3).map(s => Math.round(s.x * 1000)));
        // Settled twice is settled once, and a flush has nothing left.
        expect(sm.settle(3)).toEqual([]);
        expect(sm.flush(3)).toEqual([]);
      }
    });
    return out;
  };

  it.each([2, 3, 4, 6])('lays the tail once when settled after %s points, with the rest of the path unchanged', (at) => {
    const settled = lay(9, at);
    // What comes after the settle never repeats or goes back over a stamp it laid.
    for (let i = 1; i < settled.length; i++) expect(settled[i]).toBeGreaterThan(settled[i - 1] - 1);
    // Ends at the last point of the path either way.
    expect(settled[settled.length - 1]).toBeGreaterThan(130 * 1000 - 3000);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { makeBrush } from './helpers.ts';

function strokeAlphas(durationMs: number): number[] {
  const alphaSetter = vi.spyOn(CanvasRenderingContext2D.prototype, 'globalAlpha', 'set');
  const engine = new StampStrokeEngine();
  const brush = makeBrush({
    size: 10,
    flow: 0.25,
    spacing: 0.5,
    pressureSize: false,
    ink: { buildup: 1 },
  });

  engine.begin(brush, '#000000', false, 120, 20);
  engine.stroke(5, 10, 1, undefined, 0);
  engine.stroke(105, 10, 1, undefined, durationMs);

  const alphas = alphaSetter.mock.calls
    .map(([value]) => value)
    .filter(value => value > 0 && value < 1);
  alphaSetter.mockRestore();
  return alphas;
}

describe('StampStrokeEngine pressure and buildup', () => {
  it('does not paint a zero-pressure sample', () => {
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush(), '#000000', false, 20, 20);

    engine.stroke(10, 10, 0, undefined, 0);

    expect(engine.getDirtyBounds()).toBeNull();
  });

  it('does not reconnect across a zero-pressure gap', () => {
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 10, spacing: 0.5, pressureSize: true }), '#000000', false, 120, 20);
    engine.stroke(5, 10, 1, undefined, 0);
    engine.stroke(55, 10, 0, undefined, 100);
    engine.stroke(105, 10, 1, undefined, 200);

    const preview = engine.getStrokePreview();
    const ctx = (preview!.canvas as HTMLCanvasElement).getContext('2d')!;
    const drawCalls = ctx.__getDrawCalls().filter(event => event.type === 'drawImage');

    expect(drawCalls).toHaveLength(2);
  });

  it('ignores pressure values when both pressure effects are disabled', () => {
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ pressureSize: false, pressureOpacity: false }), '#000000', false, 20, 20);

    engine.stroke(10, 10, 0, undefined, 0);

    expect(engine.getDirtyBounds()).not.toBeNull();
  });

  it('wires pointer speed through to rendered stamp alpha', () => {
    const slow = strokeAlphas(1000);
    const fast = strokeAlphas(100);

    expect(Math.max(...slow)).toBeGreaterThan(Math.max(...fast));
    expect(Math.max(...fast)).toBe(0.25);
  });

  it('lays dabs at subpixel positions and at the exact pressure size', () => {
    // Spied directly: the canvas mock records the wrong dWidth/dHeight for 5-argument drawImage.
    const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 5, spacing: 10, pressureSize: true, pressureCurve: 'linear' }), '#000000', false, 40, 40);
    // Pressure 0.66 makes a 3.3 px dab; tips are cached at an even 4 px.
    engine.stroke(10.3, 12.7, 0.66, undefined, 0);

    const [, dx, dy, dw, dh] = drawImage.mock.lastCall as unknown as [unknown, number, number, number, number];
    drawImage.mockRestore();
    expect(dw).toBeCloseTo(3.3);
    expect(dh).toBeCloseTo(3.3);
    expect(dx + dw / 2).toBeCloseTo(10.3);
    expect(dy + dh / 2).toBeCloseTo(12.7);
    const bounds = engine.getDirtyBounds()!;
    expect(bounds.x).toBeLessThanOrEqual(dx);
    expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(dx + dw);
  });

  it('grows every tip shape smoothly with size, across the quantized tip diameters', () => {
    const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
    for (const shape of ['round', 'flat', 'chisel', 'calligraphy'] as const) {
      let prev: { w: number; h: number } | null = null;
      for (let size = 1; size <= 12; size += 0.05) {
        const engine = new StampStrokeEngine();
        engine.begin(makeBrush({ size, pressureSize: false, tip: { shape, aspect: 4, angle: 0, orientation: 'fixed' } }), '#000000', false, 40, 40);
        engine.stroke(20, 20, 1, undefined, 0);
        const [, , , w, h] = drawImage.mock.lastCall as unknown as [unknown, number, number, number, number];
        // Calligraphy: dabs a hair past 3px were drawn half as tall when their tip came from the next cached diameter.
        if (prev) {
          expect(w, `${shape} width at ${size}`).toBeGreaterThanOrEqual(prev.w);
          expect(h, `${shape} height at ${size}`).toBeGreaterThanOrEqual(prev.h);
          expect(w - prev.w, `${shape} width jump at ${size}`).toBeLessThan(0.1);
          expect(h - prev.h, `${shape} height jump at ${size}`).toBeLessThan(0.1);
        }
        prev = { w, h };
      }
    }
    drawImage.mockRestore();
  });
});

describe('calligraphy tips', () => {
  it('fill their canvas, so a dab is as thick as its footprint at any size', async () => {
    const { generateCalligraphyTip } = await import('../src/engine/tip-generators.ts');
    const ellipse = vi.spyOn(CanvasRenderingContext2D.prototype, 'ellipse');
    const tip = { shape: 'calligraphy' as const, aspect: 4, angle: 0, orientation: 'fixed' as const };
    for (const diameter of [8, 10, 22]) {
      ellipse.mockClear();
      const canvas = generateCalligraphyTip(diameter, 1, tip) as HTMLCanvasElement;
      const [, , rx, ry] = ellipse.mock.calls[0] as number[];
      expect(rx * 2).toBe(canvas.width);
      expect(ry * 2).toBe(canvas.height);
    }
    ellipse.mockRestore();
  });
});

describe('dab spacing', () => {
  it('keeps a steep pressure taper joined at wide spacing', () => {
    const dabs: { x: number; w: number }[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      if (args.length === 5 && (args[0] as HTMLCanvasElement).width <= 100) {
        dabs.push({ x: (args[1] as number) + (args[3] as number) / 2, w: args[3] as number });
      }
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 100, spacing: 0.75, pressureSize: true, pressureCurve: 'linear' }), '#000000', false, 600, 200);
    [[50, 1], [150, 1], [250, 0.01], [350, 0.01]].forEach(([x, p], i) => engine.stroke(x, 100, p, undefined, i * 16));
    engine.commit(document.createElement('canvas').getContext('2d')!);
    spy.mockRestore();

    expect(dabs.length).toBeGreaterThan(5);
    for (let i = 1; i < dabs.length; i++) {
      expect(dabs[i].x - dabs[i - 1].x).toBeLessThanOrEqual((dabs[i].w + dabs[i - 1].w) / 2 + 0.01);
    }
  });

  it('keeps a taper joined that starts past where the spacing was set', () => {
    const dabs: { x: number; w: number }[] = [];
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      if (args.length === 5 && (args[0] as HTMLCanvasElement).width <= 100) {
        dabs.push({ x: (args[1] as number) + (args[3] as number) / 2, w: args[3] as number });
      }
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 100, spacing: 0.75, pressureSize: true, pressureCurve: 'linear' }), '#000000', false, 600, 200);
    [1, 1, 0.7, 0.3, 0.2, 0.8, 0.1].forEach((p, i) => engine.stroke(50 + 60 * i, 100, p, undefined, 60 * i));
    engine.commit(document.createElement('canvas').getContext('2d')!);
    spy.mockRestore();

    for (let i = 1; i < dabs.length; i++) {
      expect(dabs[i].x - dabs[i - 1].x).toBeLessThanOrEqual((dabs[i].w + dabs[i - 1].w) / 2 + 0.01);
    }
  });

  it('keeps random pressure joined and about as dense at any report rate, straight or curved', () => {
    // A seeded generator, so a failure reproduces.
    let seed = 7;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    const lay = (path: (u: number) => [number, number], pressure: (u: number) => number, step: number, spacing: number) => {
      const dabs: { x: number; y: number; w: number }[] = [];
      const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
        if (args.length === 5 && (args[0] as HTMLCanvasElement).width <= 100) {
          const w = args[3] as number;
          dabs.push({ x: (args[1] as number) + w / 2, y: (args[2] as number) + (args[4] as number) / 2, w });
        }
      });
      const engine = new StampStrokeEngine();
      engine.begin(makeBrush({ size: 100, spacing, pressureSize: true, pressureCurve: 'linear' }), '#000000', false, 800, 800);
      for (let d = 0; ; d += step) {
        const u = Math.min(1, d / 600);
        const [x, y] = path(u);
        engine.stroke(x, y, pressure(u), undefined, d);
        if (u === 1) break;
      }
      engine.commit(document.createElement('canvas').getContext('2d')!);
      spy.mockRestore();
      return dabs;
    };
    const straight = (u: number): [number, number] => [100 + 600 * u, 400];
    const curved = (u: number): [number, number] => [400 + 250 * Math.cos(u * 2.4), 400 + 250 * Math.sin(u * 2.4)];
    for (let trial = 0; trial < 4; trial++) {
      // Pressure through random knots, dips to nearly nothing included.
      const knots = Array.from({ length: 9 }, () => (random() < 0.3 ? 0.02 : 0.05 + 0.95 * random()));
      const pressure = (u: number) => {
        const k = u * (knots.length - 1), i = Math.min(knots.length - 2, Math.floor(k));
        return knots[i] + (knots[i + 1] - knots[i]) * (k - i);
      };
      for (const spacing of [0.1, 0.5, 0.75]) {
        for (const path of [straight, curved]) {
          const fine = lay(path, pressure, 1, spacing).length;
          for (const step of [1, 3, 15, 17, 25, 60, 75, 100]) {
            const dabs = lay(path, pressure, step, spacing);
            for (let i = 1; i < dabs.length; i++) {
              const gap = Math.hypot(dabs[i].x - dabs[i - 1].x, dabs[i].y - dabs[i - 1].y) - (dabs[i].w + dabs[i - 1].w) / 2;
              expect(gap, `trial ${trial}, spacing ${spacing}, step ${step}, dab ${i}`).toBeLessThanOrEqual(0.01);
            }
            // Reports that miss knots draw a different pressure; compare those that don't.
            if (path === straight && 75 % step === 0) {
              expect(Math.abs(dabs.length - fine) / fine, `trial ${trial}, spacing ${spacing}, step ${step}`).toBeLessThan(0.2);
            }
          }
        }
      }
    }
  });

  it('lays a taper about as densely however often the pen reported it', () => {
    const taperDabs = (step: number) => {
      let count = 0;
      const spy = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
        if (args.length === 5 && (args[0] as HTMLCanvasElement).width <= 100) count++;
      });
      const engine = new StampStrokeEngine();
      engine.begin(makeBrush({ size: 100, spacing: 0.1, pressureSize: true, pressureCurve: 'linear' }), '#000000', false, 400, 300);
      for (let x = 100; x <= 200; x += step) engine.stroke(x, 150, 1 - 0.9 * (x - 100) / 100, undefined, x);
      engine.commit(document.createElement('canvas').getContext('2d')!);
      spy.mockRestore();
      return count;
    };
    const fine = taperDabs(1);
    const coarse = taperDabs(100);
    // Spacing the whole of a coarse segment for its narrow end would lay
    // several times as many dabs, darkening the stroke at low flow.
    expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.2);
  });
});


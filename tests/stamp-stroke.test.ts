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


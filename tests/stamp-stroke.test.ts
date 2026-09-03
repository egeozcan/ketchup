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
});

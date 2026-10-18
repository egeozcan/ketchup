import { describe, expect, it } from 'vitest';
import { PathSmoother } from '../src/engine/path-smoother.ts';

function straightStroke(durationMs: number) {
  const smoother = new PathSmoother();
  const points = [
    ...smoother.addPoint(0, 0, 1, 10, 0),
    ...smoother.addPoint(100, 0, 1, 10, durationMs),
    ...smoother.flush(10),
  ];
  return points.filter(point => point.x > 0);
}

describe('PathSmoother velocity', () => {
  it('carries input speed onto uniformly spaced stamps', () => {
    const slow = straightStroke(1000);
    const fast = straightStroke(100);

    expect(slow.every(point => point.speedPxPerMs === 0.1)).toBe(true);
    expect(fast.every(point => point.speedPxPerMs === 1)).toBe(true);
  });
});

describe('PathSmoother spacing', () => {
  it('lays stamps at a fixed spacing across segments', () => {
    const smoother = new PathSmoother();
    const xs = [0, 20, 40, 60, 80, 100].flatMap((x, i) => smoother.addPoint(x, 0, 1, 7, i * 10)).concat(smoother.flush(7)).map(p => p.x);
    xs.forEach((x, i) => expect(x).toBeCloseTo(i * 7, 2));
    expect(xs.length).toBe(15);
  });

  it('lays the next stamp at the first point a narrower one is due, not past a narrowing', () => {
    const smoother = new PathSmoother();
    // Stamps want 50 px, except in a narrow band where they want 2.
    const spacing = (at: { x: number }) => (at.x >= 20 && at.x <= 22 ? 2 : 50);
    const xs = [...smoother.addPoint(0, 0, 1, spacing, 0), ...smoother.addPoint(100, 0, 1, spacing, 100)].map(p => p.x);
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBeCloseTo(20, 3);
  });
});

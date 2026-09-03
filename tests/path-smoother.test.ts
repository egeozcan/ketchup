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

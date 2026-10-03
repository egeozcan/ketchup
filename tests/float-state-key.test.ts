import { describe, expect, it } from 'vitest';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { makeCanvas } from './helpers.ts';

function make() {
  return new TransformManager(new ImageData(10, 10), { x: 0, y: 0, w: 10, h: 10 }, makeCanvas(100, 100), 1, { x: 0, y: 0 });
}

describe('TransformManager.getStateKey', () => {
  it('is stable while the float is untouched and changes with each edit', () => {
    const tm = make();
    const key = tm.getStateKey();
    expect(tm.getStateKey()).toBe(key);
    tm.x = 5;
    const moved = tm.getStateKey();
    expect(moved).not.toBe(key);
    tm.rotation = 10;
    expect(tm.getStateKey()).not.toBe(moved);
  });

  it('follows perspective corners and differs between floats', () => {
    const tm = make();
    (tm as any)._perspectiveActive = true;
    const before = tm.getStateKey();
    (tm as any)._perspectiveCorners.se = { x: 3, y: 2 };
    expect(tm.getStateKey()).not.toBe(before);
    expect(make().getStateKey()).not.toBe(make().getStateKey());
  });
});

import { describe, expect, it } from 'vitest';
import { applyBuildup } from '../src/engine/ink-model.ts';
import type { InkDescriptor } from '../src/engine/types.ts';

const INK: InkDescriptor = {
  depletion: 0,
  depletionLength: 500,
  buildup: 1,
  wetness: 0,
};

describe('paint buildup', () => {
  it('deposits more paint for a slow stroke than a fast stroke', () => {
    const slow = applyBuildup(INK, 0.25, 0.1);
    const fast = applyBuildup(INK, 0.25, 1);

    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBe(0.25);
  });

  it('does not change flow when buildup is disabled', () => {
    expect(applyBuildup({ ...INK, buildup: 0 }, 0.25, 0.1)).toBe(0.25);
  });
});

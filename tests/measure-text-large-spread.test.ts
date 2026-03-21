import { describe, expect, it } from 'vitest';
import { measureTextBlock } from '../src/tools/text.ts';

describe('measureTextBlock large line count', () => {
  it('does not throw RangeError when text has more lines than the call stack can spread', () => {
    // Math.max(0, ...lineWidths) spreads all line widths as individual
    // arguments. When the text has more lines than the JS engine can handle
    // as function arguments (~125k on V8), it throws
    // "Maximum call stack size exceeded". A safe implementation should use
    // a loop or reduce instead of spread.

    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;

    // 150 000 newlines → 150 001 lines (each empty).
    // On V8, Math.max(0, ...new Array(150001).fill(0)) throws
    // "Maximum call stack size exceeded" because the spread exceeds the
    // engine's maximum argument count for function calls (~125k on V8).
    const bigText = '\n'.repeat(150_000);

    expect(() => {
      measureTextBlock(ctx, bigText, 16, 'sans-serif', false, false);
    }).not.toThrow();
  });

  it('returns correct width for a large multi-line text', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;

    // Build text where only the 100 000th line has content; rest are empty.
    const lines = new Array(150_001).fill('');
    lines[100_000] = 'hello';
    const bigText = lines.join('\n');

    // Should not throw AND should report a non-zero width (from the
    // 'hello' line).
    const result = measureTextBlock(ctx, bigText, 16, 'sans-serif', false, false);
    expect(result.width).toBeGreaterThan(0);
    expect(result.lineWidths.length).toBe(150_001);
  });
});

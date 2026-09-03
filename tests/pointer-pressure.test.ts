import { describe, expect, it } from 'vitest';
import { normalizePointerPressure } from '../src/utils/pointer-pressure.ts';

describe('pointer pressure normalization', () => {
  it('uses full size for a mouse instead of the Pointer Events placeholder pressure', () => {
    expect(normalizePointerPressure({ pointerType: 'mouse', pressure: 0.5 })).toBe(1);
  });

  it('preserves real pen pressure, including zero', () => {
    expect(normalizePointerPressure({ pointerType: 'pen', pressure: 0 })).toBe(0);
    expect(normalizePointerPressure({ pointerType: 'pen', pressure: 0.35 })).toBe(0.35);
  });

  it('uses full pressure for touch hardware that does not report force', () => {
    expect(normalizePointerPressure({ pointerType: 'touch', pressure: 0 })).toBe(1);
    expect(normalizePointerPressure({ pointerType: 'touch', pressure: 0.2 })).toBe(1);
    expect(normalizePointerPressure({ pointerType: 'touch', pressure: 0.5 })).toBe(1);
    expect(normalizePointerPressure({ pointerType: 'touch', pressure: 0.8 })).toBe(1);
  });

  it('retains the legacy fallback for unidentified pointer devices', () => {
    expect(normalizePointerPressure({ pointerType: '', pressure: 0 })).toBe(0.5);
  });
});

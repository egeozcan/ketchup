import { describe, expect, it } from 'vitest';
import { getDefaultTipDescriptor, getTipCapabilities } from '../src/engine/brush-capabilities.ts';

describe('brush tip capabilities', () => {
  it('only exposes controls that can change each tip shape', () => {
    expect(getTipCapabilities('round')).toEqual({
      aspect: false,
      rotation: false,
      bristles: false,
    });
    expect(getTipCapabilities('flat')).toEqual({
      aspect: true,
      rotation: true,
      bristles: false,
    });
    expect(getTipCapabilities('chisel')).toEqual({
      aspect: true,
      rotation: true,
      bristles: false,
    });
    expect(getTipCapabilities('calligraphy')).toEqual({
      aspect: true,
      rotation: true,
      bristles: false,
    });
    expect(getTipCapabilities('fan')).toEqual({
      aspect: false,
      rotation: true,
      bristles: true,
    });
    expect(getTipCapabilities('splatter')).toEqual({
      aspect: false,
      rotation: true,
      bristles: true,
    });
  });

  it('provides valid, shape-specific defaults when changing tip type', () => {
    expect(getDefaultTipDescriptor('fan')).toEqual({
      shape: 'fan',
      aspect: 1,
      angle: 0,
      orientation: 'direction',
      bristles: 8,
      spread: 120,
    });
    expect(getDefaultTipDescriptor('splatter')).toEqual({
      shape: 'splatter',
      aspect: 1,
      angle: 0,
      orientation: 'fixed',
      bristles: 12,
      spread: 0.8,
    });
  });
});

import type { TipDescriptor, TipShape } from './types.js';

export interface TipCapabilities {
  aspect: boolean;
  rotation: boolean;
  bristles: boolean;
}

const CAPABILITIES: Record<TipShape, TipCapabilities> = {
  round: { aspect: false, rotation: false, bristles: false },
  flat: { aspect: true, rotation: true, bristles: false },
  chisel: { aspect: true, rotation: true, bristles: false },
  calligraphy: { aspect: true, rotation: true, bristles: false },
  fan: { aspect: false, rotation: true, bristles: true },
  splatter: { aspect: false, rotation: true, bristles: true },
};

const DEFAULT_TIPS: Record<TipShape, TipDescriptor> = {
  round: { shape: 'round', aspect: 1, angle: 0, orientation: 'fixed' },
  flat: { shape: 'flat', aspect: 3, angle: 0, orientation: 'direction' },
  chisel: { shape: 'chisel', aspect: 2.5, angle: 0, orientation: 'direction' },
  calligraphy: { shape: 'calligraphy', aspect: 4, angle: 45, orientation: 'fixed' },
  fan: { shape: 'fan', aspect: 1, angle: 0, orientation: 'direction', bristles: 8, spread: 120 },
  splatter: { shape: 'splatter', aspect: 1, angle: 0, orientation: 'fixed', bristles: 12, spread: 0.8 },
};

export function getTipCapabilities(shape: TipShape): TipCapabilities {
  return CAPABILITIES[shape];
}

export function getDefaultTipDescriptor(shape: TipShape): TipDescriptor {
  return { ...DEFAULT_TIPS[shape] };
}

import type { BrushDescriptor, BrushPreset } from './types.js';
import { getDefaultTipDescriptor } from './brush-capabilities.js';

const NO_INK = { depletion: 0, depletionLength: 500, buildup: 0, wetness: 0 };

export const BRUSH_PRESETS: BrushPreset[] = [
  {
    id: 'round',
    name: 'Round',
    category: 'basic',
    descriptor: {
      size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 0.15,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('round'),
      ink: { ...NO_INK },
    },
  },
  {
    id: 'soft-round',
    name: 'Soft Round',
    category: 'basic',
    descriptor: {
      size: 20, opacity: 1, flow: 0.6, hardness: 0.3, spacing: 0.12,
      pressureSize: true, pressureOpacity: true, pressureCurve: 'light',
      tip: getDefaultTipDescriptor('round'),
      ink: { ...NO_INK },
    },
  },
  {
    id: 'flat',
    name: 'Flat',
    category: 'artistic',
    descriptor: {
      size: 30, opacity: 1, flow: 0.8, hardness: 0.9, spacing: 0.1,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('flat'),
      ink: { depletion: 0.3, depletionLength: 800, buildup: 0, wetness: 0 },
    },
  },
  {
    id: 'chisel',
    name: 'Chisel',
    category: 'artistic',
    descriptor: {
      size: 24, opacity: 1, flow: 0.9, hardness: 0.95, spacing: 0.1,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('chisel'),
      ink: { depletion: 0.2, depletionLength: 600, buildup: 0.3, wetness: 0 },
    },
  },
  {
    id: 'calligraphy',
    name: 'Calligraphy',
    category: 'artistic',
    descriptor: {
      size: 20, opacity: 1, flow: 1, hardness: 1, spacing: 0.08,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('calligraphy'),
      ink: { ...NO_INK },
    },
  },
  {
    id: 'fan',
    name: 'Fan',
    category: 'artistic',
    descriptor: {
      size: 40, opacity: 1, flow: 0.7, hardness: 0.8, spacing: 0.15,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('fan'),
      ink: { depletion: 0.5, depletionLength: 600, buildup: 0, wetness: 0 },
    },
  },
  {
    id: 'splatter',
    name: 'Splatter',
    category: 'effects',
    descriptor: {
      size: 50, opacity: 0.8, flow: 0.6, hardness: 0.7, spacing: 0.25,
      pressureSize: false, pressureOpacity: true, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('splatter'),
      ink: { depletion: 0.7, depletionLength: 400, buildup: 0, wetness: 0 },
    },
  },
  {
    id: 'dry-brush',
    name: 'Dry Brush',
    category: 'artistic',
    descriptor: {
      size: 25, opacity: 1, flow: 0.5, hardness: 0.8, spacing: 0.12,
      pressureSize: true, pressureOpacity: true, pressureCurve: 'heavy',
      tip: getDefaultTipDescriptor('round'),
      ink: { depletion: 0.8, depletionLength: 300, buildup: 0.4, wetness: 0 },
    },
  },
  {
    id: 'wet-brush',
    name: 'Wet Brush',
    category: 'artistic',
    descriptor: {
      size: 20, opacity: 0.8, flow: 0.7, hardness: 0.5, spacing: 0.1,
      pressureSize: false, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('round'),
      ink: { depletion: 0, depletionLength: 500, buildup: 0.2, wetness: 0.91 },
    },
  },
];

export function getPresetById(id: string): BrushPreset | undefined {
  return BRUSH_PRESETS.find(p => p.id === id);
}

export function getDefaultDescriptor(): BrushDescriptor {
  return { ...BRUSH_PRESETS[0].descriptor, tip: { ...BRUSH_PRESETS[0].descriptor.tip }, ink: { ...BRUSH_PRESETS[0].descriptor.ink } };
}

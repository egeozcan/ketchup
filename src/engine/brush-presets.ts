import type { BrushDescriptor, BrushDynamics, BrushJitter, BrushPreset } from './types.js';
import { getDefaultTipDescriptor } from './brush-capabilities.js';

const NO_INK = { depletion: 0, depletionLength: 500, buildup: 0, wetness: 0 };
export const NO_DYNAMICS: BrushDynamics = { sizeVelocity: 0, flowVelocity: 0, minSize: 0, tilt: 0 };
export const NO_JITTER: BrushJitter = { size: 0, angle: 0, roundness: 0, flow: 0 };

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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
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
      dynamics: { ...NO_DYNAMICS },
      jitter: { ...NO_JITTER },
    },
  },
];

export function getPresetById(id: string): BrushPreset | undefined {
  return BRUSH_PRESETS.find(p => p.id === id);
}

export function getDefaultDescriptor(): BrushDescriptor {
  return copyDescriptor(BRUSH_PRESETS[0].descriptor);
}

/** A descriptor that shares no nested object with `d`. */
export function copyDescriptor(d: BrushDescriptor): BrushDescriptor {
  return { ...d, tip: { ...d.tip }, ink: { ...d.ink }, dynamics: { ...d.dynamics }, jitter: { ...NO_JITTER, ...d.jitter } };
}

/** Stored dynamics over the defaults, each clamped to -1..1; a value that isn't a number keeps its default. */
const DYNAMICS_RANGES: Record<keyof BrushDynamics, [number, number]> = {
  sizeVelocity: [-1, 1],
  flowVelocity: [-1, 1],
  minSize: [0, 1],
  tilt: [0, 1],
};

export function normalizeDynamics(stored: Partial<BrushDynamics> | undefined): BrushDynamics {
  const out = { ...NO_DYNAMICS };
  for (const key of Object.keys(out) as (keyof BrushDynamics)[]) {
    const v = stored?.[key];
    const [min, max] = DYNAMICS_RANGES[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.max(min, Math.min(max, v));
  }
  return out;
}

/** Stored jitter over the defaults, each clamped to 0..1; a value that isn't a number keeps its default. */
export function normalizeJitter(stored: Partial<BrushJitter> | undefined): BrushJitter {
  const out = { ...NO_JITTER };
  for (const key of Object.keys(out) as (keyof BrushJitter)[]) {
    const v = stored?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.max(0, Math.min(1, v));
  }
  return out;
}

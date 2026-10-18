import type { BrushDescriptor, TipDescriptor, BrushDynamics, BrushJitter, BrushScatter, BrushColorDynamics, BrushFade, BrushTexture, BrushPreset } from './types.js';
import { isBrushBlendMode, isTextureMode, isTipShape } from './types.js';
import { MAX_PATTERN_ID_LENGTH } from './brush-texture.js';
import { getDefaultTipDescriptor } from './brush-capabilities.js';

const NO_INK = { depletion: 0, depletionLength: 500, buildup: 0, wetness: 0 };
export const NO_DYNAMICS: BrushDynamics = { sizeVelocity: 0, flowVelocity: 0, minSize: 0, tilt: 0 };
export const NO_JITTER: BrushJitter = { size: 0, angle: 0, roundness: 0, flow: 0 };

/** The ranges scatter's controls and stored values stay within. */
export const MAX_SCATTER = 5;
export const MAX_SCATTER_COUNT = 16;
export const NO_SCATTER: BrushScatter = { amount: 0, bothAxes: false, count: 1, countJitter: 0 };

/** The ranges the airbrush rate (dabs per second) and its stored values stay within. */
export const MIN_AIRBRUSH_RATE = 5;
export const MAX_AIRBRUSH_RATE = 60;
export const DEFAULT_AIRBRUSH_RATE = 20;

/** A stored airbrush rate clamped to its range; the default when it isn't a number (older stored brushes have none). */
export function normalizeAirbrushRate(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(MIN_AIRBRUSH_RATE, Math.min(MAX_AIRBRUSH_RATE, v)) : DEFAULT_AIRBRUSH_RATE;
}

/** Longest fade or taper length (px) a stored value may have. */
export const MAX_FADE_LENGTH = 5000;
export const NO_FADE: BrushFade = { sizeLength: 0, sizeUnit: 'distance', taperStart: 0 };

/** Stored fade lengths over the defaults, each clamped to 0..MAX_FADE_LENGTH; a value that isn't a number keeps its default (off). */
export function normalizeFade(stored: Partial<BrushFade> | undefined): BrushFade {
  const out = { ...NO_FADE };
  for (const key of ['sizeLength', 'taperStart'] as const) {
    const v = stored?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.max(0, Math.min(MAX_FADE_LENGTH, v));
  }
  if (stored?.sizeUnit === 'dabs') out.sizeUnit = 'dabs';
  return out;
}

export const MIN_TEXTURE_SCALE = 0.1;
export const MAX_TEXTURE_SCALE = 4;
export const NO_TEXTURE: BrushTexture = { pattern: 'none', scale: 1, depth: 0.8, mode: 'multiply', invert: false, depthPressure: false, perTip: false };

/** Stored texture settings over the defaults; anything of the wrong kind or out of range keeps its default or is clamped. */
export function normalizeTexture(stored: Partial<BrushTexture> | undefined): BrushTexture {
  const out = { ...NO_TEXTURE };
  if (!stored || typeof stored !== 'object') return out;
  if (typeof stored.pattern === 'string' && stored.pattern.length > 0 && stored.pattern.length <= MAX_PATTERN_ID_LENGTH) out.pattern = stored.pattern;
  if (typeof stored.scale === 'number' && Number.isFinite(stored.scale)) out.scale = Math.max(MIN_TEXTURE_SCALE, Math.min(MAX_TEXTURE_SCALE, stored.scale));
  if (typeof stored.depth === 'number' && Number.isFinite(stored.depth)) out.depth = Math.max(0, Math.min(1, stored.depth));
  if (isTextureMode(stored.mode)) out.mode = stored.mode;
  out.invert = stored.invert === true;
  out.depthPressure = stored.depthPressure === true;
  out.perTip = stored.perTip === true;
  return out;
}

export const NO_COLOR: BrushColorDynamics = { hue: 0, saturation: 0, brightness: 0, purity: 0, fgBg: 0, fgBgPressure: false, perTip: true };

/**
 * Whether colour dynamics change the colour of any dab. The two switches
 * alone don't: pressure needs a mix to drive, and per-tip needs a variation.
 */
export function colorDynamicsActive(c: BrushColorDynamics | undefined): boolean {
  return !!c && (c.hue > 0 || c.saturation > 0 || c.brightness > 0 || c.purity !== 0 || c.fgBg > 0);
}

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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
    },
  },
  {
    id: 'ink-pen',
    name: 'Ink Pen',
    category: 'basic',
    descriptor: {
      size: 6, opacity: 1, flow: 1, hardness: 1, spacing: 0.1,
      pressureSize: true, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('round'),
      ink: { ...NO_INK },
      dynamics: { ...NO_DYNAMICS, minSize: 0.15 },
      jitter: { ...NO_JITTER },
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE, taperStart: 40 },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
    },
  },
  {
    id: 'spray',
    name: 'Spray',
    category: 'effects',
    descriptor: {
      size: 12, opacity: 1, flow: 0.6, hardness: 0.5, spacing: 0.5,
      pressureSize: false, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('round'),
      ink: { ...NO_INK },
      dynamics: { ...NO_DYNAMICS },
      jitter: { size: 0.6, angle: 0, roundness: 0, flow: 0.5 },
      scatter: { amount: 2, bothAxes: true, count: 8, countJitter: 0.5 },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
    },
  },
  {
    id: 'confetti',
    name: 'Confetti',
    category: 'effects',
    descriptor: {
      size: 14, opacity: 1, flow: 1, hardness: 1, spacing: 0.9,
      pressureSize: false, pressureOpacity: false, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('flat'),
      ink: { ...NO_INK },
      dynamics: { ...NO_DYNAMICS },
      jitter: { size: 0.4, angle: 1, roundness: 0.5, flow: 0 },
      scatter: { amount: 1.5, bothAxes: true, count: 3, countJitter: 0.3 },
      // Toward the fill colour as well as around the stroke's own hue, so it also shows on black.
      color: { hue: 1, saturation: 0.3, brightness: 0.2, purity: 0, fgBg: 1, fgBgPressure: false, perTip: true },
      fade: { ...NO_FADE },
      texture: { ...NO_TEXTURE },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
    },
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    category: 'artistic',
    descriptor: {
      size: 30, opacity: 1, flow: 0.8, hardness: 0.6, spacing: 0.1,
      pressureSize: true, pressureOpacity: true, pressureCurve: 'linear',
      tip: getDefaultTipDescriptor('round'),
      ink: { ...NO_INK },
      dynamics: { ...NO_DYNAMICS, minSize: 0.4 },
      jitter: { ...NO_JITTER },
      scatter: { ...NO_SCATTER },
      color: { ...NO_COLOR },
      fade: { ...NO_FADE },
      texture: { pattern: 'charcoal', scale: 1, depth: 0.9, mode: 'height', invert: false, depthPressure: false, perTip: false },
      blendMode: 'normal',
      airbrush: false, airbrushRate: DEFAULT_AIRBRUSH_RATE,
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
  return { ...d, tip: { ...d.tip }, ink: { ...d.ink }, dynamics: { ...d.dynamics }, jitter: { ...NO_JITTER, ...d.jitter }, scatter: { ...NO_SCATTER, ...d.scatter }, color: { ...NO_COLOR, ...d.color }, fade: { ...NO_FADE, ...d.fade }, texture: normalizeTexture(d.texture), blendMode: isBrushBlendMode(d.blendMode) ? d.blendMode : 'normal', airbrush: d.airbrush === true, airbrushRate: normalizeAirbrushRate(d.airbrushRate) };
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

/** Stored scatter over the defaults: amount 0..5, count a whole number 1..16, countJitter 0..1; anything else keeps its default. */
export function normalizeScatter(stored: Partial<BrushScatter> | undefined): BrushScatter {
  const out = { ...NO_SCATTER };
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  out.amount = num(stored?.amount, 0, MAX_SCATTER, out.amount);
  out.count = Math.round(num(stored?.count, 1, MAX_SCATTER_COUNT, out.count));
  out.countJitter = num(stored?.countJitter, 0, 1, out.countJitter);
  if (typeof stored?.bothAxes === 'boolean') out.bothAxes = stored.bothAxes;
  return out;
}

/** Stored colour dynamics over the defaults: purity -1..1, the other amounts 0..1, the switches booleans; anything else keeps its default. */
export function normalizeColorDynamics(stored: Partial<BrushColorDynamics> | undefined): BrushColorDynamics {
  const out = { ...NO_COLOR };
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  out.hue = num(stored?.hue, 0, 1, out.hue);
  out.saturation = num(stored?.saturation, 0, 1, out.saturation);
  out.brightness = num(stored?.brightness, 0, 1, out.brightness);
  out.purity = num(stored?.purity, -1, 1, out.purity);
  out.fgBg = num(stored?.fgBg, 0, 1, out.fgBg);
  if (typeof stored?.fgBgPressure === 'boolean') out.fgBgPressure = stored.fgBgPressure;
  if (typeof stored?.perTip === 'boolean') out.perTip = stored.perTip;
  return out;
}

/** Longest sampled-tip id a stored brush may name. */
export const MAX_TIP_ID_LENGTH = 128;

/**
 * A stored tip over the round default. An unknown shape, or a sampled tip
 * that names no image, is the round default (a brush saved by a newer build
 * must still paint here); the other shapes merge over the default as ever.
 */
export function normalizeTip(stored: Partial<TipDescriptor> | undefined): TipDescriptor {
  const base = getDefaultTipDescriptor('round');
  if (!stored || typeof stored !== 'object' || !isTipShape(stored.shape)) return base;
  const { imageId, ...rest } = stored;
  if (stored.shape === 'image') {
    if (typeof imageId !== 'string' || imageId.length === 0 || imageId.length > MAX_TIP_ID_LENGTH) return base;
    return { ...getDefaultTipDescriptor('image'), ...rest, imageId };
  }
  return { ...base, ...rest };
}

/**
 * A stored brush over the default one: every field present and in range,
 * whatever an older build (or an imported file) left out. The one place
 * stored brushes are read through: project state, user presets, imports.
 */
export function normalizeBrushDescriptor(stored: Partial<BrushDescriptor> | undefined): BrushDescriptor {
  const base = getDefaultDescriptor();
  const s = stored ?? {};
  return {
    size: s.size ?? base.size,
    opacity: s.opacity ?? base.opacity,
    flow: s.flow ?? base.flow,
    hardness: s.hardness ?? base.hardness,
    spacing: s.spacing ?? base.spacing,
    pressureSize: s.pressureSize ?? base.pressureSize,
    pressureOpacity: s.pressureOpacity ?? base.pressureOpacity,
    pressureCurve: s.pressureCurve ?? base.pressureCurve,
    tip: normalizeTip(s.tip),
    ink: { ...base.ink, ...(s.ink ?? {}) },
    dynamics: normalizeDynamics(s.dynamics),
    jitter: normalizeJitter(s.jitter),
    scatter: normalizeScatter(s.scatter),
    color: normalizeColorDynamics(s.color),
    fade: normalizeFade(s.fade),
    texture: normalizeTexture(s.texture),
    blendMode: isBrushBlendMode(s.blendMode) ? s.blendMode : 'normal',
    airbrush: s.airbrush === true,
    airbrushRate: normalizeAirbrushRate(s.airbrushRate),
  };
}

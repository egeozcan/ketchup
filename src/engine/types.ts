export type PressureCurveName = 'linear' | 'light' | 'heavy';

export type TipShape = 'round' | 'flat' | 'chisel' | 'calligraphy' | 'fan' | 'splatter';
export type OrientationMode = 'fixed' | 'direction';

export interface TipDescriptor {
  shape: TipShape;
  aspect: number;
  angle: number;
  orientation: OrientationMode;
  bristles?: number;
  spread?: number;
}

export interface InkDescriptor {
  depletion: number;
  depletionLength: number;
  buildup: number;
  wetness: number;
}

/** How pen pressure and the stroke's speed shape each dab. */
export interface BrushDynamics {
  /**
   * How speed scales dab size and flow, as -1..1: positive grows it with
   * speed (from 1 - c of its value at rest), negative shrinks it (to 1 + c
   * at full speed), 0 leaves it alone.
   */
  sizeVelocity: number;
  flowVelocity: number;
  /** With stylus size, the share (0..1) of the size the lightest touch draws at. */
  minSize: number;
  /** How far (0..1) a leaning pen stretches each dab along its lean. */
  tilt: number;
}

/** Random variation per dab, each 0 (none) to 1 (the most); drawn from the stroke's seeded RNG. */
export interface BrushJitter {
  /** The share (0..1) of the dab's size that can randomly be taken off. */
  size: number;
  /** The range, in turns (0..1), the dab's angle varies over, centred on its own. */
  angle: number;
  /** How far (0..1) a dab can be squashed across its axis: down to 1 - this of its height. */
  roundness: number;
}

export interface BrushDescriptor {
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureCurve: PressureCurveName;
  tip: TipDescriptor;
  ink: InkDescriptor;
  dynamics: BrushDynamics;
  jitter: BrushJitter;
}

export interface BrushPreset {
  id: string;
  name: string;
  category: 'basic' | 'artistic' | 'effects';
  descriptor: BrushDescriptor;
}

export interface InkState {
  distanceTraveled: number;
  remainingPaint: number;
  originalColor: string;
  currentColor: string;
  stampCount: number;
  layerSnapshot: ImageData | null;
  prevRotation: number;
}

/** Values a stroke carries along its path besides pressure, interpolated between samples. */
export interface PathChannels {
  /** Smoothed screen speed as a share (0..1) of the speed dynamics take full effect at. */
  velocity: number;
  /** Pen tilt in degrees (-90..90), as Pointer Events report it; 0, 0 is upright. */
  tiltX: number;
  tiltY: number;
}

export interface StampPoint extends PathChannels {
  x: number;
  y: number;
  pressure: number;
  speedPxPerMs: number;
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'soft-light';

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  'normal': 'Normal',
  'multiply': 'Multiply',
  'screen': 'Screen',
  'overlay': 'Overlay',
  'darken': 'Darken',
  'lighten': 'Lighten',
  'soft-light': 'Soft Light',
};

const BLEND_MODE_TO_COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  'normal': 'source-over',
  'multiply': 'multiply',
  'screen': 'screen',
  'overlay': 'overlay',
  'darken': 'darken',
  'lighten': 'lighten',
  'soft-light': 'soft-light',
};

export function blendModeToCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  return BLEND_MODE_TO_COMPOSITE[mode];
}

export const PRESSURE_CURVES: Record<PressureCurveName, (p: number) => number> = {
  linear: (p) => p,
  light: (p) => Math.pow(p, 0.5),
  heavy: (p) => Math.pow(p, 2.0),
};

/** Quantize diameter to nearest even pixel for cache stability under pressure variation. */
export function quantizeDiameter(d: number): number {
  return Math.max(2, Math.round(d / 2) * 2);
}

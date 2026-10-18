export type PressureCurveName = 'linear' | 'light' | 'heavy';

export type TipShape = 'round' | 'flat' | 'chisel' | 'calligraphy' | 'fan' | 'splatter';
/**
 * What turns the tip: nothing, the stroke's direction, the way the pen leans
 * (its azimuth) or the pen barrel's rotation (twist). `TipDescriptor.angle`
 * is added to the last three.
 */
export type OrientationMode = 'fixed' | 'direction' | 'tilt' | 'twist';

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
  /** The share (0..1) of each dab's flow that can randomly be taken off; the stroke's opacity cap is unchanged. */
  flow: number;
}

/**
 * Scatter lays several dabs around each spot of the path. It is its own block
 * rather than part of BrushJitter: jitter varies a dab's own look from 0 to 1,
 * while scatter changes where and how many dabs go down, with units (dab
 * diameters, a count, a switch) of its own.
 */
export interface BrushScatter {
  /** How far (0..5, in dab diameters) a dab can land from the path, to either side; 0 is off. */
  amount: number;
  /** Scatter along the stroke as well as across it. */
  bothAxes: boolean;
  /** Dabs laid per spot (1..16). */
  count: number;
  /** The share (0..1) of the count that can randomly be taken off a spot. */
  countJitter: number;
}

/**
 * Photoshop's Color Dynamics: the colour each dab is painted in varies around
 * the stroke colour, in OKLCh so a hue step looks as large in every hue. A
 * stroke where all of it is off paints as it always did.
 */
export interface BrushColorDynamics {
  /** How far (0..1) a dab's hue can turn either way; 1 is half a turn. */
  hue: number;
  /** How far (0..1) a dab's chroma can change either way: down to nothing and up to double at 1. */
  saturation: number;
  /** How far (0..1) a dab's lightness can change either way: by half the scale at 1. */
  brightness: number;
  /** Shifts the chroma of the whole stroke (-1 grey .. 1 doubled), by a fixed amount rather than at random. */
  purity: number;
  /** How far (0..1) a dab's colour can move from the stroke colour toward the fill colour. */
  fgBg: number;
  /** Pen pressure sets that mix instead of chance: light pressure goes toward the fill colour, full pressure stays on the stroke's. */
  fgBgPressure: boolean;
  /** Vary per dab; off picks one variation for the whole stroke (Photoshop's "Apply Per Tip"). */
  perTip: boolean;
}

/**
 * Photoshop's tool "Mode": how a stroke combines with the layer it is painted
 * on. The first twelve are canvas blend modes; `behind` paints only under
 * what is already there and `clear` erases, as the eraser does.
 */
export type BrushBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-burn'
  | 'color-dodge'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'behind'
  | 'clear';

export const BRUSH_BLEND_MODE_LABELS: Record<BrushBlendMode, string> = {
  'normal': 'Normal',
  'multiply': 'Multiply',
  'screen': 'Screen',
  'overlay': 'Overlay',
  'darken': 'Darken',
  'lighten': 'Lighten',
  'color-burn': 'Color Burn',
  'color-dodge': 'Color Dodge',
  'hue': 'Hue',
  'saturation': 'Saturation',
  'color': 'Color',
  'luminosity': 'Luminosity',
  'behind': 'Behind',
  'clear': 'Clear',
};

/** Whether a stored value names a brush blend mode (older stored brushes have none). */
export function isBrushBlendMode(v: unknown): v is BrushBlendMode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BRUSH_BLEND_MODE_LABELS, v);
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
  scatter: BrushScatter;
  color: BrushColorDynamics;
  /**
   * How the stroke combines with the layer, defaulting to 'normal'. It lives
   * on the descriptor, not beside it in the tool state, so presets can carry
   * it and it is saved, copied and reset with the rest of the brush. The
   * eraser tool ignores it: it always erases.
   */
  blendMode: BrushBlendMode;
  /**
   * Build-up: while the pen is down and still (or moving slower than the
   * spacing lays dabs), dabs keep landing at the stroke's position at
   * `airbrushRate`. Paint then accumulates in the stroke buffer, up to the
   * stroke opacity, as fast as flow allows (flow under 100% is what builds).
   */
  airbrush: boolean;
  /** Dabs per second a held airbrush lays (5..60). */
  airbrushRate: number;
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
  /** The canvas colour last picked up and how much of it the stamp takes (0 when there was none to pick up). */
  pickedColor: string;
  pickedWeight: number;
}

/** Values a stroke carries along its path besides pressure, interpolated between samples. */
export interface PathChannels {
  /** Smoothed screen speed as a share (0..1) of the speed dynamics take full effect at. */
  velocity: number;
  /** Pen tilt in degrees (-90..90), as Pointer Events report it; 0, 0 is upright. */
  tiltX: number;
  tiltY: number;
  /** Pen barrel rotation in degrees (0..360), as Pointer Events report it; 0 for a pen that reports none. */
  twist: number;
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

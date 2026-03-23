export type PressureCurveName = 'linear' | 'light' | 'heavy';

export interface BrushParams {
  size: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  pressureCurve: PressureCurveName;
  color: string;
  eraser: boolean;
}

export interface StampPoint {
  x: number;
  y: number;
  pressure: number;
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

export function blendModeToCompositeOp(mode: BlendMode): GlobalCompositeOperation {
  if (mode === 'normal') return 'source-over';
  return mode as GlobalCompositeOperation;
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

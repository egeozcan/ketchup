import type { Point } from '../types.js';

/** Which handle the user is dragging */
export type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Current interaction mode within the transform */
export type TransformInteraction =
  | { type: 'idle' }
  | { type: 'moving'; startPoint: Point; startX: number; startY: number }
  | { type: 'resizing'; handle: HandleType; origin: { rect: TransformRect; point: Point } }
  | { type: 'rotating'; startAngle: number; startRotation: number }
  | { type: 'skewing'; edge: 'n' | 'e' | 's' | 'w'; startPoint: Point; startSkewX: number; startSkewY: number }
  | { type: 'perspective'; corner: 'nw' | 'ne' | 'se' | 'sw'; startPoint: Point }
  | { type: 'outside-pending'; startPoint: Point };

/** Bounding rect in document space */
export interface TransformRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Individual transform parameters — composed into a DOMMatrix on every change */
export interface TransformState {
  /** Position of top-left corner in document pixels */
  x: number;
  y: number;
  /** Size in document pixels */
  width: number;
  height: number;
  /** Rotation in radians (clockwise) */
  rotation: number;
  /** Skew angles in degrees */
  skewX: number;
  skewY: number;
  /** Scale factors (negative = flipped) */
  scaleX: number;
  scaleY: number;
}

/** Per-corner offsets for perspective warp (relative to affine-transformed corners) */
export interface PerspectiveCorners {
  nw: Point;
  ne: Point;
  se: Point;
  sw: Point;
}

/** Handle visual configuration (adapts for touch) */
export interface HandleConfig {
  /** Visual size of handle in viewport pixels */
  size: number;
  /** Hit area radius in viewport pixels */
  hitRadius: number;
  /** Whether to draw as circle (touch) or square (desktop) */
  shape: 'square' | 'circle';
  /** Rotation handle stem length in viewport pixels */
  rotationStemLength: number;
}

export const HANDLE_CONFIG_DESKTOP: HandleConfig = {
  size: 8,
  hitRadius: 6,
  shape: 'square',
  rotationStemLength: 30,
};

export const HANDLE_CONFIG_TOUCH: HandleConfig = {
  size: 20,
  hitRadius: 20,
  shape: 'circle',
  rotationStemLength: 50,
};

/** Minimum size in document pixels (before zoom) during resize */
export const MIN_TRANSFORM_SIZE = 4;

/** Distance threshold for click-outside vs drag-outside in viewport pixels */
export const OUTSIDE_DRAG_THRESHOLD = 3;

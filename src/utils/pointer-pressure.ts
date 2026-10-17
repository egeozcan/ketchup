export interface PointerPressureInput {
  pointerType: string;
  pressure: number;
}

function clampPressure(pressure: number): number {
  return Math.max(0, Math.min(1, pressure));
}

/** Normalize Pointer Events pressure without treating a real pen zero as missing. */
export function normalizePointerPressure(input: PointerPressureInput): number {
  if (input.pointerType === 'mouse') return 1;

  if (input.pointerType === 'pen') {
    return Number.isFinite(input.pressure) ? clampPressure(input.pressure) : 0.5;
  }

  if (input.pointerType === 'touch') {
    // Touch pressure support is not reliably distinguishable from the Pointer
    // Events placeholder, so fingers use a consistent full-pressure stroke.
    return 1;
  }

  return input.pressure > 0 && Number.isFinite(input.pressure)
    ? clampPressure(input.pressure)
    : 0.5;
}

export interface PointerTiltInput {
  pointerType: string;
  tiltX?: number;
  tiltY?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
}

/**
 * A pen's tilt in degrees (-90..90 each way, 0, 0 upright), from tiltX/tiltY
 * or, where only they are given, altitude and azimuth. Anything but a pen
 * is upright.
 */
export function pointerTilt(input: PointerTiltInput): { tiltX: number; tiltY: number } {
  if (input.pointerType !== 'pen') return { tiltX: 0, tiltY: 0 };
  const { tiltX, tiltY, altitudeAngle, azimuthAngle } = input;
  if (Number.isFinite(tiltX) && Number.isFinite(tiltY)) return { tiltX: tiltX!, tiltY: tiltY! };
  if (!Number.isFinite(altitudeAngle) || !Number.isFinite(azimuthAngle)) return { tiltX: 0, tiltY: 0 };
  // Pointer Events' conversion: each tilt is the lean's share along its axis.
  const t = Math.tan(altitudeAngle!);
  // cos and sin of a right angle come out a hair off zero: a flat pen leaning
  // along one axis has no lean along the other.
  const toDeg = (along: number) => Math.atan2(Math.abs(along) < 1e-9 ? 0 : along, t) * 180 / Math.PI;
  return { tiltX: toDeg(Math.cos(azimuthAngle!)), tiltY: toDeg(Math.sin(azimuthAngle!)) };
}

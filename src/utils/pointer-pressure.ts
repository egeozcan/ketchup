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

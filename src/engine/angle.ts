/** An angle in degrees brought into 0..360. */
export function wrapDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Between two angles in degrees, `f` (0..1) of the way along the shorter arc,
 * so 359 to 1 passes through 0 rather than sweeping back through 180.
 */
export function lerpDegrees(a: number, b: number, f: number): number {
  const diff = wrapDegrees(b - a + 180) - 180;
  return wrapDegrees(a + diff * f);
}

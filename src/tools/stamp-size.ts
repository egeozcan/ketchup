export const DEFAULT_STAMP_SIZE = 120;
export const MIN_STAMP_SIZE = 8;
export const MAX_STAMP_SIZE = 1600;

export function normalizeStampSize(value: number | undefined, fallback = DEFAULT_STAMP_SIZE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_STAMP_SIZE, Math.min(MAX_STAMP_SIZE, value!));
}

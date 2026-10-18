/**
 * Thrown for an ABR file (or part of one) that can't be read: not an ABR,
 * a version this reader doesn't know, a truncated or inconsistent record, or
 * one past the size limits. The message is meant to be shown to the user.
 * Anything else escaping the parser would be a bug in it, which the fuzz
 * tests look for.
 */
export class AbrParseError extends Error {
  constructor(message: string, /** The whole file is past a limit: reading it stops rather than skipping one record. */ readonly fatal = false) {
    super(message);
    this.name = 'AbrParseError';
  }
}

/** Limits that keep a hostile or damaged file from using unbounded memory or time. */
export const ABR_LIMITS = {
  /** Longest side (px) of one decoded tip or pattern tile. */
  maxSide: 5000,
  /** Most pixels in one decoded tip or pattern tile. */
  maxPixels: 5000 * 5000,
  /** Most brushes (tips, presets) read from one file. */
  maxBrushes: 2000,
  /** Most patterns read from one file. */
  maxPatterns: 500,
  /** Bytes all tips and patterns of a file may decode to, summed (time as much as memory). */
  maxDecodedBytes: 1.5 * 1024 * 1024 * 1024,
  /** How deep descriptors may nest. */
  maxDescriptorDepth: 24,
  /** Descriptor values (of every kind) read from one file. */
  maxDescriptorNodes: 400_000,
  /** Longest text value in a descriptor (UTF-16 units). */
  maxStringLength: 4096,
} as const;

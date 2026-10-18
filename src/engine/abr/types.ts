import type { DescObject } from './descriptor.js';

/**
 * A sampled tip as Photoshop stores it: 8-bit coverage, row by row, where 255
 * paints fully and 0 not at all (the same sense as the engine's `TipMask`; see
 * `sampleToMask`). 16-bit tips are brought to 8 bits on reading.
 */
export interface AbrSample {
  /** The UUID of a v6+ tip, `legacy-N` for a v1/v2 one. */
  id: string;
  /** Only v1/v2 tips carry a name of their own. */
  name?: string;
  width: number;
  height: number;
  alpha: Uint8Array;
}

/** A pattern tile as 8-bit heights (luminance), 255 the brightest. */
export interface AbrPattern {
  id: string;
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
}

/** The tip of a preset: a computed (round, soft or hard) one or a sampled one named by `sampleId`. */
export type AbrTip =
  | { kind: 'computed'; diameter: number; hardness: number; roundness: number; angle: number; spacing: number }
  | { kind: 'sampled'; sampleId: string; diameter: number; roundness: number; angle: number; spacing: number; flipX: boolean; flipY: boolean }
  | { kind: 'other'; className: string };

/** One brush of the file: its tip, and for v6+ the whole settings object (dynamics, texture, ...). */
export interface AbrPreset {
  name: string;
  tip: AbrTip;
  settings?: DescObject;
}

export type AbrEvent =
  | { type: 'sample'; sample: AbrSample }
  | { type: 'pattern'; pattern: AbrPattern }
  | { type: 'preset'; preset: AbrPreset }
  /** Something unreadable was left out; the rest carries on. */
  | { type: 'skip'; what: 'sample' | 'pattern' | 'preset'; reason: string }
  /** Bytes of the file read so far, for progress. */
  | { type: 'progress'; done: number; total: number };

export interface AbrSummary {
  version: number;
  subversion: number;
}

/** A whole file held in memory, from `parseAbr`. */
export interface AbrFile extends AbrSummary {
  samples: AbrSample[];
  patterns: AbrPattern[];
  presets: AbrPreset[];
  /** Records left out because they could not be read. */
  skipped: number;
  skipReasons: string[];
}

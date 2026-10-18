import { AbrParseError } from './errors.js';
import { parseAbrEvents } from './parse.js';
import type { AbrFile } from './types.js';

export { AbrParseError, ABR_LIMITS } from './errors.js';
export { parseAbrEvents } from './parse.js';
export type * from './types.js';

/** Bytes of decoded tips and patterns `parseAbr` holds before giving up; the import path converts as it goes instead. */
const MAX_RETAINED_BYTES = 256 * 1024 * 1024;

/**
 * Reads a whole brush file into memory. Records that can't be read are
 * counted in `skipped` (with their reasons) and the rest returned; a file
 * that isn't a brush file at all throws `AbrParseError`.
 */
export function parseAbr(data: ArrayBuffer | ArrayBufferView): AbrFile {
  const gen = parseAbrEvents(data);
  const file: AbrFile = { version: 0, subversion: 0, samples: [], patterns: [], presets: [], skipped: 0, skipReasons: [] };
  let retained = 0;
  for (;;) {
    const next = gen.next();
    if (next.done) {
      file.version = next.value.version;
      file.subversion = next.value.subversion;
      return file;
    }
    const ev = next.value;
    if (ev.type === 'sample') {
      retained += ev.sample.alpha.length;
      file.samples.push(ev.sample);
    } else if (ev.type === 'pattern') {
      retained += ev.pattern.data.length;
      file.patterns.push(ev.pattern);
    } else if (ev.type === 'preset') {
      file.presets.push(ev.preset);
    } else if (ev.type === 'skip') {
      file.skipped++;
      file.skipReasons.push(ev.reason);
    }
    if (retained > MAX_RETAINED_BYTES) throw new AbrParseError('This brush file is too large to import.', true);
  }
}

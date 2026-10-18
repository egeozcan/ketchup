import { AbrParseError, ABR_LIMITS } from './errors.js';
import { ByteReader } from './reader.js';
import { unpackRows } from './packbits.js';
import {
  readDescriptorBody, readValue, getObject, getString, getNumber, getBool,
  type DescObject, type DescBudget,
} from './descriptor.js';
import type { AbrEvent, AbrPattern, AbrPreset, AbrSample, AbrSummary, AbrTip } from './types.js';

// Reads Photoshop brush libraries. Two families exist:
//
//  v1/v2 (legacy): a count, then brushes each as type, byte size and body. Type
//  1 is a computed (round) brush, type 2 a sampled one.
//
//  v6, v7, v9, v10: a version and subversion, then `8BIM` sections tagged
//  `samp` (the sampled tip images, by UUID), `patt` (patterns) and `desc` (an
//  Action Descriptor listing the presets, which name tips by UUID).
//
// Neither is documented by Adobe; the layouts here follow what the open
// readers in GIMP, Krita and ag-psd agree on. The reader is a generator of
// events so a caller can convert and drop each tip as it arrives (a big file
// holds far more decoded pixels than are worth keeping) and yield to the UI
// between them. It throws `AbrParseError` for what stops the whole file and
// reports a record it can't read as a `skip` event.

/** Bytes decoded so far across the file, against `ABR_LIMITS.maxDecodedBytes`. */
interface Spend {
  bytes: number;
}

function spend(s: Spend, n: number) {
  s.bytes += n;
  if (s.bytes > ABR_LIMITS.maxDecodedBytes) throw new AbrParseError('This brush file is too large to import.', true);
}

/** Checks a decoded image's size against the limits. */
function checkSize(width: number, height: number, what: string) {
  if (!(width >= 1 && height >= 1) || width > ABR_LIMITS.maxSide || height > ABR_LIMITS.maxSide || width * height > ABR_LIMITS.maxPixels) {
    throw new AbrParseError(`A ${what} has an unusable size (${width}×${height}).`);
  }
}

/**
 * Pixels for one channel: raw or PackBits rows, at 8 or 16 bits, brought to 8.
 * A 16-bit sample v maps to round(v × 255 / 65535).
 */
function readChannel(r: ByteReader, width: number, height: number, depth: number, compression: number, s: Spend): Uint8Array {
  checkSize(width, height, 'brush image');
  if (depth !== 8 && depth !== 16) throw new AbrParseError(`A brush image has a pixel depth of ${depth} bits, which isn't supported.`);
  if (compression !== 0 && compression !== 1) throw new AbrParseError('A brush image uses an unknown compression.');
  const bps = depth / 8;
  const rowBytes = width * bps;
  spend(s, width * height * (bps + 1));
  let raw: Uint8Array;
  if (compression === 0) {
    raw = r.bytes(rowBytes * height);
  } else {
    // Each row needs its 16-bit count at least.
    r.need(height * 2);
    raw = new Uint8Array(rowBytes * height);
    unpackRows(r, height, rowBytes, raw);
  }
  if (depth === 8) return raw;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 2) out[i] = Math.round(((raw[p] << 8) | raw[p + 1]) * 255 / 65535);
  return out;
}

const align4 = (n: number) => Math.ceil(n / 4) * 4;

export function* parseAbrEvents(data: ArrayBuffer | ArrayBufferView): Generator<AbrEvent, AbrSummary> {
  const r = new ByteReader(data);
  if (r.remaining < 4) throw new AbrParseError('This is not a Photoshop brush file (.abr): it is too short.');
  const version = r.i16();
  const spent: Spend = { bytes: 0 };
  if (version === 1 || version === 2) {
    yield* readLegacy(r, version, spent);
    return { version, subversion: 0 };
  }
  if (version === 6 || version === 7 || version === 9 || version === 10) {
    const subversion = r.i16();
    if (subversion !== 1 && subversion !== 2) throw new AbrParseError(`This brush file has a layout (${version}.${subversion}) this reader doesn't know.`);
    yield* readSections(r, subversion, spent);
    return { version, subversion };
  }
  throw new AbrParseError(version > 10 || version < 1
    ? 'This is not a Photoshop brush file (.abr), or it is from a version this reader does not know.'
    : `Photoshop brush files of version ${version} are not supported.`);
}

// ---------------------------------------------------------------------------
// v1 / v2
// ---------------------------------------------------------------------------

function* readLegacy(r: ByteReader, version: number, s: Spend): Generator<AbrEvent> {
  const count = r.i16();
  if (count < 0) throw new AbrParseError('This brush file is damaged.');
  const total = r.end;
  let done = 0;
  for (let i = 0; i < count; i++) {
    if (r.remaining < 6) {
      yield { type: 'skip', what: 'preset', reason: 'The file ends before its last brushes.' };
      return;
    }
    if (i >= ABR_LIMITS.maxBrushes) {
      yield { type: 'skip', what: 'preset', reason: `Only the first ${ABR_LIMITS.maxBrushes} brushes are read.` };
      return;
    }
    const type = r.u16();
    const size = r.u32();
    if (size > r.remaining) {
      yield { type: 'skip', what: 'preset', reason: 'The file ends in the middle of a brush.' };
      return;
    }
    const body = r.slice(size);
    try {
      if (type === 1) {
        yield { type: 'preset', preset: readComputedLegacy(body, i) };
      } else if (type === 2) {
        const { sample, preset } = readSampledLegacy(body, version, i, s);
        yield { type: 'sample', sample };
        yield { type: 'preset', preset };
      } else {
        yield { type: 'skip', what: 'preset', reason: `A brush of unknown type ${type} was left out.` };
      }
    } catch (e) {
      if (!(e instanceof AbrParseError) || e.fatal) throw e;
      yield { type: 'skip', what: 'preset', reason: e.message };
    }
    done = r.pos;
    yield { type: 'progress', done, total };
  }
}

/**
 * Misc (4), spacing, diameter, roundness, angle, hardness (2 each). No open
 * reader supports this brush type, so the layout is from the file format
 * notes and checked against plausible ranges: a body that doesn't fit them is
 * skipped rather than imported with nonsense.
 */
function readComputedLegacy(b: ByteReader, index: number): AbrPreset {
  if (b.remaining < 14) throw new AbrParseError('A computed brush is too short.');
  b.skip(4);
  const spacing = b.u16();
  const diameter = b.u16();
  const roundness = b.u16();
  const angle = b.i16();
  const hardness = b.u16();
  if (spacing < 1 || spacing > 999 || diameter < 1 || diameter > 2500 || roundness > 100 || hardness > 100 || angle < -360 || angle > 360) {
    throw new AbrParseError('A computed brush has values out of range and was left out.');
  }
  return {
    name: `Brush ${index + 1}`,
    tip: { kind: 'computed', diameter, hardness: hardness / 100, roundness: roundness / 100, angle, spacing },
  };
}

function readSampledLegacy(b: ByteReader, version: number, index: number, s: Spend): { sample: AbrSample; preset: AbrPreset } {
  b.skip(4); // misc
  const spacing = b.u16();
  const name = version === 2 ? b.unicode(ABR_LIMITS.maxStringLength).trim() : '';
  b.skip(1); // antialiasing
  b.skip(8); // bounds as 16-bit; the 32-bit ones follow
  const top = b.i32(), left = b.i32(), bottom = b.i32(), right = b.i32();
  const depth = b.i16();
  const compression = b.u8();
  const width = right - left, height = bottom - top;
  const alpha = readChannel(b, width, height, depth, compression, s);
  const id = `legacy-${index}`;
  const label = name || `Brush ${index + 1}`;
  return {
    sample: { id, name: label, width, height, alpha },
    preset: {
      name: label,
      tip: { kind: 'sampled', sampleId: id, diameter: Math.max(width, height), roundness: 1, angle: 0, spacing, flipX: false, flipY: false },
    },
  };
}

// ---------------------------------------------------------------------------
// v6 and later
// ---------------------------------------------------------------------------

function* readSections(r: ByteReader, subversion: number, s: Spend): Generator<AbrEvent> {
  const total = r.end;
  // Counted over the whole file, so repeating a section doesn't repeat its allowance.
  const counts = { samples: 0, patterns: 0, presets: 0, descriptorNodes: { nodes: 0 } as DescBudget };
  while (r.remaining >= 12) {
    if (r.fourCC() !== '8BIM') {
      yield { type: 'skip', what: 'preset', reason: 'Unrecognised data after the brush sections was ignored.' };
      return;
    }
    const tag = r.fourCC();
    const size = r.u32();
    const truncated = size > r.remaining;
    const sec = r.slice(Math.min(size, r.remaining));
    if (truncated) yield { type: 'skip', what: 'preset', reason: 'The file ends in the middle of a section.' };
    if (tag === 'samp') yield* readSamples(sec, subversion, s, counts, total);
    else if (tag === 'patt') yield* readPatterns(sec, s, counts);
    else if (tag === 'desc') yield* readDescriptorPresets(sec, counts);
    if (truncated) return;
    // Sections are padded to four bytes, though not every writer does: the pad is skipped unless the next section already starts here.
    if (size % 4 !== 0 && r.peekFourCC() !== '8BIM') r.skip(Math.min(align4(size) - size, r.remaining));
    yield { type: 'progress', done: r.pos, total };
  }
}

function* readSamples(sec: ByteReader, subversion: number, s: Spend, counts: { samples: number }, total: number): Generator<AbrEvent> {
  while (sec.remaining >= 4) {
    if (counts.samples >= ABR_LIMITS.maxBrushes) {
      yield { type: 'skip', what: 'sample', reason: `Only the first ${ABR_LIMITS.maxBrushes} brush images are read.` };
      return;
    }
    counts.samples++;
    const length = align4(sec.u32());
    // A sample reaching past its section is cut there; what can be read of it still is.
    const body = sec.slice(Math.min(length, sec.remaining));
    try {
      const id = body.pascal();
      if (!id) throw new AbrParseError('A brush image has no id.');
      body.skip(subversion === 1 ? 10 : 264);
      const top = body.i32(), left = body.i32(), bottom = body.i32(), right = body.i32();
      const depth = body.i16();
      const compression = body.u8();
      const width = right - left, height = bottom - top;
      const alpha = readChannel(body, width, height, depth, compression, s);
      yield { type: 'sample', sample: { id, width, height, alpha } };
    } catch (e) {
      if (!(e instanceof AbrParseError) || e.fatal) throw e;
      yield { type: 'skip', what: 'sample', reason: e.message };
    }
    yield { type: 'progress', done: sec.pos, total };
  }
}

function* readDescriptorPresets(sec: ByteReader, counts: { presets: number; descriptorNodes: DescBudget }): Generator<AbrEvent> {
  const budget = counts.descriptorNodes;
  try {
    const version = sec.u32();
    if (version !== 16) throw new AbrParseError('The brush settings are in a format this reader does not know.');
    sec.unicode(ABR_LIMITS.maxStringLength);
    readIdKey(sec);
    const n = sec.u32();
    if (n > sec.remaining / 8) throw new AbrParseError('The brush settings are damaged.');
    for (let i = 0; i < n; i++) {
      const key = readIdKey(sec);
      const type = sec.fourCC();
      if (key !== 'Brsh' || type !== 'VlLs') {
        readValue(sec, type, 1, budget);
        continue;
      }
      const count = sec.u32();
      if (count > sec.remaining / 4) throw new AbrParseError('The list of brushes is damaged.');
      for (let j = 0; j < count; j++) {
        const t = sec.fourCC();
        if (t !== 'Objc') {
          readValue(sec, t, 2, budget);
          continue;
        }
        if (counts.presets >= ABR_LIMITS.maxBrushes) {
          yield { type: 'skip', what: 'preset', reason: `Only the first ${ABR_LIMITS.maxBrushes} brushes are read.` };
          return;
        }
        const obj = readDescriptorBody(sec, 2, budget);
        const preset = presetFromObject(obj, counts.presets++);
        if (preset) yield { type: 'preset', preset };
        else yield { type: 'skip', what: 'preset', reason: 'A brush has no tip this reader can use.' };
      }
    }
  } catch (e) {
    if (!(e instanceof AbrParseError) || e.fatal) throw e;
    // The tree can't be walked past a bad value, so what came before it stands.
    yield { type: 'skip', what: 'preset', reason: e.message };
  }
}

/** A key or class id: a 32-bit length, 0 meaning four characters. */
function readIdKey(r: ByteReader): string {
  const n = r.u32();
  if (n > ABR_LIMITS.maxStringLength) throw new AbrParseError('The file holds a name that is too long.');
  return String.fromCharCode(...r.bytes(n === 0 ? 4 : n));
}

function presetFromObject(obj: DescObject, index: number): AbrPreset | null {
  const shape = getObject(obj, 'Brsh');
  if (!shape) return null;
  const name = (getString(obj, 'Nm  ') ?? getString(shape, 'Nm  ') ?? '').trim() || `Brush ${index + 1}`;
  const common = {
    diameter: getNumber(shape, 'Dmtr') ?? 0,
    roundness: (getNumber(shape, 'Rndn') ?? 100) / 100,
    angle: getNumber(shape, 'Angl') ?? 0,
    spacing: getNumber(shape, 'Spcn') ?? 25,
  };
  let tip: AbrTip;
  if (shape.classId === 'sampledBrush') {
    const sampleId = getString(shape, 'sampledData');
    if (!sampleId) return null;
    tip = { kind: 'sampled', sampleId, ...common, flipX: getBool(shape, 'flipX') === true, flipY: getBool(shape, 'flipY') === true };
  } else if (shape.classId === 'computedBrush') {
    tip = { kind: 'computed', ...common, hardness: (getNumber(shape, 'Hrdn') ?? 100) / 100 };
  } else {
    tip = { kind: 'other', className: shape.classId };
  }
  return { name, tip, settings: obj };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

function* readPatterns(sec: ByteReader, s: Spend, counts: { patterns: number }): Generator<AbrEvent> {
  while (sec.remaining >= 4) {
    if (counts.patterns >= ABR_LIMITS.maxPatterns) {
      yield { type: 'skip', what: 'pattern', reason: `Only the first ${ABR_LIMITS.maxPatterns} patterns are read.` };
      return;
    }
    counts.patterns++;
    const length = sec.u32();
    if (length > sec.remaining) {
      yield { type: 'skip', what: 'pattern', reason: 'The file ends in the middle of a pattern.' };
      return;
    }
    const body = sec.slice(length);
    // Records are padded to four bytes, which the length may or may not include.
    const pad = Math.min(align4(length) - length, sec.remaining);
    sec.skip(pad);
    try {
      yield { type: 'pattern', pattern: readPattern(body, s) };
    } catch (e) {
      if (!(e instanceof AbrParseError) || e.fatal) throw e;
      yield { type: 'skip', what: 'pattern', reason: e.message };
    }
  }
}

/** Image modes the pattern reader takes: 1 grayscale, 2 indexed, 3 RGB. */
function readPattern(b: ByteReader, s: Spend): AbrPattern {
  if (b.u32() !== 1) throw new AbrParseError('A pattern is in a format this reader does not know.');
  const mode = b.u32();
  if (mode !== 1 && mode !== 2 && mode !== 3) throw new AbrParseError('A pattern is not grayscale, indexed or RGB, and was left out.');
  b.skip(4); // point
  const name = b.unicode(ABR_LIMITS.maxStringLength).trim();
  const id = b.pascal();
  if (!id) throw new AbrParseError('A pattern has no id.');
  let palette: Uint8Array | null = null;
  if (mode === 2) {
    palette = b.bytes(768).slice();
    b.skip(4);
  }
  if (b.u32() !== 3) throw new AbrParseError('A pattern is in a format this reader does not know.');
  const arrayLength = b.u32();
  const arrayEnd = Math.min(b.end, b.pos + arrayLength);
  const top = b.i32(), left = b.i32(), bottom = b.i32(), right = b.i32();
  const width = right - left, height = bottom - top;
  checkSize(width, height, 'pattern');
  const channelCount = b.u32();
  const needed = mode === 3 ? 3 : 1;
  const channels: Uint8Array[] = [];
  // The channel list is `channelCount` plus two slots (masks), the unwritten ones just a zero flag.
  for (let i = 0; i < Math.min(channelCount, 56) + 2 && channels.length < needed && b.pos + 4 <= arrayEnd; i++) {
    if (b.u32() === 0) continue;
    const chLength = b.u32();
    if (chLength > arrayEnd - b.pos) throw new AbrParseError('A pattern is cut short.');
    const chEnd = b.pos + chLength;
    const ch = new ByteReader(b.bytes(chLength));
    ch.skip(4); // pixel depth, again below
    const cTop = ch.i32(), cLeft = ch.i32(), cBottom = ch.i32(), cRight = ch.i32();
    // A channel covering less than the tile would need placing; none is seen in practice, so it is refused rather than misread.
    if (cRight - cLeft !== width || cBottom - cTop !== height) throw new AbrParseError('A pattern has a channel of another size than the pattern.');
    const depth = ch.u16();
    const compression = ch.u8();
    channels.push(readChannel(ch, width, height, depth, compression, s));
    b.seek(chEnd);
  }
  if (channels.length < needed) throw new AbrParseError('A pattern is missing its pixels.');
  const data = new Uint8Array(width * height);
  if (mode === 3) {
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.round(0.2126 * channels[0][i] + 0.7152 * channels[1][i] + 0.0722 * channels[2][i]);
    }
  } else if (mode === 2 && palette) {
    for (let i = 0; i < data.length; i++) {
      const p = channels[0][i] * 3;
      data[i] = Math.round(0.2126 * palette[p] + 0.7152 * palette[p + 1] + 0.0722 * palette[p + 2]);
    }
  } else {
    data.set(channels[0]);
  }
  return { id, name: name || id, width, height, data };
}

import { cropMask, downscaleMask, MAX_TIP_SIZE, type TipMask } from '../tip-mask.js';
import { normalizeBrushDescriptor, MAX_FADE_LENGTH, MAX_SCATTER, MAX_SCATTER_COUNT, MIN_TEXTURE_SCALE, MAX_TEXTURE_SCALE } from '../brush-presets.js';
import { getDefaultTipDescriptor } from '../brush-capabilities.js';
import { MAX_PATTERN_ID_LENGTH } from '../brush-texture.js';
import type { BrushBlendMode, BrushDescriptor, OrientationMode, TextureMode } from '../types.js';
import { getBool, getEnum, getNumber, getObject, getString, type DescObject } from './descriptor.js';
import { parseAbrEvents } from './parse.js';
import { AbrParseError } from './errors.js';
import type { AbrPattern, AbrPreset, AbrSample } from './types.js';

// Turns what the reader found into what Ketchup stores: tips as `TipMask`s,
// presets as full brush descriptors, patterns as texture tiles.
//
// Polarity: a Photoshop sampled tip is coverage with 255 painting fully (Krita
// shows it as 255 - v on white, i.e. dark where it paints). That is the sense
// of `TipMask` already, so samples are used as they are; item "From image…"
// differs only in that it derives coverage from luminance first.

/** A tip to store: a mask, and the spacing it is laid with by default. */
export interface PlannedTip {
  /** What the planned brushes name it by (`PlannedBrush.tipKey`). */
  key: string;
  name: string;
  mask: TipMask;
  spacing: number;
}

export interface PlannedBrush {
  name: string;
  descriptor: BrushDescriptor;
  /** The tip it paints with; absent for a brush on a built-in tip shape. */
  tipKey?: string;
}

/** A pattern to store, its id already in the form brushes name it by. */
export interface PlannedPattern {
  id: string;
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ImportPlan {
  tips: PlannedTip[];
  brushes: PlannedBrush[];
  /** Only the patterns some planned brush uses. */
  patterns: PlannedPattern[];
  /** Brushes and images left out (unreadable, or of a kind Ketchup has no equivalent for). */
  skipped: number;
  skipReasons: string[];
  /** Settings keys and features with no equivalent here, for developers (see `logUnmapped`). */
  unmapped: string[];
}

export interface PlanOptions {
  /** Called with 0..1 as the file is read and converted. */
  onProgress?: (fraction: number) => void;
  /** Awaited every so often so the page stays responsive; defaults to a macrotask. */
  yieldToUi?: () => Promise<void>;
  /** Wall time (ms) between yields. */
  sliceMs?: number;
}

const MAX_BRUSH_SIZE = 150;
/** Photoshop's default spacing, a share of the diameter. */
const DEFAULT_SPACING = 0.25;
/** The spacing control's range. */
const MIN_SPACING = 0.05, MAX_SPACING = 1;
/** Decoded masks and pattern tiles a plan holds at once. */
const MAX_PLAN_MASK_BYTES = 256 * 1024 * 1024;
const MAX_PLAN_PATTERN_BYTES = 128 * 1024 * 1024;
/** Longest side of a stored pattern tile. */
const MAX_PATTERN_SIDE = 1024;
const MAX_NAME_LENGTH = 80;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pct = (o: DescObject | undefined, key: string): number => clamp((getNumber(o, key) ?? 0) / 100, 0, 1);

function cleanName(s: string, fallback: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return t || fallback;
}

/** The mask mirrored left-right and/or top-bottom. */
export function flipMask(mask: TipMask, flipX: boolean, flipY: boolean): TipMask {
  if (!flipX && !flipY) return mask;
  const { width, height, alpha } = mask;
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y++) {
    const sy = flipY ? height - 1 - y : y;
    for (let x = 0; x < width; x++) out[y * width + x] = alpha[sy * width + (flipX ? width - 1 - x : x)];
  }
  return { width, height, alpha: out };
}

interface SampleEntry {
  mask: TipMask;
  /** The painted area's longer side as a share of the whole image's: the tip is cropped, so its size must shrink with it. */
  cropShare: number;
  /** The original image's longer side. */
  originalLong: number;
}

function sampleEntry(s: AbrSample): SampleEntry | null {
  const cropped = cropMask({ width: s.width, height: s.height, alpha: s.alpha });
  if (!cropped) return null;
  const originalLong = Math.max(s.width, s.height);
  const mask = downscaleMask(cropped, MAX_TIP_SIZE);
  return {
    // Copied: a mask can be a view onto the whole file's bytes, and storing a view keeps all of them.
    mask: { width: mask.width, height: mask.height, alpha: mask.alpha.slice() },
    cropShare: Math.max(cropped.width, cropped.height) / originalLong,
    originalLong,
  };
}

/**
 * The id a pattern is stored and named by: the file's id made safe without two
 * ids meeting (an escape, not a replacement), plus a hash of the pixels, so the
 * same pattern imported again is the same record and a different one under a
 * reused id is another.
 */
function patternStorageId(p: AbrPattern, tile: TipMask): string {
  let h = 0x811c9dc5;
  for (const v of [tile.width, tile.height, ...tile.alpha]) h = Math.imul(h ^ v, 0x01000193);
  const hash = (h >>> 0).toString(16).padStart(8, '0');
  const safe = p.id.replace(/[^A-Za-z0-9-]/g, c => `_${c.charCodeAt(0).toString(16)}_`);
  const room = MAX_PATTERN_ID_LENGTH - 'abr-'.length - 1 - hash.length;
  return `abr-${safe.length <= room ? safe : `long-${safe.length}`}-${hash}`;
}

/** The pattern tile cut to `MAX_PATTERN_SIDE`, with how much larger the original's grain was. */
function patternTile(p: AbrPattern): { tile: PlannedPattern; shrink: number } {
  const tile = downscaleMask({ width: p.width, height: p.height, alpha: p.data }, MAX_PATTERN_SIDE);
  return {
    tile: { id: patternStorageId(p, tile), name: cleanName(p.name, 'Pattern'), width: tile.width, height: tile.height, data: tile.alpha.slice() },
    shrink: Math.max(p.width, p.height) / Math.max(tile.width, tile.height),
  };
}

// Photoshop's "control" values for a dynamics group.
const CONTROL_PRESSURE = 2, CONTROL_TILT = 3, CONTROL_FADE = 1;

function orientationFor(control: number | undefined): OrientationMode {
  switch (control) {
    case CONTROL_TILT: return 'tilt';
    // 5 and 6: initial direction and direction (a stroke's initial direction is followed all along).
    case 5: case 6: return 'direction';
    // 7 and 8: initial rotation and rotation of the pen barrel.
    case 7: case 8: return 'twist';
    default: return 'fixed';
  }
}

const BLEND_MODES: Record<string, BrushBlendMode> = {
  Nrml: 'normal', Mltp: 'multiply', Scrn: 'screen', Ovrl: 'overlay', Drkn: 'darken', Lghn: 'lighten',
  CDdg: 'color-dodge', CBrn: 'color-burn', 'H   ': 'hue', Strt: 'saturation', 'Clr ': 'color', Lmns: 'luminosity',
  Bhnd: 'behind', Clar: 'clear',
};

function textureModeFor(v: string | undefined): TextureMode {
  if (!v) return 'multiply';
  if (v === 'Sbtr') return 'subtract';
  if (/height|hght|lnrh/i.test(v)) return 'height';
  return 'multiply';
}

/** Preset keys this mapping reads or knowingly leaves, so a key outside them is worth a developer's note. */
const KNOWN_KEYS = new Set([
  'Nm  ', 'Brsh', 'useTipDynamics', 'flipX', 'flipY', 'brushProjection', 'minimumDiameter', 'minimumRoundness', 'tiltScale',
  'szVr', 'angleDynamics', 'roundnessDynamics', 'useScatter', 'Spcn', 'Cnt ', 'bothAxes', 'countDynamics', 'scatterDynamics',
  'dualBrush', 'brushGroup', 'useTexture', 'TxtC', 'interpretation', 'textureBlendMode', 'textureDepth', 'minimumDepth',
  'textureDepthDynamics', 'Txtr', 'textureScale', 'InvT', 'protectTexture', 'textureBrightness', 'textureContrast',
  'usePaintDynamics', 'prVr', 'opVr', 'wtVr', 'mxVr', 'useColorDynamics', 'clVr', 'H   ', 'Strt', 'Brgh', 'purity',
  'colorDynamicsPerTip', 'Wtdg', 'Nose', 'Rpt ', 'useBrushSize', 'useBrushPose', 'overridePoseAngle', 'overridePoseTiltX',
  'overridePoseTiltY', 'overridePosePressure', 'brushPosePressure', 'brushPoseTiltX', 'brushPoseTiltY', 'brushPoseAngle',
  'toolOptions',
]);

interface Ctx {
  patterns: Map<string, { tile: PlannedPattern; shrink: number }>;
  usedPatterns: Set<string>;
  unmapped: Set<string>;
}

/** Layers a preset's dynamics, texture, colour and transfer settings onto `d` (in place). */
function applySettings(d: BrushDescriptor, o: DescObject, ctx: Ctx, cropShare: number): void {
  for (const key of o.items.keys()) if (!KNOWN_KEYS.has(key)) ctx.unmapped.add(`preset:${key}`);
  const note = (what: string) => ctx.unmapped.add(what);

  if (getBool(o, 'useTipDynamics')) {
    const sz = getObject(o, 'szVr');
    const sizeControl = getNumber(sz, 'bVTy');
    d.jitter.size = pct(sz, 'jitter');
    d.pressureSize = sizeControl === CONTROL_PRESSURE;
    d.dynamics.minSize = pct(o, 'minimumDiameter');
    if (sizeControl === CONTROL_FADE) {
      // Photoshop counts a fade in dabs (steps), as the brush does natively.
      d.fade.sizeLength = clamp(Math.max(0, getNumber(sz, 'fStp') ?? 0), 0, MAX_FADE_LENGTH);
      d.fade.sizeUnit = 'dabs';
    } else if (sizeControl === 4) {
      note('szVr:stylusWheel');
    }
    const angle = getObject(o, 'angleDynamics');
    d.jitter.angle = pct(angle, 'jitter');
    d.tip.orientation = orientationFor(getNumber(angle, 'bVTy'));
    d.jitter.roundness = pct(getObject(o, 'roundnessDynamics'), 'jitter');
    if (getNumber(o, 'minimumRoundness')) note('minimumRoundness');
    if (getBool(o, 'flipX') || getBool(o, 'flipY')) note('flipJitter');
    if (getBool(o, 'brushProjection')) note('brushProjection');
  } else {
    d.pressureSize = false;
  }

  if (getBool(o, 'useScatter')) {
    // Photoshop's scatter is up to 1000% of the diameter; a percent over 100 reads as that many diameters.
    // Our unit is a dab (the cropped tip), Photoshop's the whole image.
    d.scatter.amount = clamp((getNumber(getObject(o, 'scatterDynamics'), 'jitter') ?? 0) / 100 / cropShare, 0, MAX_SCATTER);
    d.scatter.bothAxes = getBool(o, 'bothAxes') === true;
    d.scatter.count = Math.round(clamp(getNumber(o, 'Cnt ') ?? 1, 1, MAX_SCATTER_COUNT));
    d.scatter.countJitter = pct(getObject(o, 'countDynamics'), 'jitter');
  }

  if (getBool(o, 'useTexture')) {
    const ref = getObject(o, 'Txtr');
    const id = getString(ref, 'Idnt');
    const found = id ? ctx.patterns.get(id.toLowerCase()) : undefined;
    if (found) {
      ctx.usedPatterns.add(found.tile.id);
      const depthControl = getNumber(getObject(o, 'textureDepthDynamics'), 'bVTy');
      d.texture = {
        pattern: found.tile.id,
        scale: clamp((getNumber(o, 'textureScale') ?? 100) / 100 * found.shrink, MIN_TEXTURE_SCALE, MAX_TEXTURE_SCALE),
        depth: pct(o, 'textureDepth'),
        mode: textureModeFor(getEnum(o, 'textureBlendMode')),
        invert: getBool(o, 'InvT') === true,
        depthPressure: depthControl === CONTROL_PRESSURE,
        perTip: getBool(o, 'TxtC') === true,
      };
      const mode = getEnum(o, 'textureBlendMode');
      if (mode && mode !== 'Mltp' && mode !== 'Sbtr' && textureModeFor(mode) === 'multiply') note(`textureBlendMode:${mode}`);
      if (getNumber(o, 'textureBrightness') || getNumber(o, 'textureContrast')) note('textureBrightnessContrast');
    } else {
      note('texture:patternMissing');
    }
  }

  if (getBool(o, 'useColorDynamics')) {
    const fgBg = getObject(o, 'clVr');
    d.color = {
      hue: pct(o, 'H   '),
      saturation: pct(o, 'Strt'),
      brightness: pct(o, 'Brgh'),
      purity: clamp((getNumber(o, 'purity') ?? 0) / 100, -1, 1),
      fgBg: pct(fgBg, 'jitter'),
      fgBgPressure: getNumber(fgBg, 'bVTy') === CONTROL_PRESSURE,
      perTip: getBool(o, 'colorDynamicsPerTip') === true,
    };
  }

  if (getBool(o, 'usePaintDynamics')) {
    // Ketchup has no opacity jitter of its own; the nearest thing is the dab's flow varying.
    const flow = getObject(o, 'prVr');
    const opacity = getObject(o, 'opVr');
    d.jitter.flow = Math.max(pct(flow, 'jitter'), pct(opacity, 'jitter'));
    // The engine's pressure control scales each dab's flow, which is what both of Photoshop's pressure controls do to a dab.
    d.pressureOpacity = getNumber(opacity, 'bVTy') === CONTROL_PRESSURE || getNumber(flow, 'bVTy') === CONTROL_PRESSURE;
    if (getNumber(getObject(o, 'wtVr'), 'jitter') || getNumber(getObject(o, 'mxVr'), 'jitter')) note('wetnessMixJitter');
  }

  if (getBool(o, 'Rpt ')) d.airbrush = true;
  if (getBool(o, 'Wtdg')) note('wetEdges');
  if (getBool(o, 'Nose')) note('noise');
  if (getBool(o, 'useBrushPose')) note('brushPose');
  const dual = getObject(o, 'dualBrush');
  if (dual && getBool(dual, 'useDualBrush')) note('dualBrush');

  const tool = getObject(o, 'toolOptions');
  if (tool) {
    const opacity = getNumber(tool, 'Opct');
    const flow = getNumber(tool, 'flow');
    if (opacity !== undefined) d.opacity = clamp(opacity / 100, 0, 1);
    if (flow !== undefined) d.flow = clamp(flow / 100, 0, 1);
    const mode = getEnum(tool, 'Md  ');
    if (mode) {
      if (BLEND_MODES[mode]) d.blendMode = BLEND_MODES[mode];
      else note(`mode:${mode}`);
    }
  }
}

/** A preset's tip, size and spacing onto `d`. */
function applyTip(d: BrushDescriptor, preset: AbrPreset, entry: SampleEntry | null): void {
  const tip = preset.tip;
  if (tip.kind === 'other') return;
  // Photoshop spaces dabs by a share of the whole image; ours by a share of the cropped tip, which is smaller.
  d.spacing = clamp(tip.spacing / 100 / (tip.kind === 'sampled' && entry ? entry.cropShare : 1), MIN_SPACING, MAX_SPACING);
  const angle = ((-tip.angle % 360) + 360) % 360;
  if (tip.kind === 'sampled') {
    d.tip = { ...getDefaultTipDescriptor('image'), angle };
    const diameter = tip.diameter > 0 ? tip.diameter : entry!.originalLong;
    d.size = clamp(Math.round(diameter * entry!.cropShare), 1, MAX_BRUSH_SIZE);
    return;
  }
  d.size = clamp(Math.round(tip.diameter), 1, MAX_BRUSH_SIZE);
  d.hardness = clamp(tip.hardness, 0, 1);
  // A round tip with no aspect of its own: a squashed one is the calligraphy ellipse.
  if (tip.roundness < 0.97) {
    d.tip = { ...getDefaultTipDescriptor('calligraphy'), aspect: clamp(1 / Math.max(tip.roundness, 0.05), 1, 10), angle, orientation: 'fixed' };
  } else {
    d.tip = getDefaultTipDescriptor('round');
  }
}

/** Runs a few steps at a time, yielding to the page between them. */
function slicer(opts: PlanOptions) {
  const sliceMs = opts.sliceMs ?? 12;
  const yieldToUi = opts.yieldToUi ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let last = Date.now();
  return async () => {
    if (Date.now() - last < sliceMs) return;
    await yieldToUi();
    last = Date.now();
  };
}

/**
 * Reads a brush file and plans what to store for it. Tips are converted to
 * masks as they are read (the full-size images are dropped at once), and the
 * work yields to the page every few milliseconds. Throws `AbrParseError` when
 * the file isn't a brush file or holds no brush Ketchup can use.
 */
export async function planAbrImport(data: ArrayBuffer | ArrayBufferView, opts: PlanOptions = {}): Promise<ImportPlan> {
  const tick = slicer(opts);
  const samples = new Map<string, SampleEntry | null>();
  const patterns = new Map<string, { tile: PlannedPattern; shrink: number }>();
  const presets: AbrPreset[] = [];
  const plan: ImportPlan = { tips: [], brushes: [], patterns: [], skipped: 0, skipReasons: [], unmapped: [] };
  const skip = (reason: string) => {
    plan.skipped++;
    if (plan.skipReasons.length < 20 && !plan.skipReasons.includes(reason)) plan.skipReasons.push(reason);
  };
  let maskBytes = 0, patternBytes = 0;

  const gen = parseAbrEvents(data);
  for (;;) {
    const next = gen.next();
    if (next.done) break;
    const ev = next.value;
    if (ev.type === 'sample') {
      const entry = sampleEntry(ev.sample);
      if (entry && maskBytes + entry.mask.alpha.length > MAX_PLAN_MASK_BYTES) {
        skip('Some brush images were left out to stay within memory limits.');
        samples.set(ev.sample.id, null);
      } else {
        if (entry) maskBytes += entry.mask.alpha.length;
        samples.set(ev.sample.id, entry);
      }
    } else if (ev.type === 'pattern') {
      const t = patternTile(ev.pattern);
      if (patternBytes + t.tile.data.length > MAX_PLAN_PATTERN_BYTES) skip('Some patterns were left out to stay within memory limits.');
      else {
        patternBytes += t.tile.data.length;
        patterns.set(ev.pattern.id.toLowerCase(), t);
      }
    } else if (ev.type === 'preset') {
      presets.push(ev.preset);
    } else if (ev.type === 'skip') {
      skip(ev.reason);
    } else {
      opts.onProgress?.(ev.total > 0 ? 0.6 * Math.min(1, ev.done / ev.total) : 0);
    }
    await tick();
  }

  // A file with tips and no preset list still has brushes: one per tip.
  if (presets.length === 0) {
    let n = 0;
    for (const [id, entry] of samples) {
      if (!entry) continue;
      presets.push({
        name: `Brush ${++n}`,
        tip: { kind: 'sampled', sampleId: id, diameter: entry.originalLong, roundness: 1, angle: 0, spacing: DEFAULT_SPACING * 100, flipX: false, flipY: false },
      });
    }
  }

  const ctx: Ctx = { patterns, usedPatterns: new Set(), unmapped: new Set() };
  const tipKeys = new Map<string, PlannedTip>();
  for (let i = 0; i < presets.length; i++) {
    const preset = presets[i];
    const tip = preset.tip;
    let entry: SampleEntry | null = null;
    if (tip.kind === 'other') {
      skip('Bristle and erodible tips are not supported.');
      continue;
    }
    if (tip.kind === 'sampled') {
      if (!samples.has(tip.sampleId)) {
        skip('A brush names a tip image that is not in the file.');
        continue;
      }
      entry = samples.get(tip.sampleId)!;
      if (!entry) {
        skip('A brush tip paints nothing (it is blank) or was too large to keep.');
        continue;
      }
    }
    const descriptor = normalizeBrushDescriptor({ pressureSize: false, pressureOpacity: false });
    applyTip(descriptor, preset, entry);
    if (preset.settings) applySettings(descriptor, preset.settings, ctx, entry ? entry.cropShare : 1);
    if (tip.kind === 'sampled' && (tip.roundness < 0.97)) ctx.unmapped.add('sampledBrush:roundness');
    const brush: PlannedBrush = { name: cleanName(preset.name, `Brush ${i + 1}`), descriptor };
    if (tip.kind === 'sampled' && entry) {
      const key = `${tip.sampleId}|${tip.flipX ? 1 : 0}${tip.flipY ? 1 : 0}`;
      let planned = tipKeys.get(key);
      if (!planned) {
        // A flipped variant is a mask of its own (an unflipped one is the sample's), so it counts against the memory budget like a sample.
        const flipped = tip.flipX || tip.flipY;
        if (flipped && maskBytes + entry.mask.alpha.length > MAX_PLAN_MASK_BYTES) {
          skip('Some brushes were left out to stay within memory limits.');
          continue;
        }
        if (flipped) maskBytes += entry.mask.alpha.length;
        planned = { key, name: brush.name, mask: flipMask(entry.mask, tip.flipX, tip.flipY), spacing: descriptor.spacing };
        tipKeys.set(key, planned);
        plan.tips.push(planned);
      }
      brush.tipKey = key;
    }
    plan.brushes.push(brush);
    opts.onProgress?.(0.6 + 0.4 * ((i + 1) / presets.length));
    await tick();
  }

  for (const { tile } of patterns.values()) if (ctx.usedPatterns.has(tile.id)) plan.patterns.push(tile);
  plan.unmapped = [...ctx.unmapped].sort();
  if (plan.brushes.length === 0) {
    throw new AbrParseError(plan.skipped > 0
      ? 'None of the brushes in this file could be imported.'
      : 'This file contains no brushes.');
  }
  return plan;
}

/** Developer-only note of settings that had no equivalent (quiet in production builds). */
export function logUnmapped(file: string, unmapped: string[]): void {
  if (unmapped.length === 0) return;
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.debug(`[abr] ${file}: not mapped:`, unmapped.join(', '));
}

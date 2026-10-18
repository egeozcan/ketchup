import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAbr, AbrParseError } from '../src/engine/abr/index.ts';
import { planAbrImport } from '../src/engine/abr/to-brushes.ts';
import { normalizeBrushDescriptor } from '../src/engine/brush-presets.ts';
import { BrushLibrary, toBrushPreset } from '../src/engine/brush-library.ts';
import { getTexturePattern, unregisterTexturePattern } from '../src/engine/brush-texture.ts';
import { clearTipMasks, getTipMask } from '../src/engine/tip-images.ts';
import { MemoryBackend } from '../src/storage/memory/index.ts';
import { IndexedDBBackend } from '../src/storage/indexeddb/indexeddb-backend.ts';
import type { BrushLibraryStore } from '../src/storage/types.ts';
import {
  writeLegacy, writeV6, obj, text, long, bool, doub, unit, pct, enm, list, dyn, Out, packBitsRow,
  type V, type V6Sample,
} from './abr-writer.ts';

afterEach(() => clearTipMasks());

const ramp = (n: number) => Array.from({ length: n }, (_, i) => (i * 37) % 256);

function sampledShape(id: string, diameter: number, o: { spacing?: number; angle?: number; roundness?: number; flipX?: boolean; flipY?: boolean } = {}): V {
  return obj('sampledBrush', {
    Dmtr: unit('#Pxl', diameter), Angl: unit('#Ang', o.angle ?? 0), Rndn: pct(o.roundness ?? 100), 'Nm  ': text('tip'),
    Spcn: pct(o.spacing ?? 25), Intr: bool(true), flipX: bool(o.flipX ?? false), flipY: bool(o.flipY ?? false), sampledData: text(id),
  });
}
const preset = (name: string, shape: V, extra: Record<string, V> = {}): V => obj('null', { 'Nm  ': text(name), Brsh: shape, ...extra });

/** A 6x4 sample painted (255) only in its middle 2x2, so cropping shows. */
const MIDDLE: V6Sample = {
  id: 'AAAAAAAA-0000-0000-0000-000000000001', width: 6, height: 4,
  px: Array.from({ length: 24 }, (_, i) => { const x = i % 6, y = Math.floor(i / 6); return x >= 2 && x < 4 && y >= 1 && y < 3 ? 255 : 0; }),
};

describe('ABR v1/v2', () => {
  it('reads raw and RLE sampled brushes and a computed one', () => {
    const px = ramp(12);
    const rlePx = [9, 9, 9, 9, 9, 0, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const file = parseAbr(writeLegacy(2, [
      { kind: 'sampled', name: 'Raw', width: 4, height: 3, px, spacing: 40 },
      { kind: 'sampled', name: 'Packed', width: 5, height: 6, px: rlePx, rle: true },
      { kind: 'computed', spacing: 25, diameter: 30, roundness: 50, angle: 45, hardness: 80 },
    ]));
    expect(file.version).toBe(2);
    expect(file.skipped).toBe(0);
    expect(file.samples.map(s => [s.width, s.height])).toEqual([[4, 3], [5, 6]]);
    expect([...file.samples[0].alpha]).toEqual(px);
    expect([...file.samples[1].alpha]).toEqual(rlePx);
    expect(file.presets.map(p => p.name)).toEqual(['Raw', 'Packed', 'Brush 3']);
    expect(file.presets[0].tip).toMatchObject({ kind: 'sampled', diameter: 4, spacing: 40 });
    expect(file.presets[2].tip).toEqual({ kind: 'computed', diameter: 30, hardness: 0.8, roundness: 0.5, angle: 45, spacing: 25 });
  });

  it('reads v1 (no names)', () => {
    const file = parseAbr(writeLegacy(1, [{ kind: 'sampled', width: 3, height: 3, px: ramp(9) }]));
    expect(file.presets[0].name).toBe('Brush 1');
    expect(file.samples[0].alpha.length).toBe(9);
  });

  it('skips a computed brush with values out of range and keeps the rest', () => {
    const file = parseAbr(writeLegacy(2, [
      { kind: 'computed', spacing: 0, diameter: 30, roundness: 500, angle: 0, hardness: 80 },
      { kind: 'sampled', width: 2, height: 2, px: [1, 2, 3, 4] },
    ]));
    expect(file.skipped).toBe(1);
    expect(file.presets).toHaveLength(1);
  });

  it('imports legacy brushes with spacing and diameter only, a computed one as a round tip', async () => {
    const plan = await planAbrImport(writeLegacy(2, [
      { kind: 'sampled', name: 'Sp', width: 8, height: 4, px: Array(32).fill(255), spacing: 60 },
      { kind: 'computed', spacing: 20, diameter: 40, roundness: 100, angle: 0, hardness: 30 },
    ]));
    const [sampled, computed] = plan.brushes;
    expect(sampled.descriptor.tip.shape).toBe('image');
    expect(sampled.descriptor.spacing).toBeCloseTo(0.6);
    expect(sampled.descriptor.size).toBe(8);
    expect(computed.descriptor.tip.shape).toBe('round');
    expect(computed.descriptor).toMatchObject({ size: 40, hardness: 0.3, spacing: 0.2 });
    expect(computed.tipKey).toBeUndefined();
    expect(plan.tips).toHaveLength(1);
  });
});

describe('ABR v6', () => {
  it('reads 8 and 16 bit tips, raw and RLE, in both subversions', () => {
    for (const sub of [1, 2] as const) {
      const eight = ramp(20);
      const sixteen = [0, 65535, 0x8000, 257, 40000, 1, 65534, 12345];
      const file = parseAbr(writeV6({
        subversion: sub,
        samples: [
          { id: 'A', width: 5, height: 4, px: eight },
          { id: 'B', width: 5, height: 4, px: eight, rle: true },
          { id: 'C', width: 4, height: 2, px: sixteen, depth: 16 },
          { id: 'D', width: 4, height: 2, px: sixteen, depth: 16, rle: true },
        ],
      }));
      expect(file.skipped).toBe(0);
      expect(file.samples.map(s => s.id)).toEqual(['A', 'B', 'C', 'D']);
      expect([...file.samples[0].alpha]).toEqual(eight);
      expect([...file.samples[1].alpha]).toEqual(eight);
      // 16 to 8 bits scales 0..65535 to 0..255 with rounding.
      const expected = sixteen.map(v => Math.round(v * 255 / 65535));
      expect([...file.samples[2].alpha]).toEqual(expected);
      expect([...file.samples[3].alpha]).toEqual(expected);
      expect(expected.slice(0, 3)).toEqual([0, 255, 128]);
    }
  });

  it('reads patterns (gray and RGB, raw and RLE) as luminance heights', () => {
    const gray = ramp(12);
    const file = parseAbr(writeV6({
      patterns: [
        { id: 'P-GRAY', name: 'Gray', width: 4, height: 3, mode: 1, channels: [gray] },
        { id: 'P-RGB', name: 'Color', width: 2, height: 1, mode: 3, channels: [[255, 0], [255, 0], [255, 0]], rle: true },
      ],
    }));
    expect(file.skipped).toBe(0);
    expect(file.patterns.map(p => p.id)).toEqual(['P-GRAY', 'P-RGB']);
    expect([...file.patterns[0].data]).toEqual(gray);
    expect([...file.patterns[1].data]).toEqual([255, 0]);
    expect(file.patterns[0].name).toBe('Gray');
  });

  it('reads presets from the descriptor, whatever the order of the sections', () => {
    const bytes = writeV6({
      order: ['desc', 'samp'],
      samples: [MIDDLE],
      presets: [preset('Chalk', sampledShape(MIDDLE.id, 20, { spacing: 10, angle: 30, flipX: true })), preset('Round', obj('computedBrush', {
        Dmtr: unit('#Pxl', 12), Hrdn: pct(40), Angl: unit('#Ang', 0), Rndn: pct(100), Spcn: pct(15), Intr: bool(true), flipX: bool(false), flipY: bool(false),
      }))],
    });
    const file = parseAbr(bytes);
    expect(file.presets.map(p => p.name)).toEqual(['Chalk', 'Round']);
    expect(file.presets[0].tip).toMatchObject({ kind: 'sampled', sampleId: MIDDLE.id, diameter: 20, spacing: 10, angle: 30, flipX: true });
    expect(file.presets[1].tip).toMatchObject({ kind: 'computed', diameter: 12, hardness: 0.4 });
  });
});

describe('mapping into brushes', () => {
  it('keeps a sampled tip as coverage (255 paints), cropped, with its size scaled to the painted part', async () => {
    const plan = await planAbrImport(writeV6({ samples: [MIDDLE], presets: [preset('Mid', sampledShape(MIDDLE.id, 60))] }));
    const [tip] = plan.tips;
    expect([tip.mask.width, tip.mask.height]).toEqual([2, 2]);
    expect([...tip.mask.alpha]).toEqual([255, 255, 255, 255]);
    // 60px across the 6px image: the 2px painted part is 20px.
    expect(plan.brushes[0].descriptor.size).toBe(20);
    expect(plan.brushes[0].tipKey).toBe(tip.key);
  });

  it('flips a tip into its mask and keeps one tip per sample and flip', async () => {
    const lopsided: V6Sample = { id: 'L', width: 3, height: 1, px: [255, 100, 0] };
    const plan = await planAbrImport(writeV6({
      samples: [lopsided],
      presets: [
        preset('A', sampledShape('L', 10)),
        preset('B', sampledShape('L', 20)),
        preset('C', sampledShape('L', 10, { flipX: true })),
      ],
    }));
    expect(plan.tips).toHaveLength(2);
    expect(plan.brushes.map(b => b.tipKey)).toEqual([plan.tips[0].key, plan.tips[0].key, plan.tips[1].key]);
    // The 0 column is cropped away, then the rest is mirrored for C.
    expect([...plan.tips[0].mask.alpha]).toEqual([255, 100]);
    expect([...plan.tips[1].mask.alpha]).toEqual([100, 255]);
  });

  it('skips brushes whose tip is blank, missing or of an unsupported kind', async () => {
    const blank: V6Sample = { id: 'blank', width: 2, height: 2, px: [0, 0, 0, 0] };
    const plan = await planAbrImport(writeV6({
      samples: [MIDDLE, blank],
      presets: [
        preset('ok', sampledShape(MIDDLE.id, 10)),
        preset('blank', sampledShape('blank', 10)),
        preset('gone', sampledShape('nope', 10)),
        preset('bristle', obj('dBrush', { Dmtr: unit('#Pxl', 10), Spcn: pct(10) })),
      ],
    }));
    expect(plan.brushes.map(b => b.name)).toEqual(['ok']);
    expect(plan.skipped).toBe(3);
  });

  it('refuses a file with nothing to import', async () => {
    await expect(planAbrImport(writeV6({ presets: [preset('gone', sampledShape('nope', 10))] }))).rejects.toThrow(AbrParseError);
    await expect(planAbrImport(writeV6({}))).rejects.toThrow(/no brushes/);
  });

  it('maps shape, scatter, transfer, colour and airbrush settings', async () => {
    const extra: Record<string, V> = {
      useTipDynamics: bool(true),
      szVr: dyn(2, 40),
      minimumDiameter: pct(25),
      angleDynamics: dyn(6, 50),
      roundnessDynamics: dyn(0, 30),
      useScatter: bool(true),
      bothAxes: bool(true),
      'Cnt ': long(4),
      scatterDynamics: dyn(0, 250),
      countDynamics: dyn(0, 60),
      usePaintDynamics: bool(true),
      prVr: dyn(0, 35),
      opVr: dyn(2, 10),
      useColorDynamics: bool(true),
      clVr: dyn(2, 80),
      'H   ': pct(20),
      Strt: pct(30),
      Brgh: pct(40),
      purity: pct(-50),
      colorDynamicsPerTip: bool(true),
      'Rpt ': bool(true),
      dualBrush: obj('null', { useDualBrush: bool(true) }),
      toolOptions: obj('null', { brushPreset: bool(true), Opct: long(70), flow: long(55), 'Md  ': enm('BlnM', 'Mltp') }),
    };
    const plan = await planAbrImport(writeV6({ samples: [MIDDLE], presets: [preset('Rich', sampledShape(MIDDLE.id, 30), extra)] }));
    const d = plan.brushes[0].descriptor;
    expect(d.pressureSize).toBe(true);
    expect(d.jitter).toMatchObject({ size: 0.4, angle: 0.5, roundness: 0.3, flow: 0.35 });
    expect(d.dynamics.minSize).toBeCloseTo(0.25);
    expect(d.tip.orientation).toBe('direction');
    expect(d.scatter).toMatchObject({ amount: 2.5, bothAxes: true, count: 4 });
    expect(d.scatter.countJitter).toBeCloseTo(0.6);
    expect(d.pressureOpacity).toBe(true);
    expect(d.color).toMatchObject({ fgBg: 0.8, fgBgPressure: true, perTip: true });
    expect(d.color.hue).toBeCloseTo(0.2);
    expect(d.color.purity).toBeCloseTo(-0.5);
    expect(d.airbrush).toBe(true);
    expect(d.opacity).toBeCloseTo(0.7);
    expect(d.flow).toBeCloseTo(0.55);
    expect(d.blendMode).toBe('multiply');
    expect(plan.unmapped).toContain('dualBrush');
  });

  it('turns a fade into a length from the step count', async () => {
    const plan = await planAbrImport(writeV6({
      samples: [MIDDLE],
      presets: [preset('Fade', sampledShape(MIDDLE.id, 60, { spacing: 50 }), { useTipDynamics: bool(true), szVr: dyn(1, 0, 10) })],
    }));
    const d = plan.brushes[0].descriptor;
    // 10 dabs, each spaced as Photoshop would (half of the 60px image), which is 1.5 of the 20px cropped tip, within the 100% the control allows.
    expect(d.spacing).toBe(1);
    expect(d.fade.sizeLength).toBeCloseTo(10 * 1 * 20);
    expect(d.pressureSize).toBe(false);
  });

  it('keeps the dab separation when the tip is cropped', async () => {
    const plan = await planAbrImport(writeV6({ samples: [MIDDLE], presets: [preset('Mid', sampledShape(MIDDLE.id, 60, { spacing: 10 }))] }));
    // 10% of the 60px image is 6px; the cropped tip is 20px, so 30%.
    expect(plan.brushes[0].descriptor.spacing).toBeCloseTo(0.3);
    expect(plan.brushes[0].descriptor.size).toBe(20);
  });

  it('compensates spacing for the crop before limiting it', async () => {
    const dot: V6Sample = { id: 'DOT', width: 20, height: 20, px: Array.from({ length: 400 }, (_, i) => (i === 210 ? 255 : 0)) };
    const plan = await planAbrImport(writeV6({ samples: [dot], presets: [preset('Dot', sampledShape('DOT', 100, { spacing: 1 }))] }));
    // The tip is 1 of 20px: 1% of the image is 20% of it.
    expect(plan.brushes[0].descriptor.spacing).toBeCloseTo(0.2);
  });

  it('measures how much a tall pattern was shrunk along its long side', async () => {
    const tall = { id: 'TALL', name: 'Tall', width: 1, height: 2048, mode: 1 as const, channels: [Array.from({ length: 2048 }, (_, i) => i % 256)] };
    const plan = await planAbrImport(writeV6({
      samples: [MIDDLE], patterns: [tall],
      presets: [preset('T', sampledShape(MIDDLE.id, 10), { useTexture: bool(true), textureDepth: pct(50), Txtr: obj('Ptrn', { Idnt: text('TALL') }) })],
    }));
    expect([plan.patterns[0].width, plan.patterns[0].height]).toEqual([1, 1024]);
    expect(plan.brushes[0].descriptor.texture.scale).toBe(2);
  });

  it('maps pressure on flow as the engine\'s pressure-driven flow', async () => {
    const plan = await planAbrImport(writeV6({
      samples: [MIDDLE],
      presets: [preset('Flow', sampledShape(MIDDLE.id, 30), { usePaintDynamics: bool(true), prVr: dyn(2, 0), opVr: dyn(0, 0) })],
    }));
    expect(plan.brushes[0].descriptor.pressureOpacity).toBe(true);
  });

  it('copies tips out of the file, so storing one does not keep the whole file', async () => {
    const big: V6Sample = { id: 'BIG', width: 300, height: 300, px: Array.from({ length: 90000 }, (_, i) => (i % 7 ? 255 : 0)) };
    const small: V6Sample = { id: 'SM', width: 2, height: 2, px: [255, 255, 255, 255] };
    const plan = await planAbrImport(writeV6({ samples: [big, small], presets: [preset('a', sampledShape('BIG', 10)), preset('b', sampledShape('SM', 10))] }));
    for (const t of plan.tips) expect(t.mask.alpha.buffer.byteLength).toBe(t.mask.alpha.length);
  });

  it('gives patterns with different ids different stored ids, and the same pattern the same one', async () => {
    const pat = (id: string, v: number) => ({ id, name: id, width: 2, height: 2, mode: 1 as const, channels: [[v, v, v, v]] });
    const tex = (id: string) => ({ useTexture: bool(true), textureDepth: pct(50), Txtr: obj('Ptrn', { Idnt: text(id) }) });
    const bytes = (v: number) => writeV6({
      samples: [MIDDLE],
      patterns: [pat('P.A', v), pat('P_A', v)],
      presets: [preset('one', sampledShape(MIDDLE.id, 10), tex('P.A')), preset('two', sampledShape(MIDDLE.id, 10), tex('P_A'))],
    });
    const a = await planAbrImport(bytes(10));
    expect(new Set(a.brushes.map(b => b.descriptor.texture.pattern)).size).toBe(2);
    expect(a.patterns.every(p => p.id.length <= 100)).toBe(true);
    const again = await planAbrImport(bytes(10));
    expect(again.patterns.map(p => p.id)).toEqual(a.patterns.map(p => p.id));
    // Same id, different pixels: another record.
    const changed = await planAbrImport(bytes(200));
    expect(changed.patterns[0].id).not.toBe(a.patterns[0].id);
  });

  it('plans a texture with its imported pattern, and only the patterns in use', async () => {
    const tile = ramp(16);
    const plan = await planAbrImport(writeV6({
      samples: [MIDDLE],
      patterns: [
        { id: 'AB-PATTERN-1', name: 'Grain', width: 4, height: 4, mode: 1, channels: [tile] },
        { id: 'unused', name: 'Unused', width: 2, height: 2, mode: 1, channels: [[1, 2, 3, 4]] },
      ],
      presets: [preset('Gritty', sampledShape(MIDDLE.id, 30), {
        useTexture: bool(true), TxtC: bool(true), InvT: bool(true), textureScale: pct(200), textureDepth: pct(60),
        textureBlendMode: enm('BlnM', 'Sbtr'), textureDepthDynamics: dyn(2),
        Txtr: obj('Ptrn', { 'Nm  ': text('Grain'), Idnt: text('ab-pattern-1') }),
      })],
    }));
    expect(plan.patterns.map(p => p.name)).toEqual(['Grain']);
    const d = plan.brushes[0].descriptor;
    expect(d.texture).toMatchObject({ pattern: plan.patterns[0].id, scale: 2, depth: 0.6, mode: 'subtract', invert: true, perTip: true, depthPressure: true });
    expect([...plan.patterns[0].data]).toEqual(tile);
  });
});

describe('robustness', () => {
  const small = () => writeV6({
    samples: [MIDDLE, { id: 'B', width: 3, height: 2, px: [1, 2, 3, 4, 5, 6], rle: true }],
    patterns: [{ id: 'P', name: 'p', width: 2, height: 2, mode: 1, channels: [[1, 2, 3, 4]] }],
    presets: [preset('One', sampledShape(MIDDLE.id, 10), { useTipDynamics: bool(true), szVr: dyn(2, 10) }), preset('Two', sampledShape('B', 5))],
  });
  const legacy = () => writeLegacy(2, [
    { kind: 'sampled', name: 'A', width: 3, height: 2, px: [1, 2, 3, 4, 5, 6], rle: true },
    { kind: 'computed', spacing: 25, diameter: 10, roundness: 100, angle: 0, hardness: 50 },
  ]);

  it.each([['v6', small], ['v2', legacy]])('a %s file cut at any length throws AbrParseError or returns what was read', async (_n, make) => {
    const whole = make();
    for (let n = 0; n < whole.length; n++) {
      const cut = whole.slice(0, n);
      try {
        parseAbr(cut);
      } catch (e) {
        expect(e).toBeInstanceOf(AbrParseError);
      }
      try {
        await planAbrImport(cut);
      } catch (e) {
        expect(e).toBeInstanceOf(AbrParseError);
      }
    }
    expect(parseAbr(whole).skipped).toBe(0);
  });

  it.each([['v6', small], ['v2', legacy]])('a %s file with damaged bytes only ever throws AbrParseError', async (_n, make) => {
    const whole = make();
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 400; round++) {
      const bytes = whole.slice();
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) bytes[Math.floor(rnd() * bytes.length)] = rnd() < 0.5 ? 255 : Math.floor(rnd() * 256);
      try {
        await planAbrImport(bytes);
      } catch (e) {
        expect(e).toBeInstanceOf(AbrParseError);
      }
    }
  });

  it('rejects things that are not brush files', () => {
    expect(() => parseAbr(new Uint8Array(0))).toThrow(AbrParseError);
    expect(() => parseAbr(new TextEncoder().encode('GIF89a not a brush file'))).toThrow(AbrParseError);
    expect(() => parseAbr(new Uint8Array([0, 6, 0, 9]))).toThrow(/layout/);
  });

  it('skips a tip with a huge size without allocating it', () => {
    const o = new Out().i16(6).i16(2).raw('8BIM').raw('samp');
    const e = new Out().pascal('HUGE').zeros(264).i32(0).i32(0).i32(100000).i32(100000).i16(8).u8(0);
    const s = new Out().u32(e.length).bytes(e.parts).pad4();
    o.u32(s.length).bytes(s.parts);
    const file = parseAbr(o.done());
    expect(file.samples).toHaveLength(0);
    expect(file.skipped).toBe(1);
  });

  it('does not loop on zero-length sections', () => {
    const o = new Out().i16(6).i16(2);
    for (let i = 0; i < 50; i++) o.raw('8BIM').raw('samp').u32(0);
    o.raw('8BIM').raw('desc').u32(0).raw('8BIM').raw('patt').u32(0);
    expect(parseAbr(o.done()).presets).toHaveLength(0);
  });

  it('counts brushes over the whole file, not per section', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => preset(`b${i}`, sampledShape('x', 5)));
    const one = writeV6({ presets: many(1500) });
    // Two description sections in one file: the second one's brushes past the limit are dropped.
    const body = one.slice(4);
    const both = new Uint8Array(one.length + body.length);
    both.set(one);
    both.set(body, one.length);
    const file = parseAbr(both);
    expect(file.presets.length).toBe(2000);
    expect(file.skipped).toBeGreaterThan(0);
  });

  it('refuses a pattern whose channel is another size than the pattern', () => {
    const bytes = writeV6({ patterns: [{ id: 'P', name: 'p', width: 2, height: 2, mode: 1, channels: [[1, 2, 3, 4]] }] });
    // The channel's rectangle follows its depth field (8); shrink its right edge from 2 to 1.
    const at = bytes.findIndex((_, i) => i > 40 && bytes[i + 3] === 8 && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 15] === 2 && bytes[i + 19] === 2);
    expect(at).toBeGreaterThan(0);
    bytes[at + 19] = 1;
    const file = parseAbr(bytes);
    expect(file.patterns).toHaveLength(0);
    expect(file.skipped).toBe(1);
  });

  it('refuses descriptors nested too deeply or claiming impossible counts', () => {
    let nested: V = text('x');
    for (let i = 0; i < 100; i++) nested = obj('deep', { next: nested });
    const file = parseAbr(writeV6({ presets: [preset('Deep', sampledShape('x', 5), { deep: nested })] }));
    expect(file.presets).toHaveLength(0);
    expect(file.skipped).toBeGreaterThan(0);

    const bad = new Out().u32(16).unicode('', true).u32(0).raw('null').u32(0xffffffff);
    const o = new Out().i16(6).i16(2).raw('8BIM').raw('desc').u32(bad.length).bytes(bad.parts);
    expect(parseAbr(o.done()).presets).toHaveLength(0);
  });

  it('packs rows the way the writer does (self-check of the test helper)', () => {
    expect(packBitsRow([5, 5, 5, 1, 2])).toEqual([254, 5, 1, 1, 2]);
  });
});

const stores: [string, () => Promise<{ store: BrushLibraryStore; reopen: () => Promise<BrushLibraryStore>; done: () => Promise<void> }>][] = [
  ['MemoryBackend', async () => {
    const backend = new MemoryBackend();
    return { store: backend.brushes, reopen: async () => backend.brushes, done: async () => {} };
  }],
  ['IndexedDBBackend', async () => {
    const name = `abr-${Math.random()}`;
    const open = async () => { const b = new IndexedDBBackend({ dbName: name }); await b.init(); return b; };
    let backend = await open();
    return {
      store: backend.brushes,
      reopen: async () => { await backend.dispose(); backend = await open(); return backend.brushes; },
      done: () => backend.dispose(),
    };
  }],
];

describe.each(stores)('importing into the brush library: %s', (_name, open) => {
  async function planned() {
    return planAbrImport(writeV6({
      samples: [MIDDLE],
      patterns: [{ id: 'GRAIN-1', name: 'Grain', width: 4, height: 4, mode: 1, channels: [ramp(16)] }],
      presets: [
        preset('Chalk', sampledShape(MIDDLE.id, 30), { useTexture: bool(true), textureDepth: pct(50), Txtr: obj('Ptrn', { Idnt: text('grain-1') }) }),
        preset('Chalk 2', sampledShape(MIDDLE.id, 50)),
      ],
    }));
  }

  it('stores tips, presets under a group and patterns, and finds them again after a reload', async () => {
    const { store, reopen, done } = await open();
    const lib = new BrushLibrary(store);
    const plan = await planned();
    const n = await lib.importBrushes({ group: 'Chalks', tips: plan.tips, brushes: plan.brushes, patterns: plan.patterns });
    expect(n).toBe(2);
    expect(lib.groups()).toEqual(['Chalks']);
    const patternId = plan.patterns[0].id;
    expect(getTexturePattern(patternId)).not.toBeNull();

    // A fresh start: nothing registered, everything read back from storage.
    unregisterTexturePattern(patternId);
    clearTipMasks();
    const again = new BrushLibrary(await reopen());
    await again.load();
    expect(again.presets.map(p => [p.name, p.group])).toEqual([['Chalk', 'Chalks'], ['Chalk 2', 'Chalks']]);
    expect(again.tips).toHaveLength(1);
    expect(again.tips[0].group).toBe('Chalks');
    expect(getTexturePattern(patternId)?.data.length).toBe(16);
    const chalk = toBrushPreset(again.presets[0]);
    expect(chalk.group).toBe('Chalks');
    expect(chalk.descriptor.texture).toMatchObject({ pattern: patternId, depth: 0.5 });
    expect(chalk.descriptor.tip).toMatchObject({ shape: 'image', imageId: again.tips[0].id });
    await again.ensureTip(again.tips[0].id);
    expect([...getTipMask(again.tips[0].id)!.alpha]).toEqual([255, 255, 255, 255]);
    await done();
  });

  it('deletes a whole group with its tips and patterns, and leaves other brushes', async () => {
    const { store, reopen, done } = await open();
    const lib = new BrushLibrary(store);
    const plan = await planned();
    await lib.importBrushes({ group: 'Chalks', tips: plan.tips, brushes: plan.brushes, patterns: plan.patterns });
    await lib.add([{ name: 'Mine', mask: { width: 1, height: 1, alpha: Uint8Array.of(255) } }]);
    const patternId = plan.patterns[0].id;
    await lib.removeGroup('Chalks');
    expect(lib.presets.map(p => p.name)).toEqual(['Mine']);
    expect(lib.tips).toHaveLength(1);
    expect(getTexturePattern(patternId)).toBeNull();

    const again = new BrushLibrary(await reopen());
    await again.load();
    expect(again.presets.map(p => p.name)).toEqual(['Mine']);
    expect(again.tips).toHaveLength(1);
    expect(await (await reopen()).listPatterns()).toEqual([]);
    await done();
  });

  it('does not let a reload that began before an import replace its brushes', async () => {
    const { store, done } = await open();
    const lib = new BrushLibrary(store);
    let release!: () => void;
    const realList = store.listPatterns.bind(store);
    vi.spyOn(store, 'listPatterns').mockImplementationOnce(async () => {
      await new Promise<void>(r => { release = r; });
      return realList();
    });
    const reloading = lib.reload();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const plan = await planned();
    await lib.importBrushes({ group: 'New', tips: plan.tips, brushes: plan.brushes, patterns: plan.patterns });
    release();
    await reloading;
    expect(lib.groups()).toEqual(['New']);
    await done();
  });

  it('keeps the registered patterns when reading them fails, and an import finished during a group delete', async () => {
    const { store, done } = await open();
    const lib = new BrushLibrary(store);
    const plan = await planned();
    await lib.importBrushes({ group: 'A', tips: plan.tips, brushes: plan.brushes, patterns: plan.patterns });
    const id = plan.patterns[0].id;
    const failing = vi.spyOn(store, 'listPatterns').mockRejectedValue(new Error('read failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await lib.load();
    expect(getTexturePattern(id)).not.toBeNull();
    failing.mockRestore();

    // B's write completes while A's deletion is under way.
    let release!: () => void;
    const realDelete = store.deleteMany.bind(store);
    vi.spyOn(store, 'deleteMany').mockImplementation(async batch => {
      await new Promise<void>(r => { release = r; });
      return realDelete(batch);
    });
    const deleting = lib.removeGroup('A');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const other = await planned();
    await lib.importBrushes({ group: 'B', tips: other.tips, brushes: other.brushes, patterns: other.patterns });
    release();
    await deleting;
    expect(lib.presets.map(p => p.group)).toEqual(['B', 'B']);
    expect(lib.groups()).toEqual(['B']);
    await done();
  });

  it('keeps a pattern while any brush still uses it', async () => {
    const { store, done } = await open();
    const lib = new BrushLibrary(store);
    const plan = await planned();
    await lib.importBrushes({ group: 'A', tips: plan.tips, brushes: plan.brushes, patterns: plan.patterns });
    const first = lib.presets.find(p => p.name === 'Chalk')!;
    // The second preset has no texture; removing the textured one drops the pattern.
    await lib.removePreset(lib.presets.find(p => p.name === 'Chalk 2')!.id);
    expect(getTexturePattern(plan.patterns[0].id)).not.toBeNull();
    await lib.removePreset(first.id);
    expect(getTexturePattern(plan.patterns[0].id)).toBeNull();
    await done();
  });

  it('deletes a pattern only if no stored preset names it, checked as it deletes', async () => {
    const { store, done } = await open();
    const pattern = (id: string) => ({ id, name: id, width: 1, height: 1, createdAt: 1, data: Uint8Array.of(9) });
    const withTexture = (id: string, pat: string) => {
      const d = normalizeBrushDescriptor({ texture: { pattern: pat, scale: 1, depth: 1, mode: 'multiply', invert: false, depthPressure: false, perTip: false } });
      return { id, name: id, descriptor: d, createdAt: 1 };
    };
    // Another tab stored a brush on P after this one decided P was unused.
    await store.putBatch({ patterns: [pattern('P'), pattern('Q')], presets: [withTexture('theirs', 'P'), withTexture('mine', 'Q')] });
    const result = await store.deleteMany({ presets: ['mine'], unusedPatterns: ['P', 'Q'] });
    expect(result.patterns).toEqual(['Q']);
    expect((await store.listPatterns()).map(p => p.id)).toEqual(['P']);
    await done();
  });
});

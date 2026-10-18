import { afterEach, describe, expect, it, vi } from 'vitest';
import { StampStrokeEngine } from '../src/engine/stamp-stroke.ts';
import { NO_COLOR, colorDynamicsActive, copyDescriptor, normalizeColorDynamics, getPresetById } from '../src/engine/brush-presets.ts';
import { varyColor, srgbToOklab } from '../src/engine/ink-model.ts';
import { makeBrush } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const DOC_W = 400, DOC_H = 100;
const ROLLS = { hue: 0.5, saturation: 0.5, brightness: 0.5, fgBg: 0.5 };

interface Dab { cx: number; cy: number; w: number; h: number; alpha: number; rot: number }

/** A stroke through a line of points: the dabs as drawn, the colours it tinted tips with, and the engine afterwards. */
function run(brush: Parameters<typeof makeBrush>[0], seed: number, opts: { secondaryColor?: string; pressure?: (i: number) => number; eraser?: boolean; layer?: CanvasRenderingContext2D } = {}) {
  const dabs: Dab[] = [];
  const tints: string[] = [];
  let commitTints = 0;
  vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation(function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if ((args[0] as HTMLCanvasElement).width >= 200) return;
    // Plain mode draws (tip, x, y, w, h); colour mode crops (tint, 0, 0, tw, th, x, y, w, h).
    const o = args.length === 9 ? 4 : 0;
    if (args.length !== 5 && args.length !== 9) return;
    // The edge copies into a tinted slot start elsewhere than its corner.
    if (args.length === 9 && (args[1] !== 0 || args[2] !== 0)) return;
    const m = this.getTransform();
    const w = args[o + 3] as number, h = args[o + 4] as number;
    dabs.push({ cx: m.m41 + (args[o + 1] as number) + w / 2, cy: m.m42 + (args[o + 2] as number) + h / 2, w, h, alpha: this.globalAlpha, rot: Math.atan2(m.m12, m.m11) });
  });
  vi.spyOn(CanvasRenderingContext2D.prototype, 'fillRect').mockImplementation(function (this: CanvasRenderingContext2D) {
    if (this.globalCompositeOperation !== 'source-in') return;
    if (this.canvas.width < 200) tints.push(String(this.fillStyle));
    else commitTints++;
  });
  const engine = new StampStrokeEngine();
  engine.begin(makeBrush({ size: 20, spacing: 0.25, flow: 1, pressureSize: false, pressureOpacity: false, ...brush }), '#3366cc', !!opts.eraser, DOC_W, DOC_H, { seed, secondaryColor: opts.secondaryColor ?? '#ff0000' });
  const preview = engine.getStrokePreview();
  for (let i = 0; i < 21; i++) engine.stroke(20 + i * 15, 50, opts.pressure?.(i) ?? 1, opts.layer, i * 8);
  const during = engine.getStrokePreview();
  engine.commit(document.createElement('canvas').getContext('2d')!);
  vi.restoreAllMocks();
  return { dabs, tints, preview, during, commitTints };
}

const varied = { color: { ...NO_COLOR, hue: 1, saturation: 0.5, brightness: 0.4, fgBg: 0.5 } };

describe('colour dynamics', () => {
  it('is off by default, and the two switches alone change nothing', () => {
    expect(colorDynamicsActive(NO_COLOR)).toBe(false);
    expect(colorDynamicsActive({ ...NO_COLOR, fgBgPressure: true, perTip: false })).toBe(false);
    expect(colorDynamicsActive({ ...NO_COLOR, purity: -0.2 })).toBe(true);
    for (const key of ['hue', 'saturation', 'brightness', 'fgBg'] as const) expect(colorDynamicsActive({ ...NO_COLOR, [key]: 0.1 })).toBe(true);
    expect(run({ color: { ...NO_COLOR, fgBgPressure: true, perTip: false } }, 3).during!.color).toBe('#3366cc');
  });

  it('turns the per-dab colour path on only when something varies (or the brush is wet), never for the eraser', () => {
    expect(run({}, 1).during!.color).toBe('#3366cc');
    expect(run(varied, 1).during!.color).toBeNull();
    expect(run({ ink: { wetness: 0.5 } }, 1).during!.color).toBeNull();
    // The eraser's strokes are plain coverage; its preview is not coloured.
    expect(run(varied, 1, { eraser: true }).during!.color).not.toBeNull();
  });

  it('commits the buffer as painted: only the plain path tints it with the stroke colour', () => {
    expect(run({}, 1).commitTints).toBe(1);
    expect(run(varied, 1).commitTints).toBe(0);
    expect(run({ ink: { wetness: 0.3 } }, 1).commitTints).toBe(0);
  });

  it('leaves a stroke without it exactly as it was', () => {
    const jitter = { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 };
    const plain = run({ jitter }, 4);
    expect(plain.dabs.length).toBeGreaterThan(20);
    expect(plain.tints).toEqual([]);
    expect(run({ jitter, color: { ...NO_COLOR } }, 4)).toEqual(plain);
  });

  it('draws the same colours for the same seed and others otherwise', () => {
    const a = run(varied, 7).tints;
    expect(a.length).toBeGreaterThan(5);
    expect(run(varied, 7).tints).toEqual(a);
    expect(run(varied, 8).tints).not.toEqual(a);
  });

  it('reads its own random stream, so jitter and scatter land where they did', () => {
    const base = { jitter: { size: 0.5, angle: 0.5, roundness: 0.3, flow: 0.5 }, scatter: { amount: 1, bothAxes: true, count: 3, countJitter: 0.4 } };
    expect(run({ ...base, ...varied }, 5).dabs).toEqual(run(base, 5).dabs);
  });

  it('does not read back the layer for colour alone, only for a wet brush', () => {
    const layer = document.createElement('canvas').getContext('2d')!;
    const read = vi.spyOn(layer, 'getImageData');
    run(varied, 2, { layer });
    expect(read).not.toHaveBeenCalled();
    run({ ...varied, ink: { wetness: 0.4 } }, 2, { layer });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('mixes what a wet brush picks up into the varied colour, extras included, and clears it over nothing', () => {
    const snapshot = (rgba: [number, number, number, number]) => {
      const img = new ImageData(DOC_W, DOC_H);
      for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
      return img;
    };
    const layerWith = (rgba: [number, number, number, number]) => {
      const layer = document.createElement('canvas').getContext('2d')!;
      vi.spyOn(layer, 'getImageData').mockReturnValue(snapshot(rgba));
      return layer;
    };
    const scatter = { amount: 1, bothAxes: true, count: 3, countJitter: 0 };
    const dry = run({ ...varied, scatter }, 12).tints;
    // Fully wet over opaque green: every dab, scattered or not, is the canvas colour.
    const green = run({ ...varied, scatter, ink: { wetness: 1 } }, 12, { layer: layerWith([0, 255, 0, 255]) }).tints;
    expect(green.length).toBeGreaterThan(0);
    expect(new Set(green)).toEqual(new Set(['#00ff00']));
    // Half wet: part varied colour, part green, so neither of the two.
    const half = run({ ...varied, scatter, ink: { wetness: 0.5 } }, 12, { layer: layerWith([0, 255, 0, 255]) }).tints;
    expect(half).not.toEqual(dry);
    expect(half).not.toContain('#00ff00');
    // Over transparent canvas there is nothing to pick up: the varied colours as without wetness.
    const clear = run({ ...varied, scatter, ink: { wetness: 1 } }, 12, { layer: layerWith([0, 0, 0, 0]) }).tints;
    expect(clear).toEqual(dry);
  });

  it('treats zero pressure as a lift when pressure drives the fill mix', () => {
    const lifted = run({ color: { ...NO_COLOR, fgBg: 1, fgBgPressure: true } }, 3, { pressure: i => (i < 10 ? 0.3 : 0) });
    const held = run({ color: { ...NO_COLOR, fgBg: 1, fgBgPressure: true } }, 3, { pressure: () => 0.3 });
    // Without the lift the zero-pressure tail would be read as full pressure and drawn in the stroke colour.
    expect(lifted.dabs.length).toBeLessThan(held.dabs.length);
    expect(lifted.tints.every(t => t !== '#3366cc')).toBe(true);
  });

  it('retints a bounded number of times: once for a stroke-wide colour, few for a snapped one', () => {
    const dabs = run({}, 6).dabs.length;
    const once = run({ color: { ...NO_COLOR, hue: 1, brightness: 1, fgBg: 1, perTip: false } }, 6);
    expect(once.dabs).toHaveLength(dabs);
    expect(once.tints).toHaveLength(1);
    // Hue alone has 64 stops, however long the stroke.
    const hueOnly = run({ color: { ...NO_COLOR, hue: 1 } }, 6);
    expect(hueOnly.tints.length).toBeLessThanOrEqual(64);
    expect(hueOnly.tints.length).toBeLessThan(dabs);
    expect(new Set(hueOnly.tints).size).toBe(hueOnly.tints.length);
    // However much varies, no more than one tint per dab.
    expect(run(varied, 6).tints.length).toBeLessThanOrEqual(dabs);
  });

  it('stays on the stroke colour with a stroke-wide variation off per tip, whatever the pressure', () => {
    const r = run({ color: { ...NO_COLOR, hue: 1, fgBg: 1, fgBgPressure: true, perTip: false } }, 9, { pressure: i => 1 - i / 25 });
    expect(r.tints).toHaveLength(1);
  });

  it('mixes toward the fill colour by chance or, with the switch, by pressure', () => {
    const bright = (hex: string) => parseInt(hex.slice(1, 3), 16) - parseInt(hex.slice(5, 7), 16);
    const dyn = { ...NO_COLOR, fgBg: 1, fgBgPressure: true };
    // Full pressure keeps the stroke colour (blue), none goes all the way to the fill (red).
    expect(bright(varyColor('#3366cc', '#ff0000', dyn, ROLLS, 1))).toBeLessThan(0);
    expect(bright(varyColor('#3366cc', '#ff0000', dyn, ROLLS, 0))).toBeGreaterThan(200);
    // Without it the roll decides and pressure is ignored.
    const chance = { ...NO_COLOR, fgBg: 1 };
    expect(varyColor('#3366cc', '#ff0000', chance, { ...ROLLS, fgBg: 1 }, 1)).toBe(varyColor('#3366cc', '#ff0000', chance, { ...ROLLS, fgBg: 1 }, 0));
    expect(bright(varyColor('#3366cc', '#ff0000', chance, { ...ROLLS, fgBg: 1 }, 1))).toBeGreaterThan(200);
    // No fill colour known: nothing to mix toward.
    expect(run({ color: { ...NO_COLOR, fgBg: 1 } }, 1, { secondaryColor: '' }).tints.length).toBe(1);
  });

  it('returns the stroke colour exactly where nothing moves it, and moves only the channels asked for', () => {
    const none = { ...NO_COLOR };
    for (const base of ['#00ff00', '#3366cc', '#808080', '#000000', '#ffffff']) {
      expect(varyColor(base, '#ff0000', none, ROLLS, 1)).toBe(base);
      // The documented endpoints: full pressure is the stroke colour, whatever else is set.
      expect(varyColor(base, '#ff0000', { ...none, fgBg: 1, fgBgPressure: true }, ROLLS, 1)).toBe(base);
      // A jitter too small for one step is no change either.
      expect(varyColor(base, '#ff0000', { ...none, hue: 0.001, brightness: 0.001, saturation: 0.001 }, { hue: 0.6, saturation: 0.6, brightness: 0.6, fgBg: 0 }, 1)).toBe(base);
    }
    // The ends are exact: the fill at no pressure or a full chance roll, grey at purity -1.
    expect(varyColor('#0000ff', '#ff0000', { ...none, fgBg: 1, fgBgPressure: true }, ROLLS, 0)).toBe('#ff0000');
    expect(varyColor('#0000ff', '#ff0000', { ...none, fgBg: 1 }, { ...ROLLS, fgBg: 1 }, 1)).toBe('#ff0000');
    const grey = varyColor('#ff0000', '#00ff00', { ...none, purity: -1 }, ROLLS, 1).slice(1).match(/../g)!;
    expect(new Set(grey).size).toBe(1);
    // Full lightness is white and none black, not a clipped tint.
    expect(varyColor('#0000ff', '#ff0000', { ...none, brightness: 1 }, { ...ROLLS, brightness: 0 }, 1)).toBe('#000000');
    expect(varyColor('#ff0000', '#ff0000', { ...none, brightness: 1 }, { ...ROLLS, brightness: 1 }, 1)).toBe('#ffffff');
    // Only hue is on: lightness and chroma stay what the stroke colour has.
    const lum = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).reduce((a, v) => a + v, 0);
    expect(Math.abs(lum(varyColor('#3366cc', '#ff0000', { ...none, hue: 0.1 }, { ...ROLLS, hue: 1 }, 1)) - lum('#3366cc'))).toBeLessThan(60);
  });

  it('reuses tinted canvases once the cache is full instead of allocating one per dab', () => {
    const created: unknown[] = [];
    const make = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, o?: ElementCreationOptions) => {
      const el = make(tag, o);
      if (tag === 'canvas') created.push(el);
      return el;
    }) as typeof document.createElement);
    const r = run({ size: 150, spacing: 0.05, scatter: { amount: 2, bothAxes: true, count: 16, countJitter: 0 }, color: { ...NO_COLOR, hue: 1, saturation: 1, brightness: 1, fgBg: 1 } }, 11);
    expect(r.dabs.length).toBeGreaterThan(500);
    expect(r.tints.length).toBeGreaterThan(300);
    // The cache keeps at most 128 tinted tips; the rest is recycled.
    expect(created.length).toBeGreaterThan(100);
    expect(created.length).toBeLessThan(260);
  });

  it('keeps recycling tinted canvases when the dabs vary in size', () => {
    const created: unknown[] = [];
    const make = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, o?: ElementCreationOptions) => {
      const el = make(tag, o);
      if (tag === 'canvas') created.push(el);
      return el;
    }) as typeof document.createElement);
    const r = run({ size: 150, spacing: 0.05, jitter: { size: 0.6, angle: 0, roundness: 0, flow: 0 }, scatter: { amount: 2, bothAxes: true, count: 16, countJitter: 0 }, color: { ...NO_COLOR, hue: 1, saturation: 1, brightness: 1, fgBg: 1 } }, 11);
    expect(r.tints.length).toBeGreaterThan(300);
    // The tip cache makes a canvas per size; the tinted slots are all one size.
    expect(created.length).toBeLessThan(260);
  });

  it('keeps a tinted tip\'s edge pixels outside it, so a dab drawn from a larger slot is no softer than from a tip-sized canvas', () => {
    const copies: unknown[][] = [];
    vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage').mockImplementation((...args: unknown[]) => {
      // The one-pixel-wide copies of the last column (the tip is 20 wide).
      if (args.length === 9 && args[3] === 1 && args[1] === 19) copies.push(args);
    });
    const engine = new StampStrokeEngine();
    engine.begin(makeBrush({ size: 20, hardness: 1, spacing: 5, pressureSize: false, color: { ...NO_COLOR, hue: 1 } }), '#3366cc', false, DOC_W, DOC_H, { seed: 1 });
    engine.stroke(50, 50, 1, undefined, 0);
    engine.stroke(150, 50, 1, undefined, 8);
    engine.commit(document.createElement('canvas').getContext('2d')!);
    expect(copies.length).toBeGreaterThanOrEqual(2);
  });

  it('mixes toward the fill in OKLab without clipping, keeping the lightness of a mix of saturated colours', () => {
    const lab = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return srgbToOklab(r, g, b); };
    const mixed = varyColor('#00ff00', '#0000ff', { ...NO_COLOR, fgBg: 1 }, { ...ROLLS, fgBg: 0.5 }, 1);
    const expected = (lab('#00ff00').L + lab('#0000ff').L) / 2;
    expect(Math.abs(lab(mixed).L - expected)).toBeLessThan(0.02);
  });

  it('keeps every colour a valid sRGB hex, however far it is pushed', () => {
    const extremes = [
      { ...NO_COLOR, hue: 1, saturation: 1, brightness: 1, purity: 1, fgBg: 1 },
      { ...NO_COLOR, hue: 1, saturation: 1, brightness: 1, purity: -1 },
      { ...NO_COLOR, brightness: 1, purity: 1 },
    ];
    for (const base of ['#ff0000', '#00ff00', '#0000ff', '#000000', '#ffffff', '#808080', '#3366cc'])
      for (const dyn of extremes)
        for (const r of [0, 0.25, 0.5, 0.99, 1])
          for (const fill of ['#ff00ff', '#ffffff', '#000000'])
            expect(varyColor(base, fill, dyn, { hue: r, saturation: 1 - r, brightness: r, fgBg: r }, r)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('turns the hue by up to half a turn, and purity -1 takes the colour to grey', () => {
    const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const same = varyColor('#3366cc', '#ff0000', { ...NO_COLOR, hue: 1 }, ROLLS, 1);
    const turned = varyColor('#3366cc', '#ff0000', { ...NO_COLOR, hue: 1 }, { ...ROLLS, hue: 1 }, 1);
    expect(turned).not.toBe(same);
    const grey = rgb(varyColor('#3366cc', '#ff0000', { ...NO_COLOR, purity: -1 }, ROLLS, 1));
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(3);
    // Grey has no hue to turn.
    const g = rgb(varyColor('#808080', '#ff0000', { ...NO_COLOR, hue: 1 }, { ...ROLLS, hue: 1 }, 1));
    expect(Math.max(...g) - Math.min(...g)).toBeLessThanOrEqual(1);
  });

  it('copies its block with the descriptor and fills it in for stored brushes without one', () => {
    const d = makeBrush({ color: { hue: 0.3 } });
    const copy = copyDescriptor(d);
    expect(copy.color).toEqual(d.color);
    expect(copy.color).not.toBe(d.color);
    const legacy = { ...d } as Partial<typeof d>;
    delete legacy.color;
    expect(copyDescriptor(legacy as typeof d).color).toEqual(NO_COLOR);
    expect(normalizeColorDynamics(undefined)).toEqual(NO_COLOR);
    expect(normalizeColorDynamics({ hue: 4, saturation: -1, brightness: NaN, purity: -9, fgBg: 0.3, fgBgPressure: true, perTip: 'no' as unknown as boolean }))
      .toEqual({ hue: 1, saturation: 0, brightness: 0, purity: -1, fgBg: 0.3, fgBgPressure: true, perTip: true });
  });

  it('ships a preset that uses it', () => {
    expect(colorDynamicsActive(getPresetById('confetti')!.descriptor.color)).toBe(true);
  });
});

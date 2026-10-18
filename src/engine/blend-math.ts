import type { BrushBlendMode } from './types.js';

/**
 * Photoshop-style blend modes on straight (not premultiplied) RGB, after the
 * W3C Compositing and Blending spec's formulas. Canvas blend modes can't be
 * used where a layer's alpha is locked: they weigh the stroke's own colour
 * into semi-transparent pixels, which then no longer keep their colour (white
 * Multiply over half-transparent black would turn it grey).
 */

type Rgb = [number, number, number];

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);

/** Scratch for the non-separable modes, so a pixel allocates nothing. */
const tmp = new Float64Array(3);

/** `(r, g, b)` moved to luminosity `l` and clipped into 0..1 (the spec's SetLum), into `out`. */
function setLum(r: number, g: number, b: number, l: number, out: Float64Array) {
  const d = l - lum(r, g, b);
  r += d; g += d; b += d;
  const lu = lum(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0) {
    const k = lu / (lu - n);
    r = lu + (r - lu) * k; g = lu + (g - lu) * k; b = lu + (b - lu) * k;
  }
  if (x > 1) {
    const k = (1 - lu) / (x - lu);
    r = lu + (r - lu) * k; g = lu + (g - lu) * k; b = lu + (b - lu) * k;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

/** `(r, g, b)` scaled to saturation `s` (the spec's SetSat: the least channel to 0, the most to `s`), into `out`. */
function setSat(r: number, g: number, b: number, s: number, out: Float64Array) {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  if (max > min) {
    const k = s / (max - min);
    out[0] = (r - min) * k; out[1] = (g - min) * k; out[2] = (b - min) * k;
  } else {
    out[0] = 0; out[1] = 0; out[2] = 0;
  }
}

/** One channel of a separable mode, backdrop `b` and source `s` in 0..1. */
function separable(mode: BrushBlendMode, b: number, s: number): number {
  switch (mode) {
    case 'multiply': return b * s;
    case 'screen': return b + s - b * s;
    case 'overlay': return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'darken': return Math.min(b, s);
    case 'lighten': return Math.max(b, s);
    case 'color-dodge': return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'color-burn': return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    default: return s;
  }
}

/** The colour `mode` makes of source (sr, sg, sb) over backdrop (br, bg, bb), straight RGB in 0..1, into `out`. Allocates nothing. */
function blendInto(mode: BrushBlendMode, br: number, bg: number, bb: number, sr: number, sg: number, sb: number, out: Float64Array) {
  switch (mode) {
    case 'hue':
      setSat(sr, sg, sb, sat(br, bg, bb), tmp);
      setLum(tmp[0], tmp[1], tmp[2], lum(br, bg, bb), out);
      return;
    case 'saturation':
      setSat(br, bg, bb, sat(sr, sg, sb), tmp);
      setLum(tmp[0], tmp[1], tmp[2], lum(br, bg, bb), out);
      return;
    case 'color':
      setLum(sr, sg, sb, lum(br, bg, bb), out);
      return;
    case 'luminosity':
      setLum(br, bg, bb, lum(sr, sg, sb), out);
      return;
    default:
      out[0] = separable(mode, br, sr);
      out[1] = separable(mode, bg, sg);
      out[2] = separable(mode, bb, sb);
  }
}

/** The colour `mode` makes of source `s` over backdrop `b` (both straight RGB, 0..1). */
export function blendColor(mode: BrushBlendMode, b: Rgb, s: Rgb): Rgb {
  const out = new Float64Array(3);
  blendInto(mode, b[0], b[1], b[2], s[0], s[1], s[2], out);
  return [out[0], out[1], out[2]];
}

/**
 * Blend a stroke into a region of an alpha-locked layer, in place: each
 * pixel's colour becomes the stroke's blend over it, weighted by the stroke's
 * coverage (its alpha times `opacity`), and its alpha is left exactly as it
 * was. Pixels with no coverage or no alpha are not touched. Both images are
 * straight RGBA of the same size.
 */
export function blendKeepingAlpha(dst: ImageData, src: ImageData, opacity: number, mode: BrushBlendMode) {
  const d = dst.data;
  const s = src.data;
  const out = new Float64Array(3);
  for (let i = 0; i < d.length; i += 4) {
    const cover = (s[i + 3] / 255) * opacity;
    if (cover <= 0 || d[i + 3] === 0) continue;
    const br = d[i] / 255, bg = d[i + 1] / 255, bb = d[i + 2] / 255;
    blendInto(mode, br, bg, bb, s[i] / 255, s[i + 1] / 255, s[i + 2] / 255, out);
    d[i] = Math.round(255 * (cover * out[0] + (1 - cover) * br));
    d[i + 1] = Math.round(255 * (cover * out[1] + (1 - cover) * bg));
    d[i + 2] = Math.round(255 * (cover * out[2] + (1 - cover) * bb));
  }
}

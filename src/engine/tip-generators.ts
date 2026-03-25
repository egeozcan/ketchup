import { createOffscreenCanvas, get2dContext, type AnyCanvas } from './canvas-pool.js';
import type { TipDescriptor, TipShape } from './types.js';

export type TipGeneratorFn = (
  diameter: number,
  hardness: number,
  tip: TipDescriptor,
) => AnyCanvas;

export function generateRoundTip(diameter: number, hardness: number, _tip: TipDescriptor): AnyCanvas {
  const size = Math.max(1, diameter);
  const canvas = createOffscreenCanvas(size, size);
  const ctx = get2dContext(canvas);
  const r = size / 2;

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const grad = ctx.createRadialGradient(r, r, r * hardness, r, r, r);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  }

  return canvas;
}

export function generateFlatTip(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.ceil(diameter / Math.max(1, tip.aspect)));
  const canvas = createOffscreenCanvas(w, h);
  const ctx = get2dContext(canvas);

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);

    const falloff = Math.max(1, (1 - hardness) * Math.min(w, h) * 0.5);
    ctx.globalCompositeOperation = 'destination-in';

    const hGrad = ctx.createLinearGradient(0, 0, w, 0);
    hGrad.addColorStop(0, 'rgba(255,255,255,0)');
    hGrad.addColorStop(Math.min(0.5, falloff / w), 'rgba(255,255,255,1)');
    hGrad.addColorStop(Math.max(0.5, 1 - falloff / w), 'rgba(255,255,255,1)');
    hGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hGrad;
    ctx.fillRect(0, 0, w, h);

    const vGrad = ctx.createLinearGradient(0, 0, 0, h);
    vGrad.addColorStop(0, 'rgba(255,255,255,0)');
    vGrad.addColorStop(Math.min(0.5, falloff / h), 'rgba(255,255,255,1)');
    vGrad.addColorStop(Math.max(0.5, 1 - falloff / h), 'rgba(255,255,255,1)');
    vGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = vGrad;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'source-over';
  }

  return canvas;
}

export function generateChiselTip(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.ceil(diameter / Math.max(1, tip.aspect)));
  const canvas = createOffscreenCanvas(w, h);
  const ctx = get2dContext(canvas);

  const shear = h / 3;
  ctx.beginPath();
  ctx.moveTo(shear, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w - shear, h);
  ctx.lineTo(0, h);
  ctx.closePath();

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.fill();
  } else {
    ctx.fillStyle = '#fff';
    ctx.fill();

    const cx = w / 2, cy = h / 2;
    const maxR = Math.sqrt(cx * cx + cy * cy);
    ctx.globalCompositeOperation = 'destination-in';
    const grad = ctx.createRadialGradient(cx, cy, maxR * hardness, cx, cy, maxR);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  return canvas;
}

export function generateCalligraphyTip(diameter: number, hardness: number, tip: TipDescriptor): AnyCanvas {
  const rx = Math.max(1, diameter / 2);
  const ry = Math.max(1, (diameter / Math.max(1, tip.aspect)) / 2);
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.ceil(ry * 2));
  const canvas = createOffscreenCanvas(w, h);
  const ctx = get2dContext(canvas);
  const cx = w / 2, cy = h / 2;

  if (hardness >= 1) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, rx * hardness, 0, 0, rx);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return canvas;
}

/** Seeded PRNG (mulberry32) for deterministic scatter */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFanTip(diameter: number, hardness: number, tip: TipDescriptor, variantIndex = 0): AnyCanvas {
  const bristleCount = tip.bristles ?? 8;
  const spreadDeg = tip.spread ?? 120;
  const spreadRad = (spreadDeg * Math.PI) / 180;
  const radius = diameter / 2;
  const bristleR = Math.max(1, diameter / 8);
  const canvas = createOffscreenCanvas(diameter, diameter);
  const ctx = get2dContext(canvas);
  const cx = diameter / 2, cy = diameter / 2;
  const startAngle = -Math.PI / 2 - spreadRad / 2;
  const rng = seededRandom(42 + variantIndex * 7);

  for (let i = 0; i < bristleCount; i++) {
    const t = bristleCount > 1 ? i / (bristleCount - 1) : 0.5;
    const a = startAngle + spreadRad * t;
    const jitterR = radius * 0.08 * (rng() - 0.5);
    const jitterA = 0.05 * (rng() - 0.5);
    const bx = cx + Math.cos(a + jitterA) * (radius - bristleR + jitterR);
    const by = cy + Math.sin(a + jitterA) * (radius - bristleR + jitterR);

    if (hardness >= 1) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bx, by, bristleR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(bx, by, bristleR * hardness, bx, by, bristleR);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, bristleR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
}

export function generateSplatterTip(diameter: number, hardness: number, tip: TipDescriptor, variantIndex = 0): AnyCanvas {
  const dotCount = tip.bristles ?? 12;
  const spreadRatio = tip.spread ?? 0.8;
  const maxRadius = (diameter / 2) * spreadRatio;
  const dotR = Math.max(1, diameter / 10);
  const canvas = createOffscreenCanvas(diameter, diameter);
  const ctx = get2dContext(canvas);
  const cx = diameter / 2, cy = diameter / 2;
  const rng = seededRandom(137 + variantIndex * 13);

  for (let i = 0; i < dotCount; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = rng() * maxRadius;
    const bx = cx + Math.cos(angle) * dist;
    const by = cy + Math.sin(angle) * dist;
    const r = dotR * (0.5 + rng() * 0.5);

    if (hardness >= 1) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(bx, by, r * hardness, bx, by, r);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
}

export const tipGenerators: Record<TipShape, TipGeneratorFn> = {
  round: generateRoundTip,
  flat: generateFlatTip,
  chisel: generateChiselTip,
  calligraphy: generateCalligraphyTip,
  fan: generateFanTip,
  splatter: generateSplatterTip,
};

/** Number of cached variants per shape (for visual variety) */
export const TIP_VARIANT_COUNTS: Partial<Record<TipShape, number>> = {
  fan: 4,
  splatter: 6,
};

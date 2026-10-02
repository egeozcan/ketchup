import { describe, expect, it } from 'vitest';
import { warpPerspective } from '../src/transform/transform-math.ts';
import type { Point } from '../src/types.ts';

type Quad = [Point, Point, Point, Point];

function solid(w: number, h: number, rgba: [number, number, number, number]): ImageData {
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(rgba, i * 4);
  return img;
}

function pixel(img: ImageData, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.slice(i, i + 4));
}

/** Pixels whose centre lies at least `margin` inside every edge of a convex quad. */
function interior(q: Quad, w: number, h: number, margin: number): [number, number][] {
  const pts: [number, number][] = [];
  const area = q.reduce((s, p, i) => s + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = q.every((p, i) => {
        const n = q[(i + 1) % 4];
        const cross = (n.x - p.x) * (y + 0.5 - p.y) - (n.y - p.y) * (x + 0.5 - p.x);
        return Math.sign(area) * cross / Math.hypot(n.x - p.x, n.y - p.y) >= margin;
      });
      if (inside) pts.push([x, y]);
    }
  }
  return pts;
}

describe('warpPerspective', () => {
  const perspective: Quad = [{ x: 3.3, y: 5.7 }, { x: 70.1, y: 1.2 }, { x: 62.6, y: 68.4 }, { x: 8.2, y: 59.9 }];
  const region = { x: 0, y: 0, w: 72, h: 70 };

  it('copies the source exactly onto a same-size rectangle', () => {
    const src = new ImageData(8, 6);
    for (let i = 0; i < src.data.length; i++) src.data[i] = (i * 37) % 256;
    for (let i = 3; i < src.data.length; i += 4) src.data[i] = 255;
    const out = warpPerspective(src, [{ x: 4, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 8 }, { x: 4, y: 8 }], {
      x: 4, y: 2, w: 8, h: 6,
    });
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('leaves no seams inside a warped opaque image', () => {
    const out = warpPerspective(solid(40, 40, [200, 100, 50, 255]), perspective, region);
    const pts = interior(perspective, region.w, region.h, 0.75);
    expect(pts.length).toBeGreaterThan(2500);
    for (const [x, y] of pts) expect(pixel(out, x, y)).toEqual([200, 100, 50, 255]);
  });

  it('keeps a semi-transparent image at its own alpha throughout', () => {
    const out = warpPerspective(solid(40, 40, [200, 100, 50, 128]), perspective, region);
    for (const [x, y] of interior(perspective, region.w, region.h, 0.75)) {
      expect(pixel(out, x, y)).toEqual([200, 100, 50, 128]);
    }
  });

  it('keeps enlarged edges crisp instead of fading them into transparency', () => {
    const out = warpPerspective(solid(2, 2, [10, 20, 30, 255]), [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ], { x: 0, y: 0, w: 20, h: 20 });
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) expect(pixel(out, x, y)[3]).toBe(255);
    }
  });

  it('anti-aliases the outline by coverage', () => {
    const out = warpPerspective(solid(4, 4, [0, 0, 255, 255]), [
      { x: 0, y: 0 }, { x: 10.5, y: 0 }, { x: 10.5, y: 10 }, { x: 0, y: 10 },
    ], { x: 0, y: 0, w: 12, h: 10 });
    expect(pixel(out, 9, 5)[3]).toBe(255);
    expect(pixel(out, 10, 5)[3]).toBeCloseTo(128, -1);
    expect(pixel(out, 11, 5)[3]).toBe(0);
  });

  it('does not darken colour next to transparent texels', () => {
    const src = new ImageData(2, 1);
    src.data.set([255, 0, 0, 255, 0, 0, 0, 0]);
    const out = warpPerspective(src, [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 2 }, { x: 0, y: 2 }], {
      x: 0, y: 0, w: 20, h: 2,
    });
    for (let x = 0; x < 20; x++) {
      const [r, g, b, a] = pixel(out, x, 1);
      if (a > 0) expect([r, g, b]).toEqual([255, 0, 0]);
    }
    expect(pixel(out, 10, 1)[3]).toBeGreaterThan(100);
    expect(pixel(out, 10, 1)[3]).toBeLessThan(155);
  });

  it('renders any region exactly as the same part of the whole warp', () => {
    const src = new ImageData(16, 16);
    for (let i = 0; i < src.data.length; i++) src.data[i] = (i * 53) % 256;
    const whole = warpPerspective(src, perspective, region);
    const part = warpPerspective(src, perspective, { x: 30, y: 20, w: 25, h: 40 });
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 25; x++) expect(pixel(part, x, y)).toEqual(pixel(whole, x + 30, y + 20));
    }
  });

  it('handles concave and folded quads without throwing', () => {
    const src = solid(10, 10, [1, 2, 3, 255]);
    const concave: Quad = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 15, y: 15 }, { x: 0, y: 40 }];
    const folded: Quad = [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 40, y: 0 }, { x: 0, y: 30 }];
    for (const q of [concave, folded]) {
      const out = warpPerspective(src, q, { x: 0, y: 0, w: 40, h: 40 });
      expect(out.data.some(v => v > 0)).toBe(true);
    }
    // Deep inside the concave quad's arms.
    const out = warpPerspective(src, concave, { x: 0, y: 0, w: 40, h: 40 });
    expect(pixel(out, 3, 3)).toEqual([1, 2, 3, 255]);
  });
});

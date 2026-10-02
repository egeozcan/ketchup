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

  it('maps each part of the source to its own corner, mirrored when the quad is', () => {
    // Quadrants: red top-left, green top-right, blue bottom-right, white bottom-left.
    const src = new ImageData(20, 20);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const c = y < 10 ? (x < 10 ? [255, 0, 0] : [0, 255, 0]) : (x < 10 ? [255, 255, 255] : [0, 0, 255]);
        src.data.set([...c, 255], (y * 20 + x) * 4);
      }
    }
    const trapezoid: Quad = [{ x: 20, y: 5 }, { x: 60, y: 5 }, { x: 75, y: 60 }, { x: 5, y: 60 }];
    const out = warpPerspective(src, trapezoid, { x: 0, y: 0, w: 80, h: 65 });
    expect(pixel(out, 24, 9)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 55, 9)).toEqual([0, 255, 0, 255]);
    expect(pixel(out, 68, 55)).toEqual([0, 0, 255, 255]);
    expect(pixel(out, 12, 55)).toEqual([255, 255, 255, 255]);

    const mirrored: Quad = [trapezoid[1], trapezoid[0], trapezoid[3], trapezoid[2]];
    const flipped = warpPerspective(src, mirrored, { x: 0, y: 0, w: 80, h: 65 });
    expect(pixel(flipped, 24, 9)).toEqual([0, 255, 0, 255]);
    expect(pixel(flipped, 68, 55)).toEqual([255, 255, 255, 255]);
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

  it('covers each pixel by the area of it inside the outline, sharp and collapsed corners included', () => {
    const quads: Quad[] = [
      // A corner of about 10°, a needle thinner than a quarter pixel at its tip,
      // a kite, a concave quad and a bow-tie.
      [{ x: 2.3, y: 20.1 }, { x: 60.2, y: 16 }, { x: 60.4, y: 24.1 }, { x: 2.6, y: 20.4 }],
      [{ x: 1.2, y: 10.1 }, { x: 50.7, y: 9.3 }, { x: 50.9, y: 11.6 }, { x: 1.4, y: 10.2 }],
      [{ x: 30.5, y: 1.1 }, { x: 34.2, y: 30.3 }, { x: 30.7, y: 58.6 }, { x: 26.9, y: 30.1 }],
      [{ x: 1, y: 1 }, { x: 60, y: 3 }, { x: 10, y: 6 }, { x: 3, y: 50 }],
      [{ x: 2.5, y: 2.2 }, { x: 50.3, y: 40.7 }, { x: 50.1, y: 2.9 }, { x: 2.2, y: 40.1 }],
      // Two corners dragged together: triangles, including tips a whole
      // source edge maps onto.
      [{ x: 2.2, y: 2.7 }, { x: 60.4, y: 5.1 }, { x: 30.3, y: 50.6 }, { x: 30.3, y: 50.6 }],
      [{ x: 2.2, y: 2.7 }, { x: 60.4, y: 5.1 }, { x: 60.4, y: 5.1 }, { x: 10.3, y: 50.6 }],
      [{ x: 10.6, y: 10.6 }, { x: 40, y: 20 }, { x: 20, y: 40 }, { x: 10.6, y: 10.6 }],
      [{ x: 40, y: 20 }, { x: 10.6, y: 10.6 }, { x: 10.6, y: 10.6 }, { x: 20, y: 40 }],
      // Symmetric bow-ties crossing on a pixel centre.
      [{ x: 9, y: 6 }, { x: 8, y: 7 }, { x: 7, y: 6 }, { x: 6, y: 7 }],
      [{ x: 47, y: 24.5 }, { x: 36, y: 36.5 }, { x: 25, y: 24.5 }, { x: 14, y: 36.5 }],
    ];
    const src = solid(8, 8, [255, 255, 255, 255]);
    for (const q of quads) {
      const out = warpPerspective(src, q, { x: 0, y: 0, w: 64, h: 64 });
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const alpha = pixel(out, x, y)[3] / 255;
          const at = `(${x}, ${y}) of ${JSON.stringify(q)}`;
          // A pixel whose centre is more than √½ from the outline is wholly in or out.
          const d = signedOutlineDistance(q, x + 0.5, y + 0.5);
          if (d >= 0.75) expect(alpha, at).toBe(1);
          else if (d <= -0.75) expect(alpha, at).toBe(0);
          else expect(alpha, at).toBeCloseTo(supersampledCoverage(q, x, y), 1.5);
        }
      }
    }
  });

  it('fills a concave quad up to its outline, without seams and nothing past it', () => {
    // The bilinear map folds past a concave quad's outline; the result must
    // still be exactly the outline, anti-aliased, as the handles show it, and
    // its edge pixels must continue what is inside rather than show the fold.
    const src = new ImageData(256, 256);
    for (let i = 0; i < 256 * 256; i++) src.data.set([i % 256, i >> 8, 128, 255], i * 4);
    const quads: Quad[] = [
      [{ x: 0.5, y: 0.5 }, { x: 120.5, y: 0.5 }, { x: 20.5, y: 20.5 }, { x: 0.5, y: 120.5 }],
      [{ x: 2, y: 2 }, { x: 300, y: 100 }, { x: 2, y: 200 }, { x: 100, y: 100 }],
      [{ x: 1, y: 1 }, { x: 400, y: 1 }, { x: 60, y: 60 }, { x: 1, y: 400 }],
    ];
    for (const q of quads) {
      const w = Math.ceil(Math.max(...q.map(p => p.x))) + 2, h = Math.ceil(Math.max(...q.map(p => p.y))) + 2;
      const out = warpPerspective(src, q, { x: 0, y: 0, w, h });
      let inside = 0, outside = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = signedOutlineDistance(q, x + 0.5, y + 0.5);
          const alpha = pixel(out, x, y)[3];
          if (d >= 0.75) {
            inside++;
            expect(alpha, `inside (${x}, ${y})`).toBe(255);
          } else if (d <= -0.75) {
            outside++;
            expect(alpha, `outside (${x}, ${y})`).toBe(0);
          } else if (d <= 0 && alpha > 0) {
            // Close in colour to a neighbour inside: adjacent pixels inside
            // differ by up to 13 levels on this gradient, the fold by over 100.
            let nearest = Infinity;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              if (x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h) continue;
              if (signedOutlineDistance(q, x + dx + 0.5, y + dy + 0.5) <= 0) continue;
              const [r, g] = pixel(out, x, y), [nr, ng] = pixel(out, x + dx, y + dy);
              nearest = Math.min(nearest, Math.max(Math.abs(r - nr), Math.abs(g - ng)));
            }
            if (nearest < Infinity) expect(nearest, `edge (${x}, ${y})`).toBeLessThanOrEqual(20);
          }
        }
      }
      expect(inside).toBeGreaterThan(500);
      expect(outside).toBeGreaterThan(500);
    }
  });
});

/** How much of pixel (x, y) the quad covers by nonzero winding, from 64 × 64 samples. */
function supersampledCoverage(q: Quad, x: number, y: number): number {
  let inside = 0;
  for (let j = 0; j < 64; j++) {
    for (let i = 0; i < 64; i++) {
      if (signedOutlineDistance(q, x + (i + 0.5) / 64, y + (j + 0.5) / 64) > 0) inside++;
    }
  }
  return inside / 4096;
}

/** Distance from (x, y) to the quad's outline: positive inside (nonzero winding), negative outside. */
function signedOutlineDistance(q: Quad, x: number, y: number): number {
  let winding = 0, dist = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    const cross = (n.x - p.x) * (y - p.y) - (x - p.x) * (n.y - p.y);
    if (p.y <= y && n.y > y && cross > 0) winding++;
    else if (p.y > y && n.y <= y && cross < 0) winding--;
    const ex = n.x - p.x, ey = n.y - p.y;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x) * ex + (y - p.y) * ey) / len2)) : 0;
    dist = Math.min(dist, Math.hypot(x - p.x - ex * t, y - p.y - ey * t));
  }
  return winding !== 0 ? dist : -dist;
}

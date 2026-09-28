import { describe, expect, it } from 'vitest';
import { cropImageData, diffBounds, hashImageData } from '../src/utils/image-diff.ts';

function setPixel(img: ImageData, x: number, y: number, rgba: [number, number, number, number]) {
  img.data.set(rgba, (y * img.width + x) * 4);
}

describe('image diff utilities', () => {
  it('returns null for identical images', () => {
    expect(diffBounds(new ImageData(8, 6), new ImageData(8, 6))).toBeNull();
  });

  it('finds the tight rectangle around every changed pixel', () => {
    const a = new ImageData(10, 8);
    const b = new ImageData(10, 8);
    setPixel(b, 6, 1, [0, 0, 0, 1]);
    setPixel(b, 2, 3, [255, 0, 0, 255]);
    setPixel(b, 4, 6, [0, 9, 0, 0]);

    expect(diffBounds(a, b)).toEqual({ x: 2, y: 1, w: 5, h: 6 });
  });

  it('detects a change in any single channel', () => {
    for (let channel = 0; channel < 4; channel++) {
      const a = new ImageData(3, 3);
      const b = new ImageData(3, 3);
      b.data[(1 * 3 + 2) * 4 + channel] = 1;
      expect(diffBounds(a, b)).toEqual({ x: 2, y: 1, w: 1, h: 1 });
    }
  });

  it('crops a sub-rectangle row by row', () => {
    const src = new ImageData(4, 3);
    for (let i = 0; i < src.data.length; i++) src.data[i] = i;
    const out = cropImageData(src, { x: 1, y: 1, w: 2, h: 2 });

    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(Array.from(out.data)).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27,
      36, 37, 38, 39, 40, 41, 42, 43,
    ]);
    expect(cropImageData(src, { x: 0, y: 0, w: 4, h: 3 })).toBe(src);
  });

  it('hashes equal pixels equally and changed pixels differently', () => {
    const a = new ImageData(16, 16);
    const b = new ImageData(16, 16);
    expect(hashImageData(a)).toBe(hashImageData(b));

    b.data[(5 * 16 + 7) * 4 + 3] = 1;
    expect(hashImageData(b)).not.toBe(hashImageData(a));
    expect(hashImageData(new ImageData(16, 8))).not.toBe(hashImageData(new ImageData(8, 16)));
  });

  it('distinguishes alpha-only edits to several pixels', () => {
    const base = new ImageData(64, 64);
    const seen = new Set([hashImageData(base)]);
    for (let i = 0; i < 200; i++) {
      const img = new ImageData(64, 64);
      img.data[(i % 4096) * 4 + 3] = (i % 255) + 1;
      img.data[((i * 37 + 11) % 4096) * 4 + 3] = ((i * 7) % 255) + 1;
      seen.add(hashImageData(img));
    }
    expect(seen.size).toBe(201);
  });
});

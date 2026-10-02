import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransformManager } from '../src/transform/transform-manager.ts';
import { makeCanvas } from './helpers.ts';

// jsdom has no WebGL2; stand in for a GPU that can or can't warp.
const gpu = vi.hoisted(() => ({ available: true, succeeds: true }));
vi.mock('../src/transform/perspective-gl.ts', () => ({
  canWarpOnGpu: vi.fn(() => gpu.available),
  warpPerspectiveGpu: vi.fn(() => gpu.available && gpu.succeeds),
  releaseGpuSource: vi.fn(),
}));
const gl = await import('../src/transform/perspective-gl.ts');

function makeLargeManager() {
  const tm = new TransformManager(
    new ImageData(1500, 1500), { x: 0, y: 0, w: 1500, h: 1500 }, makeCanvas(100, 100), 1, { x: 0, y: 0 },
  );
  (tm as any)._perspectiveActive = true;
  (tm as any)._perspectiveCorners.se = { x: 30, y: 20 };
  (tm as any)._interaction = { type: 'perspective', corner: 'se', startPoint: { x: 1500, y: 1500 }, startOffset: { x: 0, y: 0 } };
  return tm;
}

describe('perspective warps on the GPU', () => {
  beforeEach(() => {
    gpu.available = true;
    gpu.succeeds = true;
  });

  it('warps a dragged handle at full resolution up to 2048², with no draft', () => {
    const tm = makeLargeManager();
    tm.renderTransformed(makeCanvas(100, 100).getContext('2d')!);
    expect(gl.warpPerspectiveGpu).toHaveBeenCalled();
    expect((tm as any)._warpCache.scale).toBe(1);
    expect((tm as any)._draftWarpCache).toBeNull();
  });

  it('drafts a dragged handle past 2048²', () => {
    const tm = makeLargeManager();
    (tm as any)._perspectiveCorners.se = { x: 1500, y: 1000 };
    tm.renderTransformed(makeCanvas(100, 100).getContext('2d')!);
    const draft = (tm as any)._draftWarpCache;
    expect(draft.scale).toBeLessThan(1);
    expect(draft.canvas.width * draft.canvas.height).toBeLessThanOrEqual(2048 * 2048);
  });

  it('drafts a dragged handle when only the CPU can warp', () => {
    gpu.available = false;
    const tm = makeLargeManager();
    tm.renderTransformed(makeCanvas(100, 100).getContext('2d')!);
    expect((tm as any)._draftWarpCache.scale).toBeLessThan(1);
  });

  it('warps on the CPU when the GPU fails', () => {
    gpu.succeeds = false;
    const tm = makeLargeManager();
    tm.onPointerUp({ x: 0, y: 0 });
    const ctx = makeCanvas(100, 100).getContext('2d')!;
    tm.renderTransformed(ctx);
    const warp = (tm as any)._warpCache;
    expect(vi.mocked(warp.canvas.getContext('2d').putImageData)).toHaveBeenCalled();
  });

  it('frees the GPU copy of the source when disposed', () => {
    const tm = makeLargeManager();
    tm.dispose();
    expect(gl.releaseGpuSource).toHaveBeenCalledWith((tm as any)._sourceImageData);
  });
});

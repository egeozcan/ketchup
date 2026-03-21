import { describe, expect, it } from 'vitest';
import { drawShapePreview } from '../src/tools/shapes.ts';
import type { Point } from '../src/types.ts';

/**
 * Bug: drawShapePreview for 'triangle' does NOT normalize coordinates
 * the way 'rectangle' and 'circle' do, causing the triangle orientation
 * to depend on drag direction.
 *
 * Root cause: src/tools/shapes.ts, the 'triangle' case (lines 55-65)
 *
 *   case 'triangle': {
 *     const midX = (start.x + end.x) / 2;
 *     ctx.moveTo(midX, start.y);   // apex uses start.y
 *     ctx.lineTo(end.x, end.y);    // base uses end.y
 *     ctx.lineTo(start.x, end.y);
 *     ctx.closePath();
 *   }
 *
 * When the user drags downward (start.y < end.y), the apex is at the
 * top and the base is at the bottom → triangle points UP.
 *
 * When the user drags upward (start.y > end.y), the apex is at the
 * bottom and the base is at the top → triangle points DOWN.
 *
 * By contrast, 'rectangle' normalizes with Math.min / Math.abs so the
 * shape is identical regardless of drag direction.  'circle' computes
 * the center as the midpoint and uses Math.abs for radii, also direction-
 * independent.
 *
 * The triangle should normalize its bounding box (using Math.min for
 * the top-left corner and Math.abs for dimensions), then place the
 * apex at the top of the normalized rect and the base at the bottom:
 *
 *   const x = Math.min(start.x, end.x);
 *   const y = Math.min(start.y, end.y);
 *   const w = Math.abs(end.x - start.x);
 *   const h = Math.abs(end.y - start.y);
 *   const midX = x + w / 2;
 *   ctx.moveTo(midX, y);          // apex at top
 *   ctx.lineTo(x + w, y + h);    // bottom-right
 *   ctx.lineTo(x, y + h);        // bottom-left
 *
 * Impact: When the user drags upward with the triangle tool, they get
 * an inverted triangle (pointing down), which is inconsistent with the
 * tool icon (pointing up) and with rectangle/circle normalization.
 */
describe('triangle shape normalization bug', () => {
  /**
   * Helper: collect the moveTo/lineTo calls from drawShapePreview.
   * Returns the list of [method, x, y] triples for the triangle path.
   */
  function getTriangleVertices(start: Point, end: Point): { x: number; y: number }[] {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;

    // Spy on moveTo/lineTo to capture coordinates
    const vertices: { x: number; y: number }[] = [];
    const origMoveTo = ctx.moveTo.bind(ctx);
    const origLineTo = ctx.lineTo.bind(ctx);

    ctx.moveTo = (x: number, y: number) => {
      vertices.push({ x, y });
      origMoveTo(x, y);
    };
    ctx.lineTo = (x: number, y: number) => {
      vertices.push({ x, y });
      origLineTo(x, y);
    };

    drawShapePreview(
      ctx,
      'triangle',
      start,
      end,
      '#000000',
      '#ff0000',
      false,
      2,
    );

    return vertices;
  }

  it('should produce the same triangle regardless of vertical drag direction', () => {
    // Drag downward: start=(50,50), end=(150,150)
    const downVertices = getTriangleVertices({ x: 50, y: 50 }, { x: 150, y: 150 });

    // Drag upward: start=(150,150), end=(50,50)
    // (Same bounding box, but drag is in the opposite direction)
    const upVertices = getTriangleVertices({ x: 150, y: 150 }, { x: 50, y: 50 });

    // Both should produce the same set of vertices because the bounding
    // box is the same — just like rectangle and circle normalize.
    //
    // Expected (normalized):
    //   apex:  (100, 50)   — top of bounding box
    //   br:    (150, 150)  — bottom-right
    //   bl:    (50, 150)   — bottom-left
    //
    // Actual with downward drag:
    //   moveTo(100, 50), lineTo(150, 150), lineTo(50, 150)  — correct
    //
    // Actual with upward drag (BUG):
    //   moveTo(100, 150), lineTo(50, 50), lineTo(150, 50)   — inverted!
    //   apex is at BOTTOM (150), base is at TOP (50)

    expect(downVertices).toEqual(upVertices);
  });

  it('rectangle normalizes regardless of drag direction', () => {
    // Verify rectangle normalization as a control case
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const origRect = ctx.rect.bind(ctx);
    ctx.rect = (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h });
      origRect(x, y, w, h);
    };

    // Drag downward
    drawShapePreview(ctx, 'rectangle', { x: 50, y: 50 }, { x: 150, y: 150 }, '#000', '#f00', false, 2);
    const rectDown = rects[0];

    rects.length = 0;

    // Drag upward (same bounding box)
    drawShapePreview(ctx, 'rectangle', { x: 150, y: 150 }, { x: 50, y: 50 }, '#000', '#f00', false, 2);
    const rectUp = rects[0];

    // Rectangle normalizes: both produce the same rect
    expect(rectDown).toEqual(rectUp);
  });
});

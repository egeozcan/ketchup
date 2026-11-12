import { describe, expect, it, vi } from 'vitest';
import { DrawingCanvas } from '../src/components/drawing-canvas.ts';
import { attachCanvasElements, makeLayer, makeState } from './helpers.ts';

function setupCanvas(layerOverrides: Record<string, unknown>[] = [{}, {}, {}, {}, {}], active = 2) {
  const canvas = new DrawingCanvas();
  const layers = layerOverrides.map((o, i) => ({ ...makeLayer(100, 100, { id: `l${i}` }), ...o }));
  const state = makeState({ layers, activeLayerId: layers[active].id });
  (canvas as any)._ctx = { value: { state } };
  attachCanvasElements(canvas, 100, 100);
  (canvas as any).requestUpdate = vi.fn();
  const display = (canvas as any).mainCanvas.getContext('2d') as CanvasRenderingContext2D;
  const draw = vi.spyOn(display, 'drawImage');
  /** The layer canvases drawn straight onto the display by one composite. */
  const drawnLayers = (contentChanged: boolean) => {
    draw.mockClear();
    (canvas as any)._composite(contentChanged);
    return draw.mock.calls.map(c => layers.findIndex(l => l.canvas === c[0]));
  };
  return { canvas, layers, state, draw, drawnLayers };
}

describe('layers around the active one are drawn from flattened copies', () => {
  it('draws two flattened groups and the active layer, whether or not content changed', () => {
    const { drawnLayers } = setupCanvas();
    // -1: a canvas that is no layer's, i.e. a flattened group.
    expect(drawnLayers(true)).toEqual([-1, 2, -1]);
    expect(drawnLayers(false)).toEqual([-1, 2, -1]);
  });

  it('flattens each group once and reuses it while only the active layer changes', () => {
    const { canvas, layers, drawnLayers } = setupCanvas();
    const flatten = vi.spyOn(canvas as any, '_flattenLayers');
    drawnLayers(false);
    drawnLayers(true);
    // A history entry for the active layer: it is drawn live, so nothing is rebuilt.
    (canvas as any)._layerRevisions.set(layers[2].id, 7);
    drawnLayers(true);
    expect(flatten).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when another layer was made active or the layers were replaced', () => {
    const { canvas, layers, state, drawnLayers } = setupCanvas();
    const flatten = vi.spyOn(canvas as any, '_flattenLayers');
    drawnLayers(false);
    state.activeLayerId = layers[3].id;
    expect(drawnLayers(false)).toEqual([-1, 3, 4]);
    expect(flatten).toHaveBeenCalledTimes(4);
    state.layers = [...layers];
    drawnLayers(false);
    expect(flatten).toHaveBeenCalledTimes(6);
  });

  it('rebuilds when a layer other than the active one has a new revision', () => {
    const { canvas, layers, drawnLayers } = setupCanvas();
    const flatten = vi.spyOn(canvas as any, '_flattenLayers');
    drawnLayers(false);
    (canvas as any)._layerRevisions.set(layers[0].id, 7);
    drawnLayers(false);
    expect(flatten).toHaveBeenCalledTimes(4);
    // As it does when every layer's does (a structural change, a document opened).
    (canvas as any)._revisionEpoch++;
    drawnLayers(true);
    expect(flatten).toHaveBeenCalledTimes(6);
  });

  it('draws a group layer by layer when it holds a blend mode or a single visible layer', () => {
    const blended = setupCanvas([{}, { blendMode: 'multiply' }, {}, {}, {}]);
    expect(blended.drawnLayers(false)).toEqual([0, 1, 2, -1]);
    const sparse = setupCanvas([{}, { visible: false }, {}, {}, { visible: false }]);
    expect(sparse.drawnLayers(false)).toEqual([0, 2, 3]);
  });

  it('flattens only visible layers, each at its opacity', () => {
    const { canvas, layers } = setupCanvas([{ opacity: 0.5 }, { visible: false }, { opacity: 0.25 }, {}, {}], 3);
    (canvas as any)._composite(false);
    const below = (canvas as any)._layerStackBelow as HTMLCanvasElement;
    expect(below.width).toBe(100);
    const events = (below.getContext('2d') as any).__getDrawCalls?.() ?? [];
    const drawn = events.filter((e: any) => e.type === 'drawImage');
    if (drawn.length) {
      expect(drawn.map((e: any) => e.props.img)).toEqual([layers[0].canvas, layers[2].canvas]);
    }
    expect((canvas as any)._layerStackAbove).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { LayersPanel } from '../src/components/layers-panel.ts';

describe('LayersPanel thumbnails', () => {
  it('applies layer opacity to thumbnails of hidden layers', () => {
    const panel = new LayersPanel();

    const hiddenLayer = {
      id: 'l1',
      name: 'Hidden',
      visible: false,
      opacity: 0.3,
      canvas: document.createElement('canvas'),
    };

    (panel as any)._ctx = {
      value: {
        state: {
          layers: [hiddenLayer],
          activeLayerId: 'l1',
          layersPanelOpen: true,
        },
      },
    };

    // Track globalAlpha at the moment drawImage is called on the thumbnail
    const alphasAtDraw: number[] = [];
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 48;
    thumbCanvas.height = 36;
    const thumbCtx = thumbCanvas.getContext('2d')!;
    const origDrawImage = thumbCtx.drawImage;
    thumbCtx.drawImage = vi.fn(function (this: CanvasRenderingContext2D) {
      alphasAtDraw.push(this.globalAlpha);
    }).bind(thumbCtx) as typeof thumbCtx.drawImage;

    // Stub shadowRoot.querySelectorAll to return our spy thumbnail
    Object.defineProperty(panel, 'shadowRoot', {
      value: { querySelectorAll: () => [thumbCanvas] },
    });

    (panel as any)._updateThumbnails();

    // drawImage should have been called at least once (for the layer content)
    expect(alphasAtDraw.length).toBeGreaterThan(0);
    // The last drawImage call renders the layer content — it must use the layer's opacity
    expect(alphasAtDraw[alphasAtDraw.length - 1]).toBe(0.3);
  });
});

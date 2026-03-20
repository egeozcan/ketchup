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

describe('LayersPanel rename', () => {
  it('does not commit rename when Escape is pressed', () => {
    const panel = new LayersPanel();

    const renameLayerSpy = vi.fn();

    (panel as any)._ctx = {
      value: {
        state: {
          layers: [{ id: 'l1', name: 'Original', visible: true, opacity: 1, canvas: document.createElement('canvas') }],
          activeLayerId: 'l1',
          layersPanelOpen: true,
        },
        renameLayer: renameLayerSpy,
      },
    };

    // Enter rename mode
    (panel as any)._editingLayerId = 'l1';

    // Simulate: user typed a new name, then pressed Escape
    const fakeInput = { value: 'Changed Name' } as HTMLInputElement;
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(escapeEvent, 'target', { value: fakeInput });

    (panel as any)._onRenameKeyDown('l1', escapeEvent);

    // _editingLayerId should be cleared (cancel)
    expect((panel as any)._editingLayerId).toBeNull();

    // Now simulate the blur that fires when Lit removes the input from DOM
    const blurEvent = new FocusEvent('blur');
    Object.defineProperty(blurEvent, 'target', { value: fakeInput });

    (panel as any)._onRenameBlur('l1', blurEvent);

    // The rename must NOT have been committed
    expect(renameLayerSpy).not.toHaveBeenCalled();
  });
});

describe('LayersPanel drop cleanup', () => {
  it('clears drop indicators when pointer-up fires with no dragged layer', () => {
    const panel = new LayersPanel();

    (panel as any)._ctx = {
      value: {
        state: {
          layers: [
            { id: 'l1', name: 'Layer 1', visible: true, opacity: 1, canvas: document.createElement('canvas') },
            { id: 'l2', name: 'Layer 2', visible: true, opacity: 1, canvas: document.createElement('canvas') },
          ],
          activeLayerId: 'l1',
          layersPanelOpen: true,
        },
      },
    };

    // Create a fake row with a lingering indicator
    const row = document.createElement('div');
    row.classList.add('layer-row', 'drop-above');
    row.dataset.layerId = 'l1';

    // Stub shadowRoot.querySelectorAll so _clearDropIndicators finds the row
    Object.defineProperty(panel, 'shadowRoot', {
      configurable: true,
      value: { querySelectorAll: (sel: string) => sel === '.layer-row' ? [row] : [] },
    });

    // No dragged layer — simulates pointer-up without a valid drag
    (panel as any)._draggedLayerId = null;
    (panel as any)._dragPointerId = 1;

    const pointerUpEvent = { pointerId: 1 } as PointerEvent;

    (panel as any)._onReorderPointerUp(pointerUpEvent);

    // _onReorderPointerUp should call _clearDragState which clears indicators
    expect(row.classList.contains('drop-above')).toBe(false);
  });
});

describe('LayersPanel opacity', () => {
  it('commits opacity history when changed via keyboard (no pointerdown)', () => {
    const panel = new LayersPanel();

    const layer = { id: 'l1', name: 'Layer 1', visible: true, opacity: 0.8, canvas: document.createElement('canvas') };

    const setLayerOpacity = vi.fn();
    (panel as any)._ctx = {
      value: {
        state: {
          layers: [layer],
          activeLayerId: 'l1',
          layersPanelOpen: true,
        },
        setLayerOpacity,
      },
    };

    // Track dispatched events
    const committed: CustomEvent[] = [];
    panel.addEventListener('commit-opacity', (e) => committed.push(e as CustomEvent));

    // Keyboard-driven slider change: input fires (value changes), then
    // change fires on blur — but pointerdown never fires.
    // Simulate input event (arrow key press changes value to 50)
    const inputEvent = new Event('input');
    Object.defineProperty(inputEvent, 'target', { value: { value: '50' } });
    (panel as any)._onOpacityInput('l1', inputEvent);

    // Simulate change event (slider loses focus)
    const changeEvent = new Event('change');
    Object.defineProperty(changeEvent, 'target', { value: { value: '50' } });
    (panel as any)._onOpacityChange('l1', changeEvent);

    // A commit-opacity event must be dispatched so the change is undoable.
    // BUG: _opacityBefore is null because pointerdown never fired, so the
    // commit is silently skipped.
    expect(committed.length).toBe(1);
    expect(committed[0].detail.before).toBe(0.8);
    expect(committed[0].detail.after).toBe(0.5);
  });
});

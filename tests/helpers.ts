import { vi } from 'vitest';
import { getDefaultDescriptor } from '../src/engine/brush-presets.ts';
import type { BrushDescriptor } from '../src/engine/types.ts';
import type { DrawingState, Layer } from '../src/types.ts';

export function makeBrush(overrides: Partial<BrushDescriptor> = {}): BrushDescriptor {
  const base = getDefaultDescriptor();
  return {
    ...base,
    ...overrides,
    tip: {
      ...base.tip,
      ...(overrides.tip ?? {}),
    },
    ink: {
      ...base.ink,
      ...(overrides.ink ?? {}),
    },
  };
}

export function makeLayer(
  width = 100,
  height = 100,
  overrides: Partial<Layer> = {},
): Layer {
  const canvas = overrides.canvas ?? document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    id: overrides.id ?? 'l1',
    name: overrides.name ?? 'Layer 1',
    visible: overrides.visible ?? true,
    opacity: overrides.opacity ?? 1,
    blendMode: overrides.blendMode ?? 'normal',
    canvas,
  };
}

export function makeState(
  overrides: Partial<DrawingState> & { brush?: Partial<BrushDescriptor> } = {},
): DrawingState {
  const documentWidth = overrides.documentWidth ?? 100;
  const documentHeight = overrides.documentHeight ?? 100;
  const layers = overrides.layers ?? [makeLayer(documentWidth, documentHeight)];
  const brush = makeBrush(overrides.brush);
  return {
    activeTool: overrides.activeTool ?? 'select',
    strokeColor: overrides.strokeColor ?? '#000000',
    fillColor: overrides.fillColor ?? '#ff0000',
    useFill: overrides.useFill ?? false,
    brush,
    activePreset: overrides.activePreset ?? 'round',
    isPresetModified: overrides.isPresetModified ?? false,
    stampImage: overrides.stampImage ?? null,
    layers,
    activeLayerId: overrides.activeLayerId ?? layers[0]?.id ?? '',
    layersPanelOpen: overrides.layersPanelOpen ?? true,
    documentWidth,
    documentHeight,
    cropAspectRatio: overrides.cropAspectRatio ?? 'free',
    fontFamily: overrides.fontFamily ?? 'sans-serif',
    fontSize: overrides.fontSize ?? 24,
    fontBold: overrides.fontBold ?? false,
    fontItalic: overrides.fontItalic ?? false,
    eyedropperSampleAll: overrides.eyedropperSampleAll ?? true,
  };
}

export function attachCanvasElements(
  canvas: object,
  width = 100,
  height = 100,
): { mainCanvas: HTMLCanvasElement; previewCanvas: HTMLCanvasElement } {
  const mainCanvas = document.createElement('canvas');
  mainCanvas.width = width;
  mainCanvas.height = height;
  Object.defineProperty(mainCanvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width, height }),
  });
  Object.defineProperty(mainCanvas, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(mainCanvas, 'releasePointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(mainCanvas, 'style', {
    configurable: true,
    value: { cursor: '' },
  });
  Object.defineProperty(canvas, 'mainCanvas', {
    configurable: true,
    value: mainCanvas,
  });

  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = width;
  previewCanvas.height = height;
  Object.defineProperty(canvas, 'previewCanvas', {
    configurable: true,
    value: previewCanvas,
  });

  return { mainCanvas, previewCanvas };
}

export function makeAppCanvasStub(overrides: Record<string, unknown> = {}) {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    paste: vi.fn(),
    pasteSelection: vi.fn(),
    pasteExternalImage: vi.fn(),
    deleteSelection: vi.fn(),
    clearSelection: vi.fn(),
    cancelCrop: vi.fn(),
    commitCrop: vi.fn(),
    cancelExternalFloat: vi.fn(),
    cancelTransform: vi.fn(),
    commitTransform: vi.fn(),
    enterTransformMode: vi.fn(),
    zoomToFit: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    setHistory: vi.fn(),
    centerDocument: vi.fn(),
    composite: vi.fn(),
    pushLayerOperation: vi.fn(),
    isTransformActive: vi.fn(() => false),
    getTransformValues: vi.fn(() => null),
    setTransformValue: vi.fn(),
    getFloatSnapshot: vi.fn(() => null),
    getViewport: vi.fn(() => ({ zoom: 1, panX: 0, panY: 0 })),
    getHistory: vi.fn(() => []),
    getHistoryIndex: vi.fn(() => -1),
    getHistoryVersion: vi.fn(() => 0),
    selectAll: vi.fn(),
    selectAllCanvas: vi.fn(),
    duplicateInPlace: vi.fn(),
    clearCanvas: vi.fn(),
    saveCanvas: vi.fn(),
    mainCanvas: null,
    hasClipboardData: false,
    hasCropRect: false,
    hasExternalFloat: false,
    ...overrides,
  };
}

export function makeTransformManagerStub(overrides: Record<string, unknown> = {}) {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    skewX: 0,
    skewY: 0,
    flipH: false,
    flipV: false,
    updateViewport: vi.fn(),
    renderTransformed: vi.fn(),
    dispose: vi.fn(),
    cancel: vi.fn(() => new ImageData(1, 1)),
    commit: vi.fn(),
    hasChanged: vi.fn(() => true),
    getSourceRect: vi.fn(() => ({ x: 0, y: 0, w: 1, h: 1 })),
    onPointerDown: vi.fn(() => true),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => null),
    getCursor: vi.fn(() => 'move'),
    ...overrides,
  };
}

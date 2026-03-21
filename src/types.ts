export type ToolType =
  | 'select'
  | 'move'
  | 'pencil'
  | 'marker'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'triangle'
  | 'fill'
  | 'stamp'
  | 'text'
  | 'hand'
  | 'crop';

export interface Point {
  x: number;
  y: number;
}

export interface FloatingSelection {
  /** Original pixel content — never mutated, used as resize source */
  originalImageData: ImageData;
  /** Current position + size (updated on move/resize) */
  currentRect: { x: number; y: number; w: number; h: number };
  /** Cached render of originalImageData at currentRect size */
  tempCanvas: HTMLCanvasElement;
  /** Rotation angle in radians (clockwise) */
  rotation: number;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  canvas: HTMLCanvasElement;
}

export interface LayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageData: ImageData;
}

export interface DrawingState {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brushSize: number;
  stampImage: HTMLImageElement | null;
  layers: Layer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
  documentWidth: number;
  documentHeight: number;
  cropAspectRatio: string;
  fontFamily: string;
  fontSize: number;
  fontBold: boolean;
  fontItalic: boolean;
}

export type HistoryEntry =
  | { type: 'draw'; layerId: string; before: ImageData; after: ImageData }
  | { type: 'add-layer'; layer: LayerSnapshot; index: number }
  | { type: 'delete-layer'; layer: LayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string }
  | {
      type: 'crop';
      beforeLayers: LayerSnapshot[];
      afterLayers: LayerSnapshot[];
      beforeWidth: number;
      beforeHeight: number;
      afterWidth: number;
      afterHeight: number;
    };

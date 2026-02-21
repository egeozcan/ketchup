export type ToolType =
  | 'select'
  | 'pencil'
  | 'marker'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'triangle'
  | 'fill'
  | 'stamp'
  | 'hand';

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
}

export type HistoryEntry =
  | { type: 'draw'; layerId: string; before: ImageData; after: ImageData }
  | { type: 'add-layer'; layer: LayerSnapshot; index: number }
  | { type: 'delete-layer'; layer: LayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string };

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnail: Blob | null;
}

export interface SerializedImageData {
  width: number;
  height: number;
  blob: Blob;
}

export type SerializedHistoryEntry =
  | { type: 'draw'; layerId: string; before: SerializedImageData; after: SerializedImageData }
  | { type: 'add-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'delete-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string };

export interface SerializedLayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageData: SerializedImageData;
}

export interface SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  imageBlob: Blob;
}

export interface ProjectStateRecord {
  projectId: string;
  toolSettings: {
    activeTool: ToolType;
    strokeColor: string;
    fillColor: string;
    useFill: boolean;
    brushSize: number;
  };
  canvasWidth: number;
  canvasHeight: number;
  layers: SerializedLayer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
  historyIndex: number;
}

export interface ProjectHistoryRecord {
  id?: number;
  projectId: string;
  index: number;
  entry: SerializedHistoryEntry;
}

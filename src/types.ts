export type ToolType =
  | 'pencil'
  | 'marker'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'circle'
  | 'triangle'
  | 'fill'
  | 'stamp';

export interface Point {
  x: number;
  y: number;
}

export interface DrawingState {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brushSize: number;
  stampImage: HTMLImageElement | null;
}

export interface HistoryEntry {
  imageData: ImageData;
}

import { createContext } from '@lit/context';
import type { DrawingState, ToolType } from '../types.js';

export interface DrawingContextValue {
  state: DrawingState;
  setTool: (tool: ToolType) => void;
  setStrokeColor: (color: string) => void;
  setFillColor: (color: string) => void;
  setUseFill: (useFill: boolean) => void;
  setBrushSize: (size: number) => void;
  setStampImage: (img: HTMLImageElement | null) => void;
  undo: () => void;
  redo: () => void;
  clearCanvas: () => void;
  saveCanvas: () => void;
  // Layer operations
  addLayer: () => void;
  deleteLayer: (id: string) => void;
  setActiveLayer: (id: string) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  reorderLayer: (id: string, newIndex: number) => void;
  renameLayer: (id: string, name: string) => void;
  toggleLayersPanel: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const drawingContext = createContext<DrawingContextValue>('drawing-context');

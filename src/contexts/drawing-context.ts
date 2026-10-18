import { createContext } from '@lit/context';
import type { DrawingState, ToolType } from '../types.js';
import type { ProjectMeta, BrushTipMeta } from '../storage/types.js';
import type { ConfirmOptions } from '../components/confirm-dialog.js';
import type { BlendMode, BrushDescriptor, TipDescriptor, InkDescriptor, BrushDynamics, BrushJitter, BrushScatter, BrushColorDynamics, BrushFade, BrushTexture, BrushPreset } from '../engine/types.js';

export interface DrawingContextValue {
  state: DrawingState;
  setTool: (tool: ToolType) => void;
  setStrokeColor: (color: string) => void;
  setFillColor: (color: string) => void;
  setUseFill: (useFill: boolean) => void;
  setBrushSize: (size: number) => void;
  setStampSize: (size: number) => void;
  setStampImage: (img: HTMLImageElement | null, stampId?: string | null) => void;
  undo: () => void;
  redo: () => void;
  /** Clears the active layer, or with `allLayers` every layer (one undo step; only Layer 1 remains, white). */
  clearCanvas: (allLayers?: boolean) => void;
  /** Save: downloads a PNG standalone, asks the host (`save-request`) when embedded. */
  saveCanvas: () => void;
  /** A host page owns the document; project management is its business. See `DrawingApp.embedded`. */
  embedded: boolean;
  // Layer operations
  addLayer: (name?: string) => string;
  deleteLayer: (id: string) => void;
  setActiveLayer: (id: string) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  reorderLayer: (id: string, newIndex: number) => void;
  renameLayer: (id: string, name: string) => void;
  mergeLayerDown: (id: string) => void;
  mergeVisibleLayers: () => void;
  flattenImage: () => void;
  toggleLayersPanel: () => void;
  setCropAspectRatio: (ratio: string) => void;
  setFontFamily: (family: string) => void;
  setFontSize: (size: number) => void;
  setFontBold: (bold: boolean) => void;
  setFontItalic: (italic: boolean) => void;
  setBrush: (partial: Partial<BrushDescriptor>) => void;
  setBrushTip: (tip: Partial<TipDescriptor>) => void;
  setBrushInk: (ink: Partial<InkDescriptor>) => void;
  setBrushDynamics: (dynamics: Partial<BrushDynamics>) => void;
  setBrushJitter: (jitter: Partial<BrushJitter>) => void;
  setBrushScatter: (scatter: Partial<BrushScatter>) => void;
  setBrushColorDynamics: (color: Partial<BrushColorDynamics>) => void;
  setBrushFade: (fade: Partial<BrushFade>) => void;
  setBrushTexture: (texture: Partial<BrushTexture>) => void;
  selectPreset: (presetId: string) => void;
  /** The user's sampled brush tips (shared by every project); empty where the backend keeps none. */
  userTips: BrushTipMeta[];
  /** The user's custom presets, listed under "Custom". */
  userPresets: BrushPreset[];
  /** Makes a custom brush from the current selection's pixels and selects it. Resolves to a message when it can't, else null. */
  defineBrushFromSelection: () => Promise<string | null>;
  /** Makes a custom brush from an image file and selects it. Resolves to a message when it can't, else null. */
  defineBrushFromFile: (file: Blob, name?: string) => Promise<string | null>;
  /**
   * Loads the images of the custom presets, so their previews show the tip (only
   * the active brush's is loaded otherwise). With `groups`, only those headings'
   * presets ('' is the ungrouped "Custom" ones): an imported file can hold
   * thousands, which are read when its heading is opened.
   */
  loadUserTips: (groups?: string[]) => void;
  /** Imports the brushes of a Photoshop .abr file as a group named after it. Resolves to a message to show, and whether it went through. */
  importBrushFile: (file: File, onProgress?: (fraction: number) => void) => Promise<{ ok: boolean; message: string }>;
  /** Deletes every brush of an import, after asking. */
  deleteUserGroup: (group: string) => Promise<void>;
  /** Paints with a library tip, keeping the rest of the brush. */
  selectUserTip: (tipId: string) => void;
  deleteUserPreset: (presetId: string) => Promise<void>;
  /** Deletes a tip and the presets made on it (after asking). */
  deleteUserTip: (tipId: string) => Promise<void>;
  setLayerBlendMode: (id: string, mode: BlendMode) => void;
  setLayerAlphaLocked: (id: string, locked: boolean) => void;
  setEyedropperSampleAll: (v: boolean) => void;
  setStabilizer: (percent: number) => void;
  /** Asks a yes/no question in the editor's own modal dialog (not `window.confirm`); resolves true to go ahead. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  canUndo: boolean;
  canRedo: boolean;
  // Project operations
  currentProject: ProjectMeta | null;
  projectList: ProjectMeta[];
  saving: boolean;
  // Viewport state (read-only for consumers)
  zoom: number;
  panX: number;
  panY: number;
  viewportWidth: number;
  viewportHeight: number;
  isMobile: boolean;
  switchProject: (id: string) => void;
  createProject: (name: string, width: number, height: number) => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  /** True when the TransformManager is active */
  transformActive: boolean;
  /** Get current transform values for numeric panel, or null if not in transform mode */
  getTransformValues: () => { x: number; y: number; width: number; height: number; rotation: number; skewX: number; skewY: number; flipH: boolean; flipV: boolean } | null;
  /** Set a transform value from the numeric panel */
  setTransformValue: (key: string, value: number | boolean) => void;
  setChildMode: (on: boolean) => void;
}

export const drawingContext = createContext<DrawingContextValue>('drawing-context');

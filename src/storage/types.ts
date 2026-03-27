// src/storage/types.ts
import type { ToolType } from '../types.js';
import type { PressureCurveName, TipDescriptor, InkDescriptor } from '../engine/types.js';

// ---------------------------------------------------------------------------
// BlobRef — branded string, opaque to consumers
// ---------------------------------------------------------------------------

export type BlobRef = string & { readonly __brand: unique symbol };

export function createBlobRef(value: string): BlobRef {
  return value as BlobRef;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ToolSettings {
  activeTool: ToolType;
  strokeColor: string;
  fillColor: string;
  useFill: boolean;
  brushSize: number;
  opacity?: number;
  flow?: number;
  hardness?: number;
  spacing?: number;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
  pressureCurve?: PressureCurveName;
  tip?: TipDescriptor;
  ink?: InkDescriptor;
  activePreset?: string;
  isPresetModified?: boolean;
  cropAspectRatio?: string;
  fontFamily?: string;
  fontSize?: number;
  fontBold?: boolean;
  fontItalic?: boolean;
  eyedropperSampleAll?: boolean;
}

// ---------------------------------------------------------------------------
// Serialized types (use BlobRef, not Blob)
// ---------------------------------------------------------------------------

export interface SerializedImageData {
  width: number;
  height: number;
  blobRef: BlobRef;
}

export interface SerializedLayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode?: string;
  imageData: SerializedImageData;
}

export type SerializedHistoryEntry =
  | { type: 'draw'; layerId: string; before: SerializedImageData; after: SerializedImageData }
  | { type: 'add-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'delete-layer'; layer: SerializedLayerSnapshot; index: number }
  | { type: 'reorder'; fromIndex: number; toIndex: number }
  | { type: 'visibility'; layerId: string; before: boolean; after: boolean }
  | { type: 'opacity'; layerId: string; before: number; after: number }
  | { type: 'rename'; layerId: string; before: string; after: string }
  | {
      type: 'crop';
      beforeLayers: SerializedLayerSnapshot[];
      afterLayers: SerializedLayerSnapshot[];
      beforeWidth: number;
      beforeHeight: number;
      afterWidth: number;
      afterHeight: number;
    }
  | {
      type: 'merge';
      beforeLayers: SerializedLayerSnapshot[];
      afterLayers: SerializedLayerSnapshot[];
      previousActiveLayerId: string;
      afterActiveLayerId: string;
    }
  | { type: 'blend-mode'; layerId: string; before: string; after: string }
  | { type: 'transform'; layerId: string; before: SerializedImageData; after: SerializedImageData };

export interface SerializedLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode?: string;
  imageBlobRef: BlobRef;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnailRef: BlobRef | null;
}

export interface ProjectStateRecord {
  projectId: string;
  toolSettings: ToolSettings;
  canvasWidth: number;
  canvasHeight: number;
  layers: SerializedLayer[];
  activeLayerId: string;
  layersPanelOpen: boolean;
  historyIndex: number;
  zoom?: number;
  panX?: number;
  panY?: number;
}

export interface ProjectHistoryRecord {
  id?: number;
  projectId: string;
  index: number;
  entry: SerializedHistoryEntry;
}

export interface StampEntry {
  id: string;
  projectId: string;
  blobRef: BlobRef;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface BlobStore {
  put(data: Blob | ArrayBuffer): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Blob>;
  delete(ref: BlobRef): Promise<void>;
  deleteMany(refs: BlobRef[]): Promise<void>;
  gc?(activeRefs: Set<BlobRef>): Promise<number>;
}

export interface ProjectStore {
  list(opts?: { orderBy?: 'updatedAt' | 'createdAt'; direction?: 'asc' | 'desc' }): Promise<ProjectMeta[]>;
  get(id: string): Promise<ProjectMeta | null>;
  create(meta: Omit<ProjectMeta, 'id' | 'createdAt' | 'updatedAt'> & { thumbnailRef?: BlobRef | null }): Promise<ProjectMeta>;
  update(id: string, changes: Partial<Pick<ProjectMeta, 'name' | 'thumbnailRef'>>): Promise<ProjectMeta>;
  delete(id: string): Promise<void>;
}

export interface ProjectStateStore {
  get(projectId: string): Promise<ProjectStateRecord | null>;
  save(record: ProjectStateRecord): Promise<void>;
  delete(projectId: string): Promise<void>;
}

export interface ProjectHistoryStore {
  /** Returns entries sorted by index ascending. */
  getEntries(projectId: string): Promise<ProjectHistoryRecord[]>;
  putEntries(projectId: string, entries: ProjectHistoryRecord[]): Promise<void>;
  replaceAll(projectId: string, entries: ProjectHistoryRecord[]): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}

export interface StampStore {
  list(projectId: string): Promise<StampEntry[]>;
  add(projectId: string, data: Blob | ArrayBuffer): Promise<StampEntry>;
  delete(id: string): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Root interface
// ---------------------------------------------------------------------------

export interface StorageBackend {
  readonly projects: ProjectStore;
  readonly state: ProjectStateStore;
  readonly history: ProjectHistoryStore;
  readonly stamps: StampStore;
  readonly blobs: BlobStore;
  init(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProjectServiceOptions {
  maxStampsPerProject?: number;
}

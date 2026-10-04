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
  stampSize?: number;
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
  childMode?: boolean;
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
  | { type: 'patch'; layerId: string; x: number; y: number; before: SerializedImageData; after: SerializedImageData }
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
  /** Display size the viewport was saved at, used to detect a different screen on load. */
  viewportWidth?: number;
  viewportHeight?: number;
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
  /**
   * In one transaction, delete the entries whose `index` is in `removeIndices`
   * and add `entries`. Optional: without it, every history save is a replaceAll.
   */
  updateEntries?(projectId: string, removeIndices: number[], entries: ProjectHistoryRecord[]): Promise<void>;
  deleteForProject(projectId: string): Promise<void>;
}

export interface StampStore {
  list(projectId: string): Promise<StampEntry[]>;
  /** `createdAt` defaults to now; given, it keeps a copied stamp's place in the recent order. */
  add(projectId: string, data: Blob | ArrayBuffer, createdAt?: number): Promise<StampEntry>;
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
  /**
   * Optional: runs writes that belong together (a project's state and its
   * history) so that the backend doesn't close storage between them (for
   * another window's upgrade, say); it waits for them to settle first, and
   * refuses to start new ones once closing.
   */
  writeTogether?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ProjectServiceOptions {
  maxStampsPerProject?: number;
}

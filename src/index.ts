export { DrawingApp } from './components/drawing-app.js';
export { DrawingCanvas } from './components/drawing-canvas.js';
export { AppToolbar } from './components/app-toolbar.js';
export { ToolSettings } from './components/tool-settings.js';
export { drawingContext } from './contexts/drawing-context.js';
export type { DrawingContextValue } from './contexts/drawing-context.js';
export type { ToolType, Point, DrawingState } from './types.js';
export { IndexedDBBackend, MemoryBackend } from './storage/index.js';
export type { StorageBackend } from './storage/index.js';
// Errors a custom StorageBackend throws so the editor can tell them apart:
// a missing blob (StorageNotFoundError) costs only the history that needs it.
export {
  StorageError,
  StorageNotFoundError,
  StorageQuotaError,
} from './storage/index.js';

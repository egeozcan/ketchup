# Stamp Recent History Feature

## Overview

Add a recent stamps row (last 20) with easy select/delete to the stamp tool, persisted via IndexedDB.

## Storage Layer — `src/stamp-store.ts`

New module wrapping IndexedDB. No framework dependency — pure async functions.

- **DB name:** `ketchup-stamps`, **object store:** `stamps`
- Each entry: `{ id: string (crypto.randomUUID), blob: Blob, createdAt: number }`
- **API:**
  - `getRecentStamps(limit = 20): Promise<StampEntry[]>` — sorted by createdAt desc
  - `addStamp(blob: Blob): Promise<StampEntry>` — adds stamp, auto-prunes oldest if count > 20
  - `deleteStamp(id: string): Promise<void>` — removes one entry

## Integration

- On upload: blob saved to IndexedDB via `addStamp()`, converted to `HTMLImageElement`, set as active via `setStampImage()`
- On click recent stamp: blob converted to `HTMLImageElement`, set as active
- On click X: `deleteStamp(id)` removes from IndexedDB, row re-renders

**No changes to:** `drawing-canvas.ts`, `stamp.ts`, `drawing-context.ts`, `types.ts`. The stamp image remains an `HTMLImageElement` passed through context.

## UI

When stamp tool is active, tool-settings stamp section renders a horizontal row of recent stamp thumbnails before the upload button:

- Thumbnails: 32x32, rounded corners, dark background
- Active stamp: blue border (#5b8cf7)
- Delete X: absolute-positioned, top-right corner, appears on hover
- Row scrolls horizontally via overflow-x: auto
- Existing stamp preview (28x28 next to upload button) remains unchanged

## Files Changed

- **New:** `src/stamp-store.ts` — IndexedDB storage layer
- **Modified:** `src/components/tool-settings.ts` — recent stamps row UI, load/save/delete logic

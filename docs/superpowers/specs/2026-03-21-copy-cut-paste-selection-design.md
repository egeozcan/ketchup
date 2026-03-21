# Copy/Cut/Paste Selection Enhancements

## Overview

Enhance the existing selection clipboard system with system clipboard integration, Select All operations, cross-layer paste verification, and Duplicate in Place. All features build on the existing floating selection infrastructure.

## 1. System Clipboard Integration

### Copy/Cut (writing to system clipboard)

When the user copies or cuts a floating selection (Ctrl+C / Ctrl+X):

1. Existing behavior preserved: store `ImageData` + origin point in internal clipboard (`_clipboard`, `_clipboardOrigin`)
2. **New:** Render `tempCanvas` to PNG blob via `canvas.toBlob('image/png')`
3. **New:** Write blob to system clipboard via `navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`
4. **New:** Store `blob.size` as `_clipboardBlobSize` for change detection
5. System clipboard write is fire-and-forget (async, non-blocking). If it fails (permissions, insecure context), internal clipboard still works — no functionality regression.
6. PNG preserves full alpha transparency.

### Paste (unified dispatch)

The current Ctrl+V handler in `drawing-app.ts` branches between `pasteSelection()` (internal) and `pasteExternalImage()` (external). This gets replaced with a single call to a new unified `paste()` method on `drawing-canvas.ts` that handles both paths:

1. Attempt `navigator.clipboard.read()` to get system clipboard contents
2. If an image blob is found, compare `blob.size` to stored `_clipboardBlobSize`:
   - **Match** — content is our own copy. Use internal `ImageData` (fast, lossless, preserves `_clipboardOrigin` for positioning). Follows existing `pasteSelection()` logic.
   - **No match** — external content. Decode and handle via existing `pasteExternalImage()` path (centers on viewport, creates new layer for external images)
3. If clipboard read fails (permission denied, no image) — fall back to internal `ImageData` via `pasteSelection()`
4. If nothing available — no-op

The existing `pasteSelection()` and `pasteExternalImage()` methods remain as internal helpers; the new `paste()` method orchestrates which one to call.

In `drawing-app.ts`, the Ctrl+V handler simplifies to a single `canvas.paste()` call, removing the `hasClipboardData` branching.

### Why blob size fingerprint

Comparing `blob.size` (a single integer) is:
- Trivial to implement (store one number on copy)
- No PNG byte manipulation or metadata injection needed
- Extremely reliable — different images producing the exact same PNG byte count is astronomically unlikely. This is an accepted trade-off: in the near-impossible collision case, the app would use stale internal data. The user can re-copy to recover.
- Eliminates the need for blur/focus heuristics to detect clipboard changes

## 2. Select All

### Ctrl+A — Smart Select (auto-trim to content)

1. Read the active layer's `ImageData`
2. Scan alpha channel to find bounding box of all non-transparent pixels (alpha > 0)
3. If layer is completely empty — no-op
4. If there's an active float, commit it first
5. Lift the bounding box region as a floating selection via existing `_liftToFloat()`
6. All existing float interactions work: marching ants, resize handles, move, copy, cut, paste, delete

**Performance:** Linear scan of ImageData alpha channel (every 4th byte). For 800x600 canvas = 480K checks, sub-millisecond.

### Ctrl+Shift+A — Full Canvas Select

1. If there's an active float, commit it first
2. Lift the entire document bounds as a floating selection via `_liftToFloat()` with rect set to `{ x: 0, y: 0, w: docWidth, h: docHeight }`
3. Same float interactions as above

### Keyboard binding

- `Ctrl+A` → `selectAll()` (auto-trim)
- `Ctrl+Shift+A` → `selectAllCanvas()` (full document)

Both added to `_onKeyDown` in `drawing-app.ts`. Must switch active tool to `'select'` if not already.

## 3. Cross-Layer Paste

No design changes needed. The existing system already supports this:

- Internal clipboard stores `ImageData` + origin point, not tied to any layer
- `pasteSelection()` creates a float on whichever layer is currently active
- If a float is already active, it's committed first before creating the new one
- System clipboard integration reinforces this — content is layer-independent

This section confirms existing behavior and ensures it's tested during implementation.

## 4. Duplicate in Place (Ctrl+D)

### With active float

1. Commit the current float to the active layer (produces a draw history entry)
2. Immediately create a new float with the same `ImageData` at the same position
3. New float is ready to move/resize — user sees selection handles
4. Also writes to both internal and system clipboard (same as copy)

### Without active float

- If internal clipboard has content — paste at the original `_clipboardOrigin` position (not viewport center). This is functionally equivalent to Ctrl+V when internal clipboard data exists.
- If clipboard is empty — no-op

### Undo behavior

- `Ctrl+Z` after `Ctrl+D` discards the new float (existing float discard behavior)
- `Ctrl+Z` again undoes the commit of the original (existing draw history undo)

### Keyboard binding

- `Ctrl+D` added to `_onKeyDown` in `drawing-app.ts`
- Must prevent browser default (bookmark dialog)

## Files Modified

| File | Changes |
|------|---------|
| `src/components/drawing-canvas.ts` | System clipboard write on copy/cut, clipboard read + blob size comparison on paste, `selectAll()` and `selectAllCanvas()` methods, `duplicateInPlace()` method, `_clipboardBlobSize` field |
| `src/components/drawing-app.ts` | Ctrl+A, Ctrl+Shift+A, Ctrl+D keyboard shortcuts in `_onKeyDown`; simplify Ctrl+V to single `canvas.paste()` call (remove `hasClipboardData` branching); delegate to canvas methods via context |
| `src/contexts/drawing-context.ts` | Not modified — new methods follow existing pattern of direct `this.canvas` calls from `drawing-app.ts` via `@query` reference, consistent with `copySelection`, `cutSelection`, etc. |

## Non-Goals

- Multi-selection or polygonal selection
- Clipboard history / multiple clipboards
- Copy/paste entire layers
- Export clipboard as file
- Cross-tab clipboard sync within Ketchup

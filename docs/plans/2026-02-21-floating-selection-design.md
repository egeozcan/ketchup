# Floating (Detached) Selection Design

## Problem

Currently, selections commit immediately on pointer-up after a move, and stamps draw directly to the layer on click. Users need the ability to place content and reposition/resize it freely before committing.

## Design

### Unified FloatingSelection State

Both select and stamp tools produce the same floating state:

```typescript
interface FloatingSelection {
  imageData: ImageData;          // original pixel content (never mutated)
  sourceRect: DOMRect;           // where it was lifted/placed from
  currentRect: DOMRect;          // current position + size (updated on move/resize)
  tempCanvas: HTMLCanvasElement;  // cached render at current size, always from original imageData
}
```

Stored as a private field on `DrawingCanvas`. The preview canvas renders it with pan/zoom transforms.

### Select Tool Flow

1. Draw selection rectangle (unchanged)
2. On pointer-up, lift content from active layer: copy imageData, clear area on layer
3. Content appears as floating selection on preview canvas with marching ants + 8 resize handles
4. User can move (drag inside) or resize (drag handles) freely
5. Floating content stays detached until commit trigger

### Stamp Tool Flow

1. Click creates a floating selection from the stamp image (rendered to imageData at brushSize scale)
2. Same floating behavior as select: movable, resizable, marching ants + handles
3. Clicking again while a float exists: commit current float, place new one

### Resize Behavior

- 8 handles: 4 corners + 4 edge midpoints
- Corner handles maintain aspect ratio
- Edge midpoint handles stretch in one axis only
- Resize always re-renders from the **original imageData**, never from a previously resized version (prevents quality degradation)
- `tempCanvas` is rebuilt from original data at each new size

### Commit Triggers

- Click outside the floating selection: commit at current position
- Press Escape: commit at current position
- Switch tools: auto-commit
- Press Delete: discard the floating content (clear it without committing)

### Handle Visuals

- Small filled squares (approx 8x8 CSS pixels) at corners and edge midpoints
- Drawn on preview canvas, scaled inversely with zoom so they stay consistent size on screen
- Cursor changes: move cursor inside selection, resize cursors on handles (nw-resize, n-resize, etc.)

### History

- Commit produces a single `draw` history entry: full layer imageData before lift vs after commit
- No intermediate undo for individual moves/resizes
- Undo of the commit restores the layer to pre-lift state

### Interaction with Other Systems

- **Tool switch**: auto-commits any floating selection
- **Layer switch**: auto-commits any floating selection
- **Copy/Cut/Paste**: work with floating selection content (copy grabs float imageData, paste creates new float)
- **Zoom/Pan**: floating selection renders correctly via preview canvas transforms

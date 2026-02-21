# Zoom via Pinch/Wheel — Design

## Summary

Add zoom to the drawing canvas via Ctrl+wheel, pinch gestures, and keyboard shortcuts. Zoom anchors to cursor position (Figma/Photoshop style). Tools remain untouched — they already receive document coordinates.

## State

- `_zoom: number` on `drawing-canvas.ts` (default `1`, range `0.1–10`)
- Private rendering state alongside existing `_panX/_panY`

## Input

| Gesture | Action |
|---------|--------|
| Ctrl+wheel / pinch | Zoom anchored to cursor |
| Plain wheel | Pan (existing) |
| Ctrl+= / Ctrl+- | Keyboard zoom in/out |
| Ctrl+0 | Fit document in viewport |

Zoom factor: `×1.1` per wheel tick.

## Coordinate Pipeline

`_getDocPoint()`:
```
docX = (clientX - rect.left - panX) / zoom
docY = (clientY - rect.top - panY) / zoom
```

## Cursor-Anchored Zoom

When zooming, adjust pan so the document point under cursor stays fixed:

```
docPt = (viewportPt - pan) / oldZoom
newPan = viewportPt - docPt * newZoom
```

## Rendering

- `composite()`: `ctx.translate(panX, panY); ctx.scale(zoom, zoom)` before drawing layers/checkerboard/border
- Preview canvas: same transform
- Layer canvases: unchanged (document resolution)

## Selection Edge Case

`putImageData` ignores canvas transforms. Manual offset in selection preview needs `* zoom` factor added.

## Initial Pan (center document)

```
panX = (viewportWidth - docWidth * zoom) / 2
panY = (viewportHeight - docHeight * zoom) / 2
```

## Fit-to-viewport (Ctrl+0)

```
zoom = min(viewportWidth / docWidth, viewportHeight / docHeight) * 0.9
```
Then re-center pan.

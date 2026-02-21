# Move Tool Design

## Summary

A dedicated move tool that translates all pixels on the active layer by dragging. Vacated area becomes transparent. Shift constrains movement to horizontal or vertical axis.

## Interaction

1. **pointerdown** — Capture before-state via `_captureBeforeDraw()`. Snapshot active layer to a temp canvas. Record start point.
2. **pointermove** — Calculate delta from start. If Shift held, zero out the smaller axis component. Clear layer canvas, `drawImage` temp canvas at `(deltaX, deltaY)`. Call `composite()` for live feedback.
3. **pointerup** — Push draw history via `_pushDrawHistory()`. Clean up temp canvas reference.

## Shift Constraint

When Shift is held during drag, movement locks to the dominant axis (whichever has the larger absolute delta). The other axis delta is zeroed out.

## Files to Change

- `src/types.ts` — Add `'move'` to `ToolType` union
- `src/components/tool-icons.ts` — Add four-directional arrow SVG icon and "Move" label
- `src/components/app-toolbar.ts` — Add `'move'` to first toolbar group: `['select', 'move', 'hand']`
- `src/components/drawing-canvas.ts` — Add move tool state and wire pointer handlers

## Implementation Approach

Use drawImage from a temp canvas (Approach B):
- On drag start, snapshot the entire active layer canvas to a temporary offscreen canvas
- On each move event, clear the layer canvas and drawImage the snapshot at the computed offset
- On drag end, push history and discard the temp canvas

## History

Uses existing `draw` history type — full layer ImageData captured before drag starts and after drag ends. Undo/redo restores the layer pixel-perfectly.

## Edge Behavior

Content moved outside document bounds is clipped by standard canvas behavior. Pixels that leave the canvas area are lost.

## Toolbar Placement

First toolbar group alongside select and hand: `['select', 'move', 'hand']`.

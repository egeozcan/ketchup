# Navigator Panel Design

## Overview

A Photoshop-style navigator panel for Ketchup, providing a minimap with a draggable viewport rectangle, a logarithmic zoom slider, an editable zoom percentage input, and a browser fullscreen toggle.

## Layout

The navigator panel sits at the top of the right sidebar. The layers panel moves below it. Both share the same sidebar column and collapse together when the sidebar is collapsed.

```
┌──────────────────────────────────────────────────┐
│ tool-settings (top bar)                          │
├────┬────────────────────────────────┬────────────┤
│    │                                │ Navigator  │
│    │                                │ ┌────────┐ │
│    │                                │ │minimap │ │
│ T  │                                │ │  [█]   │ │
│ O  │          Canvas                │ └────────┘ │
│ O  │                                │ [−──●──+] 67% ⛶│
│ L  │                                ├────────────┤
│ B  │                                │ Layers     │
│ A  │                                │ ┌────────┐ │
│ R  │                                │ │Layer 2 │ │
│    │                                │ │Layer 1 │ │
│    │                                │ └────────┘ │
└────┴────────────────────────────────┴────────────┘
```

## Component: `navigator-panel.ts`

A new Lit web component (`<navigator-panel>`) that is a `ContextConsumer` with `subscribe: true`.

### Responsibilities

1. Render a minimap canvas showing a scaled-down composite of all visible layers
2. Draw a draggable viewport rectangle on the minimap representing the current view
3. Render a logarithmic zoom slider with +/- buttons
4. Render an editable zoom percentage input field
5. Render a fullscreen toggle button

### Internal structure

- **Minimap canvas**: An offscreen `HTMLCanvasElement` rendered into the component. Composites all visible layers scaled to fit the minimap area (~180px wide). Aspect ratio matches the document.
- **Viewport rectangle**: Drawn as an overlay on the minimap canvas. Calculated from `panX`, `panY`, `zoom`, `viewportWidth`, `viewportHeight`, and document dimensions.
- **Zoom slider**: An `<input type="range">` mapped logarithmically. Slider position `t` in [0, 1] maps to `zoom = MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM)^t`. Conversely, `t = log(zoom / MIN_ZOOM) / log(MAX_ZOOM / MIN_ZOOM)`.
- **Zoom input**: A text `<input>` showing the current zoom as a percentage (e.g., "67%"). On Enter or blur, parses the value, clamps to 10%-1000%, and dispatches a zoom change. Invalid input reverts.
- **Fullscreen button**: Calls `document.documentElement.requestFullscreen()` or `document.exitFullscreen()`. Listens for `fullscreenchange` to update icon state.

## Context changes

Add the following fields to `DrawingContextValue`:

| Field | Type | Source |
|-------|------|--------|
| `zoom` | `number` | Current zoom level from canvas |
| `panX` | `number` | Current horizontal pan offset |
| `panY` | `number` | Current vertical pan offset |
| `viewportWidth` | `number` | Display canvas width in pixels |
| `viewportHeight` | `number` | Display canvas height in pixels |

`drawing-app.ts` populates these from the `viewport-change` event already dispatched by `drawing-canvas.ts`. The canvas already has `getViewport()` which returns `{ zoom, panX, panY }`. Viewport dimensions come from the canvas element's width/height.

## Event flow

### Navigator → App (user interaction on navigator)

- **`navigator-pan`**: Dispatched when user drags the viewport rectangle on the minimap. Detail: `{ panX: number, panY: number }`.
- **`navigator-zoom`**: Dispatched when user moves the zoom slider, types a zoom value, or clicks +/- buttons. Detail: `{ zoom: number }`.

`drawing-app.ts` listens for both events and calls `canvas.setViewport()` with the new values.

### Canvas → Navigator (canvas state changes)

- **`composited` event**: Already dispatched by `drawing-canvas.ts` after every `composite()` call. The navigator listens for this (via `drawing-app.ts` forwarding or direct DOM event) to trigger a minimap redraw.
- **Context subscription**: The navigator reads `zoom`, `panX`, `panY`, `viewportWidth`, `viewportHeight` from context to position the viewport rectangle.

### Zoom from navigator

When zoom changes come from the navigator (slider or input), the zoom is applied centered on the current viewport center. This differs from wheel-zoom which anchors to the cursor position.

## Minimap rendering

On each `composited` event:

1. Calculate the scale factor to fit the document into the minimap area: `scale = min(minimapWidth / docWidth, minimapHeight / docHeight)`
2. Clear the minimap canvas
3. Fill with the workspace background color (`#3a3a3a`)
4. Draw a white rectangle for the document area (scaled)
5. Composite each visible layer with `drawImage(layer.canvas, 0, 0, docWidth * scale, docHeight * scale)` and `globalAlpha = layer.opacity`
6. Draw the viewport rectangle:
   - `rectX = (-panX / zoom) * scale`
   - `rectY = (-panY / zoom) * scale`
   - `rectW = (viewportWidth / zoom) * scale`
   - `rectH = (viewportHeight / zoom) * scale`
7. Clip the viewport rectangle to the minimap bounds
8. Stroke with red (`#ff4444`), 2px, with a subtle background fill (`rgba(255, 68, 68, 0.1)`)

## Minimap interaction

### Click-to-pan

Clicking on the minimap (outside the viewport rectangle) centers the viewport on that point:

1. Convert click position to document coordinates: `docX = clickX / scale`, `docY = clickY / scale`
2. Calculate new pan: `panX = viewportWidth / 2 - docX * zoom`, `panY = viewportHeight / 2 - docY * zoom`
3. Dispatch `navigator-pan`

### Drag viewport rectangle

1. On pointerdown inside the viewport rectangle, capture the pointer and record the offset between the click and the rectangle's top-left corner
2. On pointermove, calculate the new rectangle position, convert back to pan coordinates, and dispatch `navigator-pan`
3. On pointerup, release the pointer

### Drag bounds

Pan values are not clamped — matching existing behavior where the user can pan the document partially or fully off-screen.

## Zoom slider — logarithmic mapping

```
MIN_ZOOM = 0.1    (10%)
MAX_ZOOM = 10     (1000%)

// Slider position [0, 1] → zoom
zoom = MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM) ^ t

// Zoom → slider position [0, 1]
t = log(zoom / MIN_ZOOM) / log(MAX_ZOOM / MIN_ZOOM)
```

The slider `<input type="range">` uses `min=0`, `max=1000`, `step=1`. The integer value is mapped through the logarithmic formula. This gives perceptually even spacing: 50% and 200% are equidistant from 100%.

## Zoom input

- Displays current zoom as integer percentage (e.g., "67%")
- On focus, selects all text for easy replacement
- Accepts values like "150", "150%", "0.5", "50%"
- On Enter or blur: parses, clamps to 10%-1000%, dispatches `navigator-zoom`
- On Escape: reverts to current value, blurs
- Invalid input (non-numeric): reverts to current value

## Fullscreen toggle

- Uses the browser Fullscreen API: `document.documentElement.requestFullscreen()` / `document.exitFullscreen()`
- Listens for `fullscreenchange` event on `document` to update button icon
- Icon shows expand arrows when not fullscreen, compress arrows when fullscreen
- No conflict with Escape key handling — `fullscreenchange` fires as a document event, separate from keydown

## Collapsed state

When the right sidebar is collapsed (32px strip), the navigator panel hides its content along with the layers panel. The existing collapse/expand toggle in the layers panel header controls both. No additional collapse logic needed in the navigator — it simply renders nothing when collapsed, or the parent container clips it.

## Edge cases

- **Document aspect ratio**: The minimap area adapts. A landscape document gets a wide minimap; portrait gets a tall one. A `max-height` on the minimap container prevents it from consuming too much vertical space (cap at ~150px height).
- **Performance**: Minimap redraws on every composite, but renders to a ~180px canvas. Cost is negligible — no throttling needed.
- **Browser resize**: The minimap canvas resizes via CSS and recalculates the viewport rectangle on the next composite.
- **No layers**: If all layers are hidden or no layers exist, the minimap shows just the document background (white rectangle on grey).
- **Extreme zoom**: At 10x zoom, the viewport rectangle becomes very small on the minimap. At 0.1x, it may be larger than the minimap. Both are fine — the rectangle is clipped to minimap bounds.

## Implementation notes

- **`setViewport()` does not dispatch `viewport-change`**: Currently `setViewport()` calls `composite()` but not `_dispatchViewportChange()`. When the app handles `navigator-pan`/`navigator-zoom`, it must either add `_dispatchViewportChange()` to `setViewport()`, or manually update context state after calling it.
- **Center-anchored zoom**: Navigator zoom events carry `{ zoom }` only. The app must compute new `panX`/`panY` to keep the viewport center stable (same math as `_zoomToCenter`).
- **`composited` event listening**: The navigator should listen via `(this.getRootNode() as ShadowRoot).addEventListener('composited', ...)` — same pattern used by `layers-panel.ts`.

## Files to create

- `src/components/navigator-panel.ts` — new component

## Files to modify

- `src/components/drawing-app.ts` — import navigator-panel, add to render template above layers-panel, add viewport fields to context, handle `navigator-pan`/`navigator-zoom` events
- `src/contexts/drawing-context.ts` — add viewport fields to `DrawingContextValue`
- `src/types.ts` — add viewport fields to `DrawingState` if needed (or keep them only in context value)
- `src/components/layers-panel.ts` — remove its own panel wrapper/collapse logic if the sidebar container is refactored, or keep as-is if navigator and layers are siblings inside the existing sidebar structure

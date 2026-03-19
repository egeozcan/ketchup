# Touch & Mobile Screen Support

Full touch screen and small screen (mobile) support for the Ketchup drawing app.

## Goals

- 100% feature parity across phone, tablet, and desktop
- Both portrait and landscape orientations
- Single breakpoint at 768px: mobile layout below, desktop above
- CSS-first responsive strategy with render branching (via ResizeObserver-driven `isMobile` flag) where HTML structure must change
- Minor desktop touch target improvements

## 1. Mobile Detection & Flag Propagation

`drawing-app.ts` adds a ResizeObserver on itself that sets a reactive `isMobile: boolean` property (true when component width < 768px). This flag is:

- Added to `DrawingContextValue` so all child components can read it via context
- Reflected to a host attribute (`[mobile]`) for CSS-based styling via `:host([mobile])`

No `window.matchMedia` — ResizeObserver on the component is more reliable and works with container-based testing. Orientation changes and window resizes are handled automatically via the observer callback.

## 2. Multi-Touch: Pinch-to-Zoom & Two-Finger Pan

### Pointer Tracking

Maintain a `Map<number, {x, y}>` of active pointer IDs in `drawing-canvas.ts`:

- `pointerdown`: add to map
- `pointermove`: update in map
- `pointerup` / `pointerleave`: remove from map

### Gesture Detection

- **1 pointer active**: normal tool behavior (unchanged from today)
- **2 pointers active**: enter pinch/pan mode, suspend active tool
  - Distance delta between two points → zoom (anchored to midpoint)
  - Midpoint delta → pan offset
  - Both applied simultaneously

### Integration with Existing Zoom/Pan

The app already has `_zoom`, `_panX`, `_panY` and wheel-based zoom. Pinch/pan updates the same state variables, so compositing, coordinate transforms, and the navigator minimap all work without changes.

### Pointer Capture Management

The current codebase calls `setPointerCapture()` on the first pointer for most tools. When a second pointer arrives:

1. Release pointer capture on the first pointer
2. Cancel/discard the in-progress operation (see per-tool behavior below)
3. Reset all tool state flags (`_drawing`, `_selectionDrawing`, `_floatMoving`, etc.)
4. Enter pinch/pan mode — track both pointers without capture
5. When back to <=1 pointer, resume normal tool mode

### Per-Tool Interruption Behavior

| Tool | On second pointer | Recovery |
|------|-------------------|----------|
| Pencil / Marker / Eraser | Discard stroke (restore `_beforeDrawData`) | Clean canvas, ready for new stroke |
| Shapes (rect/ellipse/line/polygon) | Discard preview, cancel shape | Preview canvas cleared |
| Crop | Cancel drag, keep existing crop rect | Rect stays, user can retry handle |
| Select / Stamp float | Cancel move/resize, keep float at current position | Float stays in place |
| Text | No interruption (text editing uses textarea, not pointer capture) | Focus may be lost; user taps to refocus |
| Fill | No-op (fill is instant, no in-progress state) | N/A |
| Hand / Move | Cancel pan | Zoom/pan state unchanged |

## 3. Bottom Tab Bar (Mobile Toolbar)

When `isMobile` is true, `app-toolbar.ts` render-branches to a horizontal bottom bar.

### Structure

- Fixed to viewport bottom, full width, ~48px tall
- 5-6 primary tool group buttons as icons
- Each button is 44x44px touch target
- Active tool is highlighted

### Sub-tool Selection & Settings (Combined Popover)

- Tapping a different tool group switches to its default/last-used sub-tool immediately
- Tapping the already-active tool group opens a **combined popover** above the button containing:
  - **Sub-tool selector** at the top (if the group has multiple tools, e.g., rectangle/ellipse/line/polygon)
  - **Tool settings** below (color, brush size, opacity, etc.)
- This is the single entry point for both sub-tool switching and settings on mobile

### Save / Clear / More Actions

- A "more" (overflow) button at the right end of the bottom bar opens a popover with: Save, Clear, and any other action buttons from the desktop toolbar
- Keeps the primary bottom bar focused on drawing tools

### Undo/Redo

- Two buttons at the left end of the bottom bar
- Always visible, grayed out when unavailable

### Overflow

- Horizontal scroll (`overflow-x: auto`, hidden scrollbar) if tool groups exceed width
- Unlikely to be needed in landscape

### Desktop

Above 768px, the existing vertical left sidebar renders as-is (with bumped 44px touch targets).

## 4. Contextual Popovers

### Behavior

- Combined popover contains sub-tool selector (top) + tool settings (bottom) — see Section 3
- Appears above the bottom bar, anchored near the triggering button
- Dismissed by tapping outside or tapping the trigger again
- Only one popover open at a time (opening one closes any other, including layers sheet)

### Implementation

- The popover `div` in `app-toolbar.ts` embeds the existing `<tool-settings>` element (not duplicated logic)
- `tool-settings.ts` gets an `isMobile`-aware CSS branch for vertical layout within the popover
- Keyboard shortcut hints suppressed from tooltips when `isMobile` is true
- On desktop, the top settings bar renders inline as today

## 5. Layers Bottom Sheet

When `isMobile` is true, `layers-panel.ts` render-branches to a bottom sheet.

### Trigger

Layers button at the rightmost position in the bottom tab bar.

### Behavior

- Slides up from the bottom as an overlay
- Drag handle at the top for resizing
- Two snap points: half-height (default) and full-height (drag up)
- Swipe down or tap outside to dismiss
- Semi-transparent backdrop so canvas is partially visible

### Dismissal Threshold

- Dragging below 25% viewport height or with downward velocity > 0.5 px/ms dismisses the sheet
- Otherwise snaps to the nearest snap point (half or full)

### Content

Same as desktop layers panel:

- Layer list with visibility toggles, opacity sliders, thumbnails
- Add/delete buttons
- Drag-to-reorder — **prerequisite**: convert existing DragEvent-based reorder (`dragstart`/`dragover`/`drop` in `layers-panel.ts`) to pointer events, since the HTML Drag and Drop API does not fire on mobile touch. This conversion also applies to the desktop layout.
- Layer rename: supplement `dblclick` with an explicit rename button per row on mobile (double-tap is unreliable on touch)
- Layer rows bumped to 44px minimum touch targets

### Implementation

- CSS transitions for slide animation (`transform: translateY()`)
- Touch-driven drag on handle, snaps to nearest snap point on release
- Rendered within `layers-panel.ts` behind `isMobile` branch
- On desktop, right sidebar renders as today

## 6. Desktop Improvements

Applied above 768px:

- Toolbar buttons: 36px → 44px (padding increase, icon size unchanged)
- Layer row height: 24px min → 44px min
- Color swatches: 18px → 24px

No layout or behavioral changes. Just more generous hit areas for touch laptop users.

## 7. Canvas & Viewport Handling

### Viewport Meta

Update `index.html` meta tag:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
```

- `maximum-scale=1.0, user-scalable=no`: prevent browser pinch-to-zoom (we handle it ourselves)
- `viewport-fit=cover`: enable edge-to-edge rendering for safe area support

### Orientation Changes

Already handled: ResizeObserver on `drawing-app` fires on orientation change, `isMobile` re-evaluates, canvas `_resizeToFit()` fires via its own ResizeObserver.

### Safe Areas (Notch / Home Indicator)

- Bottom bar: `padding-bottom: env(safe-area-inset-bottom)`
- Top: `padding-top: env(safe-area-inset-top)` if needed
- Enables proper rendering on iPhones with notch/Dynamic Island

### Prevent Browser Gestures

- `overscroll-behavior: none` on `body` in `index.html` global styles (must be document-level to reliably prevent pull-to-refresh on all mobile browsers)

### Touch-Action for New UI Elements

- Bottom tab bar: `touch-action: none` (prevent accidental scrolling)
- Bottom sheet layer list: `touch-action: pan-y` (allow vertical scrolling, prevent horizontal)
- Popovers: `touch-action: manipulation` (allow taps, prevent double-tap zoom)

### Navigator Panel on Mobile

Hidden on mobile. Pinch-to-zoom and two-finger pan provide the same navigation functionality. The navigator minimap is not included in the bottom sheet.

## Architecture Summary

| Concern | Mobile (<768px) | Desktop (>=768px) |
|---------|-----------------|-------------------|
| Tool selection | Bottom tab bar | Left sidebar (44px buttons) |
| Tool settings | Contextual popover (tap active tool) | Top settings bar (unchanged) |
| Layers | Bottom sheet | Right sidebar (44px rows) |
| Zoom/pan | Pinch-to-zoom + two-finger pan | Ctrl+wheel zoom, wheel pan (unchanged) |
| Undo/redo | Buttons in bottom bar | Keyboard shortcuts (unchanged) |
| Navigator | Hidden (pinch-to-zoom replaces it) | Right sidebar (unchanged) |
| Canvas | Full viewport minus bottom bar | Same as today |

## Files Modified

- `index.html` — viewport meta tag update
- `src/contexts/drawing-context.ts` — add `isMobile` to context
- `src/components/drawing-app.ts` — ResizeObserver for `isMobile`, propagate via context, mobile layout (flex-direction switch: row→column, hide top settings bar and right sidebar on mobile)
- `src/components/drawing-canvas.ts` — multi-touch pointer tracking, pinch-to-zoom, two-finger pan
- `src/components/app-toolbar.ts` — mobile bottom bar render branch, popover for sub-tools, undo/redo buttons
- `src/components/tool-settings.ts` — contextual popover layout for mobile
- `src/components/layers-panel.ts` — bottom sheet render branch, convert DragEvent reorder to pointer events
- `src/components/navigator-panel.ts` — hide on mobile via `isMobile` context
- `src/types.ts` — update `DrawingContextValue` type with `isMobile`

## Out of Scope

- Touch gestures for undo/redo (decided: on-screen buttons only)
- Long-press interactions
- Pressure sensitivity (stylus/Apple Pencil)
- Floating/draggable palettes
- Separate tablet-specific layout (tablet uses mobile or desktop based on 768px breakpoint)

## Accessibility Note

`maximum-scale=1.0, user-scalable=no` prevents browser-level zoom for visually impaired users. This is a standard trade-off for canvas/drawing apps that provide their own zoom. The app's built-in pinch-to-zoom serves as the alternative.

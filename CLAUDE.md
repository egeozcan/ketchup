# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run dev          # Start Vite dev server
npm run build        # TypeScript check + Vite production build (tsc && vite build)
npx tsc --noEmit     # Type-check only (no output)
```

No test runner or linter is configured.

## Architecture

Browser-based drawing app built with **Lit 3 web components**, **Vite 6**, and **TypeScript 5** (strict mode, experimental decorators).

### State Management

Uses `@lit/context` with a single `DrawingContextValue` defined in `src/contexts/drawing-context.ts`. `drawing-app.ts` is the root component and sole `ContextProvider` — it owns all `DrawingState` and rebuilds the context value in `willUpdate()`. All other components (`app-toolbar`, `tool-settings`, `drawing-canvas`, `layers-panel`) are `ContextConsumer`s with `subscribe: true`.

### Tool System

Tools are **stateless pure functions** in `src/tools/`. Each takes a `CanvasRenderingContext2D` plus parameters and draws directly. `drawing-canvas.ts` dispatches to the correct tool function based on `activeTool` from context state inside its pointer event handlers (`_onPointerDown`/`_onPointerMove`/`_onPointerUp`). Tools draw to the **active layer's** offscreen canvas, not the display canvas.

Adding a new tool requires: add to `ToolType` union in `types.ts`, create tool function in `src/tools/`, add SVG icon + label in `tool-icons.ts`, add to a toolbar group in `app-toolbar.ts`, and wire pointer dispatch in `drawing-canvas.ts`.

### Layer System

Each layer owns an offscreen `HTMLCanvasElement` (created via `document.createElement`, not in the DOM). A display canvas in the DOM (`#main`) composites all visible layers bottom-to-top with per-layer `globalAlpha` via the `composite()` method. Layers are stored as a `Layer[]` in `DrawingState` (index 0 = bottom, last = top).

`drawing-app.ts` owns all layer state and exposes operations through context: `addLayer`, `deleteLayer`, `setActiveLayer`, `setLayerVisibility`, `setLayerOpacity`, `reorderLayer`, `renameLayer`, `toggleLayersPanel`.

`layers-panel.ts` provides the UI — a collapsible right sidebar with layer rows (visibility toggle, inline rename, opacity slider, up/down + drag-and-drop reorder, thumbnails), plus add/delete action buttons.

### Canvas Architecture

`drawing-canvas.ts` uses a **display canvas** (`#main`) that shows the composited result of all layers, and a `#preview` canvas (absolute-positioned, pointer-events:none) for live previews (shape drawing, selection marching ants). The preview canvas is cleared on commit. A checkerboard pattern is drawn on the display canvas behind layers to indicate transparency. Each composite dispatches `composited` with `{ contentChanged }`; pan/zoom, in-progress stroke frames and transform gestures (a float isn't on its layer until commit) use `scheduleComposite(false)` so the layers panel and navigator skip redrawing thumbnails of unchanged layers — pass `true` (the default) for anything that changes layer pixels. Hovering over a transform composites nothing (`TransformManager.onPointerMove` returns whether anything changed). On touch, tap tools (stamp, fill, eyedropper, a new text box or a tap committing one) act when the finger lifts (`_pendingTap`), and a pinch undoes what its first finger started (`_cancelCurrentTool(id, true)`), so a pinch leaves nothing behind; both pinch fingers are captured, a touch during a pen stroke is ignored as a palm, and a primary pointer drops stale entries of its type from `_pointers`. Float shortcuts (Ctrl+T/C/X/V/D/A, Delete) are ignored mid-gesture, and a press on the canvas first blurs a focused panel field so its typed value applies (if that moved what was under the press, or the press is off the float, it does nothing more). Choosing the select or hand tool keeps an active float (any other commits it); the hand tool pans over it, except that its ✓/✗ still take a press. Shortcuts listen on `drawing-app`, so a control that ends by key (text, layer rename, panel number fields, the navigator's zoom) hands focus back with `focusEditor`, keys pressed while nothing has focus (but Tab) go to the app if it last had focus or a press and can take focus now (not hidden, inert or without a tabindex), an Escape that closes a menu, dropdown, popover or the phone's layers sheet is stopped before the app would cancel a float with it, and while text is edited, plain keys typed elsewhere in the app (after a click on Bold or a colour) go back into the text (`focusText`). A viewport resize keeps the pan on whole pixels, carrying the rounding to the next resize so resizing back doesn't drift; `restoreViewport` drops a half-pixel centring offset rather than rounding it up, and hands the rest to that carry.

While a transform is active, previews must match what `commitTransform` writes (the float merged onto its layer with source-over). On a normal, opaque layer the float is drawn straight after the layer (equal up to display resampling, since source-over is associative); otherwise the layer and float are merged in a viewport-size scratch canvas (`_drawLayerWithTransformInView`) before the layer's blend mode and opacity apply, and `renderFlattened`/sampling merge at document resolution (`_layerWithTransform`). Perspective warps are computed per pixel (`warpPerspective`: inverse bilinear map, premultiplied bilinear sampling, edge pixels covered by their exact area inside the outline, so no mesh seams and sharp corners taper) into `TransformManager`'s cached warp canvas, which the preview and `commit()` share. They run on the GPU where WebGL2 allows (`perspective-gl.ts`, a fragment-shader port of the same code that agrees with the CPU to within rounding; keep the two in step) and on the CPU otherwise. Commit always warps the layer's part at full resolution, while the preview drops to reduced resolution past 4096² at rest, and during a drag past 2048² on the GPU or 1024² on the CPU, redone in full on pointer-up. Handles, the ✓/✗ buttons and the rotation handle are placed from the warped corners (`TransformManager._getCorners()`); ✓/✗ act only when pressed and released on them, and always read ✓ then ✗ in reading order (left to right, or top to bottom); `getButtons` tries each corner outside (on touch, 12px back from the screen's edges, then without that), then inside, then each of those pulled on screen, taking the first clear of the handles and middle, or else the one covering least. Perspective corner offsets live in the float's own (untransformed) space, so the warp turns, flips and scales with it; a Ctrl/Cmd-dragged corner continues from its current offset, and a handle resize is measured against the state at grab time so the opposite edge stays put (dragging past it flips the float in place). Typed W/H resize the box about its middle (scale only carries flips), so X/Y stay its top-left; moves snap to whole pixels.

### History

Uses a discriminated union `HistoryEntry` type (max 50 entries) supporting: `patch` (per-layer ImageData before/after of only the changed rectangle; legacy full-layer `draw`/`transform` entries still load and undo), `add-layer`, `delete-layer`, `reorder`, `visibility`, `opacity`, and `rename`. Drawing history is captured in `drawing-canvas.ts` via `_captureBeforeDraw()` (a canvas copy of the layer) and `_pushDrawHistory()` (diffs against it, reading back only the brush stroke's dirty bounds when known). `drawing-app.ts` persists history incrementally: each save serializes only new entries and deletes the ones that left the stack, and layers whose content hash is unchanged keep their stored blob. Layer structural operations are pushed by `drawing-app.ts` via `pushLayerOperation()`. Undo/redo of structural operations dispatches `layer-undo` custom events from canvas back to app.

### Persistence

`stamp-store.ts` stores recent stamp images as Blobs (max 20 per project, auto-pruned) in the `project-stamps` object store within the `ketchup-projects` database, scoped by project ID.

### Embedding

`drawing-app` doubles as an embeddable editor for pages that keep the image themselves. The `embedded` flag (read at connect) switches the default backend to `MemoryBackend` (which `_markDirty` then never autosaves, `_autosave`), hides project management in `tool-settings`/`app-toolbar` (via `embedded` on the context), and turns Save and Ctrl/Cmd+S into a `save-request` event. The host API on `DrawingApp` is `whenReady`, `openImage`, `newDocument`, `exportImage`, `modified`/`markSaved` and the `modified-change` event; `modified` compares the undo stack's top entry (and, for an empty top, `DrawingCanvas.getHistoryTrimmedCount()`) with the mark recorded at the last save; `markSaved(blob)` records the mark `exportImage` took for that Blob (the last export's without one), so edits made during the host's upload stay modified; each mark carries `_documentGeneration`, bumped by `_markSaved` whenever a document is opened, and a mark from an earlier document is ignored. Typed text not yet committed (`DrawingCanvas.hasPendingText()`, `pending-text-change`) counts as modified. `openImage`/`newDocument` are serialized through `_replaceDocumentInTurn`, and `exportImage` renders in a turn of that same queue, so it sees the document open when it was called. `_enterProject` calls `_markSaved` after every load, so marks never outlive their document. Embedded replacement carries recent stamps to the new project (`_carryStamps`) before deleting the old one. Taking the element out of the document commits work in progress (`clearSelection` in `disconnectedCallback`); a move in the DOM reconnects at once and keeps the backend open, a return after it was closed reopens it, and the canvas re-attaches its text field and size observer. Its layout sits on an inner `.app` wrapper, so a host's `display` rule on the element doesn't break it, and only the composed path inside the editor decides whether a key was typed into a field or dialog (a host's own dialog around it doesn't count). `npm run build:lib` (`vite.lib.config.ts`) bundles `src/index.ts` into `dist-lib/ketchup.js`. See README "Embedding".

### Deployment

Vite base path is `/ketchup/` (configured in `vite.config.ts`) for GitHub Pages.

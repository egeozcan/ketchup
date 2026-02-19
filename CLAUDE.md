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

`drawing-canvas.ts` uses a **display canvas** (`#main`) that shows the composited result of all layers, and a `#preview` canvas (absolute-positioned, pointer-events:none) for live previews (shape drawing, selection marching ants). The preview canvas is cleared on commit. A checkerboard pattern is drawn on the display canvas behind layers to indicate transparency.

### History

Uses a discriminated union `HistoryEntry` type (max 50 entries) supporting: `draw` (per-layer ImageData before/after), `add-layer`, `delete-layer`, `reorder`, `visibility`, `opacity`, and `rename`. Drawing history is captured in `drawing-canvas.ts` via `_captureBeforeDraw()`/`_pushDrawHistory()`. Layer structural operations are pushed by `drawing-app.ts` via `pushLayerOperation()`. Undo/redo of structural operations dispatches `layer-undo` custom events from canvas back to app.

### Persistence

`stamp-store.ts` uses IndexedDB (`ketchup-stamps` database) to store recent stamp images as Blobs (max 20, auto-pruned).

### Deployment

Vite base path is `/ketchup/` (configured in `vite.config.ts`) for GitHub Pages.

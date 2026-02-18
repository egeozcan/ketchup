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

Uses `@lit/context` with a single `DrawingContextValue` defined in `src/contexts/drawing-context.ts`. `drawing-app.ts` is the root component and sole `ContextProvider` — it owns all `DrawingState` and rebuilds the context value in `willUpdate()`. All other components (`app-toolbar`, `tool-settings`, `drawing-canvas`) are `ContextConsumer`s with `subscribe: true`.

### Tool System

Tools are **stateless pure functions** in `src/tools/`. Each takes a `CanvasRenderingContext2D` plus parameters and draws directly. `drawing-canvas.ts` dispatches to the correct tool function based on `activeTool` from context state inside its pointer event handlers (`_onPointerDown`/`_onPointerMove`/`_onPointerUp`).

Adding a new tool requires: add to `ToolType` union in `types.ts`, create tool function in `src/tools/`, add SVG icon + label in `tool-icons.ts`, add to a toolbar group in `app-toolbar.ts`, and wire pointer dispatch in `drawing-canvas.ts`.

### Canvas Layers

`drawing-canvas.ts` uses two stacked `<canvas>` elements: `#main` for committed content and `#preview` (absolute-positioned, pointer-events:none) for live previews (shape drawing, selection marching ants). The preview canvas is cleared on commit.

### History

Full-canvas `ImageData` snapshots stored in a private array (max 50). Undo/redo managed entirely inside `drawing-canvas.ts`, with a `history-change` custom event bubbled up to `drawing-app.ts` for button state.

### Persistence

`stamp-store.ts` uses IndexedDB (`ketchup-stamps` database) to store recent stamp images as Blobs (max 20, auto-pruned).

### Deployment

Vite base path is `/ketchup/` (configured in `vite.config.ts`) for GitHub Pages.

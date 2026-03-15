# Image Paste & Drop — Design Spec

## Overview

When a user pastes an image from the system clipboard (Ctrl+V) or drags and drops an image file onto the canvas, the app creates a new layer containing that image. The image appears as a floating selection so the user can reposition and resize it before committing.

## Requirements

- **Clipboard paste:** Ctrl+V with an image on the system clipboard creates a new layer with a floating selection of that image.
- **Drag-and-drop:** Dropping an image file onto the canvas does the same.
- **Oversize handling:** If either image dimension exceeds the canvas, a dialog asks the user whether to scale to fit or keep original size.
- **Interactive placement:** The image appears as a floating selection (reusing existing float infrastructure) centered on the canvas, with drag-to-move and handle-to-resize.
- **Layer naming:** Drag-and-drop uses the filename (without extension). Clipboard paste uses "Pasted Image".
- **Cancel cleanup:** If the user dismisses the float (Escape), the empty layer created for the paste is deleted.

## Design

### Event Handling

Two entry points converge on a single method `_handleExternalImage(img: HTMLImageElement, name: string)`:

**Clipboard paste (`paste` event):** A listener on the `drawing-canvas` element inspects `clipboardData.items` for image types (`image/png`, `image/jpeg`, etc.). If found, extracts the `File`, converts to `HTMLImageElement` via `URL.createObjectURL`, and calls `_handleExternalImage` with name `"Pasted Image"`.

**Drag-and-drop (`drop` + `dragover` events):** A listener on the `drawing-canvas` element inspects `dataTransfer.files` for image types. Extracts the `File` (capturing the filename), converts to `HTMLImageElement`, and calls `_handleExternalImage` with the filename minus extension. A `dragover` handler calls `preventDefault()` to allow drops.

### Ctrl+V Integration

Currently `drawing-app.ts` handles Ctrl+V by calling `this.canvas?.pasteSelection()` (internal clipboard). This is replaced by consolidating all paste handling into a `paste` DOM event listener on the canvas:

1. `paste` event fires on the canvas element.
2. If `clipboardData` contains an image → external image flow (`_handleExternalImage`).
3. If no image in clipboard data → call existing `pasteSelection()` for internal clipboard.
4. The Ctrl+V → `pasteSelection()` wiring is removed from `drawing-app.ts`.

### Oversize Image Dialog

When `_handleExternalImage` receives an image where `img.naturalWidth > documentWidth || img.naturalHeight > documentHeight`:

- A modal dialog (`<resize-dialog>`) is shown with the message: "This image (WxH) is larger than the canvas (WxH). Would you like to scale it to fit?"
- Two buttons: **"Scale to fit"** and **"Keep original size"**.
- "Scale to fit" uses `Math.min(canvasW / imgW, canvasH / imgH)` to calculate scale, preserving aspect ratio.
- The dialog resolves a promise with the user's choice.
- If the image fits within canvas bounds, the dialog is skipped entirely.

### Layer Creation & Floating Selection

Once image dimensions are resolved:

1. **Create layer:** Call `addLayer(name)` — the context method is extended to accept an optional name parameter. The layer is inserted above the current active layer and set as active. An `add-layer` history entry is pushed.
2. **Create float:** Call `_createFloatFromImage` on the new active layer, centered at `((canvasW - imgW) / 2, (canvasH - imgH) / 2)`.
3. **User interaction:** Existing float infrastructure handles repositioning (drag) and resizing (handles) on the preview canvas.
4. **Commit:** On commit (click outside, Enter, or tool switch), `_commitFloat()` draws to the layer canvas and pushes draw history. Standard behavior.
5. **Cancel:** On Escape, clear float state and delete the newly created empty layer. The canvas detects this case (layer was created for external image and float was never committed) and dispatches a layer-delete operation to clean up.

## Files Changed

- **`src/components/drawing-canvas.ts`** — Add `paste`, `drop`, `dragover` event listeners. Add `_handleExternalImage()`. Add empty-layer cleanup on float cancel.
- **`src/components/drawing-app.ts`** — Remove Ctrl+V → `pasteSelection()` wiring. Extend `addLayer()` to accept optional `name` parameter.
- **`src/components/resize-dialog.ts`** — New Lit component. Simple modal dialog with two buttons, resolves a promise.
- **`src/types.ts`** — No changes needed.

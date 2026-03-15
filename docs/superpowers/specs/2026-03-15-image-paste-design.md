# Image Paste & Drop — Design Spec

## Overview

When a user pastes an image from the system clipboard (Ctrl+V) or drags and drops an image file onto the canvas, the app creates a new layer containing that image. The image appears as a floating selection so the user can reposition and resize it before committing.

## Requirements

- **Clipboard paste:** Ctrl+V with an image on the system clipboard creates a new layer with a floating selection of that image.
- **Drag-and-drop:** Dropping an image file onto the canvas does the same.
- **Oversize handling:** If either image dimension exceeds the canvas, a dialog asks the user whether to scale to fit or keep original size.
- **Interactive placement:** The image appears as a floating selection (reusing existing float infrastructure) centered on the canvas, with drag-to-move and handle-to-resize.
- **Layer naming:** Drag-and-drop uses the filename (without extension). Clipboard paste uses "Pasted Image".
- **Cancel cleanup:** If the user cancels the float, the empty layer created for the paste is deleted.

## Design

### Event Handling

Two entry points converge on a single method `_handleExternalImage(img: HTMLImageElement, name: string)`:

**Clipboard paste:** Handled via `drawing-app.ts` keyboard handler, not a `paste` DOM event. When Ctrl+V is pressed and `drawing-canvas` has no internal `_clipboard` data, `drawing-app` calls a new public method on the canvas: `pasteExternalImage()`. This method uses `navigator.clipboard.read()` to read the system clipboard, looks for items with any type starting with `image/`, converts to a Blob, creates an `HTMLImageElement` via `URL.createObjectURL`, and on load calls `_handleExternalImage` with name `"Pasted Image"`. The object URL is revoked in the `onload` callback after the image is used. An `onerror` handler revokes the URL and returns silently.

**Drag-and-drop (`drop` + `dragover` + `dragenter` + `dragleave` events):** Listeners on the `drawing-canvas` element. On `drop`, inspects `dataTransfer.files` for files with MIME type starting with `image/`. Non-image files and empty transfers are silently ignored. Extracts the `File` (capturing the filename), converts to `HTMLImageElement` via `URL.createObjectURL` (revoked after load), and calls `_handleExternalImage` with the filename minus extension. A `dragover` handler calls `preventDefault()` to allow drops. `dragenter`/`dragleave` toggle a CSS class for visual drop-target feedback (e.g., a subtle border highlight).

### Ctrl+V Integration

The existing Ctrl+V flow in `drawing-app.ts` is extended, not replaced:

1. Ctrl+V pressed → check if canvas has internal clipboard data (`_clipboard` is non-null via a new public getter or method).
2. If yes → call existing `pasteSelection()` (float on current layer).
3. If no → call new `pasteExternalImage()` on the canvas (system clipboard → new layer).

This keeps keyboard handling in `drawing-app.ts` where all other shortcuts live.

### Oversize Image Dialog

When `_handleExternalImage` receives an image where `img.naturalWidth > documentWidth || img.naturalHeight > documentHeight`:

- A modal dialog (`<resize-dialog>`) is shown with the message: "This image (WxH) is larger than the canvas (WxH). Would you like to scale it to fit?"
- Two buttons: **"Scale to fit"** and **"Keep original size"**.
- "Scale to fit" uses `Math.min(canvasW / imgW, canvasH / imgH)` to calculate scale, preserving aspect ratio.
- The dialog resolves a promise with the user's choice.
- If the image fits within canvas bounds, the dialog is skipped entirely.
- The dialog uses a native `<dialog>` element with `showModal()` for proper modal behavior. It is rendered inside the `drawing-canvas` shadow DOM.

### Existing Float Handling

If a floating selection is already active when a paste/drop occurs, it is committed first (via `_commitFloat()`) before proceeding with the new external image flow. This matches the existing pattern used by `pasteSelection()`.

### Layer Creation & Floating Selection

Once image dimensions are resolved:

1. **Create layer:** Call `addLayer(name)` via context — the method is extended to accept an optional name parameter and returns the new layer's ID. After calling `addLayer`, await `this.updateComplete` to ensure the context update has propagated before proceeding.
2. **Capture before-draw state:** Call `_captureBeforeDraw()` on the new empty layer. This captures a blank ImageData as the "before" state for undo, which is correct for a newly created layer.
3. **Create float:** Use a new variant of `_createFloatFromImage` (or extend the existing one) that accepts pre-computed width and height instead of a `size` parameter. The stamp tool path continues to use the `size`-based scaling. The image is centered at `((canvasW - imgW) / 2, (canvasH - imgH) / 2)`.
4. **User interaction:** Existing float infrastructure handles repositioning (drag) and resizing (handles) on the preview canvas.
5. **Commit:** On commit (click outside, Enter, or tool switch), `_commitFloat()` draws to the layer canvas and pushes draw history. Standard behavior.
6. **Cancel:** A new `_discardFloat()` call (instead of `_commitFloat()`) clears the float state without drawing to the layer. The canvas tracks whether the current float was created for an external image paste (via a flag like `_floatIsExternalImage`). If so, it also dispatches a layer-delete operation to remove the empty layer. This is a new cancel path distinct from the existing Escape behavior — Escape currently commits; for external image floats specifically, Escape discards and cleans up.

## Edge Cases

- **Non-image files dropped:** Silently ignored — no error, no UI feedback.
- **Empty clipboard on Ctrl+V (no internal or external data):** No-op.
- **Image load failure (corrupted file, unsupported format):** `onerror` handler revokes the object URL and returns silently.
- **Supported image formats:** Any type starting with `image/` — the browser's `HTMLImageElement` handles decoding. No explicit format allowlist.

## Files Changed

- **`src/components/drawing-canvas.ts`** — Add `drop`, `dragover`, `dragenter`, `dragleave` event listeners. Add `_handleExternalImage()` and `pasteExternalImage()` methods. Extend or add variant of `_createFloatFromImage` for pre-computed dimensions. Add `_floatIsExternalImage` flag and discard-on-cancel logic. Add drop-target CSS feedback. Expose `hasClipboardData()` getter.
- **`src/components/drawing-app.ts`** — Extend Ctrl+V handler to check internal clipboard first, then fall back to `pasteExternalImage()`. Extend `addLayer()` to accept optional `name` parameter and return the new layer ID.
- **`src/contexts/drawing-context.ts`** — Update `addLayer` signature in `DrawingContextValue` from `() => void` to `(name?: string) => string` (returns layer ID).
- **`src/components/resize-dialog.ts`** — New Lit component using native `<dialog>` element with `showModal()`. Two buttons, resolves a promise with the user's choice.

# Performance review — 2026-10-01

A review of the drawing hot path, brush engine, tools, persistence and the
UI panels, looking for work that scales with document size when it should
scale with what changed, and for work repeated when nothing changed.

Costs below assume a 4000×3000 document (48 MB per full RGBA readback) unless
stated. "Readback" means a synchronous GPU→CPU `getImageData` on a
GPU-backed canvas, which also flushes pending GPU work.

## Fixed in this change

| # | Where | Problem | Fix |
|---|-------|---------|-----|
| 1 | `tools/fill.ts`, fill in `drawing-canvas.ts` | Every fill did 3 full-document readbacks (fill, history snapshot, history layer), a full `diffBounds`, and a full `putImageData`, even for a small enclosed area. | `floodFill` tracks and returns the filled rectangle, uploads only that with the dirty-rect `putImageData`, and the caller passes it to `_pushDrawHistory` as the region. One full readback remains (the fill's extent is unknown until it runs). |
| 2 | `engine/stroke-buffer-pool.ts`, `engine/stamp-stroke.ts` | Each stroke cleared, tinted and composited the whole grow-only stroke buffer: three document-sized GPU passes for a short tick. | The engine passes the previous stroke's footprint (unclamped, since stamps can land past the document in a larger buffer) to `acquire`, and the current footprint to `commit`. Tint is clipped to it and the composite uses the 9-argument `drawImage`. |
| 3 | `drawing-canvas.ts` `_composite` | Eraser strokes, and any stroke on a layer with opacity < 1 or a blend mode, cleared the full-document scratch canvas and copied the whole layer into it every frame. | Copy the layer once per stroke; after that refresh only the stroke's bounds. The layer can't change until the stroke commits, and the bounds only grow. |
| 4 | `drawing-canvas.ts`, `tools/shapes.ts` | Shape commits read back and diffed the whole document twice for history. | `shapeBounds()` returns the start/end box padded by half the line width plus 2px (every shape path, including the heart's Bézier control points, stays inside the box; caps and joins are round). The shape commit passes it as the history region. Cut does the same with the clipboard rectangle. |
| 5 | `drawing-canvas.ts`, `layers-panel.ts`, `navigator-panel.ts` | `composited` fired on every frame of every stroke, pan, wheel and pinch. That triggered a 4 Hz redraw of every layer thumbnail and a 10 Hz minimap downscale of every layer, although during these the layers don't change. It also invalidated the eyedropper's sampling buffer, so the next sample re-read every layer. | `composited` now carries `{ contentChanged }`. `scheduleComposite(false)` is used for pan, zoom, pinch and in-progress stroke frames, and `composite()` stays `true`. The layers panel ignores `false`, and its leftover "schedule on every update" branch is removed. The navigator caches the downscaled document and, on view-only frames, only blits it and redraws the viewport rectangle. The sampling buffer is invalidated only on content changes. The dead `_floatDetail` thumbnail code (the event never carried it) is removed. |
| 6 | `drawing-canvas.ts` wheel/pinch | Every wheel and pinch event dispatched `viewport-change`, which sets five `@state` fields on the app, rebuilds the context and re-renders every panel. | Coalesced to one per animation frame (discrete zoom/fit/resize still dispatch immediately). The save reads the live viewport, so nothing is lost. |
| 7 | `drawing-app.ts` `_markDirty` | Settings changes (tool, colour, brush slider, active layer, font, panel toggle) bumped `_contentVersion`. That defeated `reuseSaved`, so the next autosave read back and hashed every layer in one long main-thread task. | Only `'work'` bumps it. Every pixel change goes through history, whose `history-change` event marks `'work'`. |
| 8 | `drawing-app.ts` `_save` | The project thumbnail was re-rendered, PNG-encoded and written (3 extra IndexedDB transactions) on every save, including viewport- and setting-only ones. | Skipped when the layers are unchanged and a thumbnail exists. |
| 9 | `drawing-app.ts` autosave | The 500 ms debounce could fire mid-stroke, and the save's synchronous readback and hash then stalled the stroke. The save loop's coalescing pass had the same issue. | The timer re-arms while a pointer is down on the canvas (`DrawingCanvas.isGestureActive()`), for at most 20 periods (10 s) so a lost `pointerup` can't block saving. Flushes (`visibilitychange`, `beforeunload`, explicit) are unaffected. |
| 10 | `drawing-app.ts` `_save` | With a floating selection, the owning layer was read back, uploaded to a temp canvas, then read back again. | `drawImage` the layer into the temp canvas: one readback, no upload. |
| 11 | `engine/brush-tip-cache.ts` | 128-entry cap with O(n) LRU scan on every miss. A large fan or splatter brush with pressure-driven size cycles through hundreds of keys, so it thrashed (each miss builds a canvas and up to 8 gradients). | O(1) LRU using `Map` insertion order, bounded by a 32 MB byte budget instead of an entry count. |
| 12 | `engine/stamp-stroke.ts` wet brush | Every dab cleared, redrew and source-in tinted the tint canvas, even when the tip and picked-up colour were unchanged (common over transparent areas, where the colour stays the original). | Remember the tip and colour last tinted, and skip re-tinting when both match. |
| 13 | `transform/transform-manager.ts` | Perspective transforms allocated a new canvas on every composite and redrew the whole source once per mesh triangle (128 triangles), including on pan, zoom and hover frames where the corners hadn't moved. | Cache the warped result keyed by the destination corners (which, with the fixed source, determine it) and reuse the canvas element. |
| 14 | `storage/memory/index.ts` | `MemoryStampStore.delete` dropped the entry but kept its blob. Embedded mode leaked one full-size image per pruned stamp. | Free the blob, as the IndexedDB store does (carried stamps are re-added with their own copy, so blobs aren't shared). |

### Verification

- Unit tests: `tests/perf-regions.test.ts` covers the fill bounds, shape bounds, buffer clear/commit regions, tip cache eviction, the `contentChanged` flag, the content version, autosave deferral and the memory stamp blob. The full suite passes, and `npm run build` and `npm run build:lib` succeed.
- Pixel comparison in Chromium (Playwright, this branch vs. its base) runs pencil, eraser, a pencil and an eraser stroke on a 50%-opacity layer (sampled mid-stroke to cover the preview path), a rectangle, fills inside and outside it, three undos and three redos, then wheel pan and zoom. Every layer and display hash matches the base at every step, and the history lengths match.

## Not changed — recommended follow-ups

Ordered by expected impact.

1. **Per-layer revision counters for saves.** A save after any drawing change still reads back and hashes *every* layer. A counter bumped by `_pushDrawHistory` and by undo/redo of layer-scoped entries would limit that to layers that changed; a full hash on flush would act as a safety net. A further step is snapshotting with `createImageBitmap` and hashing and encoding in a Worker.
2. **Viewport state in its own context.** Only `navigator-panel` reads `zoom`, `pan*` and `viewport*`. Moving them out of `DrawingContextValue`, and building the ~60 context closures once instead of on every update, would stop pan and zoom from re-rendering the toolbar, tool settings and layers panel at all. Today they re-render at most once per frame.
3. **Merge/flatten/add-layer history snapshots every layer.** On a 10-layer 3000×3000 document one merge holds about 700 MB of `ImageData`. Storing only the affected layers needs a backward-compatible entry format change.
4. **Wet brush reads back the whole layer at pen-down** (`stamp-stroke.ts`, `layerSnapshot`). Lazily reading 256² tiles around each dab would make this proportional to the stroke.
5. **Text, lift and delete-selection commits** still diff the whole document for history. Their regions are knowable (text bounding box with glyph overhang, source plus transformed bounds), but an underestimate silently breaks undo, so each needs care.
6. **IndexedDB transaction batching.** A one-stroke save runs about 11 transactions. A `putMany` / multi-store transaction would cut that and remove the manual rollback.
7. **Stroke frames recomposite every layer** plus the checkerboard. Caching the composite below the active layer at stroke start would help many-layer documents on mobile.
8. **Eyedropper on the active layer** does a 1×1 GPU readback per pointermove. It could sample a lazily built `willReadFrequently` copy, at the cost of another document-sized canvas.
9. **Brush preview in tool settings** regenerates (about 144 dabs + `toDataURL`) on every slider input once the preset is modified. The cache key should use the clamped preview size, and generation should be throttled.
10. **Layers panel** redraws every thumbnail when the `layers` array changes (e.g. on each opacity-slider input). Keyed rows and per-thumbnail keys would limit that to the changed layer.
11. **Memory:** the document-sized scratch canvases (`_beforeDrawBuffer`, both tint canvases, the sampling buffer, the stroke buffer) live for the component's lifetime. At 4000² that is about 300 MB, close to iOS Safari's canvas memory cap.

Correctness issues noticed along the way (not performance, left alone here):
the rename field in the layers panel re-selects its text on every re-render;
`drawing-canvas` creates its `ResizeObserver` and text input only in
`firstUpdated`, so they don't come back after a disconnect/reconnect.

## Already in good shape

Scanline flood fill with a reusable generation-stamped visited buffer;
incremental Catmull-Rom smoothing; brush history reads back only the
stroke's padded bounds; `_captureBeforeDraw` copies canvas to canvas; rAF
coalescing of composites; cached canvas rect (no layout reads per move);
incremental history persistence keyed by entry; PNG blobs rather than
serialized pixels; bounded and revoking stamp thumbnail cache; layer canvases
correctly *not* `willReadFrequently` (they are composited every frame).

# ketchup
A drawing app with stamps, and basic tools that run in the browser

## Install

On browsers that support Progressive Web Apps, use the browser's install action to add Ketchup to your home screen or applications. Once the app has been loaded online, its interface is also available offline; drawings and projects remain in local browser storage.

## Embedding

Another page can host the editor and keep the image itself, for example an app that stores images on its own server. `npm run build:lib` writes `dist-lib/ketchup.js`, one self-contained ES module (Lit included) that defines the `<drawing-app>` element when loaded:

```html
<drawing-app embedded tabindex="0" style="height:80vh"></drawing-app>
<script type="module">
  import './ketchup.js';

  const app = document.querySelector('drawing-app');
  await app.whenReady();
  await app.openImage(await (await fetch('/image.png')).blob(), { name: 'image' });

  app.addEventListener('save-request', async () => {
    const blob = await app.exportImage({ type: 'image/png' });
    const res = await fetch('/image.png', { method: 'PUT', body: blob });
    if (res.ok) app.markSaved(blob);
  });
</script>
```

The `embedded` attribute (or property, set before the element is connected) means the host owns the document. The editor then keeps its working state in memory instead of IndexedDB and does not autosave it (unless you pass your own `storageBackend`), hides project switching and creation (recent stamps carry over from one opened document to the next), and answers the Save button and Ctrl/Cmd+S with a `save-request` event instead of downloading a PNG.

| Member | What it does |
|--------|--------------|
| `whenReady()` | Resolves once storage is open and a document is on the canvas. |
| `openImage(blob, { name })` | Replaces the document with the image, at its own size, on one layer, with empty history. Transparency is kept. Rejects, changing nothing, when the image is larger than the document limit or the browser reports it cannot hold a canvas that large (Safari). This and `newDocument` run one at a time, in call order. |
| `newDocument(width, height, { name, background })` | Replaces the document with a blank one; `background: null` makes it transparent (default white). |
| `exportImage({ type, quality, background })` | Commits work in progress (a transform, a floating selection, text) and flattens the visible layers into a `Blob`. Runs in call order with `openImage`/`newDocument`: it renders the document open when it was called, after any replacement called before it. Transparent by default; JPEG gets a white background. A browser that cannot encode `type` returns PNG, so check the Blob's `type`. |
| `modified` | True when the document changed since it was opened or last marked saved, including text still being typed. Undoing back to that point makes it false again, unless the undo history has since dropped it (it keeps 50 steps). |
| `markSaved(blob?)` | Records the document as saved as the export that produced `blob` rendered it, so edits made while the host was storing it, and later exports still in flight, still count as modified. Without `blob`, the last export's document, or the document as it is if nothing was exported. A `blob` exported before the document was replaced is ignored; one `exportImage` did not return counts as no `blob`. |
| `save-request` event | Save was asked for (button or Ctrl/Cmd+S). Only fired when embedded. |
| `modified-change` event | `modified` flipped; `detail.modified` is the new value. |

Both events bubble and cross shadow roots. Documents are limited to 16384 pixels a side.

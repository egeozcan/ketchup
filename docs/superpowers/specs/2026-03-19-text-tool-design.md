# Text Tool Design

## Overview

Add an inline text tool to Ketchup that lets users click on the canvas, type text directly with a blinking cursor, optionally reposition the text block by dragging, and commit it as rasterized pixels to the active layer. Text editing is powered by a hidden `<textarea>` for native cursor navigation, selection, and IME support, with real-time canvas preview rendering via `fillText()`.

## Interaction Flow

1. **Select** — User picks the Text tool from the toolbar (or presses `T`). Tool settings bar shows font controls. Canvas cursor changes to `text`.
2. **Place** — Click on the canvas records the position in document space. The hidden `<textarea>` receives focus. A blinking cursor appears on the preview canvas at the click point.
3. **Type** — Each `input` event re-renders all text lines to the preview canvas using `ctx.fillText()`. The cursor is drawn at a position calculated via `ctx.measureText()`. Enter inserts a newline. Arrow keys, selection, backspace, and delete all work natively through the textarea.
4. **Reposition (optional)** — While editing, pointer-down inside the text bounding box (shown as a dashed border on the preview canvas) initiates a drag. The text block follows the pointer and the preview re-renders at the new position.
5. **Commit** — Escape (when text is non-empty) or clicking outside the text bounding box commits the text. The text is rendered to the active layer's offscreen canvas via `fillText()`. Preview canvas is cleared. A `draw` history entry is pushed with before/after `ImageData`.
6. **Cancel** — Escape when the textarea is empty cancels without committing. Preview canvas is cleared, textarea is cleared and blurred.

### Click-outside behavior

Clicking outside the text bounding box while editing commits the current text. It does **not** simultaneously start a new text session — the user must click again to place new text. This avoids accidental double-placement.

## Font Controls

Displayed in `tool-settings.ts` when `activeTool === 'text'`:

- **Font family** — Dropdown with curated list: Sans-serif (default), Serif, Monospace, Arial, Georgia, Courier New, Verdana, Times New Roman.
- **Font size** — Numeric input, range 8–200px, default 24px.
- **Bold toggle** — Button, toggles `fontBold` state.
- **Italic toggle** — Button, toggles `fontItalic` state.
- **Color** — Uses existing `strokeColor` from context. No new color state.

Font settings are part of `DrawingState` and persist across text placements within a session.

## Architecture

### New state fields

Add to `DrawingState` in `types.ts`:

```typescript
fontFamily: string;   // default: 'sans-serif'
fontSize: number;     // default: 24
fontBold: boolean;    // default: false
fontItalic: boolean;  // default: false
```

### New context methods

Add to `DrawingContextValue` in `drawing-context.ts`:

```typescript
setFontFamily(family: string): void;
setFontSize(size: number): void;
setFontBold(bold: boolean): void;
setFontItalic(italic: boolean): void;
```

Wired in `drawing-app.ts` like existing setters.

### ToolType union

Add `'text'` to the `ToolType` union in `types.ts`.

### Tool icon and toolbar

- **tool-icons.ts**: Add SVG icon (a "T" letterform), keyboard shortcut `'T'`, label `'Text'`.
- **app-toolbar.ts**: Add `'text'` to a tool group. Place it alongside `fill` and `stamp`: `['fill', 'stamp', 'text']`.

### Tool function: `src/tools/text.ts`

Exports two functions:

```typescript
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
  color: string,
): void;
```

Renders multi-line text (split by `\n`) line by line using `ctx.fillText()`. Each line is offset vertically by `fontSize * lineHeightMultiplier` (use 1.2). Sets `ctx.font` from the bold/italic/size/family combination. Sets `ctx.fillStyle` to the color. Uses `ctx.textBaseline = 'top'` for consistent positioning.

```typescript
export function measureTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
): { width: number; height: number; lineWidths: number[] };
```

Measures the bounding box of the full text block. Returns the max line width, total height (lines * fontSize * 1.2), and an array of per-line widths (used for cursor x-positioning).

### Text editing state in `drawing-canvas.ts`

New private fields:

- `_textEditing: boolean` — whether a text session is active
- `_textPosition: Point` — document-space origin of the text block
- `_textDragging: boolean` — whether the text block is being dragged
- `_textDragOffset: Point` — offset from pointer to text origin during drag
- `_textAreaEl: HTMLTextAreaElement` — the hidden textarea element
- `_textCursorVisible: boolean` — toggled by blink interval
- `_textCursorInterval: number` — setInterval handle for blink

#### Hidden textarea setup

Created in `connectedCallback()`. Styled with `position: absolute; left: -9999px; top: -9999px; opacity: 0;` to keep it off-screen but focusable. Added to the component's shadow DOM.

Event listeners:
- `input` — re-render preview
- `keydown` — handle Escape (commit/cancel)
- `selectionchange` (on `document`) — re-render preview to update cursor position

#### Preview rendering

On each input/selection change:
1. Clear the preview canvas.
2. Build the font string: `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`.
3. Call `drawText()` on the preview canvas context at `_textPosition` (transformed to viewport space via the current pan/zoom).
4. Calculate cursor position:
   - Get `selectionStart` from textarea.
   - Split text into lines at `\n`.
   - Find which line the cursor is on and the character offset within that line.
   - Measure the text prefix up to the cursor on that line with `ctx.measureText()` to get x-offset.
   - y-offset = line index * fontSize * 1.2.
5. If `_textCursorVisible`, draw a 2px-wide vertical line at the cursor position, height = fontSize, color = strokeColor.
6. Draw a dashed border rectangle around the text bounding box (for drag affordance).

#### Pointer event integration

In `_onPointerDown`:
- If `_textEditing` is true and pointer is **inside** the text bounding box: start drag (`_textDragging = true`, record offset).
- If `_textEditing` is true and pointer is **outside** the text bounding box: commit current text.
- If `_textEditing` is false and tool is `'text'`: start new session — set `_textPosition`, focus textarea, start cursor blink interval.

In `_onPointerMove`:
- If `_textDragging`: update `_textPosition` by pointer delta, re-render preview.

In `_onPointerUp`:
- If `_textDragging`: stop drag (`_textDragging = false`).

#### Commit

1. If textarea value is empty, cancel instead.
2. Call `_captureBeforeDraw()` on the active layer.
3. Get the active layer's context via `_getActiveLayerCtx()`.
4. Call `drawText()` on the layer context at `_textPosition`.
5. Call `_pushDrawHistory()`.
6. Call `composite()` to update the display canvas.
7. Clear: set `_textEditing = false`, clear textarea value, blur textarea, clear preview canvas, stop cursor blink interval.

#### Cancel

Clear: set `_textEditing = false`, clear textarea value, blur textarea, clear preview canvas, stop cursor blink interval. No history entry.

### Tool settings UI

In `tool-settings.ts`, when `activeTool === 'text'`, render:

- A `<select>` for font family with the curated list.
- A number `<input>` for font size (min 8, max 200, step 1).
- A `<button>` for bold (styled as toggle, shows "B" in bold).
- A `<button>` for italic (styled as toggle, shows "I" in italic).

These controls dispatch to the context setters. Style consistently with existing tool-settings controls (brush size input, color pickers).

### History

Text commits use the existing `draw` history entry type — `ImageData` before/after on the active layer. No new history entry type needed.

### Keyboard shortcut conflicts

While a text session is active, keyboard shortcuts (tool switching via single keys like `B`, `E`, etc.) must be suppressed to avoid interfering with typing. The keydown handler in `drawing-canvas.ts` (or wherever shortcuts are handled) should check `_textEditing` and skip shortcut dispatch when true. Escape is the only key handled specially during editing.

## Edge Cases

- **Empty commit**: Escape with empty textarea cancels silently (no history entry).
- **Tool switch during editing**: If the user switches tools while editing, commit the current text first (if non-empty), then switch.
- **Zoom/pan during editing**: Text position is in document space, so zoom/pan should work correctly. The preview rendering transforms the position to viewport space. Hand tool (middle-click pan, pinch zoom) should remain functional during text editing.
- **Layer switch during editing**: Commit current text to the previously active layer before switching.
- **Very long text**: No explicit line wrapping — text extends as far as the user types on a single line. Users control line breaks with Enter.
- **Canvas resize during editing**: Text position is in document space and should remain stable.

## Out of Scope

- Text re-editing after commit (text is rasterized pixels, consistent with all other tools).
- Auto line wrapping / text box width constraints.
- Text alignment (left/center/right).
- Underline, strikethrough, or other decorations.
- Per-character styling (mixed fonts/sizes within one text block).
- Text along a path or curved text.

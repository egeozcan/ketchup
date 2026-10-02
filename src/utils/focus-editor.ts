// src/utils/focus-editor.ts

/**
 * Moves keyboard focus to the editor (`drawing-app`, whose keydown listener
 * holds the shortcuts) from a control inside it that is done with it, so
 * focus doesn't fall to the page, where no shortcut is heard. Returns false
 * when no host up the shadow tree takes focus (an embedded editor without a
 * tabindex).
 */
export function focusEditor(from: Node): boolean {
  for (let root = from.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    const host = root.host as HTMLElement;
    if (host.tabIndex >= 0) {
      host.focus({ preventScroll: true });
      return true;
    }
    // Not past the editor: what wraps it doesn't hear its shortcuts.
    if (host.localName === 'drawing-app') return false;
  }
  return false;
}

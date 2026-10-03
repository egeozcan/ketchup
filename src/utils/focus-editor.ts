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

/** The editor (`drawing-app`) a node is part of, through the shadow trees it sits in. */
export function editorOf(node: Node): HTMLElement | null {
  for (let root = node.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    if (root.host.localName === 'drawing-app') return root.host as HTMLElement;
  }
  return null;
}

/** Whether `node` is `ancestor` or inside it, counting a shadow root as inside its host. */
export function containsAcrossShadows(ancestor: Node, node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) {
    if (n === ancestor) return true;
  }
  return false;
}

/**
 * Whether a key is for the editor `el` is part of: typed inside it, or with
 * nothing focused. A menu it has open shouldn't take Escape from another
 * editor on the page, or from the host page's own fields.
 */
export function keyIsForEditorOf(el: Node, e: KeyboardEvent): boolean {
  const editor = editorOf(el);
  return !editor || e.composedPath().includes(editor)
    || e.target === document.body || e.target === document.documentElement;
}

// Loads the rich text editor (TipTap) on demand; shared by RichTextEditor and
// pages that load it ahead of time.
export const loadRichTextEditor = () => import('../components/RichTextEditorImpl')

/** Loads the editor ahead of time (pages used on site, where the signal may drop later). */
export function preloadRichTextEditor() {
  void loadRichTextEditor().catch(() => undefined)
}

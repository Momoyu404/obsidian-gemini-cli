function isVisible(el: Element | null): boolean {
  if (!el) return false;

  const maybeClassList = (el as { classList?: { contains?: (cls: string) => boolean } }).classList;
  if (maybeClassList?.contains) {
    return !maybeClassList.contains('geminese-hidden');
  }

  const maybeStyle = (el as { style?: { display?: string } }).style;
  return maybeStyle?.display !== 'none';
}

export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.geminese-selection-indicator');
  const browserIndicator = contextRowEl.querySelector('.geminese-browser-selection-indicator');
  const canvasIndicator = contextRowEl.querySelector('.geminese-canvas-indicator');
  const fileIndicator = contextRowEl.querySelector('.geminese-file-indicator');
  const imagePreview = contextRowEl.querySelector('.geminese-image-preview');

  const hasEditorSelection = isVisible(editorIndicator);
  const hasBrowserSelection = isVisible(browserIndicator);
  const hasCanvasSelection = isVisible(canvasIndicator);
  const hasFileChips = isVisible(fileIndicator);
  const hasImageChips = isVisible(imagePreview);

  contextRowEl.classList.toggle(
    'has-content',
    hasEditorSelection || hasBrowserSelection || hasCanvasSelection || hasFileChips || hasImageChips
  );
}

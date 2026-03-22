export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.geminese-selection-indicator');
  const browserIndicator = contextRowEl.querySelector('.geminese-browser-selection-indicator');
  const canvasIndicator = contextRowEl.querySelector('.geminese-canvas-indicator');
  const fileIndicator = contextRowEl.querySelector('.geminese-file-indicator');
  const imagePreview = contextRowEl.querySelector('.geminese-image-preview');

  const hasEditorSelection = editorIndicator !== null && !editorIndicator.classList.contains('geminese-hidden');
  const hasBrowserSelection = browserIndicator !== null && !browserIndicator.classList.contains('geminese-hidden');
  const hasCanvasSelection = canvasIndicator !== null && !canvasIndicator.classList.contains('geminese-hidden');
  const hasFileChips = fileIndicator !== null && !fileIndicator.classList.contains('geminese-hidden');
  const hasImageChips = imagePreview !== null && !imagePreview.classList.contains('geminese-hidden');

  contextRowEl.classList.toggle(
    'has-content',
    hasEditorSelection || hasBrowserSelection || hasCanvasSelection || hasFileChips || hasImageChips
  );
}

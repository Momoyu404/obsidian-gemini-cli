export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.geminese-selection-indicator') as HTMLElement | null;
  const browserIndicator = contextRowEl.querySelector('.geminese-browser-selection-indicator') as HTMLElement | null;
  const canvasIndicator = contextRowEl.querySelector('.geminese-canvas-indicator') as HTMLElement | null;
  const fileIndicator = contextRowEl.querySelector('.geminese-file-indicator') as HTMLElement | null;
  const imagePreview = contextRowEl.querySelector('.geminese-image-preview') as HTMLElement | null;

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

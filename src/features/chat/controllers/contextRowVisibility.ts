export function updateContextRowHasContent(contextRowEl: HTMLElement): void {
  const editorIndicator = contextRowEl.querySelector('.obsidian-gemini-selection-indicator') as HTMLElement | null;
  const browserIndicator = contextRowEl.querySelector('.obsidian-gemini-browser-selection-indicator') as HTMLElement | null;
  const canvasIndicator = contextRowEl.querySelector('.obsidian-gemini-canvas-indicator') as HTMLElement | null;
  const fileIndicator = contextRowEl.querySelector('.obsidian-gemini-file-indicator') as HTMLElement | null;
  const imagePreview = contextRowEl.querySelector('.obsidian-gemini-image-preview') as HTMLElement | null;

  const hasEditorSelection = editorIndicator?.style.display === 'block';
  const hasBrowserSelection = browserIndicator !== null && browserIndicator.style.display === 'block';
  const hasCanvasSelection = canvasIndicator?.style.display === 'block';
  const hasFileChips = fileIndicator?.style.display === 'flex';
  const hasImageChips = imagePreview?.style.display === 'flex';

  contextRowEl.classList.toggle(
    'has-content',
    hasEditorSelection || hasBrowserSelection || hasCanvasSelection || hasFileChips || hasImageChips
  );
}

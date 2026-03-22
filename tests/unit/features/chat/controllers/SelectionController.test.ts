/** @jest-environment jsdom */

import { SelectionController } from '@/features/chat/controllers/SelectionController';
import { hideSelectionHighlight, showSelectionHighlight } from '@/shared/components/SelectionHighlight';

jest.mock('@/shared/components/SelectionHighlight', () => ({
  showSelectionHighlight: jest.fn(),
  hideSelectionHighlight: jest.fn(),
}));

function createMockIndicator() {
  return {
    textContent: '',
    style: { display: 'none' },
  } as any;
}

function createMockInput() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    addEventListener: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      const handlers = listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
      handlers.add(listener);
      listeners.set(event, handlers);
    }),
    removeEventListener: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    trigger: (event: string) => {
      listeners.get(event)?.forEach(handler => handler());
    },
  } as any;
}

function createMockContextRow() {
  const elements: Record<string, any> = {
    '.geminese-selection-indicator': { style: { display: 'none' } },
    '.geminese-browser-selection-indicator': null,
    '.geminese-canvas-indicator': { style: { display: 'none' } },
    '.geminese-file-indicator': null,
    '.geminese-image-preview': null,
  };

  return {
    classList: {
      toggle: jest.fn(),
    },
    querySelector: jest.fn((selector: string) => elements[selector] ?? null),
  } as any;
}

/**
 * Helper to trigger a selectionchange event and advance past the debounce.
 * The SelectionController listens to document 'selectionchange' with 100ms debounce.
 */
function triggerSelectionChange() {
  document.dispatchEvent(new Event('selectionchange'));
  jest.advanceTimersByTime(100);
}

describe('SelectionController', () => {
  let controller: SelectionController;
  let app: any;
  let indicatorEl: any;
  let inputEl: any;
  let contextRowEl: any;
  let editor: any;
  let editorView: any;

  beforeEach(() => {
    jest.useFakeTimers();
    (showSelectionHighlight as jest.Mock).mockClear();
    (hideSelectionHighlight as jest.Mock).mockClear();

    indicatorEl = createMockIndicator();
    inputEl = createMockInput();
    contextRowEl = createMockContextRow();

    editorView = { id: 'editor-view' };
    editor = {
      getSelection: jest.fn().mockReturnValue('selected text'),
      getCursor: jest.fn((which: 'from' | 'to') => {
        if (which === 'from') return { line: 0, ch: 0 };
        return { line: 0, ch: 4 };
      }),
      posToOffset: jest.fn((pos: { line: number; ch: number }) => pos.line * 100 + pos.ch),
      cm: editorView,
    };

    const view = { editor, file: { path: 'notes/test.md' } };
    app = {
      workspace: {
        getActiveViewOfType: jest.fn().mockReturnValue(view),
      },
    };

    controller = new SelectionController(app, indicatorEl, inputEl, contextRowEl);
  });

  afterEach(() => {
    controller.stop();
    jest.useRealTimers();
  });

  it('captures selection and updates indicator via selectionchange event', () => {
    controller.start();
    triggerSelectionChange();

    expect(controller.hasSelection()).toBe(true);
    expect(controller.getContext()).toEqual({
      notePath: 'notes/test.md',
      mode: 'selection',
      selectedText: 'selected text',
      lineCount: 1,
      startLine: 1,
    });
    expect(indicatorEl.textContent).toBe('1 line selected');
    expect(indicatorEl.style.display).toBe('block');

    controller.showHighlight();
    expect(showSelectionHighlight).toHaveBeenCalledWith(editorView, 0, 4);
  });

  it('clears selection immediately when deselected without input handoff intent', () => {
    controller.start();
    triggerSelectionChange();

    editor.getSelection.mockReturnValue('');
    triggerSelectionChange();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('clears markdown selection when active view is no longer markdown', () => {
    controller.start();
    triggerSelectionChange();
    expect(controller.hasSelection()).toBe(true);

    app.workspace.getActiveViewOfType.mockReturnValue(null);
    triggerSelectionChange();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.style.display).toBe('none');
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('preserves selection when input focus arrives after a slow editor blur handoff', () => {
    controller.start();
    triggerSelectionChange();

    inputEl.trigger('pointerdown');
    editor.getSelection.mockReturnValue('');

    // Simulate delayed focus handoff under UI load.
    triggerSelectionChange();
    jest.advanceTimersByTime(1250);
    expect(controller.hasSelection()).toBe(true);
  });

  it('clears selection after handoff grace expires when input never receives focus', () => {
    controller.start();
    triggerSelectionChange();

    inputEl.trigger('pointerdown');
    editor.getSelection.mockReturnValue('');

    // Within grace period
    triggerSelectionChange();
    expect(controller.hasSelection()).toBe(true);

    // After grace expires (1500ms total)
    jest.advanceTimersByTime(1600);
    triggerSelectionChange();
    expect(controller.hasSelection()).toBe(false);
    expect(hideSelectionHighlight).toHaveBeenCalledWith(editorView);
  });

  it('keeps context row visible when canvas selection indicator is visible', () => {
    const canvasIndicator = { style: { display: 'block' } };
    contextRowEl.querySelector.mockImplementation((selector: string) => {
      if (selector === '.geminese-canvas-indicator') return canvasIndicator;
      return null;
    });

    controller.updateContextRowVisibility();

    expect(contextRowEl.classList.toggle).toHaveBeenCalledWith('has-content', true);
  });
});

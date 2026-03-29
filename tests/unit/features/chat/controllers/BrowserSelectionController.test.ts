/** @jest-environment jsdom */

import { BrowserSelectionController } from '@/features/chat/controllers/BrowserSelectionController';

function createMockIndicator() {
  const indicatorEl = document.createElement('div');
  indicatorEl.classList.add('geminese-hidden');
  return indicatorEl;
}

function createMockContextRow(browserIndicator: HTMLElement) {
  const fileIndicator = { style: { display: 'none' } };
  const imagePreview = { style: { display: 'none' } };
  const elements: Record<string, any> = {
    '.geminese-selection-indicator': { style: { display: 'none' } },
    '.geminese-browser-selection-indicator': browserIndicator,
    '.geminese-canvas-indicator': { style: { display: 'none' } },
    '.geminese-file-indicator': fileIndicator,
    '.geminese-image-preview': imagePreview,
  };

  return {
    classList: {
      toggle: jest.fn(),
    },
    querySelector: jest.fn((selector: string) => elements[selector] ?? null),
  } as any;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Helper to trigger a selection change via event + debounce. */
function triggerSelectionChange() {
  document.dispatchEvent(new Event('selectionchange'));
  // Advance past the 100ms debounce
  jest.advanceTimersByTime(100);
}

describe('BrowserSelectionController', () => {
  let controller: BrowserSelectionController;
  let app: any;
  let indicatorEl: any;
  let inputEl: HTMLTextAreaElement;
  let contextRowEl: any;
  let containerEl: HTMLElement;
  let selectionText = 'selected web snippet';
  let getSelectionSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    selectionText = 'selected web snippet';

    indicatorEl = createMockIndicator();
    inputEl = document.createElement('textarea');
    document.body.appendChild(inputEl);
    contextRowEl = createMockContextRow(indicatorEl);
    containerEl = document.createElement('div');
    const selectionAnchor = document.createElement('span');
    containerEl.appendChild(selectionAnchor);

    getSelectionSpy = jest.spyOn(document, 'getSelection').mockImplementation(() => ({
      toString: () => selectionText,
      anchorNode: selectionAnchor,
      focusNode: selectionAnchor,
    } as unknown as Selection));

    const view = {
      getViewType: () => 'surfing-view',
      getDisplayText: () => 'Surfing',
      containerEl,
      currentUrl: 'https://example.com',
    };

    app = {
      workspace: {
        activeLeaf: { view },
        getMostRecentLeaf: jest.fn(() => ({ view })),
      },
    };

    controller = new BrowserSelectionController(app, indicatorEl, inputEl, contextRowEl);
  });

  afterEach(() => {
    controller.stop();
    inputEl.remove();
    getSelectionSpy.mockRestore();
    jest.useRealTimers();
  });

  it('captures browser selection and updates indicator via selectionchange event', async () => {
    controller.start();
    triggerSelectionChange();
    await flushMicrotasks();

    expect(controller.getContext()).toEqual({
      source: 'browser:https://example.com',
      selectedText: 'selected web snippet',
      title: 'Surfing',
      url: 'https://example.com',
    });
    expect(indicatorEl.classList.contains('geminese-hidden')).toBe(false);
    expect(indicatorEl.textContent).toBe('1 line selected');
    expect(indicatorEl.textContent).not.toContain('source=');
    expect(indicatorEl.getAttribute('title')).toContain('chars selected');
    expect(indicatorEl.getAttribute('title')).toContain('source=browser:https://example.com');
    expect(indicatorEl.getAttribute('title')).toContain('title=Surfing');
    expect(indicatorEl.getAttribute('title')).toContain('https://example.com');
  });

  it('captures browser selection via reduced-frequency webview polling', async () => {
    controller.start();
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(controller.getContext()).toEqual({
      source: 'browser:https://example.com',
      selectedText: 'selected web snippet',
      title: 'Surfing',
      url: 'https://example.com',
    });
  });

  it('shows line-based indicator text for multi-line browser selection', async () => {
    selectionText = 'line 1\nline 2';
    controller.start();
    triggerSelectionChange();
    await flushMicrotasks();

    expect(indicatorEl.textContent).toBe('2 lines selected');
  });

  it('clears selection when text is deselected and input is not focused', async () => {
    controller.start();
    triggerSelectionChange();
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    triggerSelectionChange();
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.classList.contains('geminese-hidden')).toBe(true);
  });

  it('keeps selection while input is focused', async () => {
    controller.start();
    triggerSelectionChange();
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    selectionText = '';
    inputEl.focus();
    triggerSelectionChange();
    await flushMicrotasks();

    expect(controller.hasSelection()).toBe(true);
  });

  it('clears selection when clear is called', async () => {
    controller.start();
    triggerSelectionChange();
    await flushMicrotasks();
    expect(controller.hasSelection()).toBe(true);

    controller.clear();

    expect(controller.hasSelection()).toBe(false);
    expect(indicatorEl.classList.contains('geminese-hidden')).toBe(true);
  });

  it('handles polling errors without unhandled rejection', async () => {
    const extractSpy = jest.spyOn(controller as any, 'extractSelectedText')
      .mockRejectedValueOnce(new Error('poll failed'));

    controller.start();
    triggerSelectionChange();
    await flushMicrotasks();

    expect(extractSpy).toHaveBeenCalled();
    expect(controller.hasSelection()).toBe(false);
  });
});

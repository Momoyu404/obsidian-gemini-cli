import { createMockEl } from '../helpers/mockElement';

const globalWithRaf = globalThis as typeof globalThis & {
  cancelAnimationFrame?: typeof cancelAnimationFrame;
  DOMParser?: typeof DOMParser;
  document?: Document;
  requestAnimationFrame?: typeof requestAnimationFrame;
};

if (typeof globalWithRaf.requestAnimationFrame !== 'function') {
  globalWithRaf.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    return setTimeout(() => {
      callback(globalThis.performance?.now?.() ?? Date.now());
    }, 0) as unknown as number;
  }) as typeof requestAnimationFrame;
}

if (typeof globalWithRaf.cancelAnimationFrame !== 'function') {
  globalWithRaf.cancelAnimationFrame = ((handle: number) => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }) as typeof cancelAnimationFrame;
}

if (!globalWithRaf.document) {
  globalWithRaf.document = {} as typeof globalWithRaf.document;
}

const mockDocument = globalWithRaf.document as Record<string, any>;

if (!mockDocument.documentElement) {
  mockDocument.documentElement = { style: {} };
} else if (!mockDocument.documentElement.style) {
  mockDocument.documentElement.style = {};
}

if (!mockDocument.body) {
  mockDocument.body = createMockEl('body') as unknown as HTMLElement;
}

if (typeof mockDocument.createElement !== 'function') {
  mockDocument.createElement = (tagName: string) =>
    createMockEl(tagName) as unknown as HTMLElement;
}

if (typeof mockDocument.adoptNode !== 'function') {
  mockDocument.adoptNode = <T>(node: T): T => node;
}

if (typeof mockDocument.createElementNS !== 'function') {
  mockDocument.createElementNS = (_namespace: string, qualifiedName: string) =>
    createMockEl(qualifiedName) as unknown as Element;
}

if (typeof globalWithRaf.DOMParser !== 'function') {
  class MockDOMParser {
    parseFromString(): { documentElement: Element } {
      return { documentElement: createMockEl('svg') as unknown as Element };
    }
  }

  globalWithRaf.DOMParser = MockDOMParser as unknown as typeof DOMParser;
}

import { fetchOllamaModels, normalizeOllamaBaseUrl } from '@/utils/ollama';

describe('ollama utils', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('normalizes the base URL and falls back to the local default', () => {
    expect(normalizeOllamaBaseUrl()).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
  });

  it('loads and sorts Ollama models', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'zeta:latest' },
          { name: 'alpha:8b' },
        ],
      }),
    } as Response);

    await expect(fetchOllamaModels('http://127.0.0.1:11434')).resolves.toEqual([
      { name: 'alpha:8b', modifiedAt: undefined, size: undefined },
      { name: 'zeta:latest', modifiedAt: undefined, size: undefined },
    ]);
  });

  it('surfaces Ollama API errors with context', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ error: 'model not found' }),
    } as Response);

    await expect(fetchOllamaModels()).rejects.toThrow('model not found');
  });
});

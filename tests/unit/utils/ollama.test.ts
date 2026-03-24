import {
  fetchOllamaModels,
  normalizeOllamaBaseUrl,
  OLLAMA_AGENT_ENVELOPE_SCHEMA,
  OllamaEnvelopeParseError,
  parseOllamaAgentEnvelope,
  requestOllamaChat,
} from '@/utils/ollama';

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

  it('parses tool_call envelopes, including fenced JSON', () => {
    expect(parseOllamaAgentEnvelope('```json\n{"type":"tool_call","tool":"Read","input":{"file_path":"note.md"}}\n```')).toEqual({
      type: 'tool_call',
      tool: 'Read',
      input: { file_path: 'note.md' },
    });
  });

  it('parses final_answer envelopes', () => {
    expect(parseOllamaAgentEnvelope('{"type":"final_answer","content":"Done"}')).toEqual({
      type: 'final_answer',
      content: 'Done',
    });
  });

  it('rejects malformed agent envelopes', () => {
    expect(() => parseOllamaAgentEnvelope('{"type":"tool_call","tool":"Write","input":{}}'))
      .toThrow('supported tool');
  });

  it('classifies missing JSON envelopes', () => {
    let thrown: unknown;

    try {
      parseOllamaAgentEnvelope('Here is the answer in plain text.');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OllamaEnvelopeParseError);
    expect((thrown as OllamaEnvelopeParseError).reason).toBe('missing_json');
  });

  it('requests non-streamed chat responses from Ollama', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'llama3.1',
        message: { role: 'assistant', content: '{"type":"final_answer","content":"ok"}' },
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    } as Response);

    await expect(requestOllamaChat('http://127.0.0.1:11434', {
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'hello' }],
    })).resolves.toMatchObject({
      model: 'llama3.1',
      prompt_eval_count: 10,
      eval_count: 5,
    });

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0]?.[1] as { body: string } | undefined;
    expect(fetchCall).toBeDefined();
    expect(fetchCall?.body).toContain(JSON.stringify(OLLAMA_AGENT_ENVELOPE_SCHEMA));
    expect(fetchCall?.body).toContain('"format"');
  });
});

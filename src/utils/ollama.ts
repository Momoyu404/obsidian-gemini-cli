export interface OllamaModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    modified_at?: string;
  }>;
}

export interface OllamaChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaChatChunk {
  model?: string;
  message?: {
    role?: 'assistant';
    content?: string;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  return trimmed.replace(/\/+$/, '');
}

async function readJsonError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; message?: string };
    return body.error || body.message || response.statusText;
  } catch {
    try {
      const text = await response.text();
      return text.trim() || response.statusText;
    } catch {
      return response.statusText;
    }
  }
}

export async function fetchOllamaModels(
  baseUrl?: string,
  signal?: AbortSignal,
): Promise<OllamaModelInfo[]> {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl);
  const response = await globalThis.fetch(`${normalizedBaseUrl}/api/tags`, {
    method: 'GET',
    signal,
  });

  if (!response.ok) {
    const errorText = await readJsonError(response);
    throw new Error(`Failed to load Ollama models: ${errorText}`);
  }

  const payload = await response.json() as OllamaTagsResponse;
  const models = payload.models ?? [];
  const result: OllamaModelInfo[] = [];

  for (const model of models) {
    if (typeof model.name !== 'string' || model.name.trim().length === 0) continue;
    result.push({
      name: model.name.trim(),
      size: model.size,
      modifiedAt: model.modified_at,
    });
  }

  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export async function* streamOllamaChat(
  baseUrl: string,
  body: {
    model: string;
    messages: OllamaChatMessage[];
  },
  signal?: AbortSignal,
): AsyncGenerator<OllamaChatChunk> {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl);
  const response = await globalThis.fetch(`${normalizedBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await readJsonError(response);
    throw new Error(`Ollama request failed: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('Ollama response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        yield JSON.parse(trimmed) as OllamaChatChunk;
      } catch {
        // Ignore malformed streaming lines.
      }
    }
  }

  const tail = buffer.trim();
  if (!tail) return;

  try {
    yield JSON.parse(tail) as OllamaChatChunk;
  } catch {
    // Ignore malformed tail payload.
  }
}

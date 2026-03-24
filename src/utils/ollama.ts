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

export interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: 'assistant';
    content?: string;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export const OLLAMA_AGENT_TOOL_NAMES = ['Read', 'LS', 'Glob', 'Grep'] as const;
export type OllamaAgentToolName = (typeof OLLAMA_AGENT_TOOL_NAMES)[number];

export interface OllamaToolCallEnvelope {
  type: 'tool_call';
  tool: OllamaAgentToolName;
  input: Record<string, unknown>;
}

export interface OllamaFinalAnswerEnvelope {
  type: 'final_answer';
  content: string;
}

export type OllamaAgentEnvelope =
  | OllamaToolCallEnvelope
  | OllamaFinalAnswerEnvelope;

export type OllamaEnvelopeParseErrorReason =
  | 'missing_json'
  | 'invalid_json'
  | 'invalid_shape';

export class OllamaEnvelopeParseError extends Error {
  readonly rawText: string;
  readonly reason: OllamaEnvelopeParseErrorReason;

  constructor(reason: OllamaEnvelopeParseErrorReason, message: string, rawText: string) {
    super(message);
    this.name = 'OllamaEnvelopeParseError';
    this.reason = reason;
    this.rawText = rawText;
  }
}

export const OLLAMA_AGENT_ENVELOPE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['tool_call'] },
        tool: { type: 'string', enum: [...OLLAMA_AGENT_TOOL_NAMES] },
        input: { type: 'object' },
      },
      required: ['type', 'tool', 'input'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['final_answer'] },
        content: { type: 'string' },
      },
      required: ['type', 'content'],
      additionalProperties: false,
    },
  ],
} as const;

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export function normalizeOllamaBaseUrl(baseUrl?: string): string {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  return trimmed.replace(/\/+$/, '');
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function extractJsonObject(text: string): string | null {
  const cleaned = stripCodeFence(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function isToolName(value: unknown): value is OllamaAgentToolName {
  return typeof value === 'string' && (OLLAMA_AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

export function parseOllamaAgentEnvelope(text: string): OllamaAgentEnvelope {
  const jsonObject = extractJsonObject(text);
  if (!jsonObject) {
    throw new OllamaEnvelopeParseError(
      'missing_json',
      'Ollama response did not contain a JSON object.',
      text,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObject);
  } catch {
    throw new OllamaEnvelopeParseError(
      'invalid_json',
      'Ollama response JSON could not be parsed.',
      text,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OllamaEnvelopeParseError(
      'invalid_shape',
      'Ollama response JSON must be an object.',
      text,
    );
  }

  const record = parsed as Record<string, unknown>;

  if (record.type === 'final_answer') {
    if (typeof record.content !== 'string' || record.content.trim().length === 0) {
      throw new OllamaEnvelopeParseError(
        'invalid_shape',
        'Ollama final_answer responses must include non-empty content.',
        text,
      );
    }
    return {
      type: 'final_answer',
      content: record.content,
    };
  }

  if (record.type === 'tool_call') {
    if (!isToolName(record.tool)) {
      throw new OllamaEnvelopeParseError(
        'invalid_shape',
        'Ollama tool_call responses must specify a supported tool.',
        text,
      );
    }
    if (typeof record.input !== 'object' || record.input === null || Array.isArray(record.input)) {
      throw new OllamaEnvelopeParseError(
        'invalid_shape',
        'Ollama tool_call responses must include an input object.',
        text,
      );
    }
    return {
      type: 'tool_call',
      tool: record.tool,
      input: record.input as Record<string, unknown>,
    };
  }

  throw new OllamaEnvelopeParseError(
    'invalid_shape',
    'Ollama response type must be "tool_call" or "final_answer".',
    text,
  );
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

export async function requestOllamaChat(
  baseUrl: string,
  body: {
    model: string;
    messages: OllamaChatMessage[];
  },
  signal?: AbortSignal,
): Promise<OllamaChatResponse> {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl);
  const response = await globalThis.fetch(`${normalizedBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      format: OLLAMA_AGENT_ENVELOPE_SCHEMA,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await readJsonError(response);
    throw new Error(`Ollama request failed: ${errorText}`);
  }

  return await response.json() as OllamaChatResponse;
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

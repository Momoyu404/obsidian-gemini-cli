import type { UsageInfo } from '../types';
import { isBlockedMessage } from '../types';
import { getContextWindowSize } from '../types';
import type { TransformEvent } from './types';

type GeminiContentBlock =
  | {
      type: 'text';
      text?: string;
    }
  | {
      type: 'thinking';
      thinking?: string;
    }
  | {
      type: 'tool_use';
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };

type LegacyAssistantMessage = {
  type: 'assistant';
  parent_tool_use_id?: string | null;
  error?: string;
  message?: {
    content?: GeminiContentBlock[];
    usage?: {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
};

type LegacyUserMessage = {
  type: 'user';
  _blocked?: true;
  _blockReason?: string;
  message?: {
    content?: GeminiContentBlock[];
  };
  parent_tool_use_id?: string | null;
  tool_use_result?: unknown;
};

type LegacySystemMessage = {
  type: 'system';
  agents?: string[];
  permissionMode?: string;
  session_id?: string;
  subtype?: string;
};

type LegacyStreamEventMessage = {
  type: 'stream_event';
  event?: {
    content_block?: {
      id?: string;
      input?: Record<string, unknown>;
      name?: string;
      text?: string;
      thinking?: string;
      type?: string;
    };
    delta?: {
      text?: string;
      thinking?: string;
      type?: string;
    };
    type?: string;
  };
  parent_tool_use_id?: string | null;
};

type LegacyResultMessage = {
  type: 'result';
  errors?: string[];
  stats?: {
    [key: string]: unknown;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  subtype?: string;
};

export interface GeminiEvent {
  type:
    | 'assistant'
    | 'auth_status'
    | 'error'
    | 'init'
    | 'message'
    | 'result'
    | 'stream_event'
    | 'system'
    | 'thought'
    | 'tool_progress'
    | 'tool_result'
    | 'tool_use'
    | 'user';
  // init / system fields
  agents?: string[];
  model?: string;
  permissionMode?: string;
  session_id?: string;
  subtype?: string;
  // current message fields
  content?: string;
  delta?: boolean;
  role?: 'assistant' | 'user';
  // current tool fields
  args?: Record<string, unknown>;
  id?: string;
  is_error?: boolean;
  name?: string;
  output?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  tool_id?: string;
  tool_name?: string;
  // legacy assistant / user
  error?: string;
  message?: {
    content?: GeminiContentBlock[] | string;
    role?: string;
    usage?: {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  parent_tool_use_id?: string | null;
  tool_use_result?: unknown;
  _blocked?: true;
  _blockReason?: string;
  // legacy stream_event
  event?: LegacyStreamEventMessage['event'];
  // result stats
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
  errors?: string[];
}

export interface TransformOptions {
  intendedModel?: string;
  customContextLimits?: Record<string, number>;
}

function buildUsageInfo(
  inputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
  model: string,
  customContextLimits?: Record<string, number>,
): UsageInfo {
  const contextWindow = getContextWindowSize(model, customContextLimits);
  const contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

  return {
    model,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextWindow,
    contextTokens,
    percentage,
  };
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === undefined) {
    return '';
  }
  return JSON.stringify(content, null, 2);
}

function getNonEmptyText(text: string | undefined): string | null {
  if (!text) return null;
  if (!text.trim()) return null;
  if (text.trim() === '(no content)') return null;
  return text;
}

function* transformLegacyAssistantMessage(
  message: LegacyAssistantMessage,
  options?: TransformOptions,
): Generator<TransformEvent> {
  if (message.error) {
    yield { type: 'error', content: message.error };
  }

  const parentToolUseId = message.parent_tool_use_id ?? null;
  const contentBlocks = Array.isArray(message.message?.content)
    ? message.message?.content
    : [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      const text = getNonEmptyText(block.text);
      if (text) {
        yield { type: 'text', content: text, parentToolUseId };
      }
      continue;
    }

    if (block.type === 'thinking') {
      const thinking = getNonEmptyText(block.thinking);
      if (thinking) {
        yield { type: 'thinking', content: thinking, parentToolUseId };
      }
      continue;
    }

    if (block.type === 'tool_use') {
      yield {
        type: 'tool_use',
        id: block.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: block.name || 'unknown',
        input: block.input || {},
        parentToolUseId,
      };
    }
  }

  const usage = message.message?.usage;
  if (usage && parentToolUseId === null) {
    const model = options?.intendedModel ?? 'auto';
    yield {
      type: 'usage',
      usage: buildUsageInfo(
        usage.input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
        model,
        options?.customContextLimits,
      ),
    };
  }
}

function* transformLegacyUserMessage(message: LegacyUserMessage): Generator<TransformEvent> {
  if (isBlockedMessage(message as { type: string })) {
    yield { type: 'blocked', content: message._blockReason ?? 'Blocked' };
    return;
  }

  if (message.parent_tool_use_id && message.tool_use_result !== undefined) {
    yield {
      type: 'tool_result',
      id: message.parent_tool_use_id,
      content: contentToString(message.tool_use_result),
      isError: false,
      parentToolUseId: message.parent_tool_use_id,
      toolUseResult: message.tool_use_result as any,
    };
    return;
  }

  const contentBlocks = Array.isArray(message.message?.content)
    ? message.message?.content
    : [];

  for (const block of contentBlocks) {
    if (block.type !== 'tool_result') continue;
    yield {
      type: 'tool_result',
      id: block.tool_use_id || message.parent_tool_use_id || '',
      content: contentToString(block.content),
      isError: block.is_error || false,
      parentToolUseId: message.parent_tool_use_id ?? null,
    };
  }
}

function* transformLegacyStreamEvent(message: LegacyStreamEventMessage): Generator<TransformEvent> {
  const parentToolUseId = message.parent_tool_use_id ?? null;
  const event = message.event;
  if (!event?.type) return;

  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (!block?.type) return;

    if (block.type === 'tool_use') {
      yield {
        type: 'tool_use',
        id: block.id || `tool-${Date.now()}`,
        name: block.name || 'unknown',
        input: block.input || {},
        parentToolUseId,
      };
      return;
    }

    if (block.type === 'thinking') {
      const thinking = getNonEmptyText(block.thinking);
      if (thinking) {
        yield { type: 'thinking', content: thinking, parentToolUseId };
      }
      return;
    }

    if (block.type === 'text') {
      const text = getNonEmptyText(block.text);
      if (text) {
        yield { type: 'text', content: text, parentToolUseId };
      }
    }
    return;
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (!delta?.type) return;

    if (delta.type === 'thinking_delta') {
      const thinking = getNonEmptyText(delta.thinking);
      if (thinking) {
        yield { type: 'thinking', content: thinking, parentToolUseId };
      }
      return;
    }

    if (delta.type === 'text_delta') {
      const text = getNonEmptyText(delta.text);
      if (text) {
        yield { type: 'text', content: text, parentToolUseId };
      }
    }
  }
}

function* transformLegacySystemMessage(message: LegacySystemMessage): Generator<TransformEvent> {
  if (message.subtype === 'init') {
    yield {
      type: 'session_init',
      sessionId: message.session_id || '',
      agents: message.agents,
      permissionMode: message.permissionMode ?? 'default',
    };
    return;
  }

  if (message.subtype === 'compact_boundary') {
    yield { type: 'compact_boundary' };
  }
}

function* transformLegacyResultMessage(
  message: LegacyResultMessage,
  options?: TransformOptions,
): Generator<TransformEvent> {
  if (message.subtype && message.subtype !== 'success') {
    yield { type: 'error', content: message.errors?.[0] || 'Unknown error' };
    return;
  }

  if (message.stats) {
    const model = options?.intendedModel ?? 'auto';
    yield {
      type: 'usage',
      usage: buildUsageInfo(
        message.stats.input_tokens ?? 0,
        0,
        0,
        model,
        options?.customContextLimits,
      ),
    };
  }
}

export function* transformGeminiEvent(
  event: GeminiEvent,
  options?: TransformOptions
): Generator<TransformEvent> {
  switch (event.type) {
    case 'init':
      yield {
        type: 'session_init',
        sessionId: event.session_id || '',
        model: event.model,
        agents: [],
        permissionMode: undefined,
      };
      break;

    case 'message':
      if (event.role === 'assistant') {
        const text = getNonEmptyText(event.content);
        if (text) {
          yield { type: 'text', content: text, parentToolUseId: null };
        }
      }
      break;

    case 'thought': {
      const thinking = getNonEmptyText(event.content);
      if (thinking) {
        yield { type: 'thinking', content: thinking, parentToolUseId: null };
      }
      break;
    }

    case 'tool_use':
      yield {
        type: 'tool_use',
        id: event.tool_id || event.id || `tool-${Date.now()}`,
        name: event.tool_name || event.name || 'unknown',
        input: event.parameters || event.args || {},
        parentToolUseId: null,
      };
      break;

    case 'tool_result':
      yield {
        type: 'tool_result',
        id: event.tool_id || event.id || '',
        content: event.output || event.content || '',
        isError: event.is_error || event.status === 'error' || false,
        parentToolUseId: null,
      };
      break;

    case 'error':
      yield {
        type: 'error',
        content:
          (typeof event.message === 'string' ? event.message : undefined)
          ?? (typeof event.content === 'string' ? event.content : 'Unknown error'),
      };
      break;

    case 'result':
      yield* transformLegacyResultMessage(event as LegacyResultMessage, options);
      break;

    case 'assistant':
      yield* transformLegacyAssistantMessage(event as LegacyAssistantMessage, options);
      break;

    case 'user':
      yield* transformLegacyUserMessage(event as LegacyUserMessage);
      break;

    case 'stream_event':
      yield* transformLegacyStreamEvent(event as LegacyStreamEventMessage);
      break;

    case 'system':
      yield* transformLegacySystemMessage(event as LegacySystemMessage);
      break;

    case 'tool_progress':
    case 'auth_status':
    default:
      break;
  }
}

export function parseGeminiJsonLine(line: string): GeminiEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as GeminiEvent;
  } catch {
    return null;
  }
}

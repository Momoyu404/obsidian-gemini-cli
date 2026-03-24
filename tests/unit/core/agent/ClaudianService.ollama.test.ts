import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { GemineseService } from '@/core/agent/ClaudianService';
import type { McpServerManager } from '@/core/mcp';
import type GeminesePlugin from '@/main';
import * as ollamaUtils from '@/utils/ollama';

type MockMcpServerManager = jest.Mocked<McpServerManager>;

describe('GemineseService Ollama integration', () => {
  let tempRoot: string;
  let mockPlugin: Partial<GeminesePlugin>;
  let mockMcpManager: MockMcpServerManager;
  let service: GemineseService;

  async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
    const chunks: any[] = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }
    return chunks;
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'geminese-ollama-service-'));
    await fs.mkdir(path.join(tempRoot, 'notes'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'notes', 'today.md'), 'hello from the vault');

    mockPlugin = {
      app: {
        vault: { adapter: { basePath: tempRoot } },
      },
      settings: {
        model: 'ollama:llama3.1',
        customContextLimits: {},
        allowedExportPaths: [],
        mediaFolder: '',
        permissionMode: 'agent' as const,
        systemPrompt: '',
        userName: '',
      },
      getOllamaBaseUrl: jest.fn().mockReturnValue('http://127.0.0.1:11434'),
    } as unknown as GeminesePlugin;

    mockMcpManager = {
      loadServers: jest.fn().mockResolvedValue(undefined),
      getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
      getActiveServers: jest.fn().mockReturnValue({}),
      getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    } as unknown as MockMcpServerManager;

    service = new GemineseService(mockPlugin as GeminesePlugin, mockMcpManager);
    service.setActiveModel('ollama:llama3.1');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('executes read tools before producing a final Ollama answer', async () => {
    jest.spyOn(ollamaUtils, 'requestOllamaChat')
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '{"type":"tool_call","tool":"Read","input":{"file_path":"notes/today.md"}}',
        },
        prompt_eval_count: 12,
        eval_count: 3,
      })
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '{"type":"final_answer","content":"The current note says hello from the vault."}',
        },
        prompt_eval_count: 20,
        eval_count: 8,
      });

    const chunks = await collectChunks(service.query(
      'What does the current note say?\n\n<current_note>\nnotes/today.md\n</current_note>',
      undefined,
      [],
      { model: 'ollama:llama3.1' },
    ));

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', name: 'Read' }),
      expect.objectContaining({ type: 'tool_result', content: expect.stringContaining('FILE: notes/today.md') }),
      expect.objectContaining({ type: 'text', content: 'The current note says hello from the vault.' }),
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ model: 'llama3.1' }) }),
      expect.objectContaining({ type: 'done' }),
    ]));

    const secondRequestMessages = (ollamaUtils.requestOllamaChat as jest.Mock).mock.calls[1][1].messages;
    expect(secondRequestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Tool result for Read:') }),
    ]));
  });

  it('stops after the Ollama tool limit is exceeded', async () => {
    jest.spyOn(ollamaUtils, 'requestOllamaChat').mockResolvedValue({
      model: 'llama3.1',
      message: {
        role: 'assistant',
        content: '{"type":"tool_call","tool":"Read","input":{"file_path":"notes/today.md"}}',
      },
      prompt_eval_count: 1,
      eval_count: 1,
    });

    const chunks = await collectChunks(service.query(
      'Keep reading',
      undefined,
      [],
      { model: 'ollama:llama3.1' },
    ));

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        content: expect.stringContaining('8-step read/search limit'),
      }),
      expect.objectContaining({ type: 'done' }),
    ]));
  });

  it('retries once when Ollama returns malformed JSON and then recovers', async () => {
    jest.spyOn(ollamaUtils, 'requestOllamaChat')
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '{"type":"tool_call","tool":"Read","input":{"file_path":"notes/today.md"}}',
        },
        prompt_eval_count: 5,
        eval_count: 2,
      })
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '{"type":"final_answer","content":"broken"',
        },
        prompt_eval_count: 6,
        eval_count: 3,
      })
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '{"type":"final_answer","content":"Recovered after correction."}',
        },
        prompt_eval_count: 7,
        eval_count: 4,
      });

    const chunks = await collectChunks(service.query(
      'Summarize the current note.\n\n<current_note>\nnotes/today.md\n</current_note>',
      undefined,
      [],
      { model: 'ollama:llama3.1' },
    ));

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', name: 'Read' }),
      expect.objectContaining({ type: 'text', content: 'Recovered after correction.' }),
      expect.objectContaining({ type: 'done' }),
    ]));

    const retryMessages = (ollamaUtils.requestOllamaChat as jest.Mock).mock.calls[2][1].messages;
    expect(retryMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('did not follow the required JSON envelope') }),
    ]));
  });

  it('falls back to a plain-text final answer only after a tool has already run', async () => {
    jest.spyOn(ollamaUtils, 'requestOllamaChat')
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '{"type":"tool_call","tool":"Read","input":{"file_path":"notes/today.md"}}',
        },
        prompt_eval_count: 5,
        eval_count: 2,
      })
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: 'The note says hello from the vault.',
        },
        prompt_eval_count: 6,
        eval_count: 3,
      })
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: 'The note says hello from the vault.',
        },
        prompt_eval_count: 7,
        eval_count: 4,
      });

    const chunks = await collectChunks(service.query(
      'Summarize the current note.\n\n<current_note>\nnotes/today.md\n</current_note>',
      undefined,
      [],
      { model: 'ollama:llama3.1' },
    ));

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', content: 'The note says hello from the vault.' }),
      expect.objectContaining({ type: 'done' }),
    ]));
  });

  it('does not fall back to plain text before any tool has run', async () => {
    jest.spyOn(ollamaUtils, 'requestOllamaChat')
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: 'I can probably help with that.',
        },
        prompt_eval_count: 1,
        eval_count: 1,
      })
      .mockResolvedValueOnce({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: 'Still replying in plain text.',
        },
        prompt_eval_count: 2,
        eval_count: 1,
      });

    const chunks = await collectChunks(service.query(
      'What do you see?',
      undefined,
      [],
      { model: 'ollama:llama3.1' },
    ));

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'error',
        content: expect.stringContaining('did not contain a JSON object'),
      }),
      expect.objectContaining({ type: 'done' }),
    ]));
  });
});

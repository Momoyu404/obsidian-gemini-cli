import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import { GemineseService } from '@/core/agent/ClaudianService';
import { killGeminiCliProcess, spawnGeminiCli } from '@/core/agent/customSpawn';
import type { McpServerManager } from '@/core/mcp';
import type GeminesePlugin from '@/main';

jest.mock('@/core/agent/customSpawn', () => ({
  killGeminiCliProcess: jest.fn((child: ChildProcess, signal: NodeJS.Signals) => {
    child.kill(signal);
  }),
  spawnGeminiCli: jest.fn(),
}));

const spawnGeminiCliMock = jest.mocked(spawnGeminiCli);
const killGeminiCliProcessMock = jest.mocked(killGeminiCliProcess);

type ProcessHarness = ReturnType<typeof createProcessHarness>;

function createProcessHarness(pid = 4321) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

  let finished = false;
  let resolvedExitCode: number | null = null;

  const child = emitter as any;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    killed: false,
    pid,
    exitCode: null,
    kill: jest.fn((signal?: NodeJS.Signals) => {
      child.killed = true;
      complete(resolvedExitCode ?? 0, signal ?? null);
      return true;
    }),
  });

  function pushStdoutLine(line: string): void {
    if (!finished) {
      stdout.write(`${line}\n`);
    }
  }

  function pushJson(event: unknown): void {
    pushStdoutLine(JSON.stringify(event));
  }

  function pushStderr(chunk: string): void {
    if (!finished) {
      stderr.write(chunk);
    }
  }

  function complete(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (finished) return;
    finished = true;
    resolvedExitCode = code;
    child.exitCode = code;
    stdout.end();
    stderr.end();
    emitter.emit('exit', code, signal);
  }

  return {
    child: child as ChildProcess,
    complete,
    pushJson,
    pushStderr,
    pushStdoutLine,
  };
}

function queueProcessOutput(
  harness: ProcessHarness,
  stdoutEvents: unknown[],
  options?: {
    exitCode?: number | null;
    stderrChunks?: string[];
  },
): ChildProcess {
  queueMicrotask(() => {
    for (const chunk of options?.stderrChunks ?? []) {
      harness.pushStderr(chunk);
    }

    for (const event of stdoutEvents) {
      harness.pushJson(event);
    }

    harness.complete(options?.exitCode ?? 0);
  });

  return harness.child;
}

function createMockMcpManager(): jest.Mocked<McpServerManager> {
  return {
    getActiveServers: jest.fn().mockReturnValue({}),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getEnabledCount: jest.fn().mockReturnValue(0),
    getServers: jest.fn().mockReturnValue([]),
    hasServers: jest.fn().mockReturnValue(false),
    loadServers: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<McpServerManager>;
}

function createMockPlugin(
  vaultPath: string,
  overrides?: {
    cliPath?: string | null;
    model?: string;
    permissionMode?: 'agent' | 'plan' | 'yolo';
  },
): GeminesePlugin {
  return {
    app: {
      vault: {
        adapter: { basePath: vaultPath },
      },
    },
    pluginManager: {
      getExtensionsKey: jest.fn().mockReturnValue(''),
      hasEnabledPlugins: jest.fn().mockReturnValue(false),
      loadExtensions: jest.fn().mockResolvedValue(undefined),
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedGeminiCliPath: jest
      .fn()
      .mockReturnValue(overrides?.cliPath === undefined ? '/mock/bin/gemini' : overrides.cliPath),
    settings: {
      allowedExportPaths: [],
      blockedCommands: { unix: [], windows: [] },
      customContextLimits: {},
      enableBlocklist: true,
      loadUserGeminiSettings: false,
      mediaFolder: '',
      model: overrides?.model ?? 'auto',
      permissionMode: overrides?.permissionMode ?? 'agent',
      slashCommands: [],
      systemPrompt: '',
      thinkingBudget: 'off',
      userName: '',
    },
  } as unknown as GeminesePlugin;
}

async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function assistantMessage(content: unknown[], usage?: Record<string, number>) {
  return {
    type: 'assistant',
    message: {
      content,
      ...(usage ? { usage } : {}),
    },
    parent_tool_use_id: null,
  };
}

function blockedUserMessage(reason: string, parentToolUseId = 'tool-1') {
  return {
    type: 'user',
    _blocked: true,
    _blockReason: reason,
    message: { content: [] },
    parent_tool_use_id: parentToolUseId,
  };
}

function toolResultMessage(content: unknown, parentToolUseId = 'tool-1') {
  return {
    type: 'user',
    parent_tool_use_id: parentToolUseId,
    tool_use_result: content,
    message: { content: [] },
  };
}

describe('GemineseService integration', () => {
  let mcpManager: jest.Mocked<McpServerManager>;
  let service: GemineseService;
  let tempVaultPath: string;
  let plugin: GeminesePlugin;

  beforeEach(() => {
    jest.clearAllMocks();
    spawnGeminiCliMock.mockReset();
    killGeminiCliProcessMock.mockClear();
    tempVaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'geminese-service-'));
    mcpManager = createMockMcpManager();
    plugin = createMockPlugin(tempVaultPath);
    service = new GemineseService(plugin, mcpManager);
  });

  afterEach(() => {
    service.cleanup();
    fs.rmSync(tempVaultPath, { force: true, recursive: true });
  });

  it('returns an error when the Gemini CLI path is unavailable', async () => {
    plugin = createMockPlugin(tempVaultPath, { cliPath: null });
    service = new GemineseService(plugin, mcpManager);

    const chunks = await collectChunks(service.query('hello'));

    expect(chunks).toEqual([
      {
        type: 'error',
        content: 'Gemini CLI not found. Please install Gemini CLI: npm install -g @google/gemini-cli',
      },
      { type: 'done' },
    ]);
    expect(spawnGeminiCliMock).not.toHaveBeenCalled();
  });

  it('captures the session from init events and resumes subsequent queries', async () => {
    spawnGeminiCliMock
      .mockImplementationOnce(() => {
        const harness = createProcessHarness();
        return queueProcessOutput(harness, [
          { type: 'system', subtype: 'init', session_id: 'session-123' },
          assistantMessage([{ type: 'text', text: 'First response' }]),
        ]);
      })
      .mockImplementationOnce(() => {
        const harness = createProcessHarness();
        return queueProcessOutput(harness, [
          assistantMessage([{ type: 'text', text: 'Second response' }]),
        ]);
      });

    const firstChunks = await collectChunks(service.query('first'));
    const secondChunks = await collectChunks(service.query('second'));

    expect(firstChunks.some((chunk) => chunk.type === 'text' && chunk.content === 'First response')).toBe(true);
    expect(secondChunks.some((chunk) => chunk.type === 'text' && chunk.content === 'Second response')).toBe(true);
    expect(service.getSessionId()).toBe('session-123');

    const firstArgs = spawnGeminiCliMock.mock.calls[0][0].args;
    const secondArgs = spawnGeminiCliMock.mock.calls[1][0].args;
    expect(firstArgs).not.toContain('--resume');
    expect(secondArgs).toContain('--resume');
    expect(secondArgs).toContain('session-123');
  });

  it('transforms streamed JSONL output into current public stream chunks', async () => {
    spawnGeminiCliMock.mockImplementationOnce(() => {
      const harness = createProcessHarness();
      return queueProcessOutput(harness, [
        { type: 'system', subtype: 'init', session_id: 'session-transform' },
        assistantMessage(
          [
            { type: 'thinking', thinking: 'Let me think' },
            { type: 'text', text: 'Hello from Gemini' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'note.md' } },
          ],
          {
            input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 5,
            output_tokens: 12,
          },
        ),
        toolResultMessage('File contents here'),
        { type: 'assistant', error: 'Something went wrong', message: { content: [] } },
      ]);
    });

    const chunks = await collectChunks(service.query('transform this'));

    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'thinking', content: 'Let me think', parentToolUseId: null },
        { type: 'text', content: 'Hello from Gemini', parentToolUseId: null },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: { file_path: 'note.md' },
          parentToolUseId: null,
        },
        {
          type: 'tool_result',
          id: 'tool-1',
          content: 'File contents here',
          isError: false,
          parentToolUseId: 'tool-1',
          toolUseResult: 'File contents here',
        },
        { type: 'error', content: 'Something went wrong' },
      ]),
    );

    const usageChunk = chunks.find((chunk) => chunk.type === 'usage');
    expect(usageChunk?.usage.contextTokens).toBe(125);
    expect(usageChunk?.sessionId).toBe('session-transform');
  });

  it('emits blocked chunks from blocked user messages', async () => {
    spawnGeminiCliMock.mockImplementationOnce(() => {
      const harness = createProcessHarness();
      return queueProcessOutput(harness, [
        assistantMessage([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'rm -rf /' } }]),
        blockedUserMessage('Command blocked by policy: rm -rf /'),
      ]);
    });

    const chunks = await collectChunks(service.query('dangerous command'));

    expect(chunks).toEqual(
      expect.arrayContaining([
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'rm -rf /' },
          parentToolUseId: null,
        },
        {
          type: 'blocked',
          content: 'Command blocked by policy: rm -rf /',
        },
      ]),
    );
  });

  it('falls back from Pro to Auto when the CLI reports capacity exhaustion', async () => {
    spawnGeminiCliMock
      .mockImplementationOnce(() => {
        const harness = createProcessHarness();
        return queueProcessOutput(
          harness,
          [],
          {
            exitCode: 1,
            stderrChunks: ['resource_exhausted: no capacity available for model'],
          },
        );
      })
      .mockImplementationOnce(() => {
        const harness = createProcessHarness();
        return queueProcessOutput(harness, [
          { type: 'system', subtype: 'init', session_id: 'session-auto' },
          assistantMessage([{ type: 'text', text: 'Recovered on auto' }]),
        ]);
      });

    const chunks = await collectChunks(service.query('retry me', undefined, undefined, { model: 'pro' }));

    const textChunks = chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content);
    expect(textChunks).toContain('\n\n_Pro currently has no capacity. This request was temporarily retried with Auto._\n\n');
    expect(textChunks).toContain('Recovered on auto');

    const firstArgs = spawnGeminiCliMock.mock.calls[0][0].args;
    const secondArgs = spawnGeminiCliMock.mock.calls[1][0].args;
    expect(firstArgs).toContain('pro');
    expect(secondArgs).toContain('auto');
  });

  it('cancels an active subprocess via killGeminiCliProcess', async () => {
    let harness: ProcessHarness | null = null;
    spawnGeminiCliMock.mockImplementationOnce(() => {
      harness = createProcessHarness();
      return harness.child;
    });

    const pendingChunks = collectChunks(service.query('wait for cancel'));
    await Promise.resolve();

    service.cancel();

    const chunks = await pendingChunks;

    expect(harness).not.toBeNull();
    expect(killGeminiCliProcessMock).toHaveBeenCalledWith(harness!.child, 'SIGTERM');
    expect((harness!.child.kill as jest.Mock)).toHaveBeenCalledWith('SIGTERM');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });
});

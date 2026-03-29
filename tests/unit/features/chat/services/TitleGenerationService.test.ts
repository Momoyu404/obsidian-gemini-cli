import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { spawnGeminiCli } from '@/core/agent/customSpawn';
import { QueryOptionsBuilder } from '@/core/agent/QueryOptionsBuilder';
import { type TitleGenerationResult, TitleGenerationService } from '@/features/chat/services/TitleGenerationService';

jest.mock('@/core/agent/customSpawn', () => ({
  spawnGeminiCli: jest.fn(),
}));

jest.mock('@/core/agent/QueryOptionsBuilder', () => ({
  QueryOptionsBuilder: {
    writeSystemPromptFile: jest.fn(),
  },
}));

const spawnGeminiCliMock = jest.mocked(spawnGeminiCli);
const writeSystemPromptFileMock = jest.mocked(QueryOptionsBuilder.writeSystemPromptFile);

function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'gemini-2.5-pro',
      titleGenerationModel: '',
      thinkingBudget: 'off',
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedGeminiCliPath: jest.fn().mockReturnValue('/fake/gemini'),
  } as any;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type ProcessHarness = ReturnType<typeof createProcessHarness>;

function createProcessHarness(signal?: AbortSignal, pid = 1234) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

  let finished = false;

  const child = emitter as any;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid,
    killed: false,
    exitCode: null,
    kill: jest.fn(() => {
      child.killed = true;
      finish();
      return true;
    }),
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    child.exitCode = 0;
    stdout.end();
    stderr.end();
    emitter.emit('exit', 0, null);
  };

  signal?.addEventListener('abort', finish, { once: true });

  return {
    child: child as ChildProcess,
    finish,
    pushJson(event: unknown) {
      if (!finished) {
        stdout.write(`${JSON.stringify(event)}\n`);
      }
    },
  };
}

function queueProcessOutput(harness: ProcessHarness, stdoutEvents: unknown[]): ChildProcess {
  queueMicrotask(() => {
    for (const event of stdoutEvents) {
      harness.pushJson(event);
    }
    harness.finish();
  });

  return harness.child;
}

describe('TitleGenerationService', () => {
  let service: TitleGenerationService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    service = new TitleGenerationService(mockPlugin);
    writeSystemPromptFileMock.mockReturnValue('/tmp/title-system.md');
  });

  describe('generateTitle', () => {
    it('generates a title from streamed assistant output', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Setting Up React Project' },
        ]);
      });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'How do I set up a React project?', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: true,
        title: 'Setting Up React Project',
      });
    });

    it('writes the system prompt file and passes current CLI args/env', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Test Title' },
        ]);
      });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(writeSystemPromptFileMock).toHaveBeenCalledWith(
        '/test/vault/path',
        expect.any(String),
      );

      const spawnOptions = spawnGeminiCliMock.mock.calls[0][0];
      expect(spawnOptions.cliPath).toBe('/fake/gemini');
      expect(spawnOptions.cwd).toBe('/test/vault/path');
      expect(spawnOptions.env?.GEMINI_SYSTEM_MD).toBe('/tmp/title-system.md');
      expect(getArgValue(spawnOptions.args, '--approval-mode')).toBe('yolo');
      expect(getArgValue(spawnOptions.args, '--output-format')).toBe('stream-json');
    });

    it('uses the titleGenerationModel setting when configured', async () => {
      mockPlugin.settings.titleGenerationModel = 'gemini-2.5-pro';
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Title' },
        ]);
      });

      await service.generateTitle('conv-123', 'test', jest.fn());

      const spawnOptions = spawnGeminiCliMock.mock.calls[0][0];
      expect(getArgValue(spawnOptions.args, '--model')).toBe('gemini-2.5-pro');
    });

    it('uses GEMINI_DEFAULT_FLASH_MODEL when the setting is empty', async () => {
      mockPlugin.getActiveEnvironmentVariables.mockReturnValue(
        'GEMINI_DEFAULT_FLASH_MODEL=gemini-2.5-flash'
      );
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Title' },
        ]);
      });

      await service.generateTitle('conv-123', 'test', jest.fn());

      const spawnOptions = spawnGeminiCliMock.mock.calls[0][0];
      expect(getArgValue(spawnOptions.args, '--model')).toBe('gemini-2.5-flash');
    });

    it('falls back to gemini-2.5-flash-lite when no explicit title model is configured', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Title' },
        ]);
      });

      await service.generateTitle('conv-123', 'test', jest.fn());

      const spawnOptions = spawnGeminiCliMock.mock.calls[0][0];
      expect(getArgValue(spawnOptions.args, '--model')).toBe('gemini-2.5-flash-lite');
    });

    it('truncates long user prompts before sending them to the CLI', async () => {
      const longMessage = 'x'.repeat(1000);
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Title' },
        ]);
      });

      await service.generateTitle('conv-123', longMessage, jest.fn());

      const spawnOptions = spawnGeminiCliMock.mock.calls[0][0];
      const prompt = getArgValue(spawnOptions.args, '--prompt');
      expect(prompt).toContain('x'.repeat(500) + '...');
      expect(prompt).not.toContain('x'.repeat(501));
    });

    it('strips surrounding quotes, trailing punctuation, and long output', async () => {
      const callback = jest.fn();

      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: '"Quoted Title..."' },
        ]);
      });
      await service.generateTitle('conv-quoted', 'test', callback);

      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'A'.repeat(60) },
        ]);
      });
      await service.generateTitle('conv-long', 'test', callback);

      expect(callback).toHaveBeenNthCalledWith(1, 'conv-quoted', {
        success: true,
        title: 'Quoted Title',
      });
      expect(callback).toHaveBeenNthCalledWith(2, 'conv-long', {
        success: true,
        title: 'A'.repeat(47) + '...',
      });
    });

    it('returns a parse error when the response is empty', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, []);
      });

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Failed to parse title from response',
      });
    });

    it('fails when the vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Could not determine vault path',
      });
      expect(spawnGeminiCliMock).not.toHaveBeenCalled();
    });

    it('fails when the Gemini CLI path is unavailable', async () => {
      mockPlugin.getResolvedGeminiCliPath.mockReturnValue(null);

      const callback = jest.fn();
      await service.generateTitle('conv-123', 'test', callback);

      expect(callback).toHaveBeenCalledWith('conv-123', {
        success: false,
        error: 'Gemini CLI not found',
      });
      expect(spawnGeminiCliMock).not.toHaveBeenCalled();
    });
  });

  describe('concurrency and cancellation', () => {
    it('supports multiple concurrent generations for different conversations', async () => {
      spawnGeminiCliMock
        .mockImplementationOnce((options) => {
          const harness = createProcessHarness(options.signal, 1);
          return queueProcessOutput(harness, [
            { type: 'message', role: 'assistant', content: 'Title One' },
          ]);
        })
        .mockImplementationOnce((options) => {
          const harness = createProcessHarness(options.signal, 2);
          return queueProcessOutput(harness, [
            { type: 'message', role: 'assistant', content: 'Title Two' },
          ]);
        });

      const callback1 = jest.fn();
      const callback2 = jest.fn();

      await Promise.all([
        service.generateTitle('conv-1', 'msg1', callback1),
        service.generateTitle('conv-2', 'msg2', callback2),
      ]);

      expect(callback1).toHaveBeenCalledWith('conv-1', { success: true, title: 'Title One' });
      expect(callback2).toHaveBeenCalledWith('conv-2', { success: true, title: 'Title Two' });
    });

    it('cancels an earlier generation when the same conversation starts again', async () => {
      let firstSignal: AbortSignal | undefined;

      spawnGeminiCliMock
        .mockImplementationOnce((options) => {
          firstSignal = options.signal;
          const harness = createProcessHarness(options.signal, 1);
          return harness.child;
        })
        .mockImplementationOnce((options) => {
          const harness = createProcessHarness(options.signal, 2);
          return queueProcessOutput(harness, [
            { type: 'message', role: 'assistant', content: 'Title 2' },
          ]);
        });

      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const firstPromise = service.generateTitle('conv-1', 'msg1', callback1);
      const secondPromise = service.generateTitle('conv-1', 'msg2', callback2);

      await Promise.all([firstPromise, secondPromise]);

      expect(firstSignal?.aborted).toBe(true);
      expect(callback1).toHaveBeenCalledWith('conv-1', {
        success: false,
        error: 'Failed to parse title from response',
      });
      expect(callback2).toHaveBeenCalledWith('conv-1', {
        success: true,
        title: 'Title 2',
      });
    });

    it('cancels all active generations', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return harness.child;
      });

      const callback = jest.fn();
      const promise = service.generateTitle('conv-1', 'msg', callback);
      service.cancel();
      await promise;

      expect(callback).toHaveBeenCalledWith('conv-1', {
        success: false,
        error: 'Failed to parse title from response',
      });
    });
  });

  describe('safeCallback', () => {
    it('swallows callback failures', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Title' },
        ]);
      });

      const throwingCallback = jest.fn().mockRejectedValue(new Error('Callback error'));

      await expect(
        service.generateTitle('conv-123', 'test', throwingCallback)
      ).resolves.not.toThrow();
    });
  });
});

describe('TitleGenerationResult type', () => {
  it('supports success results', () => {
    const success: TitleGenerationResult = { success: true, title: 'Test Title' };
    expect(success).toEqual({ success: true, title: 'Test Title' });
  });

  it('supports failure results', () => {
    const failure: TitleGenerationResult = { success: false, error: 'Some error' };
    expect(failure).toEqual({ success: false, error: 'Some error' });
  });
});

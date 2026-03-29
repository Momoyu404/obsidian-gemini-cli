import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { spawnGeminiCli } from '@/core/agent/customSpawn';
import { QueryOptionsBuilder } from '@/core/agent/QueryOptionsBuilder';
import { InstructionRefineService } from '@/features/chat/services/InstructionRefineService';

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
      thinkingBudget: 'off',
      systemPrompt: '',
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

function createProcessHarness(signal?: AbortSignal, pid = 4321) {
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

describe('InstructionRefineService', () => {
  let service: InstructionRefineService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    service = new InstructionRefineService(mockPlugin);
    writeSystemPromptFileMock.mockReturnValue('/tmp/refine-system.md');
  });

  describe('refineInstruction', () => {
    it('uses the current CLI subprocess flow and returns refined instructions', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: '<instruction>- Be concise.</instruction>' },
        ]);
      });

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: true,
        refinedInstruction: '- Be concise.',
      });

      const spawnOptions = spawnGeminiCliMock.mock.calls[0][0];
      expect(spawnOptions.cliPath).toBe('/fake/gemini');
      expect(spawnOptions.cwd).toBe('/test/vault/path');
      expect(spawnOptions.env?.GEMINI_SYSTEM_MD).toBe('/tmp/refine-system.md');
      expect(getArgValue(spawnOptions.args, '--approval-mode')).toBe('yolo');
      expect(getArgValue(spawnOptions.args, '--model')).toBe('gemini-2.5-pro');
      expect(getArgValue(spawnOptions.args, '--prompt')).toBe('Please refine this instruction: "be concise"');
    });

    it('includes existing instructions in the generated system prompt', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          {
            type: 'message',
            role: 'assistant',
            content: '<instruction>\n## Coding Style\n\n- Use TypeScript.\n- Prefer small diffs.\n</instruction>',
          },
        ]);
      });

      const existing = '## Existing\n\n- Keep it short.';
      const result = await service.refineInstruction('coding style', existing);

      expect(result).toEqual({
        success: true,
        refinedInstruction: '## Coding Style\n\n- Use TypeScript.\n- Prefer small diffs.',
      });
      expect(writeSystemPromptFileMock).toHaveBeenCalledWith(
        '/test/vault/path',
        expect.stringContaining('EXISTING INSTRUCTIONS'),
      );

      const prompt = writeSystemPromptFileMock.mock.calls[0][1];
      expect(prompt).toContain(existing);
      expect(prompt).toContain('Consider how it fits with existing instructions');
      expect(prompt).toContain('Match the format of existing instructions');
    });

    it('returns clarification text when no instruction block is present', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'message', role: 'assistant', content: 'Could you clarify what you mean by concise?' },
        ]);
      });

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: true,
        clarification: 'Could you clarify what you mean by concise?',
      });
    });

    it('returns an error for an empty response', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, []);
      });

      const result = await service.refineInstruction('be concise', '');

      expect(result).toEqual({
        success: false,
        error: 'Empty response',
      });
    });

    it('reports streaming progress as assistant text arrives', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        queueMicrotask(() => {
          harness.pushJson({ type: 'message', role: 'assistant', content: '<instruction>- Be ' });
          harness.pushJson({ type: 'message', role: 'assistant', content: 'brief.</instruction>' });
          harness.finish();
        });
        return harness.child;
      });

      const onProgress = jest.fn();
      const result = await service.refineInstruction('be concise', '', onProgress);

      expect(result).toEqual({
        success: true,
        refinedInstruction: '- Be brief.',
      });
      expect(onProgress).toHaveBeenCalled();
      expect(onProgress).toHaveBeenLastCalledWith({
        success: true,
        refinedInstruction: '- Be brief.',
      });
    });
  });

  describe('continueConversation', () => {
    it('returns an error when there is no active session', async () => {
      const result = await service.continueConversation('follow up');

      expect(result).toEqual({
        success: false,
        error: 'No active conversation to continue',
      });
    });

    it('resumes the stored session id after the initial refinement', async () => {
      spawnGeminiCliMock
        .mockImplementationOnce((options) => {
          const harness = createProcessHarness(options.signal, 1);
          return queueProcessOutput(harness, [
            { type: 'init', session_id: 'session-abc' },
            { type: 'message', role: 'assistant', content: 'What do you mean?' },
          ]);
        })
        .mockImplementationOnce((options) => {
          const harness = createProcessHarness(options.signal, 2);
          return queueProcessOutput(harness, [
            {
              type: 'message',
              role: 'assistant',
              content: '<instruction>- Be concise and clear.</instruction>',
            },
          ]);
        });

      await service.refineInstruction('test', '');
      const result = await service.continueConversation('I mean short answers');

      expect(result).toEqual({
        success: true,
        refinedInstruction: '- Be concise and clear.',
      });

      const secondSpawnOptions = spawnGeminiCliMock.mock.calls[1][0];
      expect(secondSpawnOptions.args).toContain('--resume');
      expect(secondSpawnOptions.args).toContain('session-abc');
    });
  });

  describe('resetConversation', () => {
    it('clears the session so follow-up requests fail again', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return queueProcessOutput(harness, [
          { type: 'init', session_id: 'session-abc' },
          { type: 'message', role: 'assistant', content: 'clarification' },
        ]);
      });

      await service.refineInstruction('test', '');
      service.resetConversation();

      const result = await service.continueConversation('follow up');
      expect(result).toEqual({
        success: false,
        error: 'No active conversation to continue',
      });
    });
  });

  describe('cancel', () => {
    it('aborts the current request and returns an empty-response error', async () => {
      spawnGeminiCliMock.mockImplementationOnce((options) => {
        const harness = createProcessHarness(options.signal);
        return harness.child;
      });

      const promise = service.refineInstruction('test', '');
      service.cancel();

      await expect(promise).resolves.toEqual({
        success: false,
        error: 'Empty response',
      });
    });

    it('is safe to call when nothing is running', () => {
      expect(() => service.cancel()).not.toThrow();
    });
  });

  describe('error handling', () => {
    it('returns an error when the vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;

      const result = await service.refineInstruction('test', '');

      expect(result).toEqual({
        success: false,
        error: 'Could not determine vault path',
      });
      expect(spawnGeminiCliMock).not.toHaveBeenCalled();
    });

    it('returns an error when the Gemini CLI is not found', async () => {
      mockPlugin.getResolvedGeminiCliPath.mockReturnValue(null);

      const result = await service.refineInstruction('test', '');

      expect(result).toEqual({
        success: false,
        error: 'Gemini CLI not found. Please install Gemini CLI.',
      });
      expect(spawnGeminiCliMock).not.toHaveBeenCalled();
    });
  });
});

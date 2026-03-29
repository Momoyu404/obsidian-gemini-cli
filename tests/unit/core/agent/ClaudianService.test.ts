import { GemineseService } from '@/core/agent/ClaudianService';
import type { McpServerManager } from '@/core/mcp';
import type GeminesePlugin from '@/main';

type MockMcpServerManager = jest.Mocked<McpServerManager>;

async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function createService(overrides?: {
  cliPath?: string | null;
  model?: string;
  environmentVariables?: string;
}) {
  const mockPlugin = {
    app: {
      vault: { adapter: { basePath: '/mock/vault/path' } },
    },
    settings: {
      model: overrides?.model ?? 'auto',
      permissionMode: 'agent' as const,
      thinkingBudget: 'off',
      blockedCommands: { unix: [], windows: [] },
      enableBlocklist: false,
      mediaFolder: 'geminese-media',
      systemPrompt: '',
      allowedExportPaths: [],
      loadUserGeminiSettings: false,
      customContextLimits: {},
      slashCommands: [],
      ollamaBaseUrl: 'http://127.0.0.1:11434',
    },
    getResolvedGeminiCliPath: jest.fn().mockReturnValue(
      overrides?.cliPath === undefined ? '/usr/local/bin/gemini' : overrides.cliPath
    ),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(overrides?.environmentVariables ?? ''),
    pluginManager: {
      getExtensionsKey: jest.fn().mockReturnValue(''),
      loadExtensions: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as GeminesePlugin;

  const mockMcpManager = {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
  } as unknown as MockMcpServerManager;

  return {
    plugin: mockPlugin,
    mcpManager: mockMcpManager,
    service: new GemineseService(mockPlugin, mockMcpManager),
  };
}

describe('GemineseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Session Management', () => {
    it('starts without a session', () => {
      const { service } = createService();
      expect(service.getSessionId()).toBeNull();
    });

    it('sets and resets the session ID', () => {
      const { service } = createService();

      service.setSessionId('test-session-123');
      expect(service.getSessionId()).toBe('test-session-123');

      service.resetSession();
      expect(service.getSessionId()).toBeNull();
    });

    it('passes externalContextPaths through ensureReady when setting a session', async () => {
      const { service } = createService();
      const ensureReadySpy = jest.spyOn(service, 'ensureReady').mockResolvedValue(true);

      service.setSessionId('test-session', ['/path/a', '/path/b']);
      await Promise.resolve();

      expect(ensureReadySpy).toHaveBeenCalledWith({
        sessionId: 'test-session',
        externalContextPaths: ['/path/a', '/path/b'],
      });
    });
  });

  describe('Ready State', () => {
    it('reports not ready by default', () => {
      const { service } = createService();
      expect(service.isReady()).toBe(false);
    });

    it('becomes ready after ensureReady succeeds for Gemini', async () => {
      const { service } = createService();

      await expect(service.ensureReady()).resolves.toBe(true);
      expect(service.isReady()).toBe(true);
    });

    it('returns false when Gemini CLI is unavailable', async () => {
      const { service } = createService({ cliPath: null });

      await expect(service.ensureReady()).resolves.toBe(false);
      expect(service.isReady()).toBe(false);
    });

    it('does not require a Gemini CLI path for Ollama models', async () => {
      const { service } = createService({ cliPath: null, model: 'ollama:llama3.1' });

      service.setActiveModel('ollama:llama3.1');
      await expect(service.ensureReady()).resolves.toBe(true);
      expect(service.isReady()).toBe(true);
    });

    it('notifies listeners immediately with the current ready state', async () => {
      const { service } = createService();
      const listener = jest.fn();

      service.onReadyStateChange(listener);
      expect(listener).toHaveBeenCalledWith(false);

      await service.ensureReady();
      const readyListener = jest.fn();
      service.onReadyStateChange(readyListener);
      expect(readyListener).toHaveBeenCalledWith(true);
    });

    it('returns an unsubscribe function for ready-state listeners', () => {
      const { service } = createService();
      const listener = jest.fn();

      const unsubscribe = service.onReadyStateChange(listener);
      unsubscribe();

      expect((service as any).readyStateListeners.has(listener)).toBe(false);
    });
  });

  describe('Query Execution', () => {
    it('returns a CLI-not-found error when Gemini CLI is unavailable', async () => {
      const { service } = createService({ cliPath: null });

      const chunks = await collectChunks(service.query('hello'));

      expect(chunks).toEqual([
        {
          type: 'error',
          content: 'Gemini CLI not found. Please install Gemini CLI: npm install -g @google/gemini-cli',
        },
        { type: 'done' },
      ]);
    });
  });

  describe('Cancellation', () => {
    it('aborts the active request and marks the session interrupted', () => {
      const { service } = createService();
      const abort = jest.fn();
      (service as any).abortController = { abort, signal: { aborted: false } };

      service.cancel();

      expect(abort).toHaveBeenCalled();
      expect((service as any).sessionManager.wasInterrupted()).toBe(true);
    });

    it('calls the approval dismisser when present', () => {
      const { service } = createService();
      const dismisser = jest.fn();

      service.setApprovalDismisser(dismisser);
      service.cancel();

      expect(dismisser).toHaveBeenCalled();
    });
  });

  describe('Forking And Commands', () => {
    it('uses the conversation session or fork source for Gemini conversations', () => {
      const { service } = createService();

      expect(
        service.applyForkState({ sessionId: 'session-123', sdkSessionId: undefined, forkSource: undefined })
      ).toBe('session-123');
      expect(
        service.applyForkState({
          sessionId: null,
          sdkSessionId: undefined,
          forkSource: { sessionId: 'source-session-456', resumeAt: 'assistant-uuid-1' },
        })
      ).toBe('source-session-456');
    });

    it('returns null fork state for non-Gemini runtimes', () => {
      const { service } = createService({ model: 'ollama:llama3.1' });

      service.setActiveModel('ollama:llama3.1');
      expect(
        service.applyForkState({
          sessionId: 'session-123',
          sdkSessionId: undefined,
          forkSource: { sessionId: 'source-session-456', resumeAt: 'assistant-uuid-1' },
        })
      ).toBeNull();
    });

    it('returns no slash commands for Gemini mode', async () => {
      const { service } = createService();
      await expect(service.getSupportedCommands()).resolves.toEqual([]);
    });
  });

  describe('Cleanup', () => {
    it('closes the persistent query, cancels, and resets the session', () => {
      const { service } = createService();
      const closePersistentQuerySpy = jest.spyOn(service, 'closePersistentQuery');
      const cancelSpy = jest.spyOn(service, 'cancel');

      service.setSessionId('test-session-123');
      service.cleanup();

      expect(closePersistentQuerySpy).toHaveBeenCalledWith('plugin cleanup');
      expect(cancelSpy).toHaveBeenCalled();
      expect(service.getSessionId()).toBeNull();
    });
  });
});

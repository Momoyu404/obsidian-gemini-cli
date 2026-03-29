import { createMockEl } from '@test/helpers/mockElement';

import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

async function* createMockStream(chunks: any[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createDeps(): InputControllerDeps & {
  conversationController: { save: jest.Mock; generateFallbackTitle: jest.Mock; updateHistoryDropdown: jest.Mock };
  mockAgentService: { query: jest.Mock; getResolvedModel: jest.Mock };
} {
  const state = new ChatState();
  state.currentConversationId = 'conv-1';

  const mockAgentService = {
    query: jest.fn(),
    cancel: jest.fn(),
    getResolvedModel: jest.fn().mockReturnValue(null),
    getSessionId: jest.fn().mockReturnValue(null),
  };

  const conversationController = {
    save: jest.fn().mockResolvedValue(undefined),
    generateFallbackTitle: jest.fn().mockReturnValue('Fallback title'),
    updateHistoryDropdown: jest.fn(),
    clearTerminalSubagentsFromMessages: jest.fn(),
  };

  return {
    plugin: {
      settings: {
        enableAutoTitleGeneration: true,
        enableAutoScroll: true,
        permissionMode: 'agent',
      },
      mcpManager: {
        extractMentions: jest.fn().mockReturnValue(new Set()),
        transformMentions: jest.fn().mockImplementation((text: string) => text),
      },
      renameConversation: jest.fn().mockResolvedValue(undefined),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      getConversationSync: jest.fn().mockReturnValue(null),
      getConversationById: jest.fn().mockResolvedValue({
        id: 'conv-1',
        selectedModel: 'auto',
        title: 'Fallback title',
      }),
      createConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    } as any,
    state,
    renderer: {
      addMessage: jest.fn().mockReturnValue({
        querySelector: jest.fn().mockReturnValue(createMockEl()),
      }),
      refreshActionButtons: jest.fn(),
    } as any,
    streamController: {
      showThinkingIndicator: jest.fn(),
      showCancellationIndicator: jest.fn(),
      hideThinkingIndicator: jest.fn(),
      handleStreamChunk: jest.fn().mockImplementation(async (chunk, msg) => {
        if (chunk.type === 'text') {
          msg.content += chunk.content;
        }
      }),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      appendText: jest.fn(),
    } as any,
    selectionController: {
      getContext: jest.fn().mockReturnValue(null),
    } as any,
    canvasSelectionController: {
      getContext: jest.fn().mockReturnValue(null),
    } as any,
    conversationController: conversationController as any,
    getInputEl: () => ({ value: '', focus: jest.fn() } as unknown as HTMLTextAreaElement),
    getInputContainerEl: () => createMockEl(),
    getWelcomeEl: () => ({
      classList: { add: jest.fn() },
      style: { display: '' },
    }) as any,
    getMessagesEl: () => createMockEl(),
    getFileContextManager: () => ({
      startSession: jest.fn(),
      getCurrentNotePath: jest.fn().mockReturnValue(null),
      shouldSendCurrentNote: jest.fn().mockReturnValue(false),
      markCurrentNoteSent: jest.fn(),
      transformContextMentions: jest.fn().mockImplementation((text: string) => text),
    }) as any,
    getImageContextManager: () => ({
      hasImages: jest.fn().mockReturnValue(false),
      getAttachedImages: jest.fn().mockReturnValue([]),
      clearImages: jest.fn(),
    }) as any,
    getMcpServerSelector: () => null,
    getExternalContextSelector: () => null,
    getInstructionModeManager: () => null,
    getInstructionRefineService: () => null,
    getTitleGenerationService: () => null,
    getStatusPanel: () => null,
    generateId: () => `msg-${Date.now()}`,
    resetInputHeight: jest.fn(),
    getAgentService: () => mockAgentService as any,
    getSubagentManager: () => ({ resetSpawnedCount: jest.fn(), resetStreamingState: jest.fn() }) as any,
    ensureServiceInitialized: jest.fn().mockResolvedValue(true),
    mockAgentService,
  };
}

describe('InputController performance behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defers title generation until after the response is saved', async () => {
    const deps = createDeps();
    const mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps.getTitleGenerationService = () => mockTitleService as any;
    deps.mockAgentService.query.mockReturnValue(createMockStream([
      { type: 'text', content: 'Assistant response' },
      { type: 'done' },
    ]));

    const inputEl = deps.getInputEl();
    inputEl.value = 'First question';
    deps.getInputEl = () => inputEl;

    const controller = new InputController(deps);
    await controller.sendMessage();

    expect(mockTitleService.generateTitle).toHaveBeenCalled();
    expect(deps.conversationController.save).toHaveBeenCalled();
    expect(deps.conversationController.save.mock.invocationCallOrder[0]).toBeLessThan(
      mockTitleService.generateTitle.mock.invocationCallOrder[0],
    );
  });

  it('skips deferred title generation when there is no assistant text', async () => {
    const deps = createDeps();
    const mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps.getTitleGenerationService = () => mockTitleService as any;
    deps.mockAgentService.query.mockReturnValue(createMockStream([
      { type: 'done' },
    ]));

    const inputEl = deps.getInputEl();
    inputEl.value = 'First question';
    deps.getInputEl = () => inputEl;

    const controller = new InputController(deps);
    await controller.sendMessage();

    expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'Fallback title');
  });

  it('renders a diagnostic when a turn completes without visible assistant text', async () => {
    const deps = createDeps();
    deps.mockAgentService.query.mockReturnValue(createMockStream([
      { type: 'usage', usage: { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, contextWindow: 1000, contextTokens: 1, percentage: 0 } },
      { type: 'done' },
    ]));

    const inputEl = deps.getInputEl();
    inputEl.value = 'First question';
    deps.getInputEl = () => inputEl;

    const controller = new InputController(deps);
    await controller.sendMessage();

    expect((deps.streamController.appendText as jest.Mock).mock.calls.some(
      ([text]) => String(text).includes('No visible response was rendered.'),
    )).toBe(true);
  });
});

import { createMockEl } from '@test/helpers/mockElement';

import { InputController, type InputControllerDeps } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

function createDeps(): InputControllerDeps & { promptLog: string[] } {
  const state = new ChatState();
  const inputEl = {
    value: '',
    focus: jest.fn(),
  } as unknown as HTMLTextAreaElement;
  const promptLog: string[] = [];
  state.currentConversationId = 'conv-1';

  const fileContextManager = {
    startSession: jest.fn(),
    getAttachedFiles: jest.fn().mockReturnValue(new Set(['notes/live.md', 'notes/extra.md'])),
    getCurrentNotePath: jest.fn().mockReturnValue('notes/live.md'),
    shouldSendCurrentNote: jest.fn().mockReturnValue(false),
    markCurrentNoteSent: jest.fn(),
    transformContextMentions: jest.fn().mockImplementation((text: string) => text),
  };

  return {
    plugin: {
      createConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      settings: {
        permissionMode: 'agent',
        enableAutoTitleGeneration: false,
      },
      mcpManager: {
        extractMentions: jest.fn().mockReturnValue(new Set()),
        transformMentions: jest.fn().mockImplementation((text: string) => text),
      },
      renameConversation: jest.fn(),
      updateConversation: jest.fn(),
      getConversationSync: jest.fn().mockReturnValue(null),
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
      hideThinkingIndicator: jest.fn(),
      handleStreamChunk: jest.fn(),
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
    conversationController: {
      save: jest.fn(),
      generateFallbackTitle: jest.fn().mockReturnValue('Test Title'),
      updateHistoryDropdown: jest.fn(),
      clearTerminalSubagentsFromMessages: jest.fn(),
    } as any,
    getInputEl: () => inputEl,
    getInputContainerEl: () => createMockEl(),
    getWelcomeEl: () => ({
      classList: { add: jest.fn() },
    }) as any,
    getMessagesEl: () => createMockEl(),
    getFileContextManager: () => fileContextManager as any,
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
    getAgentService: () => ({
      query: jest.fn().mockImplementation((prompt: string) => {
        promptLog.push(prompt);
        return (async function* () {
          yield { type: 'done' };
        })();
      }),
      getSessionId: jest.fn().mockReturnValue(null),
    }) as any,
    getSubagentManager: () => ({ resetSpawnedCount: jest.fn(), resetStreamingState: jest.fn() }) as any,
    getSelectedModel: () => 'ollama:llama3.1',
    promptLog,
  };
}

describe('InputController Ollama context injection', () => {
  it('prepends current_note on every send and includes attached context_files', async () => {
    const deps = createDeps();
    const controller = new InputController(deps);
    const inputEl = deps.getInputEl();

    inputEl.value = 'First question';
    await controller.sendMessage();

    inputEl.value = 'Second question';
    await controller.sendMessage();

    expect(deps.promptLog[0]).toContain('<current_note>');
    expect(deps.promptLog[1]).toContain('<current_note>');
    expect(deps.promptLog[0]).toContain('<context_files>\nnotes/extra.md\n</context_files>');
    expect(deps.promptLog[1]).toContain('<context_files>\nnotes/extra.md\n</context_files>');
  });
});

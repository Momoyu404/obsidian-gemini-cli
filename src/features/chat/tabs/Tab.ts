import type { Component } from 'obsidian';
import { Notice, setIcon } from 'obsidian';

import { GemineseService } from '../../../core/agent';
import type { McpServerManager } from '../../../core/mcp';
import type { ChatMessage, Conversation, GeminiModel, PermissionMode, SlashCommand, ThinkingBudget } from '../../../core/types';
import { DEFAULT_GEMINI_MODELS, DEFAULT_THINKING_BUDGET, getContextWindowSize } from '../../../core/types';
import { t } from '../../../i18n';
import type GeminesePlugin from '../../../main';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import { getEnhancedPath } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  BrowserSelectionController,
  CanvasSelectionController,
  ConversationController,
  InputController,
  NavigationController,
  SelectionController,
  StreamController,
} from '../controllers';
import { cleanupThinkingBlock, MessageRenderer } from '../rendering';
import { BangBashService } from '../services/BangBashService';
import { InstructionRefineService } from '../services/InstructionRefineService';
import { SubagentManager } from '../services/SubagentManager';
import { TitleGenerationService } from '../services/TitleGenerationService';
import { ChatState } from '../state';
import {
  BangBashModeManager as BangBashModeManagerClass,
  createInputToolbar,
  FileContextManager,
  ImageContextManager,
  InstructionModeManager as InstructionModeManagerClass,
  NavigationSidebar,
  StatusPanel,
} from '../ui';
import type { TabData, TabDOMElements, TabId } from './types';
import { generateTabId, TEXTAREA_MAX_HEIGHT_PERCENT, TEXTAREA_MIN_MAX_HEIGHT } from './types';

export interface TabCreateOptions {
  plugin: GeminesePlugin;
  mcpManager: McpServerManager;

  containerEl: HTMLElement;
  conversation?: Conversation;
  tabId?: TabId;
  onStreamingChanged?: (isStreaming: boolean) => void;
  onTitleChanged?: (title: string) => void;
  onAttentionChanged?: (needsAttention: boolean) => void;
  onConversationIdChanged?: (conversationId: string | null) => void;
}

/**
 * Creates a new Tab instance with all required state.
 */
export function createTab(options: TabCreateOptions): TabData {
  const {
    containerEl,
    conversation,
    tabId,
    onStreamingChanged,
    onAttentionChanged,
    onConversationIdChanged,
  } = options;

  const id = tabId ?? generateTabId();

  // Create per-tab content container (hidden by default)
  const contentEl = containerEl.createDiv({ cls: 'geminese-tab-content' });
  contentEl.style.display = 'none';

  // Create ChatState with callbacks
  const state = new ChatState({
    onStreamingStateChanged: (isStreaming) => {
      onStreamingChanged?.(isStreaming);
    },
    onMessagesChanged: () => {},
    onAttentionChanged: (needsAttention) => {
      onAttentionChanged?.(needsAttention);
    },
    onConversationChanged: (conversationId) => {
      onConversationIdChanged?.(conversationId);
    },
  });

  // Create subagent manager with no-op callback.
  // This placeholder is replaced in initializeTabControllers() with the actual
  // callback that updates the StreamController. We defer the real callback
  // because StreamController doesn't exist until controllers are initialized.
  const subagentManager = new SubagentManager(() => {});

  // Create DOM structure
  const dom = buildTabDOM(contentEl);

  // Create initial TabData (service and controllers are lazy-initialized)
  const tab: TabData = {
    id,
    conversationId: conversation?.id ?? null,
    service: null,
    serviceInitialized: false,
    state,
    controllers: {
      selectionController: null,
      browserSelectionController: null,
      canvasSelectionController: null,
      conversationController: null,
      streamController: null,
      inputController: null,
      navigationController: null,
    },
    services: {
      subagentManager,
      instructionRefineService: null,
      titleGenerationService: null,
    },
    ui: {
      fileContextManager: null,
      imageContextManager: null,
      modelSelector: null,
      thinkingBudgetSelector: null,
      externalContextSelector: null,
      mcpServerSelector: null,
      permissionToggle: null,
      slashCommandDropdown: null,
      instructionModeManager: null,
      bangBashModeManager: null,
      contextUsageMeter: null,
      statusPanel: null,
      navigationSidebar: null,
    },
    dom,
    renderer: null,
  };

  return tab;
}

/**
 * Auto-resizes a textarea based on its content.
 *
 * Logic:
 * - At minimum wrapper height: let flexbox allocate space (textarea fills available)
 * - When content exceeds flex allocation: set min-height to force wrapper growth
 * - When content shrinks: remove min-height override to let wrapper shrink
 * - Max height is capped at 55% of view height (minimum 150px)
 */
function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  const wrapper = textarea.closest('.geminese-input-wrapper') as HTMLElement;
  if (wrapper && wrapper.style.height) {
    textarea.style.minHeight = '';
    return;
  }

  // Clear inline min-height to let flexbox compute natural allocation
  textarea.style.minHeight = '';

  // Calculate max height: 55% of view height, minimum 150px
  const viewHeight = textarea.closest('.geminese-container')?.clientHeight ?? window.innerHeight;
  const maxHeight = Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);

  // Get flex-allocated height (what flexbox gives the textarea)
  const flexAllocatedHeight = textarea.offsetHeight;

  // Get content height (what the content actually needs), capped at max
  const contentHeight = Math.min(textarea.scrollHeight, maxHeight);

  // Only set min-height if content exceeds flex allocation
  // This forces the wrapper to grow while letting it shrink when content reduces
  if (contentHeight > flexAllocatedHeight) {
    textarea.style.minHeight = `${contentHeight}px`;
  }

  // Always set max-height to enforce the cap
  textarea.style.maxHeight = `${maxHeight}px`;
}

/**
 * Builds the DOM structure for a tab.
 */
function buildTabDOM(contentEl: HTMLElement): TabDOMElements {
  // Messages wrapper (for scroll-to-bottom button positioning)
  const messagesWrapperEl = contentEl.createDiv({ cls: 'geminese-messages-wrapper' });

  // Messages area (inside wrapper)
  const messagesEl = messagesWrapperEl.createDiv({ cls: 'geminese-messages' });

  // Welcome message placeholder
  const welcomeEl = messagesEl.createDiv({ cls: 'geminese-welcome' });

  // Status panel container (fixed between messages and input)
  const statusPanelContainerEl = contentEl.createDiv({ cls: 'geminese-status-panel-container' });

  // Input container
  const inputContainerEl = contentEl.createDiv({ cls: 'geminese-input-container' });

  // Nav row (for tab badges and header icons, populated by GemineseView)
  const navRowEl = inputContainerEl.createDiv({ cls: 'geminese-input-nav-row' });

  const inputWrapper = inputContainerEl.createDiv({ cls: 'geminese-input-wrapper' });
  const dragHandleEl = inputWrapper.createDiv({ cls: 'geminese-input-drag-handle' });

  // File context card (current note + attached files) inside input wrapper
  const contextCardEl = inputWrapper.createDiv({ cls: 'geminese-context-card' });
  const contextBodyEl = contextCardEl.createDiv({ cls: 'geminese-context-card-body' });

  // Context row inside card body (file chips + selection / browser / canvas indicators)
  const contextRowEl = contextBodyEl.createDiv({ cls: 'geminese-context-row' });

  // Input textarea
  const inputEl = inputWrapper.createEl('textarea', {
    cls: 'geminese-input',
    attr: {
      placeholder: 'How can I help you today?',
      rows: '3',
      dir: 'auto',
    },
  });

  // Send button (icon) overlayed in bottom-right of input wrapper
  const sendBtnEl = inputWrapper.createDiv({ cls: 'geminese-send-btn' });
  sendBtnEl.setAttribute('aria-label', 'Send message');
  setIcon(sendBtnEl, 'arrow-up');

  return {
    contentEl,
    messagesEl,
    welcomeEl,
    statusPanelContainerEl,
    inputContainerEl,
    inputWrapper,
    dragHandleEl,
    contextCardEl,
    inputEl,
    sendButtonEl: sendBtnEl,
    navRowEl,
    contextRowEl,
    selectionIndicatorEl: null,
    browserIndicatorEl: null,
    canvasIndicatorEl: null,
    eventCleanups: [],
  };
}

/**
 * Initializes the tab's GemineseService (lazy initialization).
 * Call this when the tab becomes active or when the first message is sent.
 *
 * Session ID resolution:
 * - If tab has conversationId (existing chat) → lookup conversation's sessionId → ensureReady with it
 * - If tab has no conversationId (new chat) → ensureReady without sessionId
 *
 * This ensures the single source of truth (tab.conversationId) determines session behavior.
 *
 * Ensures consistent state: if initialization fails, tab.service is null
 * and tab.serviceInitialized remains false for retry.
 */
export async function initializeTabService(
  tab: TabData,
  plugin: GeminesePlugin,
  mcpManager: McpServerManager
): Promise<void> {
  if (tab.serviceInitialized) {
    return;
  }

  let service: GemineseService | null = null;
  let unsubscribeReadyState: (() => void) | null = null;

  try {
    // Create per-tab GemineseService
    service = new GemineseService(plugin, mcpManager);
    unsubscribeReadyState = service.onReadyStateChange((ready) => {
      tab.ui.modelSelector?.setReady(ready);
    });
    tab.dom.eventCleanups.push(() => unsubscribeReadyState?.());

    // Resolve session ID and external contexts from conversation if this is an existing chat
    // Single source of truth: tab.conversationId determines if we have a session to resume
    let sessionId: string | undefined;
    let externalContextPaths = plugin.settings.persistentExternalContextPaths || [];
    if (tab.conversationId) {
      const conversation = await plugin.getConversationById(tab.conversationId);

      if (conversation) {
        sessionId = service.applyForkState(conversation) ?? undefined;

        const hasMessages = conversation.messages.length > 0;
        externalContextPaths = hasMessages
          ? conversation.externalContextPaths || []
          : (plugin.settings.persistentExternalContextPaths || []);
      }
    }

    // Ensure SDK process is ready
    // - Existing chat: with sessionId for resume
    // - New chat: without sessionId
    service.ensureReady({
      sessionId,
      externalContextPaths,
    }).catch(() => {
      // Best-effort, ignore failures
    });

    // Only set tab state after successful initialization
    tab.service = service;
    tab.serviceInitialized = true;
  } catch (error) {
    // Clean up partial state on failure
    unsubscribeReadyState?.();
    service?.closePersistentQuery('initialization failed');
    tab.service = null;
    tab.serviceInitialized = false;

    // Re-throw to let caller handle (e.g., show error to user)
    throw error;
  }
}

/**
 * Initializes file and image context managers for a tab.
 */
function initializeContextManagers(tab: TabData, plugin: GeminesePlugin): void {
  const { dom } = tab;
  const app = plugin.app;

  // File context manager - chips in contextRowEl, dropdown in inputContainerEl
  tab.ui.fileContextManager = new FileContextManager(
    app,
    dom.contextRowEl,
    dom.inputEl,
    {
      getExcludedTags: () => plugin.settings.excludedTags,
      onChipsChanged: () => {
        const hasFiles =
          !!tab.ui.fileContextManager?.getCurrentNotePath() ||
          (tab.ui.fileContextManager?.getAttachedFiles().size ?? 0) > 0;
        const hasImages = (tab.ui.imageContextManager?.getAttachedImages().length ?? 0) > 0;
        if (hasFiles || hasImages) {
          dom.contextCardEl.addClass('has-content');
          dom.contextRowEl.addClass('has-content');
        } else {
          dom.contextCardEl.removeClass('has-content');
          dom.contextRowEl.removeClass('has-content');
        }

        tab.controllers.selectionController?.updateContextRowVisibility();
        tab.controllers.browserSelectionController?.updateContextRowVisibility();
        tab.controllers.canvasSelectionController?.updateContextRowVisibility();
        autoResizeTextarea(dom.inputEl);
        tab.renderer?.scrollToBottomIfNeeded();
      },
      getExternalContexts: () => tab.ui.externalContextSelector?.getExternalContexts() || [],
    },
    dom.inputContainerEl
  );
  tab.ui.fileContextManager.setMcpManager(plugin.mcpManager);
  tab.ui.fileContextManager.setAgentService(plugin.agentManager);

  // Image context manager - drag/drop uses inputContainerEl, preview in contextRowEl
  tab.ui.imageContextManager = new ImageContextManager(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onImagesChanged: () => {
        tab.controllers.selectionController?.updateContextRowVisibility();
        tab.controllers.browserSelectionController?.updateContextRowVisibility();
        tab.controllers.canvasSelectionController?.updateContextRowVisibility();
        autoResizeTextarea(dom.inputEl);
        tab.renderer?.scrollToBottomIfNeeded();
      },
    },
    dom.contextRowEl
  );
}

/**
 * Initializes slash command dropdown for a tab.
 * @param getSdkCommands Callback to get SDK commands from any ready service (shared across tabs).
 * @param getHiddenCommands Callback to get current hidden commands from settings.
 */
function initializeSlashCommands(
  tab: TabData,
  getSdkCommands?: () => Promise<SlashCommand[]>,
  getHiddenCommands?: () => Set<string>
): void {
  const { dom } = tab;

  tab.ui.slashCommandDropdown = new SlashCommandDropdown(
    dom.inputContainerEl,
    dom.inputEl,
    {
      onSelect: () => {},
      onHide: () => {},
      getSdkCommands,
    },
    {
      hiddenCommands: getHiddenCommands?.() ?? new Set(),
    }
  );
}

/**
 * Initializes instruction mode and todo panel for a tab.
 */
function initializeInstructionAndTodo(tab: TabData, plugin: GeminesePlugin): void {
  const { dom } = tab;

  tab.services.instructionRefineService = new InstructionRefineService(plugin);
  tab.services.titleGenerationService = new TitleGenerationService(plugin);
  tab.ui.instructionModeManager = new InstructionModeManagerClass(
    dom.inputEl,
    {
      onSubmit: async (rawInstruction) => {
        await tab.controllers.inputController?.handleInstructionSubmit(rawInstruction);
      },
      getInputWrapper: () => dom.inputWrapper,
    }
  );

  // Bang bash mode (! command execution)
  if (plugin.settings.enableBangBash) {
    const vaultPath = getVaultPath(plugin.app);
    if (vaultPath) {
      const enhancedPath = getEnhancedPath();
      const bashService = new BangBashService(vaultPath, enhancedPath);

      tab.ui.bangBashModeManager = new BangBashModeManagerClass(
        dom.inputEl,
        {
          onSubmit: async (command) => {
            const statusPanel = tab.ui.statusPanel;
            if (!statusPanel) return;

            const id = `bash-${Date.now()}`;
            statusPanel.addBashOutput({ id, command, status: 'running', output: '' });

            const result = await bashService.execute(command);
            const output = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
            const status = result.exitCode === 0 ? 'completed' : 'error';
            statusPanel.updateBashOutput(id, { status, output, exitCode: result.exitCode });
          },
          getInputWrapper: () => dom.inputWrapper,
        }
      );
    }
  }

  tab.ui.statusPanel = new StatusPanel();
  tab.ui.statusPanel.mount(dom.statusPanelContainerEl);
}

/**
 * Creates and wires the input toolbar for a tab.
 */
function initializeInputToolbar(tab: TabData, plugin: GeminesePlugin): void {
  const { dom } = tab;

  const inputToolbar = dom.inputWrapper.createDiv({ cls: 'geminese-input-toolbar' });
  const toolbarComponents = createInputToolbar(inputToolbar, {
    getSettings: () => ({
      model: plugin.settings.model,
      thinkingBudget: plugin.settings.thinkingBudget,
      permissionMode: plugin.settings.permissionMode,
    }),
    getEnvironmentVariables: () => plugin.getActiveEnvironmentVariables(),
    getResolvedModel: () => tab.resolvedModelName ?? null,
    onModelChange: async (model: GeminiModel) => {
      plugin.settings.model = model;
      tab.resolvedModelName = null;
      const isDefaultModel = DEFAULT_GEMINI_MODELS.find((m) => m.value === model);
      if (isDefaultModel) {
        plugin.settings.thinkingBudget = DEFAULT_THINKING_BUDGET[model];
        plugin.settings.lastGeminiModel = model;
      } else {
        plugin.settings.lastCustomModel = model;
      }
      await plugin.saveSettings();
      tab.ui.thinkingBudgetSelector?.updateDisplay();
      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();

      // Recalculate context usage percentage for the new model's context window
      const currentUsage = tab.state.usage;
      if (currentUsage) {
        const newContextWindow = getContextWindowSize(model, plugin.settings.customContextLimits);
        const newPercentage = Math.min(100, Math.max(0, Math.round((currentUsage.contextTokens / newContextWindow) * 100)));
        tab.state.usage = {
          ...currentUsage,
          model,
          contextWindow: newContextWindow,
          percentage: newPercentage,
        };
      }
    },
    onThinkingBudgetChange: async (budget: ThinkingBudget) => {
      plugin.settings.thinkingBudget = budget;
      await plugin.saveSettings();
    },
    onPermissionModeChange: async (mode) => {
      plugin.settings.permissionMode = mode;
      await plugin.saveSettings();
      dom.inputWrapper.toggleClass('geminese-input-plan-mode', mode === 'plan');
    },
  });

  tab.ui.modelSelector = toolbarComponents.modelSelector;
  tab.ui.thinkingBudgetSelector = toolbarComponents.thinkingBudgetSelector;
  tab.ui.contextUsageMeter = toolbarComponents.contextUsageMeter;
  tab.ui.externalContextSelector = toolbarComponents.externalContextSelector;
  tab.ui.mcpServerSelector = toolbarComponents.mcpServerSelector;
  tab.ui.permissionToggle = toolbarComponents.permissionToggle;

  tab.ui.mcpServerSelector.setMcpManager(plugin.mcpManager);

  // Sync @-mentions to UI selector
  tab.ui.fileContextManager?.setOnMcpMentionChange((servers) => {
    tab.ui.mcpServerSelector?.addMentionedServers(servers);
  });

  // Wire external context changes
  tab.ui.externalContextSelector.setOnChange(() => {
    tab.ui.fileContextManager?.preScanExternalContexts();
  });

  // Initialize persistent paths
  tab.ui.externalContextSelector.setPersistentPaths(
    plugin.settings.persistentExternalContextPaths || []
  );

  // Wire persistence changes
  tab.ui.externalContextSelector.setOnPersistenceChange(async (paths) => {
    plugin.settings.persistentExternalContextPaths = paths;
    await plugin.saveSettings();
  });

  dom.inputWrapper.toggleClass('geminese-input-plan-mode', plugin.settings.permissionMode === 'plan');
}

export interface InitializeTabUIOptions {
  getSdkCommands?: () => Promise<SlashCommand[]>;
}

/**
 * Initializes the tab's UI components.
 * Call this after the tab is created and before it becomes active.
 */
export function initializeTabUI(
  tab: TabData,
  plugin: GeminesePlugin,
  options: InitializeTabUIOptions = {}
): void {
  const { dom, state } = tab;

  // Initialize context managers (file/image)
  initializeContextManagers(tab, plugin);

  // Selection indicator - add to contextRowEl
  dom.selectionIndicatorEl = dom.contextRowEl.createDiv({ cls: 'geminese-selection-indicator' });
  dom.selectionIndicatorEl.style.display = 'none';

  // Browser selection indicator
  dom.browserIndicatorEl = dom.contextRowEl.createDiv({ cls: 'geminese-browser-selection-indicator' });
  dom.browserIndicatorEl.style.display = 'none';

  // Canvas selection indicator
  dom.canvasIndicatorEl = dom.contextRowEl.createDiv({ cls: 'geminese-canvas-indicator' });
  dom.canvasIndicatorEl.style.display = 'none';

  // Initialize slash commands with shared SDK commands callback and hidden commands
  initializeSlashCommands(
    tab,
    options.getSdkCommands,
    () => new Set((plugin.settings.hiddenSlashCommands || []).map(c => c.toLowerCase()))
  );

  // Initialize navigation sidebar
  if (dom.messagesEl.parentElement) {
    tab.ui.navigationSidebar = new NavigationSidebar(
      dom.messagesEl.parentElement,
      dom.messagesEl
    );
  }

  // Initialize instruction mode and todo panel
  initializeInstructionAndTodo(tab, plugin);

  // Initialize input toolbar
  initializeInputToolbar(tab, plugin);

  // Update ChatState callbacks for UI updates
  state.callbacks = {
    ...state.callbacks,
    onUsageChanged: (usage) => tab.ui.contextUsageMeter?.update(usage),
    onTodosChanged: (todos) => tab.ui.statusPanel?.updateTodos(todos),
    onAutoScrollChanged: () => tab.ui.navigationSidebar?.updateVisibility(),
  };

  // ResizeObserver to detect overflow changes (e.g., content growth)
  const resizeObserver = new ResizeObserver(() => {
    tab.ui.navigationSidebar?.updateVisibility();
  });
  resizeObserver.observe(dom.messagesEl);
  dom.eventCleanups.push(() => resizeObserver.disconnect());

  initializeDragResize(tab);
}

function initializeDragResize(tab: TabData): void {
  const { dom } = tab;

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startY = e.clientY;
    const startHeight = dom.inputWrapper.offsetHeight;
    
    dom.dragHandleEl.setPointerCapture(e.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      
      const deltaY = startY - moveEvent.clientY;
      let newHeight = startHeight + deltaY;

      const viewHeight = dom.inputWrapper.closest('.geminese-container')?.clientHeight ?? window.innerHeight;
      const maxHeight = viewHeight * 0.8;
      const minHeight = 140;

      newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));
      
      dom.inputWrapper.style.height = `${newHeight}px`;
      dom.inputWrapper.style.minHeight = `${newHeight}px`;
      dom.inputEl.style.maxHeight = `${newHeight - 40}px`;
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      upEvent.preventDefault();
      dom.dragHandleEl.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  dom.dragHandleEl.addEventListener('pointerdown', handlePointerDown);
  dom.eventCleanups.push(() => dom.dragHandleEl.removeEventListener('pointerdown', handlePointerDown));
}

export interface ForkContext {
  messages: ChatMessage[];
  sourceSessionId: string;
  resumeAt: string;
  sourceTitle?: string;
  /** 1-based index used for fork title suffix (counts only non-interrupt user messages). */
  forkAtUserMessage?: number;
  currentNote?: string;
}

function deepCloneMessages(messages: ChatMessage[]): ChatMessage[] {
  const sc = (globalThis as unknown as { structuredClone?: <T>(value: T) => T }).structuredClone;
  if (typeof sc === 'function') {
    return sc(messages);
  }
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function countUserMessagesForForkTitle(messages: ChatMessage[]): number {
  // Keep fork numbering stable by excluding non-semantic user messages.
  return messages.filter(m => m.role === 'user' && !m.isInterrupt && !m.isRebuiltContext).length;
}

interface ForkSource {
  sourceSessionId: string;
  sourceTitle?: string;
  currentNote?: string;
}

/**
 * Resolves session ID and conversation metadata needed for forking.
 * Prefers the live service session ID; falls back to persisted conversation metadata.
 * Shows a notice and returns null when no session can be resolved.
 */
function resolveForkSource(tab: TabData, plugin: GeminesePlugin): ForkSource | null {
  let sourceSessionId = tab.service?.getSessionId() ?? null;

  if (!sourceSessionId && tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    sourceSessionId = conversation?.sdkSessionId ?? conversation?.sessionId ?? conversation?.forkSource?.sessionId ?? null;
  }

  if (!sourceSessionId) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoSession') }));
    return null;
  }

  const sourceConversation = tab.conversationId
    ? plugin.getConversationSync(tab.conversationId)
    : undefined;

  return {
    sourceSessionId,
    sourceTitle: sourceConversation?.title,
    currentNote: sourceConversation?.currentNote,
  };
}

async function handleForkRequest(
  tab: TabData,
  plugin: GeminesePlugin,
  userMessageId: string,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
): Promise<void> {
  const { state } = tab;

  if (state.isStreaming) {
    new Notice(t('chat.fork.unavailableStreaming'));
    return;
  }

  const msgs = state.messages;
  const userIdx = msgs.findIndex(m => m.id === userMessageId);
  if (userIdx === -1) {
    new Notice(t('chat.fork.failed', { error: t('chat.fork.errorMessageNotFound') }));
    return;
  }

  if (!msgs[userIdx].sdkUserUuid) {
    new Notice(t('chat.fork.unavailableNoUuid'));
    return;
  }

  // Find previous assistant UUID and whether a response follows the user message
  let prevAssistantUuid: string | undefined;
  for (let i = userIdx - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].sdkAssistantUuid) {
      prevAssistantUuid = msgs[i].sdkAssistantUuid;
      break;
    }
  }
  let hasResponse = false;
  for (let i = userIdx + 1; i < msgs.length; i++) {
    if (msgs[i].role === 'user') break;
    if (msgs[i].role === 'assistant' && msgs[i].sdkAssistantUuid) {
      hasResponse = true;
      break;
    }
  }

  if (!hasResponse || !prevAssistantUuid) {
    new Notice(t('chat.fork.unavailableNoResponse'));
    return;
  }

  const source = resolveForkSource(tab, plugin);
  if (!source) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs.slice(0, userIdx)),
    sourceSessionId: source.sourceSessionId,
    resumeAt: prevAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: countUserMessagesForForkTitle(msgs.slice(0, userIdx + 1)),
    currentNote: source.currentNote,
  });
}

async function handleForkAll(
  tab: TabData,
  plugin: GeminesePlugin,
  forkRequestCallback: (forkContext: ForkContext) => Promise<void>,
): Promise<void> {
  const { state } = tab;

  if (state.isStreaming) {
    new Notice(t('chat.fork.unavailableStreaming'));
    return;
  }

  const msgs = state.messages;
  if (msgs.length === 0) {
    new Notice(t('chat.fork.commandNoMessages'));
    return;
  }

  let lastAssistantUuid: string | undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].sdkAssistantUuid) {
      lastAssistantUuid = msgs[i].sdkAssistantUuid;
      break;
    }
  }

  if (!lastAssistantUuid) {
    new Notice(t('chat.fork.commandNoAssistantUuid'));
    return;
  }

  const source = resolveForkSource(tab, plugin);
  if (!source) return;

  await forkRequestCallback({
    messages: deepCloneMessages(msgs),
    sourceSessionId: source.sourceSessionId,
    resumeAt: lastAssistantUuid,
    sourceTitle: source.sourceTitle,
    forkAtUserMessage: countUserMessagesForForkTitle(msgs) + 1,
    currentNote: source.currentNote,
  });
}

export function initializeTabControllers(
  tab: TabData,
  plugin: GeminesePlugin,
  component: Component,
  mcpManager: McpServerManager,
  forkRequestCallback?: (forkContext: ForkContext) => Promise<void>,
  openConversation?: (conversationId: string) => Promise<void>,
): void {
  const { dom, state, services, ui } = tab;

  // Create renderer
  tab.renderer = new MessageRenderer(
    plugin,
    component,
    dom.messagesEl,
    forkRequestCallback
      ? (id) => handleForkRequest(tab, plugin, id, forkRequestCallback)
      : undefined,
  );

  // Selection controller
  tab.controllers.selectionController = new SelectionController(
    plugin.app,
    dom.selectionIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl)
  );

  // Browser selection controller
  tab.controllers.browserSelectionController = new BrowserSelectionController(
    plugin.app,
    dom.browserIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl)
  );

  // Canvas selection controller
  tab.controllers.canvasSelectionController = new CanvasSelectionController(
    plugin.app,
    dom.canvasIndicatorEl!,
    dom.inputEl,
    dom.contextRowEl,
    () => autoResizeTextarea(dom.inputEl)
  );

  // Stream controller
  tab.controllers.streamController = new StreamController({
    plugin,
    state,
    renderer: tab.renderer,
    subagentManager: services.subagentManager,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    updateQueueIndicator: () => tab.controllers.inputController?.updateQueueIndicator(),
    getAgentService: () => tab.service,
  });

  // Wire subagent callback now that StreamController exists
  // DOM updates for async subagents are handled by SubagentManager directly;
  // this callback handles message persistence and status panel updates.
  services.subagentManager.setCallback(
    (subagent) => {
      // Update messages (DOM already updated by manager)
      tab.controllers.streamController?.onAsyncSubagentStateChange(subagent);

      // During active stream, regular end-of-turn save captures latest state.
      if (!tab.state.isStreaming && tab.state.currentConversationId) {
        void tab.controllers.conversationController?.save(false).catch(() => {
          // Best-effort persistence; avoid surfacing background-save failures here.
        });
      }

      // Update status panel (hidden by default - inline is shown first)
      if (subagent.mode === 'async' && ui.statusPanel) {
        ui.statusPanel.updateSubagent({
          id: subagent.id,
          description: subagent.description,
          status: subagent.asyncStatus === 'completed' ? 'completed'
            : subagent.asyncStatus === 'error' ? 'error'
            : subagent.asyncStatus === 'orphaned' ? 'orphaned'
            : subagent.asyncStatus === 'running' ? 'running'
            : 'pending',
          prompt: subagent.prompt,
          result: subagent.result,
        });
      }
    }
  );

  // Conversation controller
  tab.controllers.conversationController = new ConversationController(
    {
      plugin,
      state,
      renderer: tab.renderer,
      subagentManager: services.subagentManager,
      getHistoryDropdown: () => null, // Tab doesn't have its own history dropdown
      getWelcomeEl: () => dom.welcomeEl,
      setWelcomeEl: (el) => { dom.welcomeEl = el; },
      getMessagesEl: () => dom.messagesEl,
      getInputEl: () => dom.inputEl,
      getFileContextManager: () => ui.fileContextManager,
      getImageContextManager: () => ui.imageContextManager,
      getMcpServerSelector: () => ui.mcpServerSelector,
      getExternalContextSelector: () => ui.externalContextSelector,
      clearQueuedMessage: () => tab.controllers.inputController?.clearQueuedMessage(),
      getTitleGenerationService: () => services.titleGenerationService,
      getStatusPanel: () => ui.statusPanel,
      getAgentService: () => tab.service, // Use tab's service instead of plugin's
    },
    {}
  );

  // Input controller - needs the tab's service
  const generateId = () => `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  tab.controllers.inputController = new InputController({
    plugin,
    state,
    renderer: tab.renderer,
    streamController: tab.controllers.streamController,
    selectionController: tab.controllers.selectionController,
    browserSelectionController: tab.controllers.browserSelectionController,
    canvasSelectionController: tab.controllers.canvasSelectionController,
    conversationController: tab.controllers.conversationController,
    getInputEl: () => dom.inputEl,
    getInputContainerEl: () => dom.inputContainerEl,
    getWelcomeEl: () => dom.welcomeEl,
    getMessagesEl: () => dom.messagesEl,
    getFileContextManager: () => ui.fileContextManager,
    getImageContextManager: () => ui.imageContextManager,
    getMcpServerSelector: () => ui.mcpServerSelector,
    getExternalContextSelector: () => ui.externalContextSelector,
    getInstructionModeManager: () => ui.instructionModeManager,
    getInstructionRefineService: () => services.instructionRefineService,
    getTitleGenerationService: () => services.titleGenerationService,
    getStatusPanel: () => ui.statusPanel,
    generateId,
    resetInputHeight: () => {
      // Per-tab input height is managed by CSS, no dynamic adjustment needed
    },
    // Override to use tab's service instead of plugin.agentService
    getAgentService: () => tab.service,
    getSubagentManager: () => services.subagentManager,
    onResolvedModel: (model: string) => {
      tab.resolvedModelName = model;
      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();
    },
    // Lazy initialization: ensure service is ready before first query
    // initializeTabService() handles session ID resolution from tab.conversationId
    ensureServiceInitialized: async () => {
      if (tab.serviceInitialized) {
        return true;
      }
      try {
        await initializeTabService(tab, plugin, mcpManager);
        setupServiceCallbacks(tab, plugin);
        return true;
      } catch {
        return false;
      }
    },
    openConversation,
    onForkAll: forkRequestCallback
      ? () => handleForkAll(tab, plugin, forkRequestCallback)
      : undefined,
  });

  // Wire send button to trigger sendMessage (click behaves like Enter)
  if (dom.sendButtonEl) {
    dom.sendButtonEl.onclick = () => {
      void tab.controllers.inputController?.sendMessage();
    };
  }

  // Navigation controller
  tab.controllers.navigationController = new NavigationController({
    getMessagesEl: () => dom.messagesEl,
    getInputEl: () => dom.inputEl,
    getSettings: () => plugin.settings.keyboardNavigation,
    isStreaming: () => state.isStreaming,
    shouldSkipEscapeHandling: () => {
      if (ui.instructionModeManager?.isActive()) return true;
      if (ui.bangBashModeManager?.isActive()) return true;
      if (tab.controllers.inputController?.isResumeDropdownVisible()) return true;
      if (ui.slashCommandDropdown?.isVisible()) return true;
      if (ui.fileContextManager?.isMentionDropdownVisible()) return true;
      return false;
    },
  });
  tab.controllers.navigationController.initialize();
}

/**
 * Wires up input event handlers for a tab.
 * Call this after controllers are initialized.
 * Stores cleanup functions in dom.eventCleanups for proper memory management.
 */
export function wireTabInputEvents(tab: TabData, plugin: GeminesePlugin): void {
  const { dom, ui, state, controllers } = tab;

  let wasBangBashActive = ui.bangBashModeManager?.isActive() ?? false;
  const syncBangBashSuppression = (): void => {
    const isActive = ui.bangBashModeManager?.isActive() ?? false;
    if (isActive === wasBangBashActive) return;
    wasBangBashActive = isActive;

    ui.slashCommandDropdown?.setEnabled(!isActive);
    if (isActive) {
      ui.fileContextManager?.hideMentionDropdown();
    }
  };

  // Input keydown handler
  const keydownHandler = (e: KeyboardEvent) => {
    if (ui.bangBashModeManager?.isActive()) {
      ui.bangBashModeManager.handleKeydown(e);
      syncBangBashSuppression();
      return;
    }

    // Check for # trigger first (empty input + # keystroke)
    if (ui.instructionModeManager?.handleTriggerKey(e)) {
      return;
    }

    // Check for ! trigger (empty input + ! keystroke)
    if (ui.bangBashModeManager?.handleTriggerKey(e)) {
      syncBangBashSuppression();
      return;
    }

    if (ui.instructionModeManager?.handleKeydown(e)) {
      return;
    }

    if (controllers.inputController?.handleResumeKeydown(e)) {
      return;
    }

    if (ui.slashCommandDropdown?.handleKeydown(e)) {
      return;
    }

    if (ui.fileContextManager?.handleMentionKeydown(e)) {
      return;
    }

    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Escape' && !e.isComposing && state.isStreaming) {
      e.preventDefault();
      controllers.inputController?.cancelStreaming();
      return;
    }

    // Enter: Send message
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void controllers.inputController?.sendMessage();
    }
  };
  dom.inputEl.addEventListener('keydown', keydownHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('keydown', keydownHandler));

  // Input change handler (includes auto-resize)
  const inputHandler = () => {
    if (!ui.bangBashModeManager?.isActive()) {
      ui.fileContextManager?.handleInputChange();
    }
    ui.instructionModeManager?.handleInputChange();
    ui.bangBashModeManager?.handleInputChange();
    syncBangBashSuppression();
    // Auto-resize textarea based on content
    autoResizeTextarea(dom.inputEl);
  };
  dom.inputEl.addEventListener('input', inputHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('input', inputHandler));

  // Input focus handler
  const focusHandler = () => {
    controllers.selectionController?.showHighlight();
  };
  dom.inputEl.addEventListener('focus', focusHandler);
  dom.eventCleanups.push(() => dom.inputEl.removeEventListener('focus', focusHandler));

  // Drag-and-drop vault files into input/card to attach as context
  const dropTarget = dom.inputWrapper;
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    void ui.fileContextManager?.handleFileDrop(e);
  };
  dropTarget.addEventListener('dragover', handleDragOver);
  dropTarget.addEventListener('drop', handleDrop);
  dom.eventCleanups.push(() => {
    dropTarget.removeEventListener('dragover', handleDragOver);
    dropTarget.removeEventListener('drop', handleDrop);
  });

  // Scroll listener for auto-scroll control (tracks position always, not just during streaming)
  const SCROLL_THRESHOLD = 20; // pixels from bottom to consider "at bottom"
  const RE_ENABLE_DELAY = 150; // ms to wait before re-enabling auto-scroll
  let reEnableTimeout: ReturnType<typeof setTimeout> | null = null;

  const isAutoScrollAllowed = (): boolean => plugin.settings.enableAutoScroll ?? true;

  const scrollHandler = () => {
    if (!isAutoScrollAllowed()) {
      if (reEnableTimeout) {
        clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;

    if (!isAtBottom) {
      // Immediately disable when user scrolls up
      if (reEnableTimeout) {
        clearTimeout(reEnableTimeout);
        reEnableTimeout = null;
      }
      state.autoScrollEnabled = false;
    } else if (!state.autoScrollEnabled) {
      // Debounce re-enabling to avoid bounce during scroll animation
      if (!reEnableTimeout) {
        reEnableTimeout = setTimeout(() => {
          reEnableTimeout = null;
          // Re-verify position before enabling (content may have changed)
          const { scrollTop, scrollHeight, clientHeight } = dom.messagesEl;
          if (scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD) {
            state.autoScrollEnabled = true;
          }
        }, RE_ENABLE_DELAY);
      }
    }
  };
  dom.messagesEl.addEventListener('scroll', scrollHandler, { passive: true });
  dom.eventCleanups.push(() => {
    dom.messagesEl.removeEventListener('scroll', scrollHandler);
    if (reEnableTimeout) clearTimeout(reEnableTimeout);
  });
}

/**
 * Activates a tab (shows it and starts services).
 */
export function activateTab(tab: TabData): void {
  tab.dom.contentEl.style.display = 'flex';
  tab.controllers.selectionController?.start();
  tab.controllers.browserSelectionController?.start();
  tab.controllers.canvasSelectionController?.start();
  // Refresh navigation sidebar visibility (dimensions now available after display)
  tab.ui.navigationSidebar?.updateVisibility();
}

/**
 * Deactivates a tab (hides it and stops services).
 */
export function deactivateTab(tab: TabData): void {
  tab.dom.contentEl.style.display = 'none';
  tab.controllers.selectionController?.stop();
  tab.controllers.browserSelectionController?.stop();
  tab.controllers.canvasSelectionController?.stop();
}

/**
 * Cleans up a tab and releases all resources.
 * Made async to ensure proper cleanup ordering.
 */
export async function destroyTab(tab: TabData): Promise<void> {
  // Stop polling
  tab.controllers.selectionController?.stop();
  tab.controllers.selectionController?.clear();
  tab.controllers.browserSelectionController?.stop();
  tab.controllers.browserSelectionController?.clear();
  tab.controllers.canvasSelectionController?.stop();
  tab.controllers.canvasSelectionController?.clear();

  // Cleanup navigation controller
  tab.controllers.navigationController?.dispose();

  // Cleanup thinking state
  cleanupThinkingBlock(tab.state.currentThinkingState);
  tab.state.currentThinkingState = null;

  // Cleanup UI components
  tab.controllers.inputController?.destroyResumeDropdown();
  tab.ui.fileContextManager?.destroy();
  tab.ui.slashCommandDropdown?.destroy();
  tab.ui.slashCommandDropdown = null;
  tab.ui.instructionModeManager?.destroy();
  tab.ui.instructionModeManager = null;
  tab.ui.bangBashModeManager?.destroy();
  tab.ui.bangBashModeManager = null;
  tab.services.instructionRefineService?.cancel();
  tab.services.instructionRefineService = null;
  tab.services.titleGenerationService?.cancel();
  tab.services.titleGenerationService = null;
  tab.ui.statusPanel?.destroy();
  tab.ui.statusPanel = null;
  tab.ui.navigationSidebar?.destroy();
  tab.ui.navigationSidebar = null;

  // Cleanup subagents
  tab.services.subagentManager.orphanAllActive();
  tab.services.subagentManager.clear();

  // Remove event listeners to prevent memory leaks
  for (const cleanup of tab.dom.eventCleanups) {
    cleanup();
  }
  tab.dom.eventCleanups.length = 0;

  // Close the tab's service
  // Note: closePersistentQuery is synchronous but we make destroyTab async
  // for future-proofing and proper cleanup ordering
  tab.service?.closePersistentQuery('tab closed');
  tab.service = null;

  // Remove DOM element
  tab.dom.contentEl.remove();
}

/**
 * Gets the display title for a tab.
 * Uses synchronous access since we only need the title, not messages.
 */
export function getTabTitle(tab: TabData, plugin: GeminesePlugin): string {
  if (tab.conversationId) {
    const conversation = plugin.getConversationSync(tab.conversationId);
    if (conversation?.title) {
      return conversation.title;
    }
  }
  return 'New Chat';
}

/** Shared between Tab.ts and TabManager.ts to avoid duplication. */
export function setupServiceCallbacks(tab: TabData, plugin: GeminesePlugin): void {
  if (tab.service && tab.controllers.inputController) {
    tab.service.setApprovalCallback(
      async (toolName, input, description, options) =>
        await tab.controllers.inputController?.handleApprovalRequest(toolName, input, description, options)
        ?? 'cancel'
    );
    tab.service.setApprovalDismisser(
      () => tab.controllers.inputController?.dismissPendingApproval()
    );
    tab.service.setAskUserQuestionCallback(
      async (input, signal) =>
        await tab.controllers.inputController?.handleAskUserQuestion(input, signal)
        ?? null
    );
    tab.service.setExitPlanModeCallback(
      async (input, signal) => {
        const decision = await tab.controllers.inputController?.handleExitPlanMode(input, signal) ?? null;
        // Revert only on approve; feedback and cancel keep plan mode active.
        if (decision !== null && decision.type !== 'feedback') {
          // Only restore permission mode if still in plan mode — user may have toggled out via Shift+Tab
          if (plugin.settings.permissionMode === 'plan') {
            const restoreMode = tab.state.prePlanPermissionMode ?? 'agent';
            tab.state.prePlanPermissionMode = null;
            updatePlanModeUI(tab, plugin, restoreMode);
          }
          if (decision.type === 'approve-new-session') {
            tab.state.pendingNewSessionPlan = decision.planContent;
            tab.state.cancelRequested = true;
          }
        }
        return decision;
      }
    );
    tab.service.setPermissionModeSyncCallback(null);
  }
}

export function updatePlanModeUI(tab: TabData, plugin: GeminesePlugin, mode: PermissionMode): void {
  plugin.settings.permissionMode = mode;
  void plugin.saveSettings();
  tab.ui.permissionToggle?.updateDisplay();
  tab.dom.inputWrapper.toggleClass('geminese-input-plan-mode', mode === 'plan');
}

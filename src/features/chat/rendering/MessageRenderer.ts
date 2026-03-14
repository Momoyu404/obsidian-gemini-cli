import type { App, Component } from 'obsidian';
import { MarkdownRenderer, Notice } from 'obsidian';

import { isSubagentToolName, isWriteEditTool, TOOL_AGENT_OUTPUT } from '../../../core/tools/toolNames';
import type { ChatMessage, ImageAttachment, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { t } from '../../../i18n';
import type GeminesePlugin from '../../../main';
import { formatDurationMmSs } from '../../../utils/date';
import { processFileLinks, registerFileLinkHandler } from '../../../utils/fileLink';
import { replaceImageEmbedsWithHtml } from '../../../utils/imageEmbed';
import {
  renderStoredAsyncSubagent,
  renderStoredSubagent,
} from './SubagentRenderer';
import { renderStoredThinkingBlock } from './ThinkingBlockRenderer';
import { renderStoredToolCall } from './ToolCallRenderer';
import { renderStoredWriteEdit } from './WriteEditRenderer';

export type RenderContentFn = (el: HTMLElement, markdown: string) => Promise<void>;

/** Number of messages to render initially; older messages load on scroll. */
const INITIAL_RENDER_COUNT = 30;
/** Number of messages to load per batch when scrolling up. */
const LOAD_MORE_BATCH_SIZE = 20;

export class MessageRenderer {
  private app: App;
  private plugin: GeminesePlugin;
  private component: Component;
  private messagesEl: HTMLElement;
  private forkCallback?: (messageId: string) => Promise<void>;
  private liveMessageEls = new Map<string, HTMLElement>();

  /** All messages for current conversation (for pagination). */
  private allMessages: ChatMessage[] = [];
  /** How many messages from the end have been rendered so far. */
  private renderedCount = 0;
  /** IntersectionObserver for "load more" sentinel. */
  private loadMoreObserver: IntersectionObserver | null = null;
  /** Sentinel element at top of messages for triggering lazy load. */
  private sentinelEl: HTMLElement | null = null;

  private static readonly FORK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`;

  constructor(
    plugin: GeminesePlugin,
    component: Component,
    messagesEl: HTMLElement,
    forkCallback?: (messageId: string) => Promise<void>,
  ) {
    this.app = plugin.app;
    this.plugin = plugin;
    this.component = component;
    this.messagesEl = messagesEl;
    this.forkCallback = forkCallback;

    // Register delegated click handler for file links
    registerFileLinkHandler(this.app, this.messagesEl, this.component);
  }

  /** Sets the messages container element. */
  setMessagesEl(el: HTMLElement): void {
    this.messagesEl = el;
  }

  // ============================================
  // Streaming Message Rendering
  // ============================================

  /**
   * Adds a new message to the chat during streaming.
   * Returns the message element for content updates.
   */
  addMessage(msg: ChatMessage): HTMLElement {
    // Render images above message bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        this.scrollToBottom();
        const lastChild = this.messagesEl.lastElementChild as HTMLElement;
        return lastChild ?? this.messagesEl;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `geminese-message geminese-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });

    const contentEl = msgEl.createDiv({ cls: 'geminese-message-content', attr: { dir: 'auto' } });

    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'geminese-text-block' });
        void this.renderContent(textEl, textToShow);
        this.addUserCopyButton(msgEl, textToShow);
      }
      if (this.forkCallback) {
        this.liveMessageEls.set(msg.id, msgEl);
      }
    }

    this.scrollToBottom();
    return msgEl;
  }

  // ============================================
  // Stored Message Rendering (Batch/Replay)
  // ============================================

  /**
   * Renders messages for conversation load/switch with pagination.
   * Only the most recent INITIAL_RENDER_COUNT messages are rendered initially.
   * Older messages are loaded on demand when the user scrolls to the top.
   * @param messages Array of messages to render
   * @param getGreeting Function to get greeting text
   * @returns The newly created welcome element
   */
  renderMessages(
    messages: ChatMessage[],
    getGreeting: () => string
  ): HTMLElement {
    this.messagesEl.empty();
    this.liveMessageEls.clear();
    this.cleanupPagination();

    // Store for lazy loading
    this.allMessages = messages;
    this.renderedCount = 0;

    // Recreate welcome element after clearing
    const newWelcomeEl = this.messagesEl.createDiv({ cls: 'geminese-welcome' });
    newWelcomeEl.createDiv({ cls: 'geminese-welcome-greeting', text: getGreeting() });

    // Render only the tail of the conversation initially
    const startIndex = Math.max(0, messages.length - INITIAL_RENDER_COUNT);
    for (let i = startIndex; i < messages.length; i++) {
      this.renderStoredMessage(messages[i], messages, i);
    }
    this.renderedCount = messages.length - startIndex;

    // Add "load more" sentinel if there are older messages
    if (startIndex > 0) {
      this.addLoadMoreSentinel(newWelcomeEl);
    }

    this.scrollToBottom();
    return newWelcomeEl;
  }

  /**
   * Creates a sentinel element and IntersectionObserver to trigger loading
   * older messages when the user scrolls near the top.
   */
  private addLoadMoreSentinel(afterEl: HTMLElement): void {
    this.sentinelEl = document.createElement('div');
    this.sentinelEl.className = 'geminese-load-more-sentinel';
    this.sentinelEl.textContent = 'Loading earlier messages...';
    // Insert sentinel after the welcome element
    afterEl.insertAdjacentElement('afterend', this.sentinelEl);

    this.loadMoreObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.loadOlderMessages();
          }
        }
      },
      { root: this.messagesEl, rootMargin: '200px 0px 0px 0px' }
    );
    this.loadMoreObserver.observe(this.sentinelEl);
  }

  /**
   * Loads the next batch of older messages, preserving scroll position.
   */
  private loadOlderMessages(): void {
    const totalMessages = this.allMessages.length;
    const alreadyRenderedStart = totalMessages - this.renderedCount;
    if (alreadyRenderedStart <= 0) {
      this.cleanupPagination();
      return;
    }

    // Calculate batch range
    const batchStart = Math.max(0, alreadyRenderedStart - LOAD_MORE_BATCH_SIZE);
    const batchEnd = alreadyRenderedStart;

    // Preserve scroll position: record height before adding elements
    const scrollHeightBefore = this.messagesEl.scrollHeight;
    const scrollTopBefore = this.messagesEl.scrollTop;

    // Find the insertion point (right after sentinel or after welcome)
    const insertBefore = this.sentinelEl?.nextSibling ?? this.messagesEl.children[1] ?? null;

    // Render batch in order (oldest first)
    for (let i = batchStart; i < batchEnd; i++) {
      // Create a temporary container, render the message, then insert before the insertion point
      const tempDiv = document.createElement('div');
      tempDiv.style.display = 'contents';

      // Save and restore messagesEl to render into the temp container
      const originalMessagesEl = this.messagesEl;
      this.messagesEl = tempDiv;
      this.renderStoredMessage(this.allMessages[i], this.allMessages, i);
      this.messagesEl = originalMessagesEl;

      // Move rendered children into the real container
      while (tempDiv.firstChild) {
        this.messagesEl.insertBefore(tempDiv.firstChild, insertBefore as Node);
      }
    }

    this.renderedCount += (batchEnd - batchStart);

    // Restore scroll position so content doesn't jump
    const scrollHeightAfter = this.messagesEl.scrollHeight;
    this.messagesEl.scrollTop = scrollTopBefore + (scrollHeightAfter - scrollHeightBefore);

    // Remove sentinel if all messages are now rendered
    if (batchStart <= 0) {
      this.cleanupPagination();
    }
  }

  /** Cleans up pagination state (observer and sentinel). */
  private cleanupPagination(): void {
    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect();
      this.loadMoreObserver = null;
    }
    if (this.sentinelEl) {
      this.sentinelEl.remove();
      this.sentinelEl = null;
    }
  }

  renderStoredMessage(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    try {
      this.renderStoredMessageInner(msg, allMessages, index);
    } catch (err) {
      // Error boundary: render placeholder instead of crashing the entire conversation view
      console.error('[MessageRenderer] Failed to render message:', err, msg);
      const errorEl = this.messagesEl.createDiv({
        cls: 'geminese-message geminese-render-error',
        attr: { 'data-message-id': msg.id },
      });
      errorEl.setText('Failed to render message');
    }
  }

  private renderStoredMessageInner(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    // Render interrupt messages with special styling (not as user bubbles)
    if (msg.isInterrupt) {
      this.renderInterruptMessage();
      return;
    }

    // Skip rebuilt context messages (history sent to SDK on session reset)
    // These are internal context for the AI, not actual user messages to display
    if (msg.isRebuiltContext) {
      return;
    }

    // Render images above bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        return;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `geminese-message geminese-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });

    const contentEl = msgEl.createDiv({ cls: 'geminese-message-content', attr: { dir: 'auto' } });

    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'geminese-text-block' });
        void this.renderContent(textEl, textToShow);
        this.addUserCopyButton(msgEl, textToShow);
      }
      if (msg.sdkUserUuid && this.forkCallback) {
        this.addForkButton(msgEl, msg.id);
      }
    } else if (msg.role === 'assistant') {
      this.renderAssistantContent(msg, contentEl);
    }
  }

  /**
   * Renders an interrupt indicator (stored interrupts from SDK history).
   * Uses the same styling as streaming interrupts.
   */
  private renderInterruptMessage(): void {
    const msgEl = this.messagesEl.createDiv({ cls: 'geminese-message geminese-message-assistant' });
    const contentEl = msgEl.createDiv({ cls: 'geminese-message-content', attr: { dir: 'auto' } });
    const textEl = contentEl.createDiv({ cls: 'geminese-text-block' });
    textEl.innerHTML = '<span class="geminese-interrupted">Interrupted</span> <span class="geminese-interrupted-hint">· What should Geminese do instead?</span>';
  }

  /**
   * Renders assistant message content (content blocks or fallback).
   */
  private renderAssistantContent(msg: ChatMessage, contentEl: HTMLElement): void {
    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      const renderedToolIds = new Set<string>();
      for (const block of msg.contentBlocks) {
        try {
          if (block.type === 'thinking') {
            renderStoredThinkingBlock(
              contentEl,
              block.content,
              block.durationSeconds,
              (el, md) => this.renderContent(el, md)
            );
          } else if (block.type === 'text') {
            // Skip empty or whitespace-only text blocks to avoid extra gaps
            if (!block.content || !block.content.trim()) {
              continue;
            }
            const textEl = contentEl.createDiv({ cls: 'geminese-text-block' });
            void this.renderContent(textEl, block.content);
            this.addTextCopyButton(textEl, block.content);
          } else if (block.type === 'tool_use') {
            const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
            if (toolCall) {
              this.renderToolCall(contentEl, toolCall);
              renderedToolIds.add(toolCall.id);
            }
          } else if (block.type === 'compact_boundary') {
            const boundaryEl = contentEl.createDiv({ cls: 'geminese-compact-boundary' });
            boundaryEl.createSpan({ cls: 'geminese-compact-boundary-label', text: 'Conversation compacted' });
          } else if (block.type === 'subagent') {
            const taskToolCall = msg.toolCalls?.find(
              tc => tc.id === block.subagentId && isSubagentToolName(tc.name)
            );
            if (!taskToolCall) continue;

            this.renderTaskSubagent(contentEl, taskToolCall, block.mode);
            renderedToolIds.add(taskToolCall.id);
          }
        } catch (err) {
          console.error('[MessageRenderer] Failed to render content block:', err, block);
          contentEl.createDiv({
            cls: 'geminese-render-error',
            text: 'Failed to render content block',
          });
        }
      }

      // Defensive fallback: preserve tool visibility when contentBlocks/toolCalls drift on reload.
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (renderedToolIds.has(toolCall.id)) continue;
          this.renderToolCall(contentEl, toolCall);
          renderedToolIds.add(toolCall.id);
        }
      }
    } else {
      // Fallback for old conversations without contentBlocks
      if (msg.content) {
        const textEl = contentEl.createDiv({ cls: 'geminese-text-block' });
        void this.renderContent(textEl, msg.content);
        this.addTextCopyButton(textEl, msg.content);
      }
      if (msg.toolCalls) {
        for (const toolCall of msg.toolCalls) {
          this.renderToolCall(contentEl, toolCall);
        }
      }
    }

    // Render response duration footer (skip when message contains a compaction boundary)
    const hasCompactBoundary = msg.contentBlocks?.some(b => b.type === 'compact_boundary');
    if (msg.durationSeconds && msg.durationSeconds > 0 && !hasCompactBoundary) {
      const flavorWord = msg.durationFlavorWord || 'Baked';
      const footerEl = contentEl.createDiv({ cls: 'geminese-response-footer' });
      footerEl.createSpan({
        text: `* ${flavorWord} for ${formatDurationMmSs(msg.durationSeconds)}`,
        cls: 'geminese-baked-duration',
      });
    }
  }

  /**
   * Renders a tool call with special handling for Write/Edit and Agent (subagent).
   * TaskOutput is hidden as it's an internal tool for async subagent communication.
   */
  private renderToolCall(contentEl: HTMLElement, toolCall: ToolCallInfo): void {
    // Skip TaskOutput - it's invisible (internal async subagent communication)
    if (toolCall.name === TOOL_AGENT_OUTPUT) {
      return;
    }
    if (isWriteEditTool(toolCall.name)) {
      renderStoredWriteEdit(contentEl, toolCall);
    } else if (isSubagentToolName(toolCall.name)) {
      this.renderTaskSubagent(contentEl, toolCall);
    } else {
      renderStoredToolCall(contentEl, toolCall);
    }
  }

  private renderTaskSubagent(
    contentEl: HTMLElement,
    toolCall: ToolCallInfo,
    modeHint?: 'sync' | 'async'
  ): void {
    const subagentInfo = this.resolveTaskSubagent(toolCall, modeHint);
    if (subagentInfo.mode === 'async') {
      renderStoredAsyncSubagent(contentEl, subagentInfo);
      return;
    }
    renderStoredSubagent(contentEl, subagentInfo);
  }

  private resolveTaskSubagent(toolCall: ToolCallInfo, modeHint?: 'sync' | 'async'): SubagentInfo {
    if (toolCall.subagent) {
      if (!modeHint || toolCall.subagent.mode === modeHint) {
        return toolCall.subagent;
      }
      return {
        ...toolCall.subagent,
        mode: modeHint,
      };
    }

    const description = (toolCall.input?.description as string) || 'Subagent task';
    const prompt = (toolCall.input?.prompt as string) || '';
    const mode = modeHint ?? (toolCall.input?.run_in_background === true ? 'async' : 'sync');

    if (mode !== 'async') {
      return {
        id: toolCall.id,
        description,
        prompt,
        status: this.mapToolStatusToSubagentStatus(toolCall.status),
        toolCalls: [],
        isExpanded: false,
        result: toolCall.result,
      };
    }

    const asyncStatus = this.inferAsyncStatusFromTaskTool(toolCall);
    return {
      id: toolCall.id,
      description,
      prompt,
      mode: 'async',
      status: asyncStatus,
      asyncStatus,
      toolCalls: [],
      isExpanded: false,
      result: toolCall.result,
    };
  }

  private mapToolStatusToSubagentStatus(
    status: ToolCallInfo['status']
  ): 'completed' | 'error' | 'running' {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'error':
      case 'blocked':
        return 'error';
      default:
        return 'running';
    }
  }

  private inferAsyncStatusFromTaskTool(toolCall: ToolCallInfo): 'running' | 'completed' | 'error' {
    if (toolCall.status === 'error' || toolCall.status === 'blocked') return 'error';
    if (toolCall.status === 'running') return 'running';

    const lowerResult = (toolCall.result || '').toLowerCase();
    if (
      lowerResult.includes('not_ready') ||
      lowerResult.includes('not ready') ||
      lowerResult.includes('"status":"running"') ||
      lowerResult.includes('"status":"pending"') ||
      lowerResult.includes('"retrieval_status":"running"') ||
      lowerResult.includes('"retrieval_status":"not_ready"')
    ) {
      return 'running';
    }

    return 'completed';
  }

  // ============================================
  // Image Rendering
  // ============================================

  /**
   * Renders image attachments above a message.
   */
  renderMessageImages(containerEl: HTMLElement, images: ImageAttachment[]): void {
    const imagesEl = containerEl.createDiv({ cls: 'geminese-message-images' });

    for (const image of images) {
      const imageWrapper = imagesEl.createDiv({ cls: 'geminese-message-image' });
      const imgEl = imageWrapper.createEl('img', {
        attr: {
          alt: image.name,
        },
      });

      void this.setImageSrc(imgEl, image);

      // Click to view full size
      imgEl.addEventListener('click', () => {
        void this.showFullImage(image);
      });
    }
  }

  /**
   * Shows full-size image in modal overlay.
   */
  showFullImage(image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;

    const overlay = document.body.createDiv({ cls: 'geminese-image-modal-overlay' });
    const modal = overlay.createDiv({ cls: 'geminese-image-modal' });

    modal.createEl('img', {
      attr: {
        src: dataUri,
        alt: image.name,
      },
    });

    const closeBtn = modal.createDiv({ cls: 'geminese-image-modal-close' });
    closeBtn.setText('\u00D7');

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    const close = () => {
      document.removeEventListener('keydown', handleEsc);
      overlay.remove();
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', handleEsc);
  }

  /**
   * Sets image src from attachment data.
   */
  setImageSrc(imgEl: HTMLImageElement, image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;
    imgEl.setAttribute('src', dataUri);
  }

  // ============================================
  // Content Rendering
  // ============================================

  /**
   * Renders markdown content with code block enhancements.
   */
  async renderContent(el: HTMLElement, markdown: string): Promise<void> {
    el.empty();

    try {
      // Replace image embeds with HTML img tags before rendering
      const processedMarkdown = replaceImageEmbedsWithHtml(
        markdown,
        this.app,
        this.plugin.settings.mediaFolder
      );
      await MarkdownRenderer.renderMarkdown(processedMarkdown, el, '', this.component);

      // Wrap pre elements and move buttons outside scroll area
      el.querySelectorAll('pre').forEach((pre) => {
        // Skip if already wrapped
        if (pre.parentElement?.classList.contains('geminese-code-wrapper')) return;

        // Create wrapper
        const wrapper = createEl('div', { cls: 'geminese-code-wrapper' });
        pre.parentElement?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        // Check for language class and add label
        const code = pre.querySelector('code[class*="language-"]');
        if (code) {
          const match = code.className.match(/language-(\w+)/);
          if (match) {
            wrapper.classList.add('has-language');
            const label = createEl('span', {
              cls: 'geminese-code-lang-label',
              text: match[1],
            });
            wrapper.appendChild(label);
            label.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(code.textContent || '');
                label.setText('copied!');
                setTimeout(() => label.setText(match[1]), 1500);
              } catch {
                // Clipboard API may fail in non-secure contexts
              }
            });
          }
        }

        // Move Obsidian's copy button outside pre into wrapper
        const copyBtn = pre.querySelector('.copy-code-button');
        if (copyBtn) {
          wrapper.appendChild(copyBtn);
        }
      });

      // Process file paths to make them clickable links
      processFileLinks(this.app, el);
    } catch {
      el.createDiv({
        cls: 'geminese-render-error',
        text: 'Failed to render message content.',
      });
    }
  }

  // ============================================
  // Copy Button
  // ============================================

  /** Clipboard icon SVG for copy button. */
  private static readonly COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  /**
   * Adds a copy button to a text block.
   * Button shows clipboard icon on hover, changes to "copied!" on click.
   * @param textEl The rendered text element
   * @param markdown The original markdown content to copy
   */
  addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    const copyBtn = textEl.createSpan({ cls: 'geminese-text-copy-btn' });
    copyBtn.innerHTML = MessageRenderer.COPY_ICON;

    let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        // Clipboard API may fail in non-secure contexts
        return;
      }

      // Clear any pending timeout from rapid clicks
      if (feedbackTimeout) {
        clearTimeout(feedbackTimeout);
      }

      // Show "copied!" feedback
      copyBtn.innerHTML = '';
      copyBtn.setText('copied!');
      copyBtn.classList.add('copied');

      feedbackTimeout = setTimeout(() => {
        copyBtn.innerHTML = MessageRenderer.COPY_ICON;
        copyBtn.classList.remove('copied');
        feedbackTimeout = null;
      }, 1500);
    });
  }

  refreshActionButtons(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    if (!msg.sdkUserUuid) return;
    const msgEl = this.liveMessageEls.get(msg.id);
    if (!msgEl) return;

    if (this.forkCallback && !msgEl.querySelector('.geminese-message-fork-btn')) {
      this.addForkButton(msgEl, msg.id);
    }
    this.cleanupLiveMessageEl(msg.id, msgEl);
  }

  private cleanupLiveMessageEl(msgId: string, msgEl: HTMLElement): void {
    const needsFork = this.forkCallback && !msgEl.querySelector('.geminese-message-fork-btn');
    if (!needsFork) {
      this.liveMessageEls.delete(msgId);
    }
  }

  private getOrCreateActionsToolbar(msgEl: HTMLElement): HTMLElement {
    const existing = msgEl.querySelector('.geminese-user-msg-actions') as HTMLElement | null;
    if (existing) return existing;
    return msgEl.createDiv({ cls: 'geminese-user-msg-actions' });
  }

  private addUserCopyButton(msgEl: HTMLElement, content: string): void {
    const toolbar = this.getOrCreateActionsToolbar(msgEl);
    const copyBtn = toolbar.createSpan({ cls: 'geminese-user-msg-copy-btn' });
    copyBtn.innerHTML = MessageRenderer.COPY_ICON;
    copyBtn.setAttribute('aria-label', 'Copy message');

    let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        return;
      }
      if (feedbackTimeout) clearTimeout(feedbackTimeout);
      copyBtn.innerHTML = '';
      copyBtn.setText('copied!');
      copyBtn.classList.add('copied');
      feedbackTimeout = setTimeout(() => {
        copyBtn.innerHTML = MessageRenderer.COPY_ICON;
        copyBtn.classList.remove('copied');
        feedbackTimeout = null;
      }, 1500);
    });
  }

  private addForkButton(msgEl: HTMLElement, messageId: string): void {
    const toolbar = this.getOrCreateActionsToolbar(msgEl);
    const btn = toolbar.createSpan({ cls: 'geminese-message-fork-btn' });
    if (toolbar.firstChild !== btn) toolbar.insertBefore(btn, toolbar.firstChild);
    btn.innerHTML = MessageRenderer.FORK_ICON;
    btn.setAttribute('aria-label', t('chat.fork.ariaLabel'));
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await this.forkCallback?.(messageId);
      } catch (err) {
        new Notice(t('chat.fork.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
      }
    });
  }

  // ============================================
  // Utilities
  // ============================================

  /** Scrolls messages container to bottom. */
  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Scrolls to bottom if already near bottom (within threshold). */
  scrollToBottomIfNeeded(threshold = 100): void {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < threshold;
    if (isNearBottom) {
      requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    }
  }

}

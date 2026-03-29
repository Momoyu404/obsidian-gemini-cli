/**
 * Geminese - Gemini CLI Service
 *
 * Handles communication with Gemini via direct CLI subprocess spawning.
 * Each query spawns a new `gemini` process with --output-format stream-json.
 * Session continuity is maintained via --resume flag.
 */

import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import type GeminesePlugin from '../../main';
import { stripCurrentNoteContext } from '../../utils/context';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../utils/env';
import { getOllamaVisibleSlashCommands, listAvailableLocalSkills, type LocalSkillDefinition } from '../../utils/localSkills';
import {
  buildOllamaAgentEnvelopeSchema,
  OLLAMA_AGENT_READ_ONLY_TOOL_NAMES,
  type OllamaAgentEnvelope,
  type OllamaAgentToolName,
  type OllamaEnvelopeParseError,
  parseOllamaAgentEnvelope,
  requestOllamaChat,
} from '../../utils/ollama';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  isSessionExpiredError,
} from '../../utils/session';
import { isSkill } from '../../utils/slashCommand';
import type { McpServerManager } from '../mcp';
import { buildOllamaAgentSystemPrompt } from '../prompts/ollamaAgent';
import { isSessionInitEvent, isStreamChunk, parseGeminiJsonLine,transformGeminiEvent } from '../sdk';
import { VaultFileAdapter } from '../storage/VaultFileAdapter';
import { TOOL_SKILL } from '../tools/toolNames';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  GeminiModel,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../types';
import {
  getContextWindowSize,
  getModelId,
  getModelSelection,
  supportsGeminiNativeFeatures,
} from '../types';
import { killGeminiCliProcess, spawnGeminiCli } from './customSpawn';
import { OllamaToolExecutor } from './OllamaToolExecutor';
import {
  type ColdStartQueryContext,
  QueryOptionsBuilder,
  type QueryOptionsContext,
} from './QueryOptionsBuilder';
import { SessionManager } from './SessionManager';

export type { ApprovalDecision };

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface QueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

export interface EnsureReadyOptions {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

const CANCEL_FORCE_KILL_DELAY_MS = 1000;
const STDERR_EXCERPT_MAX_LENGTH = 1000;

type GeminiErrorCategory =
  | 'capacity_exhausted'
  | 'process_exit'
  | 'session_invalid'
  | 'spawn_failure'
  | 'stream_parse_failure'
  | 'timeout'
  | 'unknown';

interface GeminiAttemptResult {
  retryWithAuto: boolean;
}

function buildProFallbackNotice(): string {
  return '\n\n_Pro currently has no capacity. This request was temporarily retried with Auto._\n\n';
}

function isManualProSelection(model: GeminiModel): boolean {
  return getModelId(model) === 'pro';
}

function buildStderrExcerpt(stderrData: string): string | undefined {
  const trimmed = stderrData.trim();
  if (!trimmed) return undefined;
  return trimmed.length > STDERR_EXCERPT_MAX_LENGTH
    ? `${trimmed.slice(0, STDERR_EXCERPT_MAX_LENGTH)}...`
    : trimmed;
}

function categorizeGeminiError(
  errorMessage: string | undefined,
  exitCode: number | null | undefined,
  invalidStdoutLineCount: number,
): GeminiErrorCategory | undefined {
  if (!errorMessage && exitCode == null && invalidStdoutLineCount === 0) {
    return undefined;
  }

  if (invalidStdoutLineCount > 0 && exitCode !== 0) {
    return 'stream_parse_failure';
  }

  const lower = errorMessage?.toLowerCase() ?? '';
  if (
    lower.includes('model_capacity_exhausted') ||
    lower.includes('resource_exhausted') ||
    lower.includes('ratelimitexceeded') ||
    lower.includes('no capacity available for model')
  ) {
    return 'capacity_exhausted';
  }

  if (errorMessage && isSessionExpiredError(new Error(errorMessage))) {
    return 'session_invalid';
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'timeout';
  }

  if (
    lower.includes('spawn') ||
    lower.includes('enoent') ||
    lower.includes('gemini cli not found') ||
    lower.includes('failed to create gemini cli process stdout')
  ) {
    return 'spawn_failure';
  }

  if (exitCode !== null && exitCode !== 0) {
    return 'process_exit';
  }

  return 'unknown';
}

export class GemineseService {
  private plugin: GeminesePlugin;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private readyStateListeners = new Set<(ready: boolean) => void>();
  private sessionManager = new SessionManager();
  private mcpManager: McpServerManager;
  private currentProcess: ChildProcess | null = null;
  private cancelForceKillTimeout: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private lastResolvedModel: string | null = null;
  private activeModel: GeminiModel;

  constructor(plugin: GeminesePlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
    this.activeModel = plugin.settings.model;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try {
      listener(this.isReady());
    } catch {
      // Ignore listener errors
    }
    return () => {
      this.readyStateListeners.delete(listener);
    };
  }

  private notifyReadyStateChange(): void {
    const isReady = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(isReady);
      } catch {
        // Ignore listener errors
      }
    }
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  setActiveModel(model: GeminiModel): void {
    this.activeModel = model;
    this.lastResolvedModel = null;
    if (!supportsGeminiNativeFeatures(model)) {
      this.sessionManager.setSessionId(null, model);
    }
    this.ready = false;
    this.notifyReadyStateChange();
  }

  getActiveModel(): GeminiModel {
    return this.activeModel;
  }

  private usesGeminiRuntime(model: GeminiModel = this.activeModel): boolean {
    return supportsGeminiNativeFeatures(model);
  }

  setPendingResumeAt(_uuid: string | undefined): void {
    // No-op for Gemini CLI (no rewind support)
  }

  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null {
    if (!this.usesGeminiRuntime(this.activeModel)) {
      return null;
    }
    return conv.sessionId ?? conv.forkSource?.sessionId ?? null;
  }

  ensureReady(options?: EnsureReadyOptions): Promise<boolean> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) return Promise.resolve(false);

    if (!this.usesGeminiRuntime(this.activeModel)) {
      if (options?.externalContextPaths !== undefined) {
        this.currentExternalContextPaths = options.externalContextPaths;
      }
      this.vaultPath = vaultPath;
      this.ready = true;
      this.notifyReadyStateChange();
      return Promise.resolve(true);
    }

    const cliPath = this.plugin.getResolvedGeminiCliPath();
    if (!cliPath) return Promise.resolve(false);

    if (options?.sessionId) {
      this.sessionManager.setSessionId(options.sessionId, this.activeModel);
    }

    if (options?.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = options.externalContextPaths;
    }

    this.vaultPath = vaultPath;
    this.ready = true;
    this.notifyReadyStateChange();
    return Promise.resolve(true);
  }

  isPersistentQueryActive(): boolean {
    return this.currentProcess !== null;
  }

  isReady(): boolean {
    return this.ready;
  }

  closePersistentQuery(_reason?: string): void {
    this.clearCancelForceKillTimeout();
    if (this.currentProcess) {
      try {
        killGeminiCliProcess(this.currentProcess, 'SIGTERM');
      } catch {
        // Process may already be dead
      }
      this.currentProcess = null;
    }
  }

  private getTransformOptions(modelOverride?: string) {
    return {
      intendedModel: modelOverride ?? this.activeModel,
      customContextLimits: this.plugin.settings.customContextLimits,
    };
  }

  private clearCancelForceKillTimeout(): void {
    if (this.cancelForceKillTimeout) {
      clearTimeout(this.cancelForceKillTimeout);
      this.cancelForceKillTimeout = null;
    }
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const selectedModel = queryOptions?.model || this.activeModel;

    if (!this.usesGeminiRuntime(selectedModel)) {
      yield* this.queryOllama(
        selectedModel,
        prompt,
        images,
        conversationHistory,
        queryOptions?.externalContextPaths ?? this.currentExternalContextPaths,
        queryOptions?.allowedTools,
      );
      yield { type: 'done' };
      return;
    }

    let attemptModel = selectedModel;
    let allowResume = true;
    let fallbackTriggered = false;

    try {
      while (true) {
        const attemptResult = yield* this.queryGeminiAttempt(
          prompt,
          attemptModel,
          images,
          conversationHistory,
          queryOptions,
          allowResume,
        );

        if (
          attemptResult.retryWithAuto &&
          isManualProSelection(selectedModel) &&
          !fallbackTriggered
        ) {
          fallbackTriggered = true;
          yield { type: 'text', content: buildProFallbackNotice() };
          attemptModel = 'auto';
          allowResume = false;
          continue;
        }

        break;
      }
    } finally {
      this.abortController = null;
      this.clearCancelForceKillTimeout();
      this.currentProcess = null;
    }

    yield { type: 'done' };
  }

  private async *queryGeminiAttempt(
    prompt: string,
    attemptModel: GeminiModel,
    images: ImageAttachment[] | undefined,
    conversationHistory: ChatMessage[] | undefined,
    queryOptions: QueryOptions | undefined,
    allowResume: boolean,
  ): AsyncGenerator<StreamChunk, GeminiAttemptResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return { retryWithAuto: false };
    }

    const resolvedCliPath = this.plugin.getResolvedGeminiCliPath();
    if (!resolvedCliPath) {
      yield { type: 'error', content: 'Gemini CLI not found. Please install Gemini CLI: npm install -g @google/gemini-cli' };
      return { retryWithAuto: false };
    }

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedCliPath);

    if (resolvedCliPath.endsWith('.js')) {
      const missingNodeError = getMissingNodeError(resolvedCliPath, enhancedPath);
      if (missingNodeError) {
        yield { type: 'error', content: missingNodeError };
        return { retryWithAuto: false };
      }
    }

    this.vaultPath = vaultPath;

    let promptToSend = prompt;
    const resumedSessionId = allowResume ? (this.sessionManager.getSessionId() ?? undefined) : undefined;
    const hasConversationHistory = !!(conversationHistory && conversationHistory.length > 0);

    if (hasConversationHistory && (this.sessionManager.needsHistoryRebuild() || !resumedSessionId)) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);

      if (this.sessionManager.needsHistoryRebuild()) {
        this.sessionManager.clearHistoryRebuild();
      }
    }

    if (images && images.length > 0) {
      const imagePromptParts: string[] = [];
      for (const image of images) {
        const ext = image.mediaType.split('/')[1] || 'png';
        const tmpFile = path.join(os.tmpdir(), `geminese-${randomUUID()}.${ext}`);
        const buffer = Buffer.from(image.data, 'base64');
        await fs.promises.writeFile(tmpFile, buffer);
        imagePromptParts.push(`[Image: ${tmpFile}]`);
      }
      promptToSend = imagePromptParts.join('\n') + '\n' + promptToSend;
    }

    const baseContext: QueryOptionsContext = {
      vaultPath,
      cliPath: resolvedCliPath,
      settings: this.plugin.settings,
      customEnv,
      enhancedPath,
      mcpManager: this.mcpManager,
      pluginManager: this.plugin.pluginManager,
    };

    const ctx: ColdStartQueryContext = {
      ...baseContext,
      abortController: this.abortController ?? undefined,
      sessionId: resumedSessionId,
      modelOverride: attemptModel,
      mcpMentions: queryOptions?.mcpMentions,
      enabledMcpServers: queryOptions?.enabledMcpServers,
      allowedTools: queryOptions?.allowedTools,
      hasEditorContext: prompt.includes('<editor_selection'),
      externalContextPaths: queryOptions?.externalContextPaths || this.currentExternalContextPaths,
    };

    const cliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, promptToSend);
    this.sessionManager.setPendingModel(attemptModel);

    this.abortController = new AbortController();

    try {
      return yield* this.spawnAndStream(cliArgs, attemptModel);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
      return { retryWithAuto: false };
    } finally {
      this.sessionManager.clearPendingModel();
      this.currentProcess = null;
    }
  }

  private async *queryOllama(
    selectedModel: GeminiModel,
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    externalContextPaths: string[] = [],
    requestedAllowedTools?: string[],
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    if (images && images.length > 0) {
      yield { type: 'error', content: 'Images are only available with Gemini in this version.' };
      return;
    }

    const baseUrl = this.plugin.getOllamaBaseUrl();
    const normalizedExternalContextPaths = externalContextPaths.filter(Boolean);
    this.currentExternalContextPaths = normalizedExternalContextPaths;
    const skillCatalog = await listAvailableLocalSkills(vaultPath);
    const allowedTools = this.getAllowedOllamaTools(requestedAllowedTools);
    const messages = this.buildOllamaMessages(
      prompt,
      conversationHistory,
      vaultPath,
      normalizedExternalContextPaths,
      allowedTools,
      skillCatalog,
    );
    const toolExecutor = new OllamaToolExecutor({
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      allowedTools,
      externalContextPaths: normalizedExternalContextPaths,
      permissionMode: this.plugin.settings.permissionMode,
      skillCatalog,
      vaultAdapter: new VaultFileAdapter(this.plugin.app),
      vaultPath,
    });

    this.abortController = new AbortController();
    this.currentProcess = null;
    this.vaultPath = vaultPath;
    this.lastResolvedModel = getModelSelection(selectedModel).label;
    this.ready = true;
    this.notifyReadyStateChange();

    let sawAnyText = false;
    let completedToolCalls = 0;
    let usageYielded = false;
    const maxToolRounds = 8;

    try {
      for (let round = 0; round < maxToolRounds; round += 1) {
        const response = await this.requestOllamaAgentTurn(baseUrl, selectedModel, messages, allowedTools);

        if (this.abortController.signal.aborted) {
          return;
        }

        if (response.model) {
          this.lastResolvedModel = response.model;
        }

        const responseText = response.message?.content?.trim() ?? '';
        if (!responseText) {
          throw new Error('Ollama returned an empty response.');
        }

        let envelope;
        try {
          envelope = parseOllamaAgentEnvelope(responseText);
        } catch (error) {
          const recovery = await this.recoverOllamaEnvelope(
            error,
            baseUrl,
            selectedModel,
            messages,
            completedToolCalls,
            allowedTools,
          );
          envelope = recovery.envelope;

          if (recovery.correctionMessage) {
            messages.push({
              role: 'user',
              content: recovery.correctionMessage,
            });
          }

          if (recovery.response.model) {
            this.lastResolvedModel = recovery.response.model;
          }

          messages.push({
            role: 'assistant',
            content: recovery.responseText,
          });

          if (envelope.type === 'final_answer') {
            sawAnyText = envelope.content.trim().length > 0;
            if (sawAnyText) {
              yield { type: 'text', content: envelope.content, parentToolUseId: null };
            }

            if (!usageYielded) {
              usageYielded = true;
              const contextWindow = getContextWindowSize(selectedModel, this.plugin.settings.customContextLimits);
              const inputTokens = recovery.response.prompt_eval_count ?? 0;
              const outputTokens = recovery.response.eval_count ?? 0;
              const contextTokens = inputTokens + outputTokens;
              const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

              yield {
                type: 'usage',
                usage: {
                  model: getModelId(selectedModel),
                  inputTokens,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  contextWindow,
                  contextTokens,
                  percentage,
                },
                sessionId: null,
              };
            }

            return;
          }

          const toolId = `ollama-tool-${randomUUID()}`;
          yield {
            type: 'tool_use',
            id: toolId,
            name: this.mapOllamaToolNameToUiName(envelope.tool),
            input: this.mapOllamaToolInputToUiInput(envelope.tool, envelope.input),
            parentToolUseId: null,
          };

          const toolResult = await toolExecutor.execute(envelope.tool, envelope.input);
          yield {
            type: 'tool_result',
            id: toolId,
            content: toolResult.content,
            isError: toolResult.isError,
            parentToolUseId: null,
          };

          completedToolCalls += 1;
          messages.push({
            role: 'user',
            content: this.buildOllamaToolResultMessage(envelope.tool, toolResult.content, toolResult.isError),
          });
          continue;
        }

        messages.push({
          role: 'assistant',
          content: responseText,
        });

        if (envelope.type === 'final_answer') {
          sawAnyText = envelope.content.trim().length > 0;
          if (sawAnyText) {
            yield { type: 'text', content: envelope.content, parentToolUseId: null };
          }

          if (!usageYielded) {
            usageYielded = true;
            const contextWindow = getContextWindowSize(selectedModel, this.plugin.settings.customContextLimits);
            const inputTokens = response.prompt_eval_count ?? 0;
            const outputTokens = response.eval_count ?? 0;
            const contextTokens = inputTokens + outputTokens;
            const percentage = Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)));

            yield {
              type: 'usage',
              usage: {
                model: getModelId(selectedModel),
                inputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                contextWindow,
                contextTokens,
                percentage,
              },
              sessionId: null,
            };
          }

          return;
        }

        const toolId = `ollama-tool-${randomUUID()}`;
        yield {
          type: 'tool_use',
          id: toolId,
          name: this.mapOllamaToolNameToUiName(envelope.tool),
          input: this.mapOllamaToolInputToUiInput(envelope.tool, envelope.input),
          parentToolUseId: null,
        };

        const toolResult = await toolExecutor.execute(envelope.tool, envelope.input);
        yield {
          type: 'tool_result',
          id: toolId,
          content: toolResult.content,
          isError: toolResult.isError,
          parentToolUseId: null,
        };

        completedToolCalls += 1;
        messages.push({
          role: 'user',
          content: this.buildOllamaToolResultMessage(envelope.tool, toolResult.content, toolResult.isError),
        });
      }

      if (!sawAnyText) {
        yield {
          type: 'error',
          content: `Ollama exceeded the ${maxToolRounds}-step read/search limit without producing a final answer.`,
        };
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Unknown Ollama error';
      yield { type: 'error', content: message };
    } finally {
      this.abortController = null;
      this.currentProcess = null;
      this.notifyReadyStateChange();
    }
  }

  private buildOllamaMessages(
    prompt: string,
    conversationHistory: ChatMessage[] | undefined,
    vaultPath: string,
    externalContextPaths: string[],
    allowedTools: readonly OllamaAgentToolName[],
    skillCatalog: LocalSkillDefinition[],
  ) {
    return [
      {
        role: 'system' as const,
        content: buildOllamaAgentSystemPrompt({
          allowedTools,
          availableSkills: skillCatalog.map(skill => ({
            name: skill.name,
            description: skill.description,
          })),
          customPrompt: this.plugin.settings.systemPrompt,
          externalContextPaths,
          permissionMode: this.plugin.settings.permissionMode,
          userName: this.plugin.settings.userName,
          vaultPath,
        }),
      },
      ...(conversationHistory ?? [])
        .filter(message => message.content.trim().length > 0)
        .map(message => ({
          role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
          content: message.content,
        })),
      { role: 'user' as const, content: prompt },
    ];
  }

  private buildOllamaToolResultMessage(
    toolName: string,
    content: string,
    isError: boolean,
  ): string {
    return [
      `Tool result for ${toolName}:`,
      isError ? 'STATUS: error' : 'STATUS: success',
      content,
      'If you need more information, request another tool. Otherwise return {"type":"final_answer","content":"..."} as JSON.',
    ].join('\n\n');
  }

  private async requestOllamaAgentTurn(
    baseUrl: string,
    selectedModel: GeminiModel,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    allowedTools: readonly OllamaAgentToolName[],
  ) {
    return await requestOllamaChat(
      baseUrl,
      {
        format: buildOllamaAgentEnvelopeSchema(allowedTools),
        model: getModelId(selectedModel),
        messages,
      },
      this.abortController?.signal,
    );
  }

  private async recoverOllamaEnvelope(
    error: unknown,
    baseUrl: string,
    selectedModel: GeminiModel,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    completedToolCalls: number,
    allowedTools: readonly OllamaAgentToolName[],
  ): Promise<{
    correctionMessage: string | null;
    envelope: OllamaAgentEnvelope;
    response: Awaited<ReturnType<typeof requestOllamaChat>>;
    responseText: string;
  }> {
    const parseError = this.normalizeOllamaParseError(error);
    const correctionMessage = this.buildInvalidOllamaEnvelopeMessage(parseError);
    const retryResponse = await this.requestOllamaAgentTurn(
      baseUrl,
      selectedModel,
      [...messages, { role: 'user', content: correctionMessage }],
      allowedTools,
    );

    const retryResponseText = retryResponse.message?.content?.trim() ?? '';
    if (!retryResponseText) {
      throw new Error('Ollama returned an empty response after envelope correction.');
    }

    try {
      return {
        correctionMessage,
        envelope: parseOllamaAgentEnvelope(retryResponseText),
        response: retryResponse,
        responseText: retryResponseText,
      };
    } catch (retryError) {
      const retryParseError = this.normalizeOllamaParseError(retryError);
      if (this.canFallbackToPlainTextAnswer(retryParseError, completedToolCalls)) {
        return {
          correctionMessage,
          envelope: {
            type: 'final_answer',
            content: retryResponseText,
          },
          response: retryResponse,
          responseText: retryResponseText,
        };
      }

      throw new Error(`Ollama returned an invalid agent envelope: ${retryParseError.message}`);
    }
  }

  private normalizeOllamaParseError(error: unknown): OllamaEnvelopeParseError {
    if (error && typeof error === 'object' && error instanceof Error && 'reason' in error && 'rawText' in error) {
      return error as OllamaEnvelopeParseError;
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'OllamaEnvelopeParseError',
      message,
      rawText: '',
      reason: 'invalid_shape',
    } as OllamaEnvelopeParseError;
  }

  private buildInvalidOllamaEnvelopeMessage(error: OllamaEnvelopeParseError): string {
    const snippet = error.rawText.trim().slice(0, 1200);
    const previousReply = snippet ? `\n\nPrevious reply:\n${snippet}` : '';

    return [
      'Your previous reply did not follow the required JSON envelope.',
      `Reason: ${error.message}`,
      previousReply,
      'Reply again with EXACTLY one JSON object and no extra prose or markdown.',
      'Allowed forms:',
      '{"type":"tool_call","tool":"Read","input":{"file_path":"notes/today.md"}}',
      '{"type":"final_answer","content":"your answer here"}',
    ].join('\n');
  }

  private canFallbackToPlainTextAnswer(
    error: OllamaEnvelopeParseError,
    completedToolCalls: number,
  ): boolean {
    return completedToolCalls > 0 && error.reason === 'missing_json';
  }

  private getAllowedOllamaTools(requestedAllowedTools?: string[]): OllamaAgentToolName[] {
    const baseTools = this.plugin.settings.permissionMode === 'plan'
      ? [...OLLAMA_AGENT_READ_ONLY_TOOL_NAMES]
      : ['Read', 'LS', 'Glob', 'Grep', 'Write', 'Edit', 'LoadSkill'] as OllamaAgentToolName[];

    if (!requestedAllowedTools || requestedAllowedTools.length === 0) {
      return [...baseTools];
    }

    const requested = new Set(requestedAllowedTools);
    return baseTools.filter(tool => requested.has(tool) || (tool === 'LoadSkill' && requested.has(TOOL_SKILL)));
  }

  private mapOllamaToolNameToUiName(toolName: OllamaAgentToolName): string {
    return toolName === 'LoadSkill' ? TOOL_SKILL : toolName;
  }

  private mapOllamaToolInputToUiInput(
    toolName: OllamaAgentToolName,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'LoadSkill') {
      const skillName = typeof input.skill_name === 'string'
        ? input.skill_name
        : (typeof input.skill === 'string' ? input.skill : '');
      return { skill: skillName };
    }
    return input;
  }

  private async *spawnAndStream(
    cliArgs: ReturnType<typeof QueryOptionsBuilder.buildColdStartCliArgs>,
    selectedModel: GeminiModel,
  ): AsyncGenerator<StreamChunk, GeminiAttemptResult> {
    const child = spawnGeminiCli({
      cliPath: cliArgs.cliPath,
      args: cliArgs.args,
      cwd: cliArgs.cwd,
      env: cliArgs.env,
      signal: this.abortController?.signal,
      enhancedPath: cliArgs.env.PATH as string,
    });

    this.currentProcess = child;
    this.notifyReadyStateChange();

    if (!child.stdout) {
      throw new Error('Failed to create Gemini CLI process stdout');
    }

    let stderrData = '';
    let capacityExhaustedDetected = false;
    let processErrorMessage: string | null = null;
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        const chunkText = data.toString();
        stderrData += chunkText;

        if (
          !capacityExhaustedDetected &&
          categorizeGeminiError(chunkText, undefined, 0) === 'capacity_exhausted'
        ) {
          capacityExhaustedDetected = true;

          try {
            killGeminiCliProcess(child, 'SIGTERM');
          } catch {
            // Process may already be dead.
          }

          this.clearCancelForceKillTimeout();
          this.cancelForceKillTimeout = setTimeout(() => {
            if (!this.currentProcess) {
              return;
            }

            try {
              killGeminiCliProcess(this.currentProcess, 'SIGKILL');
            } catch {
              // Process may already be dead.
            }
          }, CANCEL_FORCE_KILL_DELAY_MS);
        }
      });
    }
    child.on('error', (error) => {
      processErrorMessage = error.message;
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    const transformOptions = this.getTransformOptions(selectedModel);

    try {
      for await (const line of rl) {
        if (this.abortController?.signal.aborted) break;

        if (line.trim().length === 0) {
          continue;
        }

        const geminiEvent = parseGeminiJsonLine(line);
        if (!geminiEvent) {
          continue;
        }

        for (const event of transformGeminiEvent(geminiEvent, transformOptions)) {
          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
            this.lastResolvedModel = event.model ?? null;
          } else if (isStreamChunk(event)) {
            if (event.type === 'usage') {
              yield { ...event, sessionId: this.sessionManager.getSessionId() };
            } else {
              yield event;
            }
          }
        }
      }
    } catch (error) {
      if (!this.abortController?.signal.aborted) {
        throw error;
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.on('exit', (code: number | null) => resolve(code));
      child.on('error', () => resolve(null));
    });

    this.clearCancelForceKillTimeout();

    if (
      !this.abortController?.signal.aborted &&
      capacityExhaustedDetected &&
      isManualProSelection(selectedModel)
    ) {
      this.currentProcess = null;
      this.notifyReadyStateChange();
      return { retryWithAuto: true };
    }

    if (
      !this.abortController?.signal.aborted &&
      capacityExhaustedDetected &&
      !isManualProSelection(selectedModel)
    ) {
      const errorMsg =
        processErrorMessage ||
        buildStderrExcerpt(stderrData) ||
        'The selected Gemini route is temporarily unavailable due to model capacity.';
      yield { type: 'error', content: errorMsg };
      this.currentProcess = null;
      this.notifyReadyStateChange();
      return { retryWithAuto: false };
    }

    if (exitCode !== null && exitCode !== 0 && !this.abortController?.signal.aborted) {
      const errorMsg = processErrorMessage || stderrData.trim() || `Gemini CLI exited with code ${exitCode}`;
      yield { type: 'error', content: errorMsg };
    }

    this.currentProcess = null;
    this.notifyReadyStateChange();
    return { retryWithAuto: false };
  }

  cancel() {
    this.approvalDismisser?.();

    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }

    if (this.currentProcess) {
      try {
        killGeminiCliProcess(this.currentProcess, 'SIGTERM');
      } catch {
        // Process may already be dead
      }

      this.clearCancelForceKillTimeout();
      this.cancelForceKillTimeout = setTimeout(() => {
        if (!this.currentProcess) {
          return;
        }

        try {
          killGeminiCliProcess(this.currentProcess, 'SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, CANCEL_FORCE_KILL_DELAY_MS);
    }
  }

  resetSession() {
    this.closePersistentQuery('session reset');
    this.sessionManager.reset();
  }

  getSessionId(): string | null {
    if (!this.usesGeminiRuntime(this.activeModel)) {
      return null;
    }
    return this.sessionManager.getSessionId();
  }

  /** Resolved model name from CLI init (e.g. gemini-2.5-pro). One-shot: returns and clears. */
  getResolvedModel(): string | null {
    const m = this.lastResolvedModel;
    this.lastResolvedModel = null;
    return m;
  }

  consumeSessionInvalidation(): boolean {
    if (!this.usesGeminiRuntime(this.activeModel)) {
      return false;
    }
    return this.sessionManager.consumeInvalidation();
  }

  getSupportedCommands(): Promise<SlashCommand[]> {
    if (this.usesGeminiRuntime(this.activeModel)) {
      return Promise.resolve([]);
    }

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return Promise.resolve([]);
    }

    return getOllamaVisibleSlashCommands(
      vaultPath,
      this.plugin.settings.slashCommands,
    ).then(commands => commands.filter(command => !isSkill(command) || command.userInvocable !== false));
  }

  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    this.sessionManager.setSessionId(this.usesGeminiRuntime(this.activeModel) ? id : null, this.activeModel);
    if (externalContextPaths !== undefined) {
      this.currentExternalContextPaths = externalContextPaths;
    }
    this.ensureReady({
      sessionId: this.usesGeminiRuntime(this.activeModel) ? (id ?? undefined) : undefined,
      externalContextPaths,
    }).catch(() => {
      // Best-effort
    });
  }

  cleanup() {
    this.closePersistentQuery('plugin cleanup');
    this.cancel();
    this.resetSession();
  }

  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null) {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null) {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }
}

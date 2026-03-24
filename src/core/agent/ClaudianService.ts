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
import {
  type OllamaEnvelopeParseError,
  parseOllamaAgentEnvelope,
  requestOllamaChat,
} from '../../utils/ollama';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../utils/session';
import type { McpServerManager } from '../mcp';
import { buildOllamaAgentSystemPrompt } from '../prompts/ollamaAgent';
import { isSessionInitEvent, isStreamChunk, parseGeminiJsonLine,transformGeminiEvent } from '../sdk';
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
import { spawnGeminiCli } from './customSpawn';
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
    if (this.currentProcess) {
      try {
        this.currentProcess.kill();
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
      );
      yield { type: 'done' };
      return;
    }

    const resolvedCliPath = this.plugin.getResolvedGeminiCliPath();
    if (!resolvedCliPath) {
      yield { type: 'error', content: 'Gemini CLI not found. Please install Gemini CLI: npm install -g @google/gemini-cli' };
      return;
    }

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedCliPath);

    if (resolvedCliPath.endsWith('.js')) {
      const missingNodeError = getMissingNodeError(resolvedCliPath, enhancedPath);
      if (missingNodeError) {
        yield { type: 'error', content: missingNodeError };
        return;
      }
    }

    this.vaultPath = vaultPath;

    let promptToSend = prompt;

    // Session mismatch recovery: rebuild history context if SDK gave us a different session
    if (this.sessionManager.needsHistoryRebuild() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
      this.sessionManager.clearHistoryRebuild();
    }

    // No session yet but has conversation history — include context for continuity
    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
    }

    // Write image attachments to temp files and reference them in the prompt
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
      sessionId: this.sessionManager.getSessionId() ?? undefined,
      modelOverride: queryOptions?.model,
      mcpMentions: queryOptions?.mcpMentions,
      enabledMcpServers: queryOptions?.enabledMcpServers,
      allowedTools: queryOptions?.allowedTools,
      hasEditorContext: prompt.includes('<editor_selection'),
      externalContextPaths: queryOptions?.externalContextPaths || this.currentExternalContextPaths,
    };

    const cliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, promptToSend);
    this.sessionManager.setPendingModel(selectedModel);

    this.abortController = new AbortController();

    try {
      yield* this.spawnAndStream(cliArgs, selectedModel);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.sessionManager.clearPendingModel();
      this.abortController = null;
      this.currentProcess = null;
    }

    yield { type: 'done' };
  }

  private async *queryOllama(
    selectedModel: GeminiModel,
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    externalContextPaths: string[] = [],
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
    const messages = this.buildOllamaMessages(
      prompt,
      conversationHistory,
      vaultPath,
      normalizedExternalContextPaths,
    );
    const toolExecutor = new OllamaToolExecutor({
      vaultPath,
      externalContextPaths: normalizedExternalContextPaths,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
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
        const response = await this.requestOllamaAgentTurn(baseUrl, selectedModel, messages);

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
            name: envelope.tool,
            input: envelope.input,
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
          name: envelope.tool,
          input: envelope.input,
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
  ) {
    return [
      {
        role: 'system' as const,
        content: buildOllamaAgentSystemPrompt({
          customPrompt: this.plugin.settings.systemPrompt,
          externalContextPaths,
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
  ) {
    return await requestOllamaChat(
      baseUrl,
      {
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
  ): Promise<{
    correctionMessage: string | null;
    envelope: { type: 'final_answer'; content: string } | { type: 'tool_call'; tool: 'Read' | 'LS' | 'Glob' | 'Grep'; input: Record<string, unknown> };
    response: Awaited<ReturnType<typeof requestOllamaChat>>;
    responseText: string;
  }> {
    const parseError = this.normalizeOllamaParseError(error);
    const correctionMessage = this.buildInvalidOllamaEnvelopeMessage(parseError);
    const retryResponse = await this.requestOllamaAgentTurn(
      baseUrl,
      selectedModel,
      [...messages, { role: 'user', content: correctionMessage }],
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

  private async *spawnAndStream(
    cliArgs: ReturnType<typeof QueryOptionsBuilder.buildColdStartCliArgs>,
    selectedModel: string
  ): AsyncGenerator<StreamChunk> {
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
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        stderrData += data.toString();
      });
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    const transformOptions = this.getTransformOptions(selectedModel);

    try {
      for await (const line of rl) {
        if (this.abortController?.signal.aborted) break;

        const geminiEvent = parseGeminiJsonLine(line);
        if (!geminiEvent) continue;

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
      if (this.abortController?.signal.aborted) {
        return;
      }
      throw error;
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.on('exit', (code: number | null) => resolve(code));
      child.on('error', () => resolve(null));
    });

    if (exitCode !== null && exitCode !== 0 && !this.abortController?.signal.aborted) {
      const errorMsg = stderrData.trim() || `Gemini CLI exited with code ${exitCode}`;
      yield { type: 'error', content: errorMsg };
    }

    this.currentProcess = null;
    this.notifyReadyStateChange();
  }

  cancel() {
    this.approvalDismisser?.();

    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }

    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
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
    return Promise.resolve([]);
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

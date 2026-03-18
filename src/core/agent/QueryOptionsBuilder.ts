/**
 * GeminiOptionsBuilder - CLI Arguments Construction
 *
 * Builds command-line arguments for the Gemini CLI instead of SDK Options objects.
 * Handles model selection, permission modes, session resume, and MCP configuration.
 */

import * as fs from 'fs';
import * as path from 'path';

import { filterValidFiles } from '../../utils/externalContext';
import type { McpServerManager } from '../mcp';
import type { PluginManager } from '../plugins';
import { buildSystemPrompt, type SystemPromptSettings } from '../prompts/mainAgent';
import { READ_ONLY_TOOLS } from '../tools/toolNames';
import type { GemineseSettings, PermissionMode } from '../types';
import { THINKING_BUDGETS } from '../types';
import {
  computeSystemPromptKey,
  type PersistentQueryConfig,
} from './types';

export interface QueryOptionsContext {
  vaultPath: string;
  cliPath: string;
  settings: GemineseSettings;
  customEnv: Record<string, string>;
  enhancedPath: string;
  mcpManager: McpServerManager;
  pluginManager: PluginManager;
}

export interface PersistentQueryContext extends QueryOptionsContext {
  abortController?: AbortController;
  resume?: {
    sessionId: string;
    sessionAt?: string;
    fork?: boolean;
  };
  hooks?: unknown;
  externalContextPaths?: string[];
}

export interface ColdStartQueryContext extends QueryOptionsContext {
  abortController?: AbortController;
  sessionId?: string;
  modelOverride?: string;
  hooks?: unknown;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  allowedTools?: string[];
  hasEditorContext: boolean;
  externalContextPaths?: string[];
}

export interface GeminiCliArgs {
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  cliPath: string;
  systemPrompt: string;
}

export class QueryOptionsBuilder {
  static needsRestart(
    currentConfig: PersistentQueryConfig | null,
    newConfig: PersistentQueryConfig
  ): boolean {
    if (!currentConfig) return true;

    if (currentConfig.systemPromptKey !== newConfig.systemPromptKey) return true;
    if (currentConfig.disallowedToolsKey !== newConfig.disallowedToolsKey) return true;
    if (currentConfig.pluginsKey !== newConfig.pluginsKey) return true;
    if (currentConfig.settingSources !== newConfig.settingSources) return true;
    if (currentConfig.geminiCliPath !== newConfig.geminiCliPath) return true;

    if (QueryOptionsBuilder.pathsChanged(currentConfig.allowedExportPaths, newConfig.allowedExportPaths)) {
      return true;
    }

    if (QueryOptionsBuilder.pathsChanged(currentConfig.externalContextPaths, newConfig.externalContextPaths)) {
      return true;
    }

    return false;
  }

  static buildPersistentQueryConfig(
    ctx: QueryOptionsContext,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      allowedExportPaths: ctx.settings.allowedExportPaths,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    };

    const budgetSetting = ctx.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    const thinkingTokens = budgetConfig?.tokens ?? null;

    const allDisallowedTools = ctx.mcpManager.getAllDisallowedMcpTools();
    const disallowedToolsKey = allDisallowedTools.join('|');

    const pluginsKey = ctx.pluginManager.getPluginsKey();

    return {
      model: ctx.settings.model,
      thinkingTokens: thinkingTokens && thinkingTokens > 0 ? thinkingTokens : null,
      permissionMode: ctx.settings.permissionMode,
      systemPromptKey: computeSystemPromptKey(systemPromptSettings),
      disallowedToolsKey,
      mcpServersKey: '',
      pluginsKey,
      externalContextPaths: externalContextPaths || [],
      allowedExportPaths: ctx.settings.allowedExportPaths,
      settingSources: ctx.settings.loadUserGeminiSettings ? 'user,project' : 'project',
      geminiCliPath: ctx.cliPath,
    };
  }

  /** Builds Gemini CLI arguments for a persistent/warm query. */
  static buildPersistentCliArgs(ctx: PersistentQueryContext): GeminiCliArgs {
    let systemPrompt = buildSystemPrompt({
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      allowedExportPaths: ctx.settings.allowedExportPaths,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
      permissionMode: ctx.settings.permissionMode,
    });

    const args: string[] = [
      '--output-format', 'stream-json',
      '--model', ctx.settings.model,
    ];

    QueryOptionsBuilder.applyApprovalMode(args, ctx.settings.permissionMode);

    if (ctx.resume) {
      args.push('--resume', ctx.resume.sessionId);
    }

    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      const validFiles = filterValidFiles(ctx.externalContextPaths);
      if (validFiles.length > 0) {
        const includeDirs = Array.from(new Set(validFiles.map(p => path.dirname(p))));
        args.push('--include-directories', includeDirs.join(','));
        systemPrompt += `\n\nExternal Attached Files:\nThe user has attached these files. Please use your tools to read or look at them if needed:\n${validFiles.join('\n')}`;
      }
    }

    const promptPath = QueryOptionsBuilder.writeSystemPromptFile(ctx.vaultPath, systemPrompt);

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...ctx.customEnv,
      PATH: ctx.enhancedPath,
      GEMINI_SYSTEM_MD: promptPath,
    };

    return {
      args,
      env,
      cwd: ctx.vaultPath,
      cliPath: ctx.cliPath,
      systemPrompt,
    };
  }

  /** Builds Gemini CLI arguments for a cold-start query. */
  static buildColdStartCliArgs(ctx: ColdStartQueryContext, prompt: string): GeminiCliArgs {
    const selectedModel = ctx.modelOverride ?? ctx.settings.model;

    let systemPrompt = buildSystemPrompt({
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      allowedExportPaths: ctx.settings.allowedExportPaths,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
      permissionMode: ctx.settings.permissionMode,
    });

    const args: string[] = [
      '--output-format', 'stream-json',
      '--model', selectedModel,
      '--prompt', prompt,
    ];

    QueryOptionsBuilder.applyApprovalMode(args, ctx.settings.permissionMode);

    if (ctx.sessionId) {
      args.push('--resume', ctx.sessionId);
    }

    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      const validFiles = filterValidFiles(ctx.externalContextPaths);
      if (validFiles.length > 0) {
        const includeDirs = Array.from(new Set(validFiles.map(p => path.dirname(p))));
        args.push('--include-directories', includeDirs.join(','));
        systemPrompt += `\n\nExternal Attached Files:\nThe user has attached these files. Please use your tools to read or look at them if needed:\n${validFiles.join('\n')}`;
      }
    }

    if (ctx.allowedTools && ctx.allowedTools.length > 0) {
      args.push('--allowed-tools', ctx.allowedTools.join(','));
    }

    const promptPath = QueryOptionsBuilder.writeSystemPromptFile(ctx.vaultPath, systemPrompt);

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...ctx.customEnv,
      PATH: ctx.enhancedPath,
      GEMINI_SYSTEM_MD: promptPath,
    };

    return {
      args,
      env,
      cwd: ctx.vaultPath,
      cliPath: ctx.cliPath,
      systemPrompt,
    };
  }

  /**
   * Writes the system prompt to a temp file inside the vault's .gemini/ directory.
   * Gemini CLI reads its system prompt from a file pointed to by GEMINI_SYSTEM_MD.
   */
  static writeSystemPromptFile(vaultPath: string, systemPrompt: string): string {
    const geminiDir = path.join(vaultPath, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const promptPath = path.join(geminiDir, '.system-prompt.md');
    fs.writeFileSync(promptPath, systemPrompt, 'utf-8');
    return promptPath;
  }

  private static applyApprovalMode(args: string[], permissionMode: PermissionMode): void {
    if (permissionMode === 'plan') {
      args.push('--approval-mode', 'plan');
      const allowedTools = [...READ_ONLY_TOOLS].join(',');
      args.push('--allowed-tools', allowedTools);
    } else {
      // 'agent' maps to auto_edit
      args.push('--approval-mode', 'auto_edit');
    }
  }

  private static pathsChanged(a?: string[], b?: string[]): boolean {
    const aKey = [...(a || [])].sort().join('|');
    const bKey = [...(b || [])].sort().join('|');
    return aKey !== bKey;
  }
}

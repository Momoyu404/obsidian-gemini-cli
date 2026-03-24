// Chat types
export {
  type ChatMessage,
  type ContentBlock,
  type Conversation,
  type ConversationMeta,
  type ForkSource,
  type ImageAttachment,
  type ImageMediaType,
  type SessionMetadata,
  type StreamChunk,
  type UsageInfo,
  VIEW_TYPE_GEMINIAN,
} from './chat';

// Model types
export {
  CONTEXT_WINDOW_STANDARD,
  DEFAULT_GEMINI_MODELS as DEFAULT_CLAUDE_MODELS,
  DEFAULT_GEMINI_MODELS,
  DEFAULT_THINKING_BUDGET,
  encodeFamilyModel,
  type GeminiModel,
  getContextWindowSize,
  getModelFamily,
  getModelFamilyLabel,
  getModelId,
  getModelSelection,
  isGeminiDefaultModel,
  isOllamaModel,
  MODEL_FAMILY_OPTIONS,
  type ModelFamily,
  type ModelFamilyOption,
  type ModelOption,
  type ModelSelection,
  supportsGeminiNativeFeatures,
  supportsPermissionModes,
  THINKING_BUDGETS,
  type ThinkingBudget,
} from './models';

// SDK types
export { type BlockedUserMessage, isBlockedMessage } from './sdk';

// Settings types
export {
  type ApprovalDecision,
  type CCPermissions,
  createPermissionRule,
  DEFAULT_GEMINI_CLI_SETTINGS,
  DEFAULT_GEMINI_PERMISSIONS,
  DEFAULT_SETTINGS,
  type EnvSnippet,
  type GemineseSettings,
  type GeminiCLISettings,
  type GeminiPermissions,
  getBashToolBlockedCommands,
  getCurrentPlatformBlockedCommands,
  getCurrentPlatformKey,
  getDefaultBlockedCommands,
  type HostnameCliPaths,
  type InstructionRefineResult,
  type KeyboardNavigationSettings,
  legacyPermissionsToCCPermissions,
  legacyPermissionToCCRule,
  parseCCPermissionRule,
  type PermissionMode,
  type PermissionRule,
  type PlatformBlockedCommands,
  type SlashCommand,
  type TabBarPosition,
} from './settings';

// Re-export getHostnameKey from utils (moved from settings for architecture compliance)
export { getHostnameKey } from '../../utils/env';

// Diff types
export {
  type DiffLine,
  type DiffStats,
  type SDKToolUseResult,
  type StructuredPatchHunk,
} from './diff';

// Tool types
export {
  type AskUserAnswers,
  type AskUserQuestionItem,
  type AskUserQuestionOption,
  type AsyncSubagentStatus,
  type ExitPlanModeCallback,
  type ExitPlanModeDecision,
  type SubagentInfo,
  type SubagentMode,
  type ToolCallInfo,
  type ToolDiffData,
} from './tools';

// MCP types
export {
  DEFAULT_MCP_SERVER,
  type GemineseMcpConfigFile,
  type GemineseMcpServer,
  getMcpServerType,
  isValidMcpServerConfig,
  type McpConfigFile,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpServerType,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type ParsedMcpConfig,
} from './mcp';

// Extension types (formerly Plugin)
export {
  type ExtensionScope,
  type GemineseExtension,
  type InstalledExtensionEntry,
  type InstalledExtensionsFile,
} from './plugins';

// Agent types
export {
  AGENT_PERMISSION_MODES,
  type AgentDefinition,
  type AgentFrontmatter,
  type AgentPermissionMode,
} from './agent';

/**
 * Model type definitions and constants.
 */

/** Model identifier (string to support custom models via environment variables). */
export type GeminiModel = string;

export type ModelFamily = 'gemini' | 'ollama' | 'codex';

export interface ModelFamilyOption {
  value: ModelFamily;
  label: string;
  description: string;
}

export interface ModelOption {
  value: GeminiModel;
  label: string;
  description: string;
}

export interface ModelSelection {
  family: ModelFamily;
  value: GeminiModel;
  modelId: string;
  label: string;
}

const OLLAMA_MODEL_PREFIX = 'ollama:';
const CODEX_MODEL_PREFIX = 'codex:';

export const DEFAULT_GEMINI_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto', description: 'Auto-selects best model' },
  { value: 'pro', label: 'Pro', description: 'Complex reasoning (Pro tier)' },
  { value: 'flash', label: 'Flash', description: 'Fast and balanced (Flash tier)' },
  { value: 'flash-lite', label: 'Flash Lite', description: 'Fastest for simple tasks' },
];

export const MODEL_FAMILY_OPTIONS: ModelFamilyOption[] = [
  { value: 'gemini', label: 'Gemini', description: 'Use Gemini CLI models' },
  { value: 'ollama', label: 'Ollama', description: 'Use a locally running Ollama model' },
];

export function isGeminiDefaultModel(model: string): boolean {
  return DEFAULT_GEMINI_MODELS.some(option => option.value === model);
}

export function isOllamaModel(model: string): boolean {
  return model.startsWith(OLLAMA_MODEL_PREFIX);
}

export function isCodexModel(model: string): boolean {
  return model.startsWith(CODEX_MODEL_PREFIX);
}

export function getModelFamily(model: string): ModelFamily {
  if (isOllamaModel(model)) return 'ollama';
  if (isCodexModel(model)) return 'codex';
  return 'gemini';
}

export function getModelFamilyLabel(family: ModelFamily): string {
  return MODEL_FAMILY_OPTIONS.find(option => option.value === family)?.label
    ?? family.charAt(0).toUpperCase() + family.slice(1);
}

export function encodeFamilyModel(family: ModelFamily, modelId: string): GeminiModel {
  if (family === 'ollama') {
    return `${OLLAMA_MODEL_PREFIX}${modelId}`;
  }
  if (family === 'codex') {
    return `${CODEX_MODEL_PREFIX}${modelId}`;
  }
  return modelId;
}

export function getModelId(model: GeminiModel): string {
  if (isOllamaModel(model)) {
    return model.slice(OLLAMA_MODEL_PREFIX.length);
  }
  if (isCodexModel(model)) {
    return model.slice(CODEX_MODEL_PREFIX.length);
  }
  return model;
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function getGeminiModelOption(model: GeminiModel): ModelOption | null {
  return DEFAULT_GEMINI_MODELS.find(option => option.value === model) ?? null;
}

export function getModelSelection(model: GeminiModel): ModelSelection {
  const family = getModelFamily(model);
  const modelId = getModelId(model);

  if (family === 'gemini') {
    const geminiOption = getGeminiModelOption(model);
    return {
      family,
      value: model,
      modelId,
      label: geminiOption ? `Gemini ${geminiOption.label}` : `Gemini ${titleCase(modelId)}`,
    };
  }

  if (family === 'ollama') {
    return {
      family,
      value: model,
      modelId,
      label: modelId,
    };
  }

  return {
    family,
    value: model,
    modelId,
    label: `${getModelFamilyLabel(family)} ${titleCase(modelId)}`,
  };
}

export function supportsGeminiNativeFeatures(model: GeminiModel): boolean {
  return getModelFamily(model) === 'gemini';
}

export function supportsPermissionModes(model: GeminiModel): boolean {
  const family = getModelFamily(model);
  return family === 'gemini' || family === 'ollama';
}

export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

/** Default thinking budget per model tier. */
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'flash-lite': 'off',
  'flash': 'low',
  'pro': 'medium',
  'auto': 'medium',
};

export const CONTEXT_WINDOW_STANDARD = 1_000_000;
export const CONTEXT_WINDOW_FLASH = 1_000_000;

export function getContextWindowSize(
  _model: string,
  customLimits?: Record<string, number>
): number {
  if (customLimits && _model in customLimits) {
    const limit = customLimits[_model];
    if (typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit)) {
      return limit;
    }
  }

  return CONTEXT_WINDOW_STANDARD;
}

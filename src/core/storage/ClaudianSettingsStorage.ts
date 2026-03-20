/**
 * GemineseSettingsStorage - Handles geminese-settings.json read/write.
 *
 * Manages the .gemini/geminese-settings.json file for Geminese-specific settings.
 * These settings are NOT shared with Gemini CLI.
 *
 * Includes:
 * - User preferences (userName)
 * - Security (blocklist, permission mode)
 * - Model & thinking settings
 * - Content settings (tags, media, prompts)
 * - Environment (string format, snippets)
 * - UI settings (keyboard navigation)
 * - CLI paths
 * - State (merged from data.json)
 */

import type { GemineseSettings, GeminiModel, PlatformBlockedCommands } from '../types';
import { DEFAULT_SETTINGS, getDefaultBlockedCommands } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to Geminese settings file relative to vault root. */
export const GEMINIAN_SETTINGS_PATH = '.gemini/geminese-settings.json';

/** Fields that are loaded separately (slash commands from .gemini/commands/). */
type SeparatelyLoadedFields = 'slashCommands';

/** Settings stored in .gemini/geminese-settings.json. */
export type StoredGemineseSettings = Omit<GemineseSettings, SeparatelyLoadedFields>;

function normalizeCommandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeBlockedCommands(value: unknown): PlatformBlockedCommands {
  const defaults = getDefaultBlockedCommands();

  // Migrate old string[] format to new platform-keyed structure
  if (Array.isArray(value)) {
    return {
      unix: normalizeCommandList(value, defaults.unix),
      windows: [...defaults.windows],
    };
  }

  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    unix: normalizeCommandList(candidate.unix, defaults.unix),
    windows: normalizeCommandList(candidate.windows, defaults.windows),
  };
}

function normalizeHostnameCliPaths(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && val.trim()) {
      result[key] = val.trim();
    }
  }
  return result;
}

export class GemineseSettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
  * Load Geminese settings from .gemini/geminese-settings.json.
  * Returns default settings if file doesn't exist.
  * Throws if file exists but cannot be read or parsed.
  */
  async load(): Promise<StoredGemineseSettings> {
    if (!(await this.adapter.exists(GEMINIAN_SETTINGS_PATH))) {
      return this.getDefaults();
    }

     const content = await this.adapter.read(GEMINIAN_SETTINGS_PATH);
     const stored = JSON.parse(content) as Record<string, unknown>;
     // eslint-disable-next-line @typescript-eslint/no-unused-vars -- legacy field excluded from stored settings
     const { activeConversationId, ...storedWithoutLegacy } = stored;

    const blockedCommands = normalizeBlockedCommands(stored.blockedCommands);
    const hostnameCliPaths = normalizeHostnameCliPaths(stored.geminiCliPathsByHost);
    const legacyCliPath = typeof stored.geminiCliPath === 'string' ? stored.geminiCliPath : '';

    return {
      ...this.getDefaults(),
      ...storedWithoutLegacy,
      blockedCommands,
      geminiCliPath: legacyCliPath,
      geminiCliPathsByHost: hostnameCliPaths,
    } as StoredGemineseSettings;
  }

  async save(settings: StoredGemineseSettings): Promise<void> {
    const content = JSON.stringify(settings, null, 2);
    await this.adapter.write(GEMINIAN_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(GEMINIAN_SETTINGS_PATH);
  }

  async update(updates: Partial<StoredGemineseSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  /**
   * Read legacy activeConversationId from geminese-settings.json, if present.
   * Used only for one-time migration to tabManagerState.
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    if (!(await this.adapter.exists(GEMINIAN_SETTINGS_PATH))) {
      return null;
    }

    const content = await this.adapter.read(GEMINIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const value = stored.activeConversationId;

    if (typeof value === 'string') {
      return value;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from geminese-settings.json.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    if (!(await this.adapter.exists(GEMINIAN_SETTINGS_PATH))) {
      return;
    }

    const content = await this.adapter.read(GEMINIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;

    if (!('activeConversationId' in stored)) {
      return;
    }

    delete stored.activeConversationId;
    const nextContent = JSON.stringify(stored, null, 2);
    await this.adapter.write(GEMINIAN_SETTINGS_PATH, nextContent);
  }

  async setLastModel(model: GeminiModel, isCustom: boolean): Promise<void> {
    if (isCustom) {
      await this.update({ lastCustomModel: model });
    } else {
      await this.update({ lastGeminiModel: model });
    }
  }

  async setLastEnvHash(hash: string): Promise<void> {
    await this.update({ lastEnvHash: hash });
  }

  /**
   * Get default settings (excluding separately loaded fields).
   */
   private getDefaults(): StoredGemineseSettings {
     // eslint-disable-next-line @typescript-eslint/no-unused-vars -- slashCommands stored separately
     const {
       slashCommands,
       ...defaults
     } = DEFAULT_SETTINGS;

    return defaults;
  }
}

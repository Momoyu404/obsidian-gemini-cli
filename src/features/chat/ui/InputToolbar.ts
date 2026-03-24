import { Notice, setIcon } from 'obsidian';
import * as path from 'path';

import type { McpServerManager } from '../../../core/mcp';
import type {
  GemineseMcpServer,
  GeminiModel,
  ModelFamily,
  PermissionMode,
  ThinkingBudget,
  UsageInfo
} from '../../../core/types';
import {
  DEFAULT_GEMINI_MODELS,
  encodeFamilyModel,
  getModelFamily,
  getModelSelection,
  MODEL_FAMILY_OPTIONS,
  THINKING_BUDGETS
} from '../../../core/types';
import { CHECK_ICON_SVG, MCP_ICON_SVG } from '../../../shared/icons';
import { filterValidFiles, findConflictingPath, isDuplicatePath, isValidFilePath, validateFilePath } from '../../../utils/externalContext';
import { expandHomePath, normalizePathForFilesystem } from '../../../utils/path';

export interface ToolbarSettings {
  model: GeminiModel;
  thinkingBudget: ThinkingBudget;
  permissionMode: PermissionMode;
}

export interface ToolbarCallbacks {
  onModelChange: (model: GeminiModel) => Promise<void>;
  onThinkingBudgetChange: (budget: ThinkingBudget) => Promise<void>;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void>;
  getSettings: () => ToolbarSettings;
  loadOllamaModels?: () => Promise<string[]>;
  /** Resolved model name from CLI (e.g. gemini-2.5-pro), shown in selector when set. */
  getResolvedModel?: () => string | null;
}

export class ModelSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  private isReady = false;
  private isOpen = false;
  private activeFamily: ModelFamily | null = null;
  private ollamaModels: string[] = [];
  private ollamaState: 'idle' | 'loading' | 'loaded' | 'empty' | 'error' = 'idle';
  private ollamaError: string | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'geminese-model-selector' });
    this.render();
    this.container.addEventListener('mouseleave', () => this.closeDropdown());
  }

  private getFamilyOptions() {
    return MODEL_FAMILY_OPTIONS.filter(option => option.value === 'gemini' || option.value === 'ollama');
  }

  private getCurrentModel() {
    return this.callbacks.getSettings().model;
  }

  private async loadOllamaModels(force = false): Promise<void> {
    if (!this.callbacks.loadOllamaModels) {
      this.ollamaState = 'error';
      this.ollamaError = 'Ollama is not configured.';
      this.renderOptions();
      return;
    }

    if (!force && (this.ollamaState === 'loading' || this.ollamaState === 'loaded' || this.ollamaState === 'empty')) {
      return;
    }

    this.ollamaState = 'loading';
    this.ollamaError = null;
    this.renderOptions();

    try {
      const models = await this.callbacks.loadOllamaModels();
      this.ollamaModels = models;
      this.ollamaState = models.length > 0 ? 'loaded' : 'empty';
    } catch (error) {
      this.ollamaState = 'error';
      this.ollamaError = error instanceof Error ? error.message : 'Failed to load Ollama models.';
    }

    this.renderOptions();
  }

  private openDropdown() {
    this.isOpen = true;
    this.activeFamily = null;
    this.container.addClass('open');
    this.renderOptions();
  }

  private closeDropdown() {
    this.isOpen = false;
    this.activeFamily = null;
    this.container.removeClass('open');
  }

  private async openFamily(family: ModelFamily): Promise<void> {
    this.activeFamily = family;
    this.renderOptions();

    if (family === 'ollama') {
      await this.loadOllamaModels();
    }
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'geminese-model-btn' });
    this.buttonEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen) {
        this.closeDropdown();
      } else {
        this.openDropdown();
      }
    });
    this.setReady(this.isReady);
    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'geminese-model-dropdown' });
    this.renderOptions();
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    const currentModel = this.getCurrentModel();
    const selection = getModelSelection(currentModel);
    const resolved = this.callbacks.getResolvedModel?.() ?? null;

    this.buttonEl.empty();

    const labelEl = this.buttonEl.createSpan({ cls: 'geminese-model-label' });
    labelEl.setText(selection.label);
    if (resolved && getModelFamily(currentModel) === 'gemini') {
      labelEl.setAttribute('title', resolved);
      const sub = this.buttonEl.createSpan({ cls: 'geminese-model-resolved' });
      sub.setText(` (${resolved})`);
    }
  }

  setReady(ready: boolean) {
    this.isReady = ready;
    this.buttonEl?.toggleClass('ready', ready);
  }

  renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    if (!this.isOpen) {
      return;
    }

    if (!this.activeFamily) {
      for (const family of this.getFamilyOptions()) {
        const option = this.dropdownEl.createDiv({ cls: 'geminese-model-option geminese-model-family-option' });
        if (getModelFamily(this.getCurrentModel()) === family.value) {
          option.addClass('selected');
        }

        option.createSpan({ text: family.label });
        const chevron = option.createSpan({ cls: 'geminese-model-option-arrow' });
        chevron.setText('›');
        option.setAttribute('title', family.description);
        option.addEventListener('click', (e) => { void (async () => {
          e.stopPropagation();
          await this.openFamily(family.value);
        })(); });
      }
      return;
    }

    const back = this.dropdownEl.createDiv({ cls: 'geminese-model-option geminese-model-back-option' });
    back.createSpan({ text: '‹ Back' });
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      this.activeFamily = null;
      this.renderOptions();
    });

    if (this.activeFamily === 'gemini') {
      for (const model of DEFAULT_GEMINI_MODELS) {
        const encodedValue = encodeFamilyModel('gemini', model.value);
        const option = this.dropdownEl.createDiv({ cls: 'geminese-model-option' });
        if (this.getCurrentModel() === encodedValue) {
          option.addClass('selected');
        }
        option.createSpan({ text: model.label });
        option.setAttribute('title', model.description);
        option.addEventListener('click', (e) => { void (async () => {
          e.stopPropagation();
          await this.callbacks.onModelChange(encodedValue);
          this.closeDropdown();
          this.updateDisplay();
        })(); });
      }
      return;
    }

    if (this.activeFamily === 'ollama') {
      if (this.ollamaState === 'loading') {
        const loading = this.dropdownEl.createDiv({ cls: 'geminese-model-option geminese-model-status' });
        loading.setText('Loading models...');
        return;
      }

      if (this.ollamaState === 'error') {
        const error = this.dropdownEl.createDiv({ cls: 'geminese-model-option geminese-model-status error' });
        error.setText(this.ollamaError || 'Failed to load Ollama models.');

        const retry = this.dropdownEl.createDiv({ cls: 'geminese-model-option geminese-model-retry' });
        retry.setText('Retry');
        retry.addEventListener('click', (e) => { void (async () => {
          e.stopPropagation();
          await this.loadOllamaModels(true);
        })(); });
        return;
      }

      if (this.ollamaState === 'empty') {
        const empty = this.dropdownEl.createDiv({ cls: 'geminese-model-option geminese-model-status' });
        empty.setText('No Ollama models found.');
        return;
      }

      for (const modelName of this.ollamaModels) {
        const encodedValue = encodeFamilyModel('ollama', modelName);
        const option = this.dropdownEl.createDiv({ cls: 'geminese-model-option' });
        if (this.getCurrentModel() === encodedValue) {
          option.addClass('selected');
        }
        option.createSpan({ text: modelName });
        option.addEventListener('click', (e) => { void (async () => {
          e.stopPropagation();
          await this.callbacks.onModelChange(encodedValue);
          this.closeDropdown();
          this.updateDisplay();
        })(); });
      }
    }
  }
}

export class ThinkingBudgetSelector {
  private container: HTMLElement;
  private gearsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  private disabled = false;
  private disabledReason = '';

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'geminese-thinking-selector' });
    this.render();
  }

  private render() {
    this.container.empty();

    this.gearsEl = this.container.createDiv({ cls: 'geminese-thinking-gears' });
    this.renderGears();
  }

  setDisabled(disabled: boolean, reason = ''): void {
    this.disabled = disabled;
    this.disabledReason = reason;
    this.container.toggleClass('is-disabled', disabled);
    this.container.setAttribute('title', disabled ? reason : 'Thinking budget');
  }

  private renderGears() {
    if (!this.gearsEl) return;
    this.gearsEl.empty();

    const currentBudget = this.callbacks.getSettings().thinkingBudget;
    const currentBudgetInfo = THINKING_BUDGETS.find(b => b.value === currentBudget);

    const currentEl = this.gearsEl.createDiv({ cls: 'geminese-thinking-current' });
    currentEl.setText(currentBudgetInfo?.label || 'Off');

    const optionsEl = this.gearsEl.createDiv({ cls: 'geminese-thinking-options' });

    for (const budget of [...THINKING_BUDGETS].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'geminese-thinking-gear' });
      gearEl.setText(budget.label);
      gearEl.setAttribute('title', budget.tokens > 0 ? `${budget.tokens.toLocaleString()} tokens` : 'Disabled');

      if (budget.value === currentBudget) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', (e) => { void (async () => {
        if (this.disabled) return;
        e.stopPropagation();
        await this.callbacks.onThinkingBudgetChange(budget.value);
        this.updateDisplay();
      })(); });
    }
  }

  updateDisplay() {
    this.renderGears();
  }
}

export class PermissionToggle {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  private disabled = false;
  private disabledReason = '';

  private static readonly MODES: { value: PermissionMode; label: string }[] = [
    { value: 'plan', label: 'Plan' },
    { value: 'agent', label: 'Agent' },
  ];

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'geminese-permission-selector' });
    this.render();
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'geminese-permission-btn' });
    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'geminese-permission-dropdown' });
    this.renderOptions();
  }

  setDisabled(disabled: boolean, reason = ''): void {
    this.disabled = disabled;
    this.disabledReason = reason;
    this.container.toggleClass('is-disabled', disabled);
    this.container.setAttribute('title', disabled ? reason : 'Permission mode');
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    this.buttonEl.empty();

    const mode = this.callbacks.getSettings().permissionMode;
    const modeInfo = PermissionToggle.MODES.find(m => m.value === mode) ?? PermissionToggle.MODES[0];

    const labelEl = this.buttonEl.createSpan({ cls: 'geminese-permission-label' });
    labelEl.setText(modeInfo.label);

    // Apply mode-specific color styling
    this.container.removeClass('mode-plan');
    this.container.removeClass('mode-agent');
    this.container.addClass(`mode-${mode}`);
  }

  private renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const currentMode = this.callbacks.getSettings().permissionMode;

    for (const mode of PermissionToggle.MODES) {
      const option = this.dropdownEl.createDiv({ cls: 'geminese-permission-option' });
      if (mode.value === currentMode) {
        option.addClass('selected');
      }

      option.createSpan({ text: mode.label });

      option.addEventListener('click', (e) => { void (async () => {
        if (this.disabled) return;
        e.stopPropagation();
        await this.callbacks.onPermissionModeChange(mode.value);
        this.updateDisplay();
        this.renderOptions();
      })(); });
    }
  }
}

export type AddExternalContextResult =
  | { success: true; normalizedPath: string }
  | { success: false; error: string };

export class ExternalContextSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  /**
   * Current external context paths. May contain:
   * - Persistent paths only (new sessions via clearExternalContexts)
   * - Restored session paths (loaded sessions via setExternalContexts)
   * - Mixed paths during active sessions
   */
  private externalContextPaths: string[] = [];
  /** Paths that persist across all sessions (stored in settings). */
  private persistentPaths: Set<string> = new Set();
  private onChangeCallback: ((paths: string[]) => void) | null = null;
  private onPersistenceChangeCallback: ((paths: string[]) => void) | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'geminese-external-context-selector' });
    this.render();
  }

  setOnChange(callback: (paths: string[]) => void): void {
    this.onChangeCallback = callback;
  }

  setOnPersistenceChange(callback: (paths: string[]) => void): void {
    this.onPersistenceChangeCallback = callback;
  }

  getExternalContexts(): string[] {
    return [...this.externalContextPaths];
  }

  getPersistentPaths(): string[] {
    return [...this.persistentPaths];
  }

  setPersistentPaths(paths: string[]): void {
    // Validate paths - remove non-existent directories
    const validPaths = filterValidFiles(paths);
    const invalidPaths = paths.filter(p => !validPaths.includes(p));

    this.persistentPaths = new Set(validPaths);
    // Merge persistent paths into external context paths
    this.mergePersistentPaths();
    this.updateDisplay();
    this.renderDropdown();

    // If invalid paths were removed, notify user and save updated list
    if (invalidPaths.length > 0) {
      const pathNames = invalidPaths.map(p => this.shortenPath(p)).join(', ');
      new Notice(`Removed ${invalidPaths.length} invalid external context path(s): ${pathNames}`, 5000);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
  }

  togglePersistence(path: string): void {
    if (this.persistentPaths.has(path)) {
      this.persistentPaths.delete(path);
    } else {
      // Validate path still exists before persisting
      if (!isValidFilePath(path)) {
        new Notice(`Cannot persist "${this.shortenPath(path)}" - file no longer exists`, 4000);
        return;
      }
      this.persistentPaths.add(path);
    }
    this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    this.renderDropdown();
  }

  private mergePersistentPaths(): void {
    const pathSet = new Set(this.externalContextPaths);
    for (const path of this.persistentPaths) {
      pathSet.add(path);
    }
    this.externalContextPaths = [...pathSet];
  }

  /**
   * Restore exact external context paths from a saved conversation.
   * Does NOT merge with persistent paths - preserves the session's historical state.
   * Use clearExternalContexts() for new sessions to start with current persistent paths.
   */
  setExternalContexts(paths: string[]): void {
    this.externalContextPaths = [...paths];
    this.updateDisplay();
    this.renderDropdown();
  }

  /**
   * Remove a path from external contexts (and persistent paths if applicable).
   * Exposed for testing the remove button behavior.
   */
  removePath(pathStr: string): void {
    this.externalContextPaths = this.externalContextPaths.filter(p => p !== pathStr);
    // Also remove from persistent paths if it was persistent
    if (this.persistentPaths.has(pathStr)) {
      this.persistentPaths.delete(pathStr);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
    this.onChangeCallback?.(this.externalContextPaths);
    this.updateDisplay();
    this.renderDropdown();
  }

    /**
    * Add an external context path programmatically (e.g., from /add-file command).
    * Validates the path and handles duplicates/conflicts.
    * @param pathInput - Path string (supports ~/ expansion)
    * @returns Result with success status and normalized path, or error message on failure
    */
  addExternalContext(pathInput: string): AddExternalContextResult {
    const trimmed = pathInput?.trim();
    if (!trimmed) {
      return { success: false, error: 'No path provided. Usage: /add-file /absolute/path' };
    }

    // Strip surrounding quotes if present (e.g., "/path/with spaces")
    let cleanPath = trimmed;
    if ((cleanPath.startsWith('"') && cleanPath.endsWith('"')) ||
        (cleanPath.startsWith("'") && cleanPath.endsWith("'"))) {
      cleanPath = cleanPath.slice(1, -1);
    }

    // Expand home directory and normalize path
    const expandedPath = expandHomePath(cleanPath);
    const normalizedPath = normalizePathForFilesystem(expandedPath);

    if (!path.isAbsolute(normalizedPath)) {
      return { success: false, error: 'Path must be absolute. Usage: /add-file /absolute/path' };
    }

    // Validate path exists and is a file with specific error messages
    const validation = validateFilePath(normalizedPath);
    if (!validation.valid) {
      return { success: false, error: `${validation.error}: ${pathInput}` };
    }

    // Check for duplicate (normalized comparison for cross-platform support)
    if (isDuplicatePath(normalizedPath, this.externalContextPaths)) {
      return { success: false, error: 'This file is already added as an external context.' };
    }

    // Check for nested/overlapping paths
    const conflict = findConflictingPath(normalizedPath, this.externalContextPaths);
    if (conflict) {
      return { success: false, error: this.formatConflictMessage(normalizedPath, conflict) };
    }

    // Add the path
    this.externalContextPaths = [...this.externalContextPaths, normalizedPath];
    this.onChangeCallback?.(this.externalContextPaths);
    this.updateDisplay();
    this.renderDropdown();

    return { success: true, normalizedPath };
  }

  /**
   * Clear session-only external context paths (call on new conversation).
   * Uses persistent paths from settings if provided, otherwise falls back to local cache.
   * Validates paths before using them (silently filters invalid during session init).
   */
  clearExternalContexts(persistentPathsFromSettings?: string[]): void {
    // Use settings value if provided (most up-to-date), otherwise use local cache
    if (persistentPathsFromSettings) {
      // Validate paths - silently filter during session initialization (not user action)
      const validPaths = filterValidFiles(persistentPathsFromSettings);
      this.persistentPaths = new Set(validPaths);
    }
    this.externalContextPaths = [...this.persistentPaths];
    this.updateDisplay();
    this.renderDropdown();
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'geminese-external-context-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'geminese-external-context-icon' });
    setIcon(this.iconEl, 'file-plus');

    this.badgeEl = iconWrapper.createDiv({ cls: 'geminese-external-context-badge' });

    this.updateDisplay();

    // Click to open native file picker
    iconWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.openFilePicker();
    });

    this.dropdownEl = this.container.createDiv({ cls: 'geminese-external-context-dropdown' });
    this.renderDropdown();
  }

  private async openFilePicker() {
     try {
       // Access Electron's dialog through remote
       // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron remote API required for file picker
       const { remote } = require('electron');
      const result = await remote.dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: 'Select external files',
      });

      if (!result.canceled && result.filePaths.length > 0) {
        let added = 0;
        for (const selectedPath of result.filePaths) {
          // Check for duplicate (normalized comparison for cross-platform support)
          if (isDuplicatePath(selectedPath, this.externalContextPaths)) {
            continue;
          }

          this.externalContextPaths = [...this.externalContextPaths, selectedPath];
          added++;
        }

        if (added > 0) {
          this.onChangeCallback?.(this.externalContextPaths);
          this.updateDisplay();
          this.renderDropdown();
        } else if (result.filePaths.length > 0) {
          new Notice('Selected file(s) already added as external context.', 3000);
        }
      }
    } catch {
      new Notice('Unable to open file picker.', 5000);
    }
  }

  /** Formats a conflict error message for display. */
  private formatConflictMessage(newPath: string, conflict: { path: string; type: 'parent' | 'child' }): string {
    const shortNew = this.shortenPath(newPath);
    const shortExisting = this.shortenPath(conflict.path);
    return conflict.type === 'parent'
      ? `Cannot add "${shortNew}" - it's inside existing path "${shortExisting}"`
      : `Cannot add "${shortNew}" - it contains existing path "${shortExisting}"`;
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;

    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'geminese-external-context-header' });
    headerEl.setText('External contexts');

    // Path list
    const listEl = this.dropdownEl.createDiv({ cls: 'geminese-external-context-list' });

    if (this.externalContextPaths.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'geminese-external-context-empty' });
      emptyEl.setText('Click file icon to add');
    } else {
      for (const pathStr of this.externalContextPaths) {
        const itemEl = listEl.createDiv({ cls: 'geminese-external-context-item' });

        const pathTextEl = itemEl.createSpan({ cls: 'geminese-external-context-text' });
        // Show shortened path for display
        const displayPath = this.shortenPath(pathStr);
        pathTextEl.setText(displayPath);
        pathTextEl.setAttribute('title', pathStr);

        // Lock toggle button
        const isPersistent = this.persistentPaths.has(pathStr);
        const lockBtn = itemEl.createSpan({ cls: 'geminese-external-context-lock' });
        if (isPersistent) {
          lockBtn.addClass('locked');
        }
        setIcon(lockBtn, isPersistent ? 'lock' : 'unlock');
        lockBtn.setAttribute('title', isPersistent ? 'Persistent (click to make session-only)' : 'Session-only (click to persist)');
        lockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.togglePersistence(pathStr);
        });

        const removeBtn = itemEl.createSpan({ cls: 'geminese-external-context-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.setAttribute('title', 'Remove path');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removePath(pathStr);
        });
      }
    }
  }

  /** Shorten path for display (replace home dir with ~) */
   private shortenPath(fullPath: string): string {
     try {
       // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node.js os module required for home directory detection
       const os = require('os');
      const homeDir = os.homedir();
      const normalize = (value: string) => value.replace(/\\/g, '/');
      const normalizedFull = normalize(fullPath);
      const normalizedHome = normalize(homeDir);
      const compareFull = process.platform === 'win32'
        ? normalizedFull.toLowerCase()
        : normalizedFull;
      const compareHome = process.platform === 'win32'
        ? normalizedHome.toLowerCase()
        : normalizedHome;
      if (compareFull.startsWith(compareHome)) {
        // Use normalized path length and normalize the result for consistent display
        const remainder = normalizedFull.slice(normalizedHome.length);
        return '~' + remainder;
      }
    } catch {
      // Fall through to return full path
    }
    return fullPath;
  }

  updateDisplay() {
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.externalContextPaths.length;

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} external context${count > 1 ? 's' : ''} (click to add more)`);

      // Show badge only when more than 1 path
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'Add external contexts (click)');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class McpServerSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private mcpManager: McpServerManager | null = null;
  private enabledServers: Set<string> = new Set();
  private onChangeCallback: ((enabled: Set<string>) => void) | null = null;
  private disabled = false;
  private disabledReason = '';

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'geminese-mcp-selector' });
    this.render();
  }

  setMcpManager(manager: McpServerManager | null): void {
    this.mcpManager = manager;
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  setOnChange(callback: (enabled: Set<string>) => void): void {
    this.onChangeCallback = callback;
  }

  getEnabledServers(): Set<string> {
    return new Set(this.enabledServers);
  }

  addMentionedServers(names: Set<string>): void {
    let changed = false;
    for (const name of names) {
      if (!this.enabledServers.has(name)) {
        this.enabledServers.add(name);
        changed = true;
      }
    }
    if (changed) {
      this.updateDisplay();
      this.renderDropdown();
    }
  }

  clearEnabled(): void {
    this.enabledServers.clear();
    this.updateDisplay();
    this.renderDropdown();
  }

  setEnabledServers(names: string[]): void {
    this.enabledServers = new Set(names);
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  setDisabled(disabled: boolean, reason = ''): void {
    this.disabled = disabled;
    this.disabledReason = reason;
    this.container.toggleClass('is-disabled', disabled);
    this.updateDisplay();
    this.renderDropdown();
  }

  private pruneEnabledServers(): void {
    if (!this.mcpManager) return;
    const activeNames = new Set(this.mcpManager.getServers().filter((s) => s.enabled).map((s) => s.name));
    let changed = false;
    for (const name of this.enabledServers) {
      if (!activeNames.has(name)) {
        this.enabledServers.delete(name);
        changed = true;
      }
    }
    if (changed) {
      this.onChangeCallback?.(this.enabledServers);
    }
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'geminese-mcp-selector-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'geminese-mcp-selector-icon' });
    const mcpSvg = new DOMParser().parseFromString(MCP_ICON_SVG, 'image/svg+xml').documentElement;
    this.iconEl.appendChild(document.adoptNode(mcpSvg));

    this.badgeEl = iconWrapper.createDiv({ cls: 'geminese-mcp-selector-badge' });

    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'geminese-mcp-selector-dropdown' });
    this.renderDropdown();

    // Re-render dropdown content on hover (CSS handles visibility)
    this.container.addEventListener('mouseenter', () => {
      this.renderDropdown();
    });
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;
    this.pruneEnabledServers();
    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'geminese-mcp-selector-header' });
    headerEl.setText('Mcp servers');

    if (this.disabled) {
      const disabledEl = this.dropdownEl.createDiv({ cls: 'geminese-mcp-selector-empty' });
      disabledEl.setText(this.disabledReason || 'Currently unavailable.');
      return;
    }

    // Server list
    const listEl = this.dropdownEl.createDiv({ cls: 'geminese-mcp-selector-list' });

    const allServers = this.mcpManager?.getServers() || [];
    const servers = allServers.filter(s => s.enabled);

    if (servers.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'geminese-mcp-selector-empty' });
      emptyEl.setText(allServers.length === 0 ? 'No MCP servers configured' : 'All MCP servers disabled');
      return;
    }

    for (const server of servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: GemineseMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'geminese-mcp-selector-item' });
    itemEl.dataset.serverName = server.name;

    const isEnabled = this.enabledServers.has(server.name);
    if (isEnabled) {
      itemEl.addClass('enabled');
    }

    // Checkbox
    const checkEl = itemEl.createDiv({ cls: 'geminese-mcp-selector-check' });
    if (isEnabled) {
      const checkSvg = new DOMParser().parseFromString(CHECK_ICON_SVG, 'image/svg+xml').documentElement;
      checkEl.appendChild(document.adoptNode(checkSvg));
    }

    // Info
    const infoEl = itemEl.createDiv({ cls: 'geminese-mcp-selector-item-info' });

    const nameEl = infoEl.createSpan({ cls: 'geminese-mcp-selector-item-name' });
    nameEl.setText(server.name);

    // Badges
    if (server.contextSaving) {
      const csEl = infoEl.createSpan({ cls: 'geminese-mcp-selector-cs-badge' });
      csEl.setText('@');
      csEl.setAttribute('title', 'Context-saving: can also enable via @' + server.name);
    }

    // Click to toggle (use mousedown for more reliable capture)
    itemEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleServer(server.name, itemEl);
    });
  }

  private toggleServer(name: string, itemEl: HTMLElement) {
    if (this.disabled) {
      new Notice(this.disabledReason || 'Currently unavailable.');
      return;
    }

    if (this.enabledServers.has(name)) {
      this.enabledServers.delete(name);
    } else {
      this.enabledServers.add(name);
    }

    // Update item visually in-place (immediate feedback)
    const isEnabled = this.enabledServers.has(name);
    const checkEl = itemEl.querySelector('.geminese-mcp-selector-check');

    if (isEnabled) {
      itemEl.addClass('enabled');
      if (checkEl) {
        checkEl.replaceChildren();
        const checkSvg = new DOMParser().parseFromString(CHECK_ICON_SVG, 'image/svg+xml').documentElement;
        checkEl.appendChild(document.adoptNode(checkSvg));
      }
    } else {
      itemEl.removeClass('enabled');
      if (checkEl) checkEl.replaceChildren();
    }

    this.updateDisplay();
    this.onChangeCallback?.(this.enabledServers);
  }

  updateDisplay() {
    this.pruneEnabledServers();
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.enabledServers.size;
    const hasServers = (this.mcpManager?.getServers().length || 0) > 0;

    // Show/hide container based on whether there are servers
    if (!hasServers) {
      this.container.classList.add('geminese-hidden');
      return;
    }
    this.container.classList.remove('geminese-hidden');

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} MCP server${count > 1 ? 's' : ''} enabled (click to manage)`);

      // Show badge only when more than 1
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', this.disabled ? this.disabledReason || 'Mcp servers unavailable' : 'Mcp servers (click to enable)');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'geminese-context-meter' });
    this.render();
    // Initially hidden
    this.container.classList.add('geminese-hidden');
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'geminese-context-meter-gauge' });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(svgNS, 'svg');
    svgEl.setAttribute('width', String(size));
    svgEl.setAttribute('height', String(size));
    svgEl.setAttribute('viewBox', `0 0 ${size} ${size}`);
    const bgPath = document.createElementNS(svgNS, 'path');
    bgPath.setAttribute('class', 'geminese-meter-bg');
    bgPath.setAttribute('d', `M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}`);
    bgPath.setAttribute('fill', 'none');
    bgPath.setAttribute('stroke-width', String(strokeWidth));
    bgPath.setAttribute('stroke-linecap', 'round');
    svgEl.appendChild(bgPath);
    const fillPath = document.createElementNS(svgNS, 'path');
    fillPath.setAttribute('class', 'geminese-meter-fill');
    fillPath.setAttribute('d', `M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}`);
    fillPath.setAttribute('fill', 'none');
    fillPath.setAttribute('stroke-width', String(strokeWidth));
    fillPath.setAttribute('stroke-linecap', 'round');
    fillPath.setAttribute('stroke-dasharray', String(this.circumference));
    fillPath.setAttribute('stroke-dashoffset', String(this.circumference));
    svgEl.appendChild(fillPath);
    gaugeEl.appendChild(svgEl);
    this.fillPath = fillPath;

    this.percentEl = this.container.createSpan({ cls: 'geminese-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage || usage.contextTokens <= 0) {
      this.container.classList.add('geminese-hidden');
      return;
    }
    this.container.classList.remove('geminese-hidden');
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.style.strokeDashoffset = String(this.circumference - fillLength);
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    // Toggle warning class for > 80%
    if (usage.percentage > 80) {
      this.container.addClass('warning');
    } else {
      this.container.removeClass('warning');
    }

    // Set tooltip with detailed usage
    let tooltip = `${this.formatTokens(usage.contextTokens)} / ${this.formatTokens(usage.contextWindow)}`;
    if (usage.percentage > 80) {
      tooltip += ' (Approaching limit, run `/compact` to continue)';
    }
    this.container.setAttribute('data-tooltip', tooltip);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks
): {
  modelSelector: ModelSelector;
  thinkingBudgetSelector: ThinkingBudgetSelector;
  contextUsageMeter: ContextUsageMeter | null;
  externalContextSelector: ExternalContextSelector;
  mcpServerSelector: McpServerSelector;
  permissionToggle: PermissionToggle;
} {
  const modelSelector = new ModelSelector(parentEl, callbacks);
  const thinkingBudgetSelector = new ThinkingBudgetSelector(parentEl, callbacks);
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  const externalContextSelector = new ExternalContextSelector(parentEl, callbacks);
  const mcpServerSelector = new McpServerSelector(parentEl);
  const permissionToggle = new PermissionToggle(parentEl, callbacks);

  return { modelSelector, thinkingBudgetSelector, contextUsageMeter, externalContextSelector, mcpServerSelector, permissionToggle };
}

import { Notice, setIcon } from 'obsidian';

import { testMcpServer } from '../../../core/mcp/McpTester';
import { McpStorage } from '../../../core/storage';
import type { GemineseMcpServer, McpServerConfig, McpServerType } from '../../../core/types';
import { DEFAULT_MCP_SERVER, getMcpServerType } from '../../../core/types';
import type GeminesePlugin from '../../../main';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import { McpServerModal } from './McpServerModal';
import { McpTestModal } from './McpTestModal';

export class McpSettingsManager {
  private containerEl: HTMLElement;
  private plugin: GeminesePlugin;
  private servers: GemineseMcpServer[] = [];

  /**
   * Broadcasts MCP reload to all open Geminese views.
   * With multiple views open (split workspace), each view's tabs need to reload MCP config.
   */
  private async broadcastMcpReloadToAllViews(): Promise<void> {
    const views = this.plugin.getAllViews();
    for (const view of views) {
      await view.getTabManager()?.broadcastToAllTabs(
        (service) => service.reloadMcpServers()
      );
    }
  }

  constructor(containerEl: HTMLElement, plugin: GeminesePlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    void this.loadAndRender();
  }

  private async loadAndRender() {
    this.servers = await this.plugin.storage.mcp.load();
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'geminese-mcp-header' });
    headerEl.createSpan({ text: 'MCP servers', cls: 'geminese-mcp-label' });

    const addContainer = headerEl.createDiv({ cls: 'geminese-mcp-add-container' });
    const addBtn = addContainer.createEl('button', {
      cls: 'geminese-settings-action-btn',
      attr: { 'aria-label': 'Add' },
    });
    setIcon(addBtn, 'plus');

    const dropdown = addContainer.createDiv({ cls: 'geminese-mcp-add-dropdown' });

    const stdioOption = dropdown.createDiv({ cls: 'geminese-mcp-add-option' });
    setIcon(stdioOption.createSpan({ cls: 'geminese-mcp-add-option-icon' }), 'terminal');
    stdioOption.createSpan({ text: 'stdio (local command)' });
    stdioOption.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
      this.openModal(null, 'stdio');
    });

    const httpOption = dropdown.createDiv({ cls: 'geminese-mcp-add-option' });
    setIcon(httpOption.createSpan({ cls: 'geminese-mcp-add-option-icon' }), 'globe');
    httpOption.createSpan({ text: 'http / sse (remote)' });
    httpOption.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
      this.openModal(null, 'http');
    });

    const importOption = dropdown.createDiv({ cls: 'geminese-mcp-add-option' });
    setIcon(importOption.createSpan({ cls: 'geminese-mcp-add-option-icon' }), 'clipboard-paste');
    importOption.createSpan({ text: 'Import from clipboard' });
    importOption.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
      void this.importFromClipboard();
    });

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.toggleClass('is-visible', !dropdown.hasClass('is-visible'));
    });

    document.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
    });

    if (this.servers.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'geminese-mcp-empty' });
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- "MCP" is an acronym that must be uppercase
      emptyEl.setText('No MCP servers configured. Click "add" to add one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'geminese-mcp-list' });
    for (const server of this.servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: GemineseMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'geminese-mcp-item' });
    if (!server.enabled) {
      itemEl.addClass('geminese-mcp-item-disabled');
    }

    const statusEl = itemEl.createDiv({ cls: 'geminese-mcp-status' });
    statusEl.addClass(
      server.enabled ? 'geminese-mcp-status-enabled' : 'geminese-mcp-status-disabled'
    );

    const infoEl = itemEl.createDiv({ cls: 'geminese-mcp-info' });

    const nameRow = infoEl.createDiv({ cls: 'geminese-mcp-name-row' });

    const nameEl = nameRow.createSpan({ cls: 'geminese-mcp-name' });
    nameEl.setText(server.name);

    const serverType = getMcpServerType(server.config);
    const typeEl = nameRow.createSpan({ cls: 'geminese-mcp-type-badge' });
    typeEl.setText(serverType);

    if (server.contextSaving) {
      const csEl = nameRow.createSpan({ cls: 'geminese-mcp-context-saving-badge' });
      csEl.setText('@');
      csEl.setAttribute('title', 'Context-saving: mention with @' + server.name + ' to enable');
    }

    const previewEl = infoEl.createDiv({ cls: 'geminese-mcp-preview' });
    if (server.description) {
      previewEl.setText(server.description);
    } else {
      previewEl.setText(this.getServerPreview(server, serverType));
    }

    const actionsEl = itemEl.createDiv({ cls: 'geminese-mcp-actions' });

    const testBtn = actionsEl.createEl('button', {
      cls: 'geminese-mcp-action-btn',
      attr: { 'aria-label': 'Verify (show tools)' },
    });
    setIcon(testBtn, 'zap');
    testBtn.addEventListener('click', () => void this.testServer(server));

    const toggleBtn = actionsEl.createEl('button', {
      cls: 'geminese-mcp-action-btn',
      attr: { 'aria-label': server.enabled ? 'Disable' : 'Enable' },
    });
    setIcon(toggleBtn, server.enabled ? 'toggle-right' : 'toggle-left');
    toggleBtn.addEventListener('click', () => void this.toggleServer(server));

    const editBtn = actionsEl.createEl('button', {
      cls: 'geminese-mcp-action-btn',
      attr: { 'aria-label': 'Edit' },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openModal(server));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'geminese-mcp-action-btn geminese-mcp-delete-btn',
      attr: { 'aria-label': 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', () => void this.deleteServer(server));
  }

  private async testServer(server: GemineseMcpServer) {
    const modal = new McpTestModal(
      this.plugin.app,
      server.name,
      server.disabledTools,
      async (toolName, enabled) => {
        await this.updateDisabledTool(server, toolName, enabled);
      },
      async (disabledTools) => {
        await this.updateAllDisabledTools(server, disabledTools);
      }
    );
    modal.open();

    try {
      const result = await testMcpServer(server);
      modal.setResult(result);
    } catch (error) {
      modal.setError(error instanceof Error ? error.message : 'Verification failed');
    }
  }

  /** Rolls back on save failure; warns on reload failure (since save succeeded). */
  private async updateServerDisabledTools(
    server: GemineseMcpServer,
    newDisabledTools: string[] | undefined
  ): Promise<void> {
    const previous = server.disabledTools ? [...server.disabledTools] : undefined;
    server.disabledTools = newDisabledTools;

    try {
      await this.plugin.storage.mcp.save(this.servers);
    } catch (error) {
      server.disabledTools = previous;
      throw error;
    }

    try {
      await this.broadcastMcpReloadToAllViews();
    } catch {
      // Save succeeded but reload failed - don't rollback since disk has correct state
      new Notice('Setting saved but reload failed. Changes will apply on next session.');
    }
  }

  private async updateDisabledTool(
    server: GemineseMcpServer,
    toolName: string,
    enabled: boolean
  ) {
    const disabledTools = new Set(server.disabledTools ?? []);
    if (enabled) {
      disabledTools.delete(toolName);
    } else {
      disabledTools.add(toolName);
    }
    await this.updateServerDisabledTools(
      server,
      disabledTools.size > 0 ? Array.from(disabledTools) : undefined
    );
  }

  private async updateAllDisabledTools(server: GemineseMcpServer, disabledTools: string[]) {
    await this.updateServerDisabledTools(
      server,
      disabledTools.length > 0 ? disabledTools : undefined
    );
  }

  private getServerPreview(server: GemineseMcpServer, type: McpServerType): string {
    if (type === 'stdio') {
      const config = server.config as { command: string; args?: string[] };
      const args = config.args?.join(' ') || '';
      return args ? `${config.command} ${args}` : config.command;
    } else {
      const config = server.config as { url: string };
      return config.url;
    }
  }

  private openModal(existing: GemineseMcpServer | null, initialType?: McpServerType) {
    const modal = new McpServerModal(
      this.plugin.app,
      this.plugin,
      existing,
      (server) => { void this.saveServer(server, existing); },
      initialType
    );
    modal.open();
  }

  private async importFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        new Notice('Clipboard is empty');
        return;
      }

      const parsed = McpStorage.tryParseClipboardConfig(text);
      if (!parsed || parsed.servers.length === 0) {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- "MCP" is an acronym that must be uppercase
        new Notice('No valid MCP configuration found in clipboard');
        return;
      }

      if (parsed.needsName || parsed.servers.length === 1) {
        const server = parsed.servers[0];
        const type = getMcpServerType(server.config);
        const modal = new McpServerModal(
          this.plugin.app,
          this.plugin,
          null,
          (savedServer) => { void this.saveServer(savedServer, null); },
          type,
          server  // Pre-fill with parsed config
        );
        modal.open();
        if (parsed.needsName) {
          new Notice('Enter a name for the server');
        }
        return;
      }

      await this.importServers(parsed.servers);
    } catch {
      new Notice('Failed to read clipboard');
    }
  }

  private async saveServer(server: GemineseMcpServer, existing: GemineseMcpServer | null) {
    if (existing) {
      const index = this.servers.findIndex((s) => s.name === existing.name);
      if (index !== -1) {
        if (server.name !== existing.name) {
          const conflict = this.servers.find((s) => s.name === server.name);
          if (conflict) {
            new Notice(`Server "${server.name}" already exists`);
            return;
          }
        }
        this.servers[index] = server;
      }
    } else {
      const conflict = this.servers.find((s) => s.name === server.name);
      if (conflict) {
        new Notice(`Server "${server.name}" already exists`);
        return;
      }
      this.servers.push(server);
    }

    await this.plugin.storage.mcp.save(this.servers);
    await this.broadcastMcpReloadToAllViews();
    this.render();
    new Notice(existing ? `MCP server "${server.name}" updated` : `MCP server "${server.name}" added`);
  }

  private async importServers(servers: Array<{ name: string; config: McpServerConfig }>) {
    const added: string[] = [];
    const skipped: string[] = [];

    for (const server of servers) {
      const name = server.name.trim();
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        skipped.push(server.name || '<unnamed>');
        continue;
      }

      const conflict = this.servers.find((s) => s.name === name);
      if (conflict) {
        skipped.push(name);
        continue;
      }

      this.servers.push({
        name,
        config: server.config,
        enabled: DEFAULT_MCP_SERVER.enabled,
        contextSaving: DEFAULT_MCP_SERVER.contextSaving,
      });
      added.push(name);
    }

    if (added.length === 0) {
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- "MCP" is an acronym that must be uppercase
      new Notice('No new MCP servers imported');
      return;
    }

    await this.plugin.storage.mcp.save(this.servers);
    await this.broadcastMcpReloadToAllViews();
    this.render();

    let message = `Imported ${added.length} MCP server${added.length > 1 ? 's' : ''}`;
    if (skipped.length > 0) {
      message += ` (${skipped.length} skipped)`;
    }
    new Notice(message);
  }

  private async toggleServer(server: GemineseMcpServer) {
    server.enabled = !server.enabled;
    await this.plugin.storage.mcp.save(this.servers);
    await this.broadcastMcpReloadToAllViews();
    this.render();
    new Notice(`MCP server "${server.name}" ${server.enabled ? 'enabled' : 'disabled'}`);
  }

  private async deleteServer(server: GemineseMcpServer) {
    if (!await confirmDelete(this.plugin.app, `Delete MCP server "${server.name}"?`)) {
      return;
    }

    this.servers = this.servers.filter((s) => s.name !== server.name);
    await this.plugin.storage.mcp.save(this.servers);
    await this.broadcastMcpReloadToAllViews();
    this.render();
    new Notice(`MCP server "${server.name}" deleted`);
  }

  /** Refresh the server list (call after external changes). */
  public refresh() {
    void this.loadAndRender();
  }
}

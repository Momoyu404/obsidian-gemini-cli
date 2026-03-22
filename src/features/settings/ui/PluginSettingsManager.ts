import { Notice, setIcon } from 'obsidian';

import type { GemineseExtension } from '../../../core/types';
import type GeminesePlugin from '../../../main';

export class PluginSettingsManager {
  private containerEl: HTMLElement;
  private plugin: GeminesePlugin;

  private getExtensions(): GemineseExtension[] {
    return this.plugin.pluginManager.getExtensions();
  }

  private async toggleExtensionState(extensionId: string): Promise<void> {
    await this.plugin.pluginManager.toggleExtension(extensionId);
  }

  private async reloadExtensions(): Promise<void> {
    await this.plugin.pluginManager.loadExtensions();
  }

  constructor(containerEl: HTMLElement, plugin: GeminesePlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'geminese-plugin-header' });
    headerEl.createSpan({ text: 'Gemini CLI plugins', cls: 'geminese-plugin-label' });

    const refreshBtn = headerEl.createEl('button', {
      cls: 'geminese-settings-action-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshPlugins());

    const plugins = this.getExtensions();

    if (plugins.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'geminese-plugin-empty' });
      emptyEl.setText('No Gemini CLI plugins found. Enable plugins via the Gemini CLI.');
      return;
    }

    const projectPlugins = plugins.filter(p => p.scope === 'project');
    const userPlugins = plugins.filter(p => p.scope === 'user');

    const listEl = this.containerEl.createDiv({ cls: 'geminese-plugin-list' });

    if (projectPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'geminese-plugin-section-header' });
      sectionHeader.setText('Project plugins');

      for (const plugin of projectPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }

    if (userPlugins.length > 0) {
      const sectionHeader = listEl.createDiv({ cls: 'geminese-plugin-section-header' });
      sectionHeader.setText('User plugins');

      for (const plugin of userPlugins) {
        this.renderPluginItem(listEl, plugin);
      }
    }
  }

  private renderPluginItem(listEl: HTMLElement, plugin: GemineseExtension) {
    const itemEl = listEl.createDiv({ cls: 'geminese-plugin-item' });
    if (!plugin.enabled) {
      itemEl.addClass('geminese-plugin-item-disabled');
    }

    const statusEl = itemEl.createDiv({ cls: 'geminese-plugin-status' });
    if (plugin.enabled) {
      statusEl.addClass('geminese-plugin-status-enabled');
    } else {
      statusEl.addClass('geminese-plugin-status-disabled');
    }

    const infoEl = itemEl.createDiv({ cls: 'geminese-plugin-info' });

    const nameRow = infoEl.createDiv({ cls: 'geminese-plugin-name-row' });

    const nameEl = nameRow.createSpan({ cls: 'geminese-plugin-name' });
    nameEl.setText(plugin.name);

    const actionsEl = itemEl.createDiv({ cls: 'geminese-plugin-actions' });

    const toggleBtn = actionsEl.createEl('button', {
      cls: 'geminese-plugin-action-btn',
      attr: { 'aria-label': plugin.enabled ? 'Disable' : 'Enable' },
    });
    setIcon(toggleBtn, plugin.enabled ? 'toggle-right' : 'toggle-left');
    toggleBtn.addEventListener('click', () => this.toggleExtension(plugin.id));
  }

  private async toggleExtension(pluginId: string) {
    const plugin = this.getExtensions().find(p => p.id === pluginId);
    const wasEnabled = plugin?.enabled ?? false;

    try {
      await this.toggleExtensionState(pluginId);
      await this.plugin.agentManager.loadAgents();

      const view = this.plugin.getView();
      const tabManager = view?.getTabManager();
      if (tabManager) {
        try {
          await tabManager.broadcastToAllTabs(
            async (service) => { await service.ensureReady({ force: true }); }
          );
        } catch {
          new Notice('Plugin toggled, but some tabs failed to restart.');
        }
      }

      new Notice(`Plugin "${pluginId}" ${wasEnabled ? 'disabled' : 'enabled'}`);
    } catch (err) {
      await this.toggleExtensionState(pluginId);
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to toggle plugin: ${message}`);
    } finally {
      this.render();
    }
  }

  private async refreshPlugins() {
    try {
      await this.reloadExtensions();
      await this.plugin.agentManager.loadAgents();

      new Notice('Plugin list refreshed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Failed to refresh plugins: ${message}`);
    } finally {
      this.render();
    }
  }

  public refresh() {
    this.render();
  }
}

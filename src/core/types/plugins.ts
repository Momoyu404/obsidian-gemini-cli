export type ExtensionScope = 'user' | 'project';

export interface GemineseExtension {
  /** e.g., "extension-name@source" */
  id: string;
  name: string;
  enabled: boolean;
  scope: ExtensionScope;
  installPath: string;
}

export interface InstalledExtensionEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
  projectPath?: string;
}

export interface InstalledExtensionsFile {
  version: number;
  extensions: Record<string, InstalledExtensionEntry[]>;
}

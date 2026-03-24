import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { OllamaAgentToolName } from '../../utils/ollama';
import {
  getPathAccessType,
  normalizePathForComparison,
  normalizePathForFilesystem,
  normalizePathForVault,
} from '../../utils/path';

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 400;
const MAX_LS_RESULTS = 200;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 50;
const MAX_FILE_BYTES = 512 * 1024;

export interface OllamaToolExecutorOptions {
  vaultPath: string;
  externalContextPaths: string[];
  allowedExportPaths: string[];
}

export interface OllamaToolExecutionResult {
  content: string;
  isError: boolean;
}

interface ResolvedPath {
  absolutePath: string;
  displayPath: string;
}

export class OllamaToolExecutor {
  private readonly vaultPath: string;
  private readonly externalContextPaths: string[];
  private readonly allowedExportPaths: string[];

  constructor(options: OllamaToolExecutorOptions) {
    this.vaultPath = options.vaultPath;
    this.externalContextPaths = options.externalContextPaths;
    this.allowedExportPaths = options.allowedExportPaths;
  }

  async execute(
    tool: OllamaAgentToolName,
    input: Record<string, unknown>,
  ): Promise<OllamaToolExecutionResult> {
    try {
      switch (tool) {
        case 'Read':
          return {
            content: await this.executeRead(input),
            isError: false,
          };
        case 'LS':
          return {
            content: await this.executeLs(input),
            isError: false,
          };
        case 'Glob':
          return {
            content: await this.executeGlob(input),
            isError: false,
          };
        case 'Grep':
          return {
            content: await this.executeGrep(input),
            isError: false,
          };
      }
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async executeRead(input: Record<string, unknown>): Promise<string> {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath.trim()) {
      throw new Error('Read requires a file_path.');
    }

    const resolved = this.resolveAccessiblePath(filePath);
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Read target is not a file: ${resolved.displayPath}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`Read target is too large (${stat.size} bytes): ${resolved.displayPath}`);
    }

    const content = await fs.readFile(resolved.absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const startLine = clampPositiveInteger(input.offset, 1);
    const requestedLimit = clampPositiveInteger(input.limit, DEFAULT_READ_LIMIT);
    const limit = Math.min(requestedLimit, MAX_READ_LIMIT);
    const startIndex = Math.max(0, startLine - 1);
    const slice = lines.slice(startIndex, startIndex + limit);

    const numbered = slice.map((line, index) => `${startIndex + index + 1}→${line}`);
    if (slice.length === 0) {
      numbered.push(`${startLine}→`);
    }
    if (startIndex + limit < lines.length) {
      numbered.push(`... truncated ${lines.length - (startIndex + limit)} more line(s)`);
    }

    return [`FILE: ${resolved.displayPath}`, ...numbered].join('\n');
  }

  private async executeLs(input: Record<string, unknown>): Promise<string> {
    const targetPath = typeof input.path === 'string' && input.path.trim()
      ? input.path
      : '.';
    const resolved = this.resolveAccessiblePath(targetPath);
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isDirectory()) {
      throw new Error(`LS target is not a directory: ${resolved.displayPath}`);
    }

    const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
    const formatted = entries
      .map((entry) => ({
        name: entry.name,
        line: `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`,
        kind: entry.isDirectory() ? 0 : 1,
      }))
      .sort((left, right) => left.kind - right.kind || left.name.localeCompare(right.name))
      .slice(0, MAX_LS_RESULTS)
      .map((entry) => entry.line);

    const result = [`PATH: ${resolved.displayPath}`, ...formatted];
    if (entries.length > MAX_LS_RESULTS) {
      result.push(`... truncated ${entries.length - MAX_LS_RESULTS} more entr${entries.length - MAX_LS_RESULTS === 1 ? 'y' : 'ies'}`);
    }
    return result.join('\n');
  }

  private async executeGlob(input: Record<string, unknown>): Promise<string> {
    const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
    if (!pattern) {
      throw new Error('Glob requires a pattern.');
    }

    const matcher = createGlobMatcher(pattern);
    const roots = this.getSearchRoots(typeof input.path === 'string' ? input.path : undefined);
    const matches: string[] = [];

    for (const root of roots) {
      await this.walkDirectory(root.absolutePath, async (entryPath) => {
        if (matches.length >= MAX_GLOB_RESULTS) return false;
        const stat = await fs.stat(entryPath);
        if (!stat.isFile()) return true;
        const relative = path.relative(root.absolutePath, entryPath).replace(/\\/g, '/');
        if (matcher(relative)) {
          matches.push(this.formatDisplayPath(entryPath));
        }
        return true;
      });
      if (matches.length >= MAX_GLOB_RESULTS) break;
    }

    if (matches.length === 0) {
      return 'No files matched.';
    }

    const lines = matches.slice(0, MAX_GLOB_RESULTS);
    if (matches.length > MAX_GLOB_RESULTS) {
      lines.push(`... truncated ${matches.length - MAX_GLOB_RESULTS} more match(es)`);
    }
    return lines.join('\n');
  }

  private async executeGrep(input: Record<string, unknown>): Promise<string> {
    const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
    if (!pattern) {
      throw new Error('Grep requires a pattern.');
    }

    const matcher = createTextMatcher(pattern);
    const targets = await this.getGrepTargets(typeof input.path === 'string' ? input.path : undefined);
    const matches: string[] = [];

    for (const target of targets) {
      if (matches.length >= MAX_GREP_RESULTS) break;
      const stat = await fs.stat(target.absolutePath);
      if (stat.isDirectory()) {
        await this.walkDirectory(target.absolutePath, async (entryPath) => {
          if (matches.length >= MAX_GREP_RESULTS) return false;
          const entryStat = await fs.stat(entryPath);
          if (!entryStat.isFile() || entryStat.size > MAX_FILE_BYTES) return true;
          await this.collectGrepMatches(entryPath, matcher, matches);
          return matches.length < MAX_GREP_RESULTS;
        });
      } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        await this.collectGrepMatches(target.absolutePath, matcher, matches);
      }
    }

    if (matches.length === 0) {
      return 'No matches found.';
    }

    return matches.slice(0, MAX_GREP_RESULTS).join('\n');
  }

  private async collectGrepMatches(
    filePath: string,
    matcher: (line: string) => boolean,
    matches: string[],
  ): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= MAX_GREP_RESULTS) break;
        if (!matcher(lines[index])) continue;
        matches.push(`${this.formatDisplayPath(filePath)}:${index + 1}:${lines[index]}`);
      }
    } catch {
      // Skip unreadable or binary-ish files.
    }
  }

  private async getGrepTargets(rawPath?: string): Promise<ResolvedPath[]> {
    if (rawPath?.trim()) {
      return [this.resolveAccessiblePath(rawPath)];
    }

    return [
      {
        absolutePath: this.vaultPath,
        displayPath: '.',
      },
      ...this.externalContextPaths.map((contextPath) => ({
        absolutePath: contextPath,
        displayPath: contextPath.replace(/\\/g, '/'),
      })),
    ];
  }

  private getSearchRoots(rawPath?: string): ResolvedPath[] {
    if (rawPath?.trim()) {
      const resolved = this.resolveAccessiblePath(rawPath);
      return [{
        absolutePath: resolved.absolutePath,
        displayPath: resolved.displayPath,
      }];
    }

    return [
      {
        absolutePath: this.vaultPath,
        displayPath: '.',
      },
      ...this.externalContextPaths.map((contextPath) => ({
        absolutePath: contextPath,
        displayPath: contextPath.replace(/\\/g, '/'),
      })),
    ];
  }

  private resolveAccessiblePath(rawPath: string): ResolvedPath {
    const normalized = normalizePathForFilesystem(rawPath);
    if (!normalized) {
      throw new Error('A valid path is required.');
    }

    const absolutePath = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(this.vaultPath, normalized);

    const accessType = getPathAccessType(
      absolutePath,
      this.externalContextPaths,
      this.allowedExportPaths,
      this.vaultPath,
    );

    if (accessType === 'export') {
      throw new Error(`Read access is denied for export-only path: ${rawPath}`);
    }
    if (accessType === 'none') {
      throw new Error(`Path is outside the vault and allowed external contexts: ${rawPath}`);
    }

    return {
      absolutePath,
      displayPath: this.formatDisplayPath(absolutePath),
    };
  }

  private formatDisplayPath(absolutePath: string): string {
    const normalizedAbsolute = normalizePathForComparison(absolutePath);
    const normalizedVault = normalizePathForComparison(this.vaultPath);
    if (normalizedAbsolute === normalizedVault || normalizedAbsolute.startsWith(normalizedVault + '/')) {
      return normalizePathForVault(absolutePath, this.vaultPath) ?? '.';
    }
    return absolutePath.replace(/\\/g, '/');
  }

  private async walkDirectory(
    rootPath: string,
    visitor: (entryPath: string) => Promise<boolean>,
  ): Promise<void> {
    const queue: string[] = [rootPath];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        const accessType = getPathAccessType(
          entryPath,
          this.externalContextPaths,
          this.allowedExportPaths,
          this.vaultPath,
        );
        if (accessType === 'none' || accessType === 'export') continue;

        if (entry.isDirectory()) {
          queue.push(entryPath);
          continue;
        }

        if (!entry.isFile()) continue;
        const shouldContinue = await visitor(entryPath);
        if (!shouldContinue) return;
      }
    }
  }
}

function clampPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function createTextMatcher(pattern: string): (line: string) => boolean {
  try {
    const regex = new RegExp(pattern, 'i');
    return (line: string) => regex.test(line);
  } catch {
    const needle = pattern.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  }
}

function createGlobMatcher(pattern: string): (relativePath: string) => boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.?\//, '');
  const effectivePattern = normalizedPattern.includes('/') ? normalizedPattern : `**/${normalizedPattern}`;
  const regex = globPatternToRegExp(effectivePattern);
  return (relativePath: string) => regex.test(relativePath.replace(/\\/g, '/'));
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === '*' && next === '*') {
      const afterNext = pattern[index + 2];
      if (afterNext === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
      continue;
    }

    if (char === '*') {
      regex += '[^/]*';
      continue;
    }

    if (char === '?') {
      regex += '[^/]';
      continue;
    }

    regex += escapeRegex(char);
  }

  regex += '$';
  return new RegExp(regex);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

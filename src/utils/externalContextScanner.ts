/**
 * Geminese - External Context Scanner
 *
 * Scans configured external context paths for files to include in @-mention dropdown.
 * Features: recursive scanning, caching, and error handling.
 */

import * as fs from 'fs';
import * as path from 'path';

import { normalizePathForFilesystem } from './path';

export interface ExternalContextFile {
  path: string;
  name: string;
  relativePath: string;
  contextRoot: string;
  /** In milliseconds */
  mtime: number;
}

interface ScanCache {
  files: ExternalContextFile[];
  timestamp: number;
}

const CACHE_TTL_MS = 30000;
const DEFAULT_MAX_SCAN_DEPTH = 20;
const HOME_DIR_MAX_SCAN_DEPTH = 1;

class ExternalContextScanner {
  private cache = new Map<string, ScanCache>();

  scanPaths(externalContextPaths: string[]): ExternalContextFile[] {
    const allFiles: ExternalContextFile[] = [];
    const now = Date.now();

    for (const contextPath of externalContextPaths) {
      const expandedPath = normalizePathForFilesystem(contextPath);
      const maxDepth = expandedPath === normalizePathForFilesystem('~')
        ? HOME_DIR_MAX_SCAN_DEPTH
        : DEFAULT_MAX_SCAN_DEPTH;

      const cached = this.cache.get(expandedPath);
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        allFiles.push(...cached.files);
        continue;
      }

      const files = this.scanDirectory(expandedPath, expandedPath, maxDepth);
      this.cache.set(expandedPath, { files, timestamp: now });
      allFiles.push(...files);
    }

    return allFiles;
  }

  private scanDirectory(
    dir: string,
    contextRoot: string,
    maxDepth: number,
    depth = 0
  ): ExternalContextFile[] {
    try {
      if (!fs.existsSync(dir)) return [];

      const stat = fs.statSync(dir);
      if (stat.isFile()) {
        const name = path.basename(dir);
        if (this.shouldSkipEntry(name)) {
          return [];
        }

        return [{
          path: dir,
          name,
          relativePath: path.relative(contextRoot, dir) || name,
          contextRoot,
          mtime: stat.mtimeMs,
        }];
      }

      if (depth > maxDepth) {
        return [];
      }

      const files: ExternalContextFile[] = [];

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (this.shouldSkipEntry(entry.name)) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          files.push(...this.scanDirectory(fullPath, contextRoot, maxDepth, depth + 1));
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const entryStat = fs.statSync(fullPath);
        files.push({
          path: fullPath,
          name: entry.name,
          relativePath: path.relative(contextRoot, fullPath),
          contextRoot,
          mtime: entryStat.mtimeMs,
        });
      }

      return files;
    } catch {
      return [];
    }
  }

  private shouldSkipEntry(name: string): boolean {
    return name.startsWith('.') || name === 'node_modules';
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  invalidatePath(contextPath: string): void {
    const expandedPath = normalizePathForFilesystem(contextPath);
    this.cache.delete(expandedPath);
  }
}

export const externalContextScanner = new ExternalContextScanner();

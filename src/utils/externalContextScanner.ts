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

class ExternalContextScanner {
  private cache = new Map<string, ScanCache>();

  scanPaths(externalContextPaths: string[]): ExternalContextFile[] {
    const allFiles: ExternalContextFile[] = [];
    const now = Date.now();

    for (const contextPath of externalContextPaths) {
      const expandedPath = normalizePathForFilesystem(contextPath);

      const cached = this.cache.get(expandedPath);
      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        allFiles.push(...cached.files);
        continue;
      }

      const files = this.scanDirectory(expandedPath, expandedPath);
      this.cache.set(expandedPath, { files, timestamp: now });
      allFiles.push(...files);
    }

    return allFiles;
  }

  private scanDirectory(
    dir: string,
    contextRoot: string
  ): ExternalContextFile[] {
    try {
      if (!fs.existsSync(dir)) return [];

      const stat = fs.statSync(dir);
      if (stat.isFile()) {
        return [{
          path: dir,
          name: path.basename(dir),
          relativePath: path.relative(contextRoot, dir),
          contextRoot,
          mtime: stat.mtimeMs,
        }];
      }

      return [];
    } catch {
      return [];
    }
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

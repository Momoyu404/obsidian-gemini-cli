import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { OllamaToolExecutor } from '@/core/agent/OllamaToolExecutor';

describe('OllamaToolExecutor', () => {
  let tempRoot: string;
  let vaultPath: string;
  let externalPath: string;
  let exportPath: string;
  let executor: OllamaToolExecutor;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'geminese-ollama-tools-'));
    vaultPath = path.join(tempRoot, 'vault');
    externalPath = path.join(tempRoot, 'external');
    exportPath = path.join(tempRoot, 'exports');

    await fs.mkdir(path.join(vaultPath, 'notes'), { recursive: true });
    await fs.mkdir(path.join(vaultPath, 'nested'), { recursive: true });
    await fs.mkdir(externalPath, { recursive: true });
    await fs.mkdir(exportPath, { recursive: true });

    await fs.writeFile(path.join(vaultPath, 'notes', 'today.md'), 'line one\nline two\nsearch needle');
    await fs.writeFile(path.join(vaultPath, 'nested', 'deep.md'), 'deep note');
    await fs.writeFile(path.join(externalPath, 'outside.md'), 'external needle');
    await fs.writeFile(path.join(exportPath, 'blocked.md'), 'should not be readable');

    executor = new OllamaToolExecutor({
      vaultPath,
      externalContextPaths: [externalPath],
      allowedExportPaths: [exportPath],
    });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('reads vault files with 1-based offsets and limits', async () => {
    const result = await executor.execute('Read', {
      file_path: 'notes/today.md',
      offset: 2,
      limit: 1,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('FILE: notes/today.md');
    expect(result.content).toContain('2→line two');
    expect(result.content).not.toContain('1→line one');
  });

  it('searches across vault and external contexts', async () => {
    const result = await executor.execute('Grep', {
      pattern: 'needle',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('notes/today.md:3:search needle');
    expect(result.content).toContain(`${externalPath.replace(/\\/g, '/')}/outside.md:1:external needle`);
  });

  it('matches nested files with glob patterns', async () => {
    const result = await executor.execute('Glob', {
      pattern: '**/*.md',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('notes/today.md');
    expect(result.content).toContain('nested/deep.md');
  });

  it('blocks reads from export-only paths', async () => {
    const result = await executor.execute('Read', {
      file_path: exportPath,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('export-only');
  });
});

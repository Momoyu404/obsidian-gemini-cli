import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { OllamaToolExecutor } from '@/core/agent/OllamaToolExecutor';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { LocalSkillDefinition } from '@/utils/localSkills';

describe('OllamaToolExecutor', () => {
  let tempRoot: string;
  let vaultPath: string;
  let externalPath: string;
  let exportPath: string;
  let skillCatalog: LocalSkillDefinition[];
  let vaultAdapter: VaultFileAdapter;
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
    await fs.mkdir(path.join(vaultPath, '.gemini', 'skills', 'vault-skill'), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, '.gemini', 'skills', 'vault-skill', 'SKILL.md'),
      '---\ndescription: Vault skill\n---\nFollow vault instructions',
    );

    skillCatalog = [{
      command: {
        id: 'skill-vault-skill',
        name: 'vault-skill',
        description: 'Vault skill',
        content: 'Follow vault instructions',
        source: 'user',
      },
      description: 'Vault skill',
      filePath: path.join(vaultPath, '.gemini', 'skills', 'vault-skill', 'SKILL.md'),
      name: 'vault-skill',
      source: 'vault',
    }];

    vaultAdapter = new VaultFileAdapter({
      vault: {
        adapter: {
          exists: async (targetPath: string) => {
            try {
              await fs.access(path.join(vaultPath, targetPath));
              return true;
            } catch {
              return false;
            }
          },
          list: async (targetPath: string) => {
            const absolute = path.join(vaultPath, targetPath);
            const entries = await fs.readdir(absolute, { withFileTypes: true });
            return {
              files: entries.filter(entry => entry.isFile()).map(entry => path.join(targetPath, entry.name).replace(/\\/g, '/')),
              folders: entries.filter(entry => entry.isDirectory()).map(entry => path.join(targetPath, entry.name).replace(/\\/g, '/')),
            };
          },
          mkdir: async (targetPath: string) => {
            await fs.mkdir(path.join(vaultPath, targetPath), { recursive: true });
          },
          read: async (targetPath: string) => await fs.readFile(path.join(vaultPath, targetPath), 'utf8'),
          remove: async (targetPath: string) => {
            await fs.rm(path.join(vaultPath, targetPath), { force: true });
          },
          rename: async (oldPath: string, newPath: string) => {
            await fs.rename(path.join(vaultPath, oldPath), path.join(vaultPath, newPath));
          },
          rmdir: async (targetPath: string) => {
            await fs.rm(path.join(vaultPath, targetPath), { recursive: true, force: true });
          },
          stat: async (targetPath: string) => {
            try {
              const stats = await fs.stat(path.join(vaultPath, targetPath));
              return { mtime: stats.mtimeMs, size: stats.size };
            } catch {
              return null;
            }
          },
          write: async (targetPath: string, content: string) => {
            const absolute = path.join(vaultPath, targetPath);
            await fs.mkdir(path.dirname(absolute), { recursive: true });
            await fs.writeFile(absolute, content);
          },
        },
      },
    } as any);

    executor = new OllamaToolExecutor({
      allowedExportPaths: [exportPath],
      allowedTools: ['Read', 'LS', 'Glob', 'Grep', 'Write', 'Edit', 'LoadSkill'],
      externalContextPaths: [externalPath],
      permissionMode: 'agent',
      skillCatalog,
      vaultAdapter,
      vaultPath,
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

  it('writes vault files in agent mode', async () => {
    const result = await executor.execute('Write', {
      file_path: 'notes/new.md',
      content: 'created',
    });

    expect(result.isError).toBe(false);
    await expect(fs.readFile(path.join(vaultPath, 'notes', 'new.md'), 'utf8')).resolves.toBe('created');
  });

  it('edits existing vault files in agent mode', async () => {
    const result = await executor.execute('Edit', {
      file_path: 'notes/today.md',
      old_string: 'line one',
      new_string: 'line zero',
    });

    expect(result.isError).toBe(false);
    await expect(fs.readFile(path.join(vaultPath, 'notes', 'today.md'), 'utf8')).resolves.toContain('line zero');
  });

  it('rejects writes outside the vault', async () => {
    const result = await executor.execute('Write', {
      file_path: externalPath,
      content: 'blocked',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('only allowed inside the current vault');
  });

  it('loads installed skills', async () => {
    const result = await executor.execute('LoadSkill', {
      skill_name: 'vault-skill',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('SKILL: vault-skill');
    expect(result.content).toContain('Follow vault instructions');
  });

  it('blocks write/edit tools in plan mode', async () => {
    const planExecutor = new OllamaToolExecutor({
      allowedExportPaths: [exportPath],
      allowedTools: ['Read', 'LS', 'Glob', 'Grep', 'LoadSkill'],
      externalContextPaths: [externalPath],
      permissionMode: 'plan',
      skillCatalog,
      vaultAdapter,
      vaultPath,
    });

    const result = await planExecutor.execute('Write', {
      file_path: 'notes/blocked.md',
      content: 'blocked',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available in plan mode');
  });
});

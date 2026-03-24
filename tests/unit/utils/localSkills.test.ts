import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { getOllamaVisibleSlashCommands, listAvailableLocalSkills, resolveLocalSkill } from '@/utils/localSkills';

describe('localSkills utils', () => {
  let tempRoot: string;
  let vaultPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'geminese-local-skills-'));
    vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, '.gemini', 'skills', 'vault-skill'), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, '.gemini', 'skills', 'vault-skill', 'SKILL.md'),
      '---\ndescription: Vault skill\n---\nFollow vault instructions',
    );

    originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
    jest.spyOn(os, 'homedir').mockReturnValue(tempRoot);
    await fs.mkdir(path.join(tempRoot, '.gemini', 'skills', 'global-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, '.gemini', 'skills', 'global-skill', 'SKILL.md'),
      '---\ndescription: Global skill\n---\nFollow global instructions',
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('lists vault and global skills with vault taking priority', async () => {
    const skills = await listAvailableLocalSkills(vaultPath);

    expect(skills.map(skill => skill.name)).toEqual(['global-skill', 'vault-skill']);
    expect(skills.find(skill => skill.name === 'vault-skill')?.source).toBe('vault');
    expect(skills.find(skill => skill.name === 'global-skill')?.source).toBe('global');
  });

  it('resolves a skill by name', async () => {
    const skill = await resolveLocalSkill(vaultPath, 'vault-skill');
    expect(skill?.name).toBe('vault-skill');
    expect(skill?.description).toBe('Vault skill');
  });

  it('merges configured slash commands with discovered global skills', async () => {
    const commands = await getOllamaVisibleSlashCommands(vaultPath, [
      {
        id: 'cmd-review',
        name: 'review',
        content: 'Review this: $ARGUMENTS',
      },
    ]);

    expect(commands.map(command => command.name)).toEqual(['global-skill', 'review', 'vault-skill']);
  });
});

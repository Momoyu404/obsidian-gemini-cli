import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { SlashCommand } from '../core/types';
import { extractFirstParagraph, isSkill, parseSlashCommandContent } from './slashCommand';

export type LocalSkillSource = 'vault' | 'global';

export interface LocalSkillDefinition {
  command: SlashCommand;
  description?: string;
  filePath: string;
  name: string;
  source: LocalSkillSource;
}

const VAULT_SKILLS_DIR = '.gemini/skills';

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), '.gemini', 'skills');
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

async function readSkillDirectory(
  rootPath: string,
  source: LocalSkillSource,
): Promise<LocalSkillDefinition[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootPath);
  } catch {
    return [];
  }

  const skills: LocalSkillDefinition[] = [];

  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const skillPath = path.join(rootPath, entry, 'SKILL.md');
    let content: string;
    try {
      content = await fs.readFile(skillPath, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseSlashCommandContent(content);
    const description = parsed.description ?? extractFirstParagraph(parsed.promptContent);

    skills.push({
      command: {
        id: source === 'vault' ? `skill-${entry}` : `skill-global-${entry}`,
        name: entry,
        description,
        content: parsed.promptContent,
        disableModelInvocation: parsed.disableModelInvocation,
        userInvocable: parsed.userInvocable,
        context: parsed.context,
        agent: parsed.agent,
        hooks: parsed.hooks,
        source: source === 'vault' ? 'user' : 'plugin',
      },
      description,
      filePath: skillPath,
      name: entry,
      source,
    });
  }

  return skills;
}

export async function listAvailableLocalSkills(vaultPath: string): Promise<LocalSkillDefinition[]> {
  const [vaultSkills, globalSkills] = await Promise.all([
    readSkillDirectory(path.join(vaultPath, VAULT_SKILLS_DIR), 'vault'),
    readSkillDirectory(getGlobalSkillsDir(), 'global'),
  ]);

  const deduped = new Map<string, LocalSkillDefinition>();

  for (const skill of vaultSkills) {
    deduped.set(normalizeSkillName(skill.name), skill);
  }

  for (const skill of globalSkills) {
    const key = normalizeSkillName(skill.name);
    if (!deduped.has(key)) {
      deduped.set(key, skill);
    }
  }

  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveLocalSkill(vaultPath: string, skillName: string): Promise<LocalSkillDefinition | null> {
  const normalized = normalizeSkillName(skillName);
  const skills = await listAvailableLocalSkills(vaultPath);
  return skills.find(skill => normalizeSkillName(skill.name) === normalized) ?? null;
}

export async function getOllamaVisibleSlashCommands(
  vaultPath: string,
  configuredCommands: SlashCommand[] | undefined,
): Promise<SlashCommand[]> {
  const configured = configuredCommands ?? [];
  const seen = new Set<string>();
  const merged: SlashCommand[] = [];

  for (const command of configured) {
    if (isSkill(command) && command.userInvocable === false) continue;
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(command);
  }

  const globalAndLocalSkills = await listAvailableLocalSkills(vaultPath);
  for (const skill of globalAndLocalSkills) {
    if (skill.command.userInvocable === false) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(skill.command);
  }

  return merged.sort((left, right) => left.name.localeCompare(right.name));
}

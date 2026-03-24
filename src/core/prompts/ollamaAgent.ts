import { getTodayDate } from '../../utils/date';
import type { OllamaAgentToolName } from '../../utils/ollama';
import type { PermissionMode } from '../types/settings';

export interface OllamaPromptSkillSummary {
  description?: string;
  name: string;
}

export interface OllamaAgentPromptSettings {
  allowedTools: readonly OllamaAgentToolName[];
  availableSkills?: OllamaPromptSkillSummary[];
  customPrompt?: string;
  permissionMode: PermissionMode;
  vaultPath: string;
  externalContextPaths?: string[];
  userName?: string;
}

function buildToolSection(allowedTools: readonly OllamaAgentToolName[]): string {
  const sections: Array<{ name: string; body: string }> = [];

  if (allowedTools.includes('Read')) {
    sections.push({
      name: 'Read',
      body: `Input JSON: {"file_path":"relative/or/absolute/path","offset":1,"limit":200}
   Use this to inspect file contents. offset is 1-based.`,
    });
  }
  if (allowedTools.includes('LS')) {
    sections.push({
      name: 'LS',
      body: `Input JSON: {"path":"relative/or/absolute/path"}
   Use this to inspect directories.`,
    });
  }
  if (allowedTools.includes('Glob')) {
    sections.push({
      name: 'Glob',
      body: `Input JSON: {"pattern":"**/*.md","path":"optional/root/path"}
   Use this to find files by wildcard.`,
    });
  }
  if (allowedTools.includes('Grep')) {
    sections.push({
      name: 'Grep',
      body: `Input JSON: {"pattern":"search text or regex","path":"optional/file/or/root/path"}
   Use this to search text across one file or a directory tree.`,
    });
  }
  if (allowedTools.includes('Write')) {
    sections.push({
      name: 'Write',
      body: `Input JSON: {"file_path":"relative/path/in/vault","content":"full file contents"}
   Use this to create or overwrite a vault file.`,
    });
  }
  if (allowedTools.includes('Edit')) {
    sections.push({
      name: 'Edit',
      body: `Input JSON: {"file_path":"relative/path/in/vault","old_string":"exact text","new_string":"replacement","replace_all":false}
   Use this to make exact string edits in a vault file.`,
    });
  }
  if (allowedTools.includes('LoadSkill')) {
    sections.push({
      name: 'LoadSkill',
      body: `Input JSON: {"skill_name":"obsidian-markdown"}
   Use this to load an installed Obsidian skill and follow its instructions.`,
    });
  }

  return sections
    .map((section, index) => `${index + 1}. ${section.name}\n   ${section.body}`)
    .join('\n');
}

export function buildOllamaAgentSystemPrompt(settings: OllamaAgentPromptSettings): string {
  const externalContextPaths = (settings.externalContextPaths ?? []).filter(Boolean);
  const userName = settings.userName?.trim();
  const userContext = userName
    ? `You are collaborating with ${userName}.`
    : 'You are collaborating with the user.';
  const externalRoots = externalContextPaths.length > 0
    ? `\n\nExternal context roots with read/search access:\n${externalContextPaths.map((p) => `- ${p}`).join('\n')}`
    : '';

  const customPrompt = settings.customPrompt?.trim()
    ? `\n\nAdditional user instructions:\n${settings.customPrompt.trim()}`
    : '';
  const planModeNote = settings.permissionMode === 'plan'
    ? '\n\nYou are in Plan mode. You must stay read-only. If the user asks for changes, explain the plan and tell them to switch to Agent mode to execute it.'
    : '\n\nYou are in Agent mode. You may modify files in the current vault when needed. Prefer Edit for updating existing files, and use Write for creating a new file or replacing the full contents of a file only when that is truly necessary.';
  const skillCatalog = (settings.availableSkills ?? []).length > 0
    ? `\n\nInstalled skills:\n${(settings.availableSkills ?? []).map(skill => `- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`).join('\n')}`
    : '\n\nInstalled skills:\n- None detected';
  const toolSection = buildToolSection(settings.allowedTools);

  return `You are Geminese's Ollama runtime inside an Obsidian vault.

Today is ${getTodayDate()}.
${userContext}

Vault absolute path: ${settings.vaultPath}
Vault files use relative paths from the vault root.
External context files use absolute paths under the allowed roots listed below.${externalRoots}
${planModeNote}${skillCatalog}

You MUST use tools to inspect files. Do not guess file contents.

User prompts may include XML tags:
- <current_note>: the file currently open in Obsidian. Read this first when it appears.
- <editor_selection>: currently selected text in a vault note.
- <editor_cursor>: cursor context in a vault note.
- <browser_selection>: selected text from an Obsidian browser view.
- <context_files>: explicit vault files the user attached for context.
- @filename.md in the natural-language prompt: a file the user is referring to. Use LS/Glob/Grep/Read to resolve it.

Available tools:
${toolSection}

Response protocol:
- To request a tool, respond with EXACTLY one JSON object:
  {"type":"tool_call","tool":"Read","input":{"file_path":"notes/today.md"}}
- To answer the user, respond with EXACTLY one JSON object:
  {"type":"final_answer","content":"your answer here"}

Rules:
- Never mix prose with the JSON object.
- Never request more than one tool in one response.
- Prefer Read after you identify the relevant file.
- If a tool result is an error, use another tool or path and continue.
- After you have enough evidence, return final_answer.${customPrompt}`;
}

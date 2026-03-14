# obsidian-gemini-cli   

obsidian-gemini-cli is an Obsidian plugin that embeds [Gemini CLI](https://github.com/google-gemini/gemini-cli) as an AI collaborator in your vault. Your vault becomes Gemini's working directory, giving it full agentic capabilities: file read/write, search, bash commands, and multi-step workflows.

> **Based on [Claudian](https://github.com/YishenTu/claudian)** — converted from Claude Code CLI to Gemini CLI. Uses your Google account (no API key needed).

## Features

- **Full Agentic Capabilities**: Leverage Gemini CLI's power to read, write, and edit files, search, and execute bash commands, all within your Obsidian vault.
- **No API Key Required**: Uses Gemini CLI which authenticates with your Google account — works with the free tier (60 req/min, 1000 req/day).
- **Context-Aware**: Automatically attach the focused note, mention files with `@`, exclude notes by tag, include editor selection, and access external directories for additional context.
- **Vision Support**: Analyze images by sending them via drag-and-drop, paste, or file path.
- **Inline Edit**: Edit selected text or insert content at cursor position directly in notes with word-level diff preview.
- **Instruction Mode (`#`)**: Add refined custom instructions to your system prompt directly from the chat input.
- **Slash Commands**: Create reusable prompt templates triggered by `/command`, with argument placeholders and `@file` references.
- **MCP Support**: Connect external tools and data sources via Model Context Protocol servers (stdio, SSE, HTTP).
- **Model Selection**: Choose between Auto, Pro, Flash, and Flash Lite. The actual model (Gemini 2.5 or 3.x) depends on your [Gemini CLI](https://github.com/google-gemini/gemini-cli) version.
- **Plan Mode**: Toggle plan mode via Shift+Tab — Gemini explores and designs before implementing.
- **Security**: Permission modes — **Build** (execute tools and edit files) and **Plan** (read-only planning), plus command blocklist and vault-scoped access.
- **10 Languages**: English, Chinese (Simplified/Traditional), Japanese, Korean, Spanish, German, French, Portuguese, Russian.

## Requirements

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed
- Obsidian v1.4.5+
- Google account (free tier works)
- Desktop only (macOS, Linux, Windows)

## Installation

### Prerequisites: Install Gemini CLI

Depending on your platform, ensure Node.js is installed first.

**macOS & Linux**
```bash
npm install -g @google/gemini-cli
```

**Windows**
1. Install Node.js from [nodejs.org](https://nodejs.org/). Make sure "Add to PATH" is checked during installation.
2. Open Command Prompt or PowerShell and install the CLI:
   ```powershell
   npm install -g @google/gemini-cli
   ```
3. **IMPORTANT:** Fully restart Obsidian after installation to ensure it picks up the new environment variables.

Then authenticate (on any platform):

```bash
gemini
```

Follow the prompts to sign in with your Google account.

### Install the Plugin

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Momoyu404/obsidian-gemini-cli/releases/latest)
2. Create a folder called `obsidian-gemini-cli` in your vault's plugins folder:
   ```
   /path/to/vault/.obsidian/plugins/obsidian-gemini-cli/
   ```
3. Copy the downloaded files into the folder
4. Enable the plugin in Obsidian Settings → Community plugins

### Development

```bash
npm run dev     # Watch mode
npm run build   # Production build
npm run test    # Run tests
npm run lint    # Lint code
```

## Usage

**Two modes:**
1. Click the bot icon in ribbon or use command palette to open chat
2. Select text + hotkey for inline edit

Use it like Gemini CLI — read, write, edit, search files in your vault.

**Check you're connected:** If you get a reply in the chat, you're connected. You can ask e.g. “What model are you?” to confirm. The **model** (Auto / Pro / Flash / Flash Lite) is shown in the input toolbar next to “Thinking”; click it to change. Permission mode (**Plan / Build**): Plan is read-only planning, Build allows tool execution and file editing.

### Context

- **File**: Auto-attaches focused note; type `@` to attach other files
- **Selection**: Select text in editor, then chat — selection included automatically
- **Images**: Drag-drop, paste, or type path
- **External contexts**: Click folder icon in toolbar for access to directories outside vault

### Features

- **Inline Edit**: Select text + hotkey to edit directly in notes
- **Instruction Mode**: Type `#` to add refined instructions to system prompt
- **Slash Commands**: Type `/` for custom prompt templates
- **MCP**: Add external tools via Settings → MCP Servers; use `@mcp-server` in chat to activate

## Configuration

### Settings

**Customization**
- **User name**: Your name for personalized greetings
- **Excluded tags**: Tags that prevent notes from auto-loading
- **Media folder**: Configure where vault stores attachments for embedded image support
- **Custom system prompt**: Additional instructions appended to the default system prompt

**Safety**
- **Enable command blocklist**: Block dangerous bash commands (default: on)
- **Blocked commands**: Patterns to block (supports regex, platform-specific)
- **Allowed export paths**: Paths outside the vault where files can be exported

**Environment**
- **Custom variables**: Environment variables (KEY=VALUE format)
- **Environment snippets**: Save and restore environment variable configurations

**Advanced**
- **Gemini CLI path**: Custom path to Gemini CLI (leave empty for auto-detection)

## Safety and Permissions

| Scope | Access |
|-------|--------|
| **Vault** | Full read/write (symlink-safe via `realpath`) |
| **Export paths** | Write-only (e.g., `~/Desktop`, `~/Downloads`) |
| **External contexts** | Full read/write (session-only) |

- **Build mode**: Default mode — execute tools and edit files (with safety interception and approval)
- **Plan mode**: Read-only — explores and designs a plan before implementing

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs go to Google's Gemini API via the CLI.
- **Local storage**: Settings and session metadata stored in `vault/.gemini/`; session data managed by Gemini CLI.
- **No telemetry**: No tracking beyond Google's Gemini API.

## Troubleshooting

### Gemini CLI not found

If you encounter `Gemini CLI not found`, the plugin can't auto-detect your installation.

**Solution**: Find your CLI path and set it in Settings → Advanced → Gemini CLI path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which gemini` | `/usr/local/bin/gemini` |
| macOS (Homebrew) | `which gemini` | `/opt/homebrew/bin/gemini` |
| Windows | `where.exe gemini` | `%APPDATA%\npm\node_modules\@google\gemini-cli\dist\index.js` |
| npm global | `npm root -g` | `{root}/@google/gemini-cli/dist/index.js` |

**Alternative**: Add your Node.js bin directory to PATH in Settings → Environment → Custom variables.

### Authentication Issues

Make sure you've authenticated with Gemini CLI first:

```bash
gemini
```

This will open a browser for Google account login. After signing in, the CLI (and plugin) can use your account.

## Architecture

```
Obsidian Plugin (UI)
      ↓
child_process.spawn("gemini", ["--output-format", "stream-json", ...])
      ↓
Gemini CLI → Google Account (no API key)
```

The plugin spawns the Gemini CLI as a subprocess for each query, passing `--output-format stream-json` to get structured JSONL output. Session continuity is maintained via `--resume`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed source structure and development notes.

## License

Licensed under the [MIT License](LICENSE).

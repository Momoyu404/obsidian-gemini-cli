# Obsidian Community Plugin Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clear the ObsidianReviewBot required findings blocking the `Geminese` community plugin submission and re-validate the existing `obsidian-releases` PR successfully.

**Architecture:** Treat the remediation as a repository-wide compatibility and conformance sweep, not a feature change. Fix issues in batches that map to ObsidianReviewBot rule families, starting with core APIs and type/promise correctness, then UI rendering/theming, then sentence-case and final polish. Keep each batch small, test-backed, and reversible.

**Tech Stack:** TypeScript, Obsidian plugin API, ESLint, Jest, esbuild, `@modelcontextprotocol/sdk`

---

### Task 1: Freeze the review baseline and track required categories

**Files:**
- Create: `docs/plans/2026-03-14-obsidian-community-plugin-remediation.md`
- Modify: `README.md` (only if release/review notes are later needed)
- Reference: `manifest.json`
- Reference: `.eslintrc.cjs`

**Step 1: Record the blocking categories**

Create a working checklist from the current ObsidianReviewBot comment with these buckets:
- async/promise correctness
- unnecessary assertions and `any`
- deprecated Obsidian/plugin APIs and legacy type aliases
- direct `innerHTML` / `outerHTML`
- direct `element.style.*` visibility toggles
- sentence-case UI text
- undocumented `eslint-disable` directives

**Step 2: Verify local baseline commands**

Run: `npm run lint -- --format unix`
Expected: existing local lint output, not a clean result yet

Run: `npm run typecheck`
Expected: collect current TypeScript errors or confirm current baseline

**Step 3: Capture review discipline for later batches**

For each later task, do work in this order:
1. make the smallest code batch for one rule family
2. run the most targeted tests for touched files
3. run `npm run typecheck`
4. run `npm run lint -- --format unix`
5. only then move to the next batch

**Step 4: Commit checkpoint**

```bash
git add docs/plans/2026-03-14-obsidian-community-plugin-remediation.md
git commit -m "docs: add community plugin remediation plan"
```

### Task 2: Remove deprecated plugin and extension API usage

**Files:**
- Modify: `src/core/agent/QueryOptionsBuilder.ts`
- Modify: `src/core/agents/AgentManager.ts`
- Modify: `src/features/settings/ui/PluginSettingsManager.ts`
- Modify: `src/core/plugins/PluginManager.ts`
- Modify: `src/core/types/index.ts`
- Modify: `src/core/types/plugins.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/core/agent/QueryOptionsBuilder.test.ts`
- Test: `tests/unit/core/plugins/PluginManager.test.ts`

**Step 1: Write or update targeted tests for extension API names**

Add or update tests so they exercise the non-deprecated API names:
- `getExtensions()` instead of `getPlugins()`
- `getExtensionsKey()` instead of `getPluginsKey()`
- new extension-oriented type names instead of deprecated aliases where possible

**Step 2: Run focused tests before code changes**

Run: `npm run test -- tests/unit/core/agent/QueryOptionsBuilder.test.ts tests/unit/core/plugins/PluginManager.test.ts`
Expected: passing baseline or failures that expose deprecated assumptions in tests

**Step 3: Replace deprecated calls in production code**

Make these exact substitutions first:
- `src/core/agent/QueryOptionsBuilder.ts:105` -> `ctx.pluginManager.getExtensionsKey()`
- `src/core/agents/AgentManager.ts` -> iterate `this.pluginManager.getExtensions()`
- `src/features/settings/ui/PluginSettingsManager.ts:29` and `src/features/settings/ui/PluginSettingsManager.ts:92` -> `getExtensions()`

Then reduce exported deprecated aliases in `src/core/types/index.ts` and `src/core/types/plugins.ts` to migration-only surfaces that are not imported by active runtime code.

**Step 4: Replace deprecated platform helpers where still used**

Remove active runtime use of deprecated helpers like `getCliPlatformKey` in `src/main.ts` if an updated helper already exists. If a migration path must remain, isolate it behind clearly named migration code.

**Step 5: Re-run verification**

Run: `npm run test -- tests/unit/core/agent/QueryOptionsBuilder.test.ts tests/unit/core/plugins/PluginManager.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: no new type errors from the rename sweep

**Step 6: Commit checkpoint**

```bash
git add src/core/agent/QueryOptionsBuilder.ts src/core/agents/AgentManager.ts src/features/settings/ui/PluginSettingsManager.ts src/core/plugins/PluginManager.ts src/core/types/index.ts src/core/types/plugins.ts src/main.ts tests/unit/core/agent/QueryOptionsBuilder.test.ts tests/unit/core/plugins/PluginManager.test.ts
git commit -m "refactor: replace deprecated extension APIs"
```

### Task 3: Fix async and promise correctness in core and controller flows

**Files:**
- Modify: `src/core/agent/ClaudianService.ts`
- Modify: `src/core/agents/AgentManager.ts`
- Modify: `src/core/hooks/SecurityHooks.ts`
- Modify: `src/features/chat/controllers/ConversationController.ts`
- Modify: `src/features/chat/controllers/InputController.ts`
- Modify: `src/features/chat/controllers/StreamController.ts`
- Modify: `src/features/chat/rendering/MessageRenderer.ts`
- Modify: `src/features/inline-edit/InlineEditService.ts`
- Test: `tests/unit/core/agent/ClaudianService.test.ts`
- Test: `tests/unit/features/chat/controllers/ConversationController.test.ts`
- Test: `tests/unit/features/chat/controllers/InputController.test.ts`

**Step 1: Add a failing test for one representative async misuse**

Prefer one controller test that covers an event handler that currently passes an async callback directly to `addEventListener` or another void-only callback surface.

**Step 2: Run the failing test**

Run: `npm run test -- tests/unit/features/chat/controllers/ConversationController.test.ts`
Expected: fail only if the new regression test is added first

**Step 3: Apply the remediation pattern everywhere in this batch**

Use these rules consistently:
- if a function has no `await`, make it synchronous
- if an event handler needs async work, wrap it in a sync callback and call `void someAsyncMethod()`
- if a callback contract expects `void`, do not return a `Promise`
- if a catch branch swallows a promise, convert it to explicit `void fn().catch(...)` or move the `await` into a dedicated method

Representative hotspots:
- `src/core/agent/ClaudianService.ts` (`ensureReady`, `getSupportedCommands`)
- `src/core/agents/AgentManager.ts` parsing helpers
- `src/core/hooks/SecurityHooks.ts`
- `src/features/chat/controllers/ConversationController.ts`
- `src/features/chat/controllers/InputController.ts`
- `src/features/chat/rendering/MessageRenderer.ts`

**Step 4: Run focused verification**

Run: `npm run test -- tests/unit/core/agent/ClaudianService.test.ts tests/unit/features/chat/controllers/ConversationController.test.ts tests/unit/features/chat/controllers/InputController.test.ts tests/unit/features/chat/rendering/MessageRenderer.test.ts`
Expected: PASS

Run: `npm run typecheck && npm run lint -- --format unix`
Expected: fewer async/promise findings than baseline

**Step 5: Commit checkpoint**

```bash
git add src/core/agent/ClaudianService.ts src/core/agents/AgentManager.ts src/core/hooks/SecurityHooks.ts src/features/chat/controllers/ConversationController.ts src/features/chat/controllers/InputController.ts src/features/chat/controllers/StreamController.ts src/features/chat/rendering/MessageRenderer.ts src/features/inline-edit/InlineEditService.ts tests/unit/core/agent/ClaudianService.test.ts tests/unit/features/chat/controllers/ConversationController.test.ts tests/unit/features/chat/controllers/InputController.test.ts
git commit -m "fix: normalize async and promise handling"
```

### Task 4: Remove forbidden `any` usage and unnecessary assertions

**Files:**
- Modify: `src/features/chat/ClaudianView.ts`
- Modify: `src/main.ts`
- Modify: `src/utils/path.ts`
- Modify: `src/utils/slashCommand.ts`
- Modify: `src/utils/session.ts`
- Modify: `src/utils/sdkSession.ts`
- Modify: `src/features/settings/ClaudianSettings.ts`
- Modify: `src/features/settings/ui/McpServerModal.ts`
- Modify: `src/features/settings/ui/McpSettingsManager.ts`
- Test: `tests/unit/utils/slashCommand.test.ts`
- Test: `tests/unit/utils/session.test.ts`

**Step 1: Remove banned lint disables first**

Delete active `@typescript-eslint/no-explicit-any` suppression comments from runtime code, especially in:
- `src/features/chat/ClaudianView.ts:53`
- `src/main.ts:264`
- `src/main.ts:275`

**Step 2: Replace `any` with one of these exact strategies**

Use this order:
1. existing project type
2. `Record<string, unknown>`
3. discriminated union + narrowing
4. `unknown` with guard function

Do not reintroduce `any` or new disable comments.

**Step 3: Remove unnecessary `as` assertions that do not narrow types**

Start with review-hit files:
- `src/utils/slashCommand.ts`
- `src/utils/session.ts`
- `src/core/storage/CCSettingsStorage.ts`
- `src/core/storage/McpStorage.ts`

Where an assertion is still required, replace it with a guard or helper function that proves the shape.

**Step 4: Run verification**

Run: `npm run test -- tests/unit/utils/slashCommand.test.ts tests/unit/utils/session.test.ts tests/unit/utils/env.test.ts`
Expected: PASS

Run: `npm run typecheck && npm run lint -- --format unix`
Expected: no runtime `no-explicit-any` disables and fewer assertion findings

**Step 5: Commit checkpoint**

```bash
git add src/features/chat/ClaudianView.ts src/main.ts src/utils/path.ts src/utils/slashCommand.ts src/utils/session.ts src/utils/sdkSession.ts src/features/settings/ClaudianSettings.ts src/features/settings/ui/McpServerModal.ts src/features/settings/ui/McpSettingsManager.ts tests/unit/utils/slashCommand.test.ts tests/unit/utils/session.test.ts
git commit -m "refactor: tighten runtime typing"
```

### Task 5: Replace direct DOM HTML injection and inline visibility styling

**Files:**
- Modify: `src/shared/modals/InstructionConfirmModal.ts`
- Modify: `src/features/chat/rendering/MessageRenderer.ts`
- Modify: `src/features/chat/ui/InputToolbar.ts`
- Modify: `src/features/chat/ui/StatusPanel.ts`
- Modify: `src/features/chat/ClaudianView.ts`
- Modify: `src/features/chat/controllers/BrowserSelectionController.ts`
- Modify: `src/features/chat/controllers/SelectionController.ts`
- Modify: `src/features/chat/controllers/CanvasSelectionController.ts`
- Modify: `src/features/chat/rendering/ToolCallRenderer.ts`
- Modify: `src/features/inline-edit/ui/InlineEditModal.ts`
- Test: `tests/unit/features/chat/rendering/MessageRenderer.test.ts`
- Test: `tests/unit/features/inline-edit/ui/InlineEditModal.test.ts`

**Step 1: Write one failing UI regression test for class-based visibility**

Pick one modal or renderer that currently toggles `style.display` directly and assert that the state change is now represented by class toggles or `setCssProps` instead.

**Step 2: Run the focused test**

Run: `npm run test -- tests/unit/features/inline-edit/ui/InlineEditModal.test.ts`
Expected: fail if the new regression expectation is added first

**Step 3: Replace inline style toggles with class toggles**

Use these patterns:
- `el.toggleClass('is-hidden', true/false)` or equivalent helper
- `setCssProps` only when an actual CSS property must vary dynamically
- state readers like `contextRowVisibility.ts` should check classes or data attributes, not `style.display`

Focus first on:
- `src/shared/modals/InstructionConfirmModal.ts`
- `src/features/chat/ui/StatusPanel.ts`
- `src/features/chat/ClaudianView.ts`
- `src/features/chat/controllers/contextRowVisibility.ts`

**Step 4: Replace `innerHTML` / `outerHTML` uses**

Apply these rules:
- for text fragments, construct elements with `createSpan`, `setText`, and DOM append methods
- for icons, prefer `setIcon` or prebuilt SVG nodes over string HTML injection
- for rich diff content, sanitize or build DOM fragments explicitly instead of injecting raw HTML

Hotspots:
- `src/features/chat/rendering/MessageRenderer.ts`
- `src/features/chat/ui/InputToolbar.ts`
- `src/features/inline-edit/ui/InlineEditModal.ts`
- `src/shared/mention/MentionDropdownController.ts`
- `src/features/chat/rendering/ToolCallRenderer.ts`

**Step 5: Verify touched UI flows**

Run: `npm run test -- tests/unit/features/chat/rendering/MessageRenderer.test.ts tests/unit/features/chat/rendering/ToolCallRenderer.test.ts tests/unit/features/inline-edit/ui/InlineEditModal.test.ts`
Expected: PASS

Run: `npm run build && npm run typecheck`
Expected: build succeeds and UI code compiles cleanly

**Step 6: Commit checkpoint**

```bash
git add src/shared/modals/InstructionConfirmModal.ts src/features/chat/rendering/MessageRenderer.ts src/features/chat/ui/InputToolbar.ts src/features/chat/ui/StatusPanel.ts src/features/chat/ClaudianView.ts src/features/chat/controllers/BrowserSelectionController.ts src/features/chat/controllers/SelectionController.ts src/features/chat/controllers/CanvasSelectionController.ts src/features/chat/rendering/ToolCallRenderer.ts src/features/inline-edit/ui/InlineEditModal.ts tests/unit/features/chat/rendering/MessageRenderer.test.ts tests/unit/features/inline-edit/ui/InlineEditModal.test.ts
git commit -m "refactor: replace inline DOM styling patterns"
```

### Task 6: Migrate storage, permissions, MCP, and transport deprecations

**Files:**
- Modify: `src/core/storage/CCSettingsStorage.ts`
- Modify: `src/core/storage/StorageService.ts`
- Modify: `src/core/storage/McpStorage.ts`
- Modify: `src/core/mcp/McpTester.ts`
- Modify: `src/core/types/settings.ts`
- Modify: `src/core/types/index.ts`
- Test: `tests/unit/core/mcp/McpTester.test.ts`
- Test: `tests/unit/utils/mcp.test.ts`

**Step 1: Add or update MCP transport coverage**

Ensure tests cover current MCP transport selection rules so replacing deprecated `SSEClientTransport` does not silently regress compatibility.

**Step 2: Run focused MCP tests first**

Run: `npm run test -- tests/unit/core/mcp/McpTester.test.ts tests/unit/utils/mcp.test.ts`
Expected: establish baseline before transport edits

**Step 3: Replace deprecated storage and permission types**

Use current canonical names in active code:
- `CCPermissions` instead of `LegacyPermission` for normal runtime flows
- `HostnameCliPaths` instead of `PlatformCliPaths`
- extension-oriented plugin types instead of deprecated aliases

Keep migration parsing only where older persisted data still needs to load.

**Step 4: Replace deprecated MCP transport usage**

In `src/core/mcp/McpTester.ts`, prefer `StreamableHTTPClientTransport` when possible while preserving compatibility behavior where legacy SSE must still be supported.

**Step 5: Verify**

Run: `npm run test -- tests/unit/core/mcp/McpTester.test.ts tests/unit/utils/mcp.test.ts tests/unit/utils/env.test.ts`
Expected: PASS

Run: `npm run typecheck && npm run lint -- --format unix`
Expected: deprecation-related type warnings reduced in touched files

**Step 6: Commit checkpoint**

```bash
git add src/core/storage/CCSettingsStorage.ts src/core/storage/StorageService.ts src/core/storage/McpStorage.ts src/core/mcp/McpTester.ts src/core/types/settings.ts src/core/types/index.ts tests/unit/core/mcp/McpTester.test.ts tests/unit/utils/mcp.test.ts
git commit -m "refactor: update storage and MCP compatibility"
```

### Task 7: Normalize sentence case and UI wording

**Files:**
- Modify: `src/features/chat/ClaudianView.ts`
- Modify: `src/features/chat/rendering/MessageRenderer.ts`
- Modify: `src/features/chat/ui/InputToolbar.ts`
- Modify: `src/features/chat/ui/StatusPanel.ts`
- Modify: `src/features/inline-edit/ui/InlineEditModal.ts`
- Modify: `src/features/settings/ClaudianSettings.ts`
- Modify: `src/features/settings/ui/McpServerModal.ts`
- Modify: `src/features/settings/ui/PluginSettingsManager.ts`
- Modify: `src/features/settings/ui/SlashCommandSettings.ts`
- Modify: `src/shared/modals/InstructionConfirmModal.ts`

**Step 1: Sweep user-visible strings only**

Change labels like title case or inconsistent casing to sentence case.

Examples to normalize:
- `Add Custom Instruction` -> `Add custom instruction`
- `Project Plugins` -> `Project plugins`
- `User Plugins` -> `User plugins`
- `Plugin list refreshed` and similar notices should also follow sentence case

**Step 2: Preserve stable nouns and brand names**

Do not change proper nouns like `Gemini CLI`, `Geminese`, `MCP`, or exact command names.

**Step 3: Verify visually meaningful tests and build**

Run: `npm run test -- tests/unit/features/chat/rendering/MessageRenderer.test.ts tests/unit/features/settings/keyboardNavigation.test.ts`
Expected: PASS

Run: `npm run build && npm run lint -- --format unix`
Expected: no regressions from text-only changes

**Step 4: Commit checkpoint**

```bash
git add src/features/chat/ClaudianView.ts src/features/chat/rendering/MessageRenderer.ts src/features/chat/ui/InputToolbar.ts src/features/chat/ui/StatusPanel.ts src/features/inline-edit/ui/InlineEditModal.ts src/features/settings/ClaudianSettings.ts src/features/settings/ui/McpServerModal.ts src/features/settings/ui/PluginSettingsManager.ts src/features/settings/ui/SlashCommandSettings.ts src/shared/modals/InstructionConfirmModal.ts
git commit -m "style: normalize UI text casing"
```

### Task 8: Clean directive comments, run full verification, and prepare PR update

**Files:**
- Modify: `src/main.ts`
- Modify: `src/utils/path.ts`
- Modify: any touched `src/**/*.ts` file still carrying review-hit directive comments
- Test: `tests/unit/versionConsistency.test.ts`

**Step 1: Remove or justify remaining directives**

For every remaining runtime `eslint-disable` or `eslint-disable-next-line` comment:
- delete it if no longer needed
- otherwise add a short reason after `--`
- do not keep any directive that disables `@typescript-eslint/no-explicit-any`

**Step 2: Run the full repo verification set**

Run: `npm run lint -- --format unix`
Expected: either clean or reduced to intentionally deferred non-review issues

Run: `npm run typecheck`
Expected: PASS

Run: `npm run test`
Expected: PASS

Run: `npm run build`
Expected: PASS

**Step 3: Re-read the original review comment and diff**

Confirm each required rule family has been addressed in code, not just indirectly hidden.

**Step 4: Commit final remediation batch**

```bash
git add src/main.ts src/utils/path.ts src tests
git commit -m "fix: address obsidian review bot findings"
```

**Step 5: Push and update the submission**

Run: `git push`
Expected: plugin repo branch updates successfully

Then add a short PR comment in `obsidianmd/obsidian-releases` summarizing that required findings were addressed and the PR is ready for another validation pass.

## High-Risk Files

Treat these files in especially small increments because they anchor the app shell, state graph, or core runtime behavior:
- `src/main.ts`
- `src/core/agent/ClaudianService.ts`
- `src/features/chat/ClaudianView.ts`
- `src/features/chat/controllers/InputController.ts`
- `src/features/chat/controllers/StreamController.ts`
- `src/features/chat/rendering/MessageRenderer.ts`
- `src/features/chat/tabs/Tab.ts`
- `src/core/storage/StorageService.ts`

## Verification Ladder

Use this verification ladder after every task, from narrowest to broadest:

1. touched-file unit tests
2. adjacent integration tests when a controller, storage layer, or service changes
3. `npm run typecheck`
4. `npm run lint -- --format unix`
5. `npm run build`
6. final full `npm run test`

## Notes for Execution

- Keep using the existing `obsidian-releases` PR; do not open a new submission PR.
- Prefer reducing active runtime use of deprecated aliases over deleting migration code too early.
- If ObsidianReviewBot reports a false positive after the sweep, answer with a narrow justification tied to the exact file and line.
- Do not bundle unrelated feature changes into this branch.

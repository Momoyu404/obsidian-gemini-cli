---
phase: 01-ui-cleanup
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/features/chat/tabs/Tab.ts, src/features/chat/ui/InputToolbar.ts]
autonomous: true
requirements: [UI-01]
must_haves:
  truths:
    - "User no longer sees the text 'Context' above attached files"
    - "User no longer sees the text 'Thinking:' in the bottom toolbar"
    - "Toolbar and file chips layout remains unbroken after text removal"
  artifacts:
    - path: "src/features/chat/tabs/Tab.ts"
      provides: "Updated context card UI without header"
    - path: "src/features/chat/ui/InputToolbar.ts"
      provides: "Updated thinking budget selector without label"
  key_links: []
---

<objective>
Remove redundant text labels from the chat UI.

Purpose: Make the UI cleaner and save vertical space by removing "Context" and "Thinking:" labels.
Output: Updated UI rendering logic in Tab and InputToolbar components.
</objective>

<execution_context>
@/Users/lvguangxing/.config/opencode/get-shit-done/workflows/execute-plan.md
@/Users/lvguangxing/.config/opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove Context header from Tab.ts</name>
  <files>src/features/chat/tabs/Tab.ts</files>
  <action>
    Locate the section creating the `geminese-context-card-header` in `src/features/chat/tabs/Tab.ts` (around lines 197-198) and remove it entirely. This deletes the "Context" text header from the file attachments area.
  </action>
  <verify>
    <automated>grep -q "geminese-context-card-header" src/features/chat/tabs/Tab.ts && exit 1 || exit 0</automated>
  </verify>
  <done>The Context text header is no longer rendered above attached files.</done>
</task>

<task type="auto">
  <name>Task 2: Remove Thinking label from InputToolbar.ts</name>
  <files>src/features/chat/ui/InputToolbar.ts</files>
  <action>
    Locate the section creating the `geminese-thinking-label-text` in `src/features/chat/ui/InputToolbar.ts` (around lines 151-152) and remove it entirely. This deletes the "Thinking:" prefix from the thinking budget selector.
  </action>
  <verify>
    <automated>grep -q "geminese-thinking-label-text" src/features/chat/ui/InputToolbar.ts && exit 1 || exit 0</automated>
  </verify>
  <done>The Thinking: label is no longer rendered in the toolbar.</done>
</task>

</tasks>

<verification>
Check both files to ensure the text elements are removed without breaking the surrounding component structure.
</verification>

<success_criteria>
- The UI no longer displays "Context" and "Thinking:".
- The build succeeds without TypeScript errors.
</success_criteria>

<output>
After completion, create `.planning/phases/01-ui-cleanup/01-ui-cleanup-01-SUMMARY.md`
</output>

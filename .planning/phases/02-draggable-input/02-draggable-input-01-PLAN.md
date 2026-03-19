---
phase: 02-draggable-input
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/features/chat/tabs/Tab.ts, src/features/chat/tabs/types.ts, styles.css]
autonomous: true
requirements: [UI-02]
must_haves:
  truths:
    - "User sees a drag handle at the top edge of the chat input wrapper"
    - "User can click and drag the handle vertically to resize the input area"
    - "The input area's height updates smoothly during dragging"
    - "The resized height is constrained by a minimum height and maximum height (e.g., up to view height)"
    - "Content-based auto-resize gracefully yields to or works alongside manual drag resizing"
  artifacts:
    - path: "src/features/chat/tabs/Tab.ts"
      provides: "Drag handle DOM element and pointer event listeners"
    - path: "src/features/chat/tabs/types.ts"
      provides: "New element reference for dragHandleEl"
    - path: "styles.css"
      provides: "Cursor and positioning styles for the drag handle"
  key_links:
    - from: "src/features/chat/tabs/Tab.ts"
      to: "inputWrapper styles"
      via: "inline height manipulation on drag"
---

<objective>
Make the chat input dialog resizable by adding a top-edge drag handle.

Purpose: To allow users to manually expand the chat input box for a better view of long prompts, enhancing UX.
Output: A draggable edge above the input wrapper that updates its height, along with necessary CSS for the resize cursor.
</objective>

<execution_context>
@/Users/lvguangxing/.config/opencode/get-shit-done/workflows/execute-plan.md
@/Users/lvguangxing/.config/opencode/get-shit-done/templates/summary.md
</execution_context>

<context>
The current input wrapper uses `flex-direction: column` with auto-resizing based on text content via `autoResizeTextarea`.
We need to add a drag handle (e.g., `geminese-input-drag-handle`) to the top of `inputWrapper`, capture pointer events (pointerdown, pointermove, pointerup), and manually set `height` or `min-height` on `inputWrapper` based on mouse movement.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add drag handle DOM and types</name>
  <files>src/features/chat/tabs/types.ts, src/features/chat/tabs/Tab.ts</files>
  <action>
    1. In `src/features/chat/tabs/types.ts`, add `dragHandleEl: HTMLElement;` to the `TabDOMElements` interface.
    2. In `src/features/chat/tabs/Tab.ts` -> `buildTabDOM`, create a new div `dragHandleEl` with class `geminese-input-drag-handle` and append it as the first child of `inputWrapper`.
    3. Return `dragHandleEl` in the `TabDOMElements` return object.
  </action>
  <verify>
    <automated>grep -q "dragHandleEl: HTMLElement;" src/features/chat/tabs/types.ts && exit 0 || exit 1</automated>
  </verify>
  <done>The drag handle element is successfully rendered into the DOM hierarchy.</done>
</task>

<task type="auto">
  <name>Task 2: Implement pointer drag logic</name>
  <files>src/features/chat/tabs/Tab.ts</files>
  <action>
    In `src/features/chat/tabs/Tab.ts`, add a function `initializeDragResize(tab: TabData)` and call it at the end of `buildTabDOM` or `initializeTabUI` (preferably in `initializeTabUI` where other wiring happens).
    Logic:
    - On `pointerdown` on `dragHandleEl`:
      - `e.preventDefault()`
      - Capture start Y position (`e.clientY`) and current `inputWrapper.offsetHeight`.
      - Attach `pointermove` and `pointerup` listeners to `window` (or `document`).
      - Call `setPointerCapture(e.pointerId)` on the handle (optional but good).
    - On `pointermove`:
      - Calculate `deltaY = startY - e.clientY`.
      - Calculate new height: `newHeight = startHeight + deltaY`.
      - Constrain newHeight between a minimum (e.g., `140px`) and maximum (e.g., `80%` of window height).
      - Apply height via `tab.dom.inputWrapper.style.height = ${newHeight}px;`
      - To prevent auto-resize from conflicting, we might need to set a flag or let manual height take precedence. (Setting an explicit `height` on wrapper overrides `min-height` if flex allows, but text area needs to flex-grow). Let's set `height` on `inputWrapper`.
    - On `pointerup`:
      - Remove window listeners.
      - Release pointer capture.
    - Ensure cleanups are added to `tab.dom.eventCleanups`.
  </action>
  <verify>
    <automated>grep -q "pointerdown" src/features/chat/tabs/Tab.ts && exit 0 || exit 1</automated>
  </verify>
  <done>Pointer events correctly calculate and apply new height to the input wrapper.</done>
</task>

<task type="auto">
  <name>Task 3: Add CSS for drag handle</name>
  <files>styles.css</files>
  <action>
    In `styles.css`, add styles for `.geminese-input-drag-handle`:
    - `position: absolute; top: -5px; left: 0; right: 0; height: 10px;` (to give a comfortable grab area bleeding slightly out of the wrapper).
    - `cursor: ns-resize;`
    - `z-index: 10;`
    Ensure `.geminese-input-wrapper` continues to work cleanly when its `height` is set explicitly via inline styles.
  </action>
  <verify>
    <automated>grep -q "geminese-input-drag-handle" styles.css && exit 0 || exit 1</automated>
  </verify>
  <done>The drag handle has correct cursor and positioning CSS.</done>
</task>

</tasks>

<verification>
Check build success and ensure the pointer event logic cleanly attaches and detaches to avoid memory leaks.
</verification>

<success_criteria>
- The top edge of the input wrapper shows an `ns-resize` cursor.
- Dragging updates the input wrapper height.
</success_criteria>

<output>
After completion, create `.planning/phases/02-draggable-input/02-draggable-input-01-SUMMARY.md`
</output>

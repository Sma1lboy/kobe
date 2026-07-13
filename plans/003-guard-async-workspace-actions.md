# 003 — Guard async workspace actions by task identity

- **Status**: TODO
- **Commit**: 81969596
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 2–3 files, ~70 lines

## Problem

`packages/kobe/src/tui-react/workspace/host.tsx:164` combines task A's captured worktree with the latest engine sink after an await:

```ts
const wt = worktree
const prompt = await buildPRPrompt(wt)
sendToEngineFn.current(prompt)
```

`openFileInEditor()` at `host.tsx:194` has the same shape. If selection changes during resolution, task A data is sent into task B's mounted `TerminalTabs` imperative handle.

## Target

Snapshot both the task identity and sink, then reject a stale continuation:

```ts
const taskId = selectedTask?.id
const wt = worktree
const send = sendToEngineFn.current
if (!taskId || !wt || !send) return
const prompt = await buildPRPrompt(wt)
if (selectedTaskIdRef.current !== taskId || sendToEngineFn.current !== send) return
send(prompt)
```

Apply the same identity/sink check to editor resolution before opening the editor tab or changing focus.

## Repo conventions to follow

- Use the existing `useLatest` pattern for latest selected task identity.
- Keep file opening semantics: interactive editor opens do pull focus; read-only diff opens do not.
- Extract a small framework-free `isCurrentWorkspaceAction` helper only if it makes race tests independent of OpenTUI.

## Steps

1. Add a latest selected-task identity ref in `WorkspaceRoot`.
2. Snapshot identity, worktree, and imperative sink before each await.
3. Abort silently if identity or sink changed before continuation.
4. Add deferred-promise tests for PR prompt and editor resolution: start on A, select B, resolve A, assert B receives nothing.
5. Add a patch changeset.

## Boundaries

- Do not cancel the underlying git/editor lookup; only suppress stale delivery.
- Do not change focus policy or command construction.
- Do not broaden to unrelated async dialogs in this plan.

## Verification

- Focused race tests with controllable promises.
- `bun run lint && bun run typecheck`
- Manual: trigger PR/editor action, switch tasks before completion, confirm the new task is untouched.
- Done when stale continuations cannot call a newly-mounted task sink.

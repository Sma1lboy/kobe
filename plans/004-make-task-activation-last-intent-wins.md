# 004 — Make task activation last-intent-wins

- **Status**: TODO
- **Commit**: 81969596
- **Severity**: HIGH
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 3 files, ~60 lines

## Problem

`packages/kobe/src/tui-react/workspace/use-task-selection.ts:72` awaits worktree materialization with no request identity. The pure helper always commits after completion:

```ts
await opts.ensureWorktree(id)
opts.selectTask(id)
opts.focusWorkspace()
```

If A starts first but resolves after B, A steals selection and focus from the user's newer intent.

## Target

Give the helper a commit guard and gate immediately before selection:

```ts
type ActivateWorkspaceTaskOptions = {
  // existing fields
  isCurrent?: () => boolean
}

if (opts.isCurrent?.() === false) return false
opts.selectTask(id)
opts.focusWorkspace()
```

The React hook owns a monotonic generation:

```ts
const activationGeneration = useRef(0)
const generation = ++activationGeneration.current
await activateWorkspaceTask({
  // existing deps
  isCurrent: () => activationGeneration.current === generation,
}, id)
```

## Repo conventions to follow

- Keep activation policy testable in `use-task-selection.ts`.
- Extend `packages/kobe/test/tui/workspace-task-selection.test.ts` with deferred A/B promises.
- Last user intent wins; failed older requests must not overwrite newer success or focus.

## Steps

1. Add optional `isCurrent` to the pure activation options.
2. Check it after any await and before all UI side effects.
3. Add generation ownership in `useWorkspaceSelection`.
4. Test A-slow/B-fast and A-fails-after-B cases.
5. Add a patch changeset, shared with other correctness plans if desired.

## Boundaries

- Do not cancel `ensureWorktree`; it is idempotent and may complete in the background.
- Preserve direct fast-path activation for already-materialized tasks.
- Preserve error reporting for the current request.

## Verification

- `bun test packages/kobe/test/tui/workspace-task-selection.test.ts`
- `bun --filter @sma1lboy/kobe typecheck`
- Rapidly activate two tasks; the second remains selected after the first finishes.
- Done when every stale activation returns false without selection/focus side effects.

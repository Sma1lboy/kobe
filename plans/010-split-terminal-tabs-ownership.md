# 010 — Split TerminalTabs ownership from rendering

- **Status**: DONE
- **Resolution**: Landed via the concurrent workspace stream: the process-global tab store, activation event bus, and `forgetTaskTabs` moved to framework-free `terminal-tabs-shared.ts`, and `TerminalTabs.tsx` is back at the 500-line cap.
- **Commit**: 81969596
- **Severity**: MEDIUM
- **Category**: Maintainability & architecture
- **Rule**: react-doctor/no-giant-component
- **Estimated scope**: 4–6 files, behavior-preserving extraction

## Problem

`packages/kobe/src/tui-react/workspace/TerminalTabs.tsx:175` is a 364-line component in a 538-line file. It owns process-global tab state/events, persistence, spawn policy, hydration, naming, PTY exit recovery, dialogs, keybindings, notifications, and JSX. These are different lifecycle contracts with one hot-path test seam, and the file exceeds the repository's ~500-line cap.

## Target

Extract existing behavior, not a new architecture:

1. `terminal-tabs-session-store.ts` owns `tabsByTask`, pending activation, listeners, `activeTabIdFor`, `requestTabActivation`, and `forgetTaskTabs`.
2. `use-terminal-tab-actions.ts` owns close/add/select/rename/vendor action wiring that reads synchronous `stateRef`.
3. `TerminalTabs.tsx` composes hooks and renders `TabStrip`, `Terminal`, split/content views, and dialogs, staying under 500 lines.

The public exports remain re-exported from the current module if callers require compatibility.

## Repo conventions to follow

- Framework-free observable/process state must not depend on React.
- Preserve synchronous `stateRef` updates documented in the file header.
- Existing extraction examples: `use-tab-lifecycle.ts`, `use-tab-handoffs.ts`, and `terminal-tabs-core.ts`.
- Do not replace the deliberate module-level per-process store with React Context.

## Steps

1. Move the session store/event bus verbatim into a framework-free module and re-export compatibility symbols.
2. Add direct tests for activation consumption, listener cleanup, task deletion, and cross-host reset behavior.
3. Extract action wiring only where inputs/outputs are already explicit; do not create a catch-all controller object.
4. Keep `TerminalTabs.tsx` below 500 lines and preserve comments beside the contracts they describe.
5. Run all terminal tab persistence, core, render, attention, and behavior tests.

## Boundaries

- Behavior-preserving only; no new tab features or chords.
- No dependency additions.
- Do not change PTY ownership, persistence keys, session IDs, or task deletion semantics.
- Stop if extraction requires a public contract change; surface it separately.

## Verification

- `bun test packages/kobe/test/tui-react/terminal-tabs-persist.test.ts packages/kobe/test/tui/terminal-tabs-core.test.ts`
- All render tests for tab strip, terminal split, and attention.
- `bun run lint && bun run typecheck && bun --filter @sma1lboy/kobe test`
- Done when behavior remains green, direct store tests exist, and every touched source file is under the repository cap.

# Agent Hooks and Sidebar Runtime Status Design

**Date:** 2026-07-14

## Goal

Restore the global engine-hook installation lost during the PureTUI-only migration, and make the Tasks sidebar's leading status glyph describe runtime activity only. Persisted task lifecycle status remains available to the board and automation but must not affect the sidebar row's glyph, tone, spinner, or fallback subtitle.

## Root Cause

The PureTUI-only migration removed `tui/direct.ts`, including the only call to `ensureGlobalKobeHooks()`. The installer, engine adapters, hook command, daemon event reducer, and client subscription all remain intact, but no current startup path invokes the installer.

The sidebar view currently combines two independent state owners. Transient engine activity from hooks has priority, while persisted `task.status` supplies fallback glyphs, colors, loading state, and labels. This makes the agent-status position also display board lifecycle state.

## Design

### Hook Installation

`startTui()` will invoke and await `ensureGlobalKobeHooks()` before starting the Workspace Host.

The installer remains best-effort and idempotent. It merges Kobe-owned activity and worktree-watch hook groups into each supported engine's global settings file, preserves unrelated user hooks and settings, and removes Kobe's obsolete Claude `WorktreeCreate` provider hook. Awaiting the local file merge ensures the first engine session cannot start before its hooks are present; installer failures still do not block launch.

### Sidebar Status Ownership

The leading task glyph and its tone will derive only from:

- transient engine activity published by the daemon (`running`, `turn_complete`, `rate_limited`, `permission_needed`, or `error`);
- an in-flight daemon task job such as worktree materialization; or
- the explicit no-tracking affordance for a custom engine without telemetry.

Persisted `task.status` values (`backlog`, `in_progress`, `in_review`, `done`, `canceled`, and `error`) will not affect sidebar loading, glyphs, tones, or subtitles. With no runtime signal, a normal task has no leading status glyph and uses its branch as the subtitle, or a neutral dash when no branch is available.

Project-row behavior remains unchanged. The right-side PR checks chip also remains unchanged because it represents CI checks, not board lifecycle or agent activity.

## Data Flow

Engine hooks run `kobe hook <verb>`. The hook command reports a normalized event to the running daemon using task/tab identity inherited from the Hosted PTY, with cwd matching as fallback. The daemon reduces the event into transient task activity and broadcasts it. `RemoteOrchestrator` stores that activity in memory, and the sidebar projects it into the runtime-only glyph.

Task lifecycle status continues through the existing persisted task snapshot for board, API, grouping, archive, and automation consumers. The sidebar view simply stops projecting it into runtime chrome.

## Error Handling

Hook installation remains non-fatal: malformed or unwritable engine settings must not prevent Kobe from opening. Existing merge logic continues to preserve user-owned configuration and skip no-op writes.

If no activity event is available, the sidebar shows a neutral idle row instead of guessing activity from lifecycle state.

## Testing

1. Add a TUI-startup regression test that uses temporary engine settings paths and verifies startup installs real Kobe activity and worktree-watch hooks before the Workspace Host starts.
2. Add a sidebar projection test proving all six task lifecycle values produce the same visible runtime state when every other input is identical.
3. Keep existing activity-pipeline tests as protection for running, completion, permission, rate-limit, error, custom-engine, materialization, and viewed-terminal behavior.
4. Run the focused TUI and activity tests, type checking, and the repository's relevant broad verification before publishing the branch.

## Non-Goals

- Removing or redesigning `TaskStatus`.
- Changing board, issue, archive, API, or automation semantics.
- Removing or changing the PR checks chip.
- Redesigning hook event mappings or daemon activity transport.

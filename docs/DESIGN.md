# kobe design

## Mission

Give one developer a terminal-native control plane for many parallel AI coding
tasks. Conductor is the layout reference—task rail, workspace, files/diffs,
status—but kobe is local-first and runs the real interactive engine CLIs.

## Principles

### 1. Engine CLIs are products

Claude Code, Codex, Copilot CLI, and custom engines own authentication,
prompts, approvals, rendering, and model execution. Kobe embeds their real
interactive interfaces in Hosted PTYs; it does not re-render model streams or
call raw model APIs.

Engine adapters remain the one pluggability seam for identity, launch argv,
capabilities, model/effort catalogs, history, completion markers, and telemetry
normalization. Neutral layers never hard-code vendor UI data.

### 2. The product unit is a Task

```text
Task = git worktree + hosted engine sessions + branch
```

A Task owns one Worktree and may own several Terminal Tabs. Archive is
non-destructive but stops live hosted sessions. Delete removes the Task and
Worktree after explicit confirmation; the branch remains unless a separate git
operation removes it.

### 3. Process ownership is explicit

- The Daemon owns Task/Worktree control-plane state.
- The standalone PTY Host owns interactive child lifetime and output buffers.
- The Workspace Host attaches and renders; closing it detaches only.

This separation makes engine sessions survive TUI exits and daemon restarts.
There is one session backend and one launch behavior.

### 4. State stays with its natural owner

Engine conversation history stays in engine-owned files. Git state stays in
git. Kobe persists only its Task index and UI/settings manifest. Do not copy
derivable engine or repository state into a second database.

### 5. Terminal-native is a feature

Kobe composes with shell tools, SSH, `git`, `gh`, and `jq`. It accepts the
terminal's visual constraints. Fundamentally graphical work should open an
external application rather than grow a poor terminal imitation.

### 6. Reuse proven primitives

Use the locked stack: TypeScript, Bun, React 19, `@opentui/core`, and
`@opentui/react`. Study the read-only `refs/` projects before replacing a
proven parser, terminal primitive, history reader, or interaction pattern.

## UI rules

- Yoga flexbox first. Ratios use flex growth, not hardcoded pixel-like widths.
- The live Binding Stack is focus- and modal-aware. The embedded engine gets
  every unclaimed key.
- React components render and wire events; reusable policy/state lives in
  framework-free `src/tui/**` modules.
- User-visible engine identity and capability data comes from the engine
  registry.

## Performance rules

Render paths never run synchronous subprocesses. Recurring repository reads use
bounded async pollers with in-flight dedupe, timeout, and backoff. One-shot UI
actions use async subprocesses.

Long-lived lists preserve row identity: suppress no-op updates and reconcile
unchanged row objects so the renderer does not churn native objects on every
poll or filesystem event.

CI enforces the sync-subprocess rule, operation-count budgets, touched-file
coverage, and the roughly 500-line source-file cap.

## Failure behavior

- A missing Daemon is surfaced or restarted at the composition boundary.
- A missing PTY Host is started for session-creating operations.
- A stale canonical session is recovered explicitly; never create a second
  implicit engine key.
- Task teardown is idempotent when the PTY Host is absent or already stopped.
- UI polling failures keep the last good value instead of blocking or crashing.

## Historical decisions

Superseded design records under `docs/design/` and historical CHANGELOG entries
may describe older architectures. They are context, not current implementation
instructions. Current ownership and vocabulary live in
[CONTEXT.md](../CONTEXT.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

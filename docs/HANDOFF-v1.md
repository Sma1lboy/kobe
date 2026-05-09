# Handoff — kobe (codename)

> Written 2026-05-08 at the end of a prior Claude Code session.
> The user (Jackson) is opening a fresh window inside this directory and wants you to pick up here.

---

## Mission

Build a **TUI** that mimics [Conductor](https://conductor.build)'s UX: a multi-task, multi-repo AI agent orchestration dashboard.

Concretely the layout (from a screenshot the user shared) has these panes:

```
┌──────────────────────────────────────────────────────────────────┐
│ [< >] Sma1lboy/missoula-v1 > origin/main      [/Dockerfile][PR]  │  ← top bar
├──────────────┬─────────────────────────────────┬─────────────────┤
│ History      │ File preview tabs               │ All files       │
│              │  Dockerfile  Implement-X  …     │  Changes        │
│ All repos    │                                 │  Checks         │
│              │  ┌──────────────────────────┐   │                 │
│ Done       0 │  │  (file/diff content)     │   │  .prettierrc    │
│ In review  0 │  │                          │   │  bun.lock       │
│ In progress9 │  │                          │   │  Dockerfile     │
│  ├ task A    │  │                          │   │  index.html     │
│  ├ task B    │  │                          │   │  package.json   │
│  └ …         │  └──────────────────────────┘   │  …              │
│ Backlog    0 │                                 ├─────────────────┤
│ Canceled   0 │                                 │ Setup Spotlight │
│              │                                 │ Terminal        │
│              │                                 │  $ _            │
│ + Add repo   ├─────────────────────────────────┤                 │
│              │ Sending to: <task>              │                 │
│              │ [Ask to make changes …]         │                 │
│              │  Opus 4.6  Thinking      ⮐      │                 │
└──────────────┴─────────────────────────────────┴─────────────────┘
```

Five regions: history sidebar (tasks grouped by status), file/diff preview with tabs, file tree (All/Changes/Checks), terminal, chat composer. Each "task" = a workspace = a git worktree + a Claude Code session + branch + checks.

## Hard constraints from the user (stated last session, do not re-litigate)

1. **TUI only**, not a desktop app. (`opcode` ref is Tauri/React — for Claude Code integration patterns only, not UI.)
2. **Backend is Claude Code, not Claude API directly.** Reasons:
   - The user "essentially depends on Claude Code." They don't want to rebuild streaming, message history, auth, or vendor adapters.
   - Use Claude Code SDK (`@anthropic-ai/claude-agent-sdk` for TS) **or** spawn `claude` CLI with stream-json. Pick one.
3. **Message history reads from Claude Code's own session files** at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. No separate session DB.
4. **No vendor adapters.** No `@ai-sdk/*`, no MCP plumbing, no auth flows, no provider config. Anything not on the path of "TUI ↔ Claude Code" doesn't belong.
5. The `opencode` fork (the user's `Sma1lboy/opencode` with a `/diff` dialog added) is **not the base** for this project. It's a reference for TUI patterns only. We are not stripping opencode down — we are building greenfield.

## Open decisions (the next session needs to surface these to the user)

These were not chosen last session. Don't pick unilaterally — ask the user.

1. **TUI framework / language.** Three plausible paths:
   - **TypeScript + `@opentui/core` + Solid.js** — same stack as opencode. Lets us copy components (`scrollbox`, `box`, `text`, dialog system) wholesale. Pairs naturally with `@anthropic-ai/claude-agent-sdk`.
   - **Go + Bubble Tea + Lipgloss** — same stack as agent-deck. Mature, polished. Would shell out to `claude` CLI for AI.
   - **Rust + Ratatui** — most performant, biggest learning curve, no special advantage here.
   - User has not chosen. The opentui/Solid path has the lowest activation energy because most visual components in the screenshot are 1:1 to opencode's existing widgets.

2. **Claude Code integration mechanism.** SDK vs subprocess. Both work. SDK is cleaner if we go TS; subprocess works in any language.

3. **Multi-task concurrency model.** Each task as:
   - Its own git worktree?
   - Its own Claude Code session (separate JSONL)?
   - Run sequentially (one at a time) or actually concurrent?
   The screenshot implies concurrent (9 tasks "In progress").

4. **Persistence of task metadata.** Claude Code stores session messages, but doesn't know about "task = branch = worktree" semantics. We need our own light store (a JSON file or SQLite) for: task title, repo, branch, status, mapped session-id, mapped worktree path. Keep it minimal.

5. **Repo naming.** `kobe` is a temporary city codename (matches the user's `Sma1lboy/<city>-v1` branch convention; not colliding with the `osaka` opencode theme). Rename when the product has a real name.

## Reference repos (in `refs/`, gitignored, **read-only**)

| Path | Stack | Why we have it |
|---|---|---|
| `refs/opencode` (symlink → `/Users/jacksonc/i/opencode`) | TS + opentui + Solid.js | TUI architecture reference. **Look at `packages/opencode/src/cli/cmd/tui/`** — dialog system (`ui/dialog.tsx`), slash command registration (`app.tsx` `appCommands`), scrollbox/box primitives, theme system, vcs SDK calls. The user's fork has a working `/diff` dialog at `packages/opencode/src/cli/cmd/tui/component/dialog-diff.tsx` — that's a pattern for "fetch from server + render two-pane scrollable view" that we'll reuse. |
| `refs/agent-deck` (symlink → `/Users/jacksonc/i/agent-deck`) | Go + Bubble Tea + Lipgloss | TUI orchestration reference. Multi-agent dashboard. Look at how it manages per-agent state, status grouping, and TUI navigation. (The `conductor/` subdir is a Python bridge, not the UI.) |
| `refs/opcode` (fresh clone of `winfunc/opcode`) | TS + Tauri + React + Radix | Claude Code integration reference. **NOT a TUI** — desktop GUI. Look at how it: spawns/manages Claude sessions, reads JSONL history, handles streaming, manages multiple agents/sessions concurrently. Ignore its UI components. |

`opcode` is the most relevant for the **Claude Code plumbing**. `opencode` is the most relevant for **TUI rendering**. `agent-deck` is the most relevant for **multi-agent orchestration concepts**.

## What was done last session (so you don't redo it)

1. Forked `sst/opencode` → `Sma1lboy/opencode`, cloned to `/Users/jacksonc/i/opencode`. The fork has my changes:
   - `packages/opencode/src/cli/cmd/tui/component/dialog-diff.tsx` (new, ~210 lines)
   - `packages/opencode/src/cli/cmd/tui/app.tsx` (added `vcs.diff` command + import)
   - These add a `/diff` slash command that opens a two-pane workspace-diff dialog. Verified working via tmux text capture.
2. **Decision was made not to continue work on the opencode fork.** It's reference only now. The /diff feature is not being upstreamed (no PR opened). It exists if the user wants to revisit, otherwise it's frozen.
3. **Strip-down idea was abandoned.** The earlier plan to delete vendor code from opencode and wire it to Claude Code was dropped in favor of greenfield.

## Suggested next steps for the new session

Surface these to the user, then act.

1. **Decide framework** (open Q1 above). My recommendation when asked: **TS + opentui + Solid.js**, because most of the screenshot's widgets exist in opencode and we can copy them. But the user may have a preference.
2. **Use parallel `Explore` agents** to map each ref's architecture concisely:
   - opencode: TUI layout/navigation/dialog patterns
   - opcode: Claude Code session spawning, JSONL reading, streaming
   - agent-deck: multi-pane Bubble Tea layouts, per-agent state machines
3. **Sketch the task data model** with the user (5 minutes of conversation, then commit a `docs/data-model.md`).
4. **Build the smallest useful MVP first**: single task, single chat pane, history pulled from a real Claude Code JSONL file. Don't try to ship the full 5-pane layout in v0.
5. Only after MVP works, add: multi-task list, file tree pane, diff/file-preview pane, terminal pane, checks pane, PR button.

## Starter prompt the user can paste

```
I read CLAUDE.md and HANDOFF.md. Before we code, run three Explore agents in parallel:
1. refs/opencode — map the TUI layout system, dialog/slash patterns, theme system. Focus on packages/opencode/src/cli/cmd/tui/.
2. refs/opcode — map how Claude Code is spawned, how JSONL session history is read, how streaming is rendered. Skip the React UI.
3. refs/agent-deck — map the multi-agent orchestration model and Bubble Tea pane layout.
Each agent: under 250 words, paths + key types only.
Then summarize the findings and ask me about the framework choice (open Q1 in HANDOFF.md).
```

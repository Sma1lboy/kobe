# kobe — Design

> Codename. Read alongside [`../HANDOFF.md`](../HANDOFF.md) and [`../CLAUDE.md`](../CLAUDE.md).
> This document is the design philosophy + architecture sketch. It is opinionated. Things marked **OPEN** are decisions the user (Jackson) needs to make before we code.

---

## 1. Mission

A **TUI** that gives one developer the ergonomics of running **many parallel AI coding tasks** at once, with **Claude Code** as the engine.

Conductor (conductor.build) is the visual reference. We want its layout — five panes, status-grouped task sidebar, file tree, diff preview, terminal, chat composer — but in a terminal, opinionated about the engine, and pluggable about almost everything else.

This is not a Conductor clone. It is a TUI that takes Conductor's *layout grammar* as a starting point and re-derives every other choice from "what does a Claude-Code-native, terminal-first orchestrator actually want to be?"

---

## 2. Philosophy

Five principles. In tension by design — when they conflict, the earlier one wins.

### 2.1 Reuse over rebuild

If a module already exists in `refs/` and works, we copy it. We don't reimplement scrollboxes, dialog systems, theme engines, JSONL readers, or stream-json parsers.

**The job of this project is the orchestration layer**, not the primitives beneath it. opencode has spent years polishing the TUI shell. opcode has spent months polishing the Claude Code subprocess loop. We are not smarter than that.

The corollary: we accept the constraints those modules impose. If opencode's dialog stack works a certain way, we live with that way. We don't fork to "improve" it on day one.

### 2.2 Claude Code is the engine, not a vendor

We don't build a vendor abstraction. We don't ship `@ai-sdk/*` adapters. We don't have a "model picker" that supports OpenAI.

But: we *do* keep one seam — an **AI engine port** — so that if Anthropic ships a new SDK shape or someone forks Claude Code, we have one place to swap. (An earlier "Phase 2 backend swap" was dropped; see §6.2.)

Pluggability is **at one layer, not every layer**. Specifically: the boundary between `Task` and `the thing actually running the task`. Everything else (theme, panes, persistence) is hardcoded for now.

### 2.3 The terminal is a feature, not a constraint

Conductor is a desktop Electron app. We are not. That asymmetry has to mean something — otherwise we're just a worse Conductor.

What the terminal buys us:
- Lives where developers already are (tmux, ssh, VPS, server boxes).
- Composable with shell pipelines, `gh`, `git`, `jq`.
- One keystroke instead of one click.
- Free remote access (you already SSH'd in).

What we give up: visual richness, drag-drop, instant rendering of large diffs, native browser embeds. We don't fight those. If a feature is fundamentally graphical (e.g. screenshot diff of a deployed page), we **shell out**, we don't fake it.

### 2.4 One task ≈ one worktree ≈ one session

The unit of work is a **Task**. A Task is a triple:

```
Task = (git worktree, Claude Code session, branch)
```

All three are 1:1 with the Task. Killing a task removes the worktree (after confirmation), archives the session jsonl reference, and leaves the branch in place (or deletes if user opts in). This invariant simplifies a lot of UI.

### 2.5 State lives where it already lives

We don't build a session DB. Claude Code already has `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. We read those.

We *do* keep a small **task index** — title, repo, branch, worktree path, mapped session-id, status, created-at — because Claude Code doesn't know about "tasks". But this index is a manifest, not a database. Single JSON file at first, SQLite if we hit pain.

When in doubt, the source of truth is on disk in a place that already exists.

#### 2.5.1 Concretely, for the chat pane

This is the one place where "delegate to Claude Code" is most tempting to ignore — the chat is interactive and live. Resist. The minimal-state pattern (cribbed from opcode's `claude-code-session`):

- **One source-of-truth array** for chat messages, hydrated from `engine.readHistory(sessionId)` on session mount, then **appended-to** as live `EngineEvent`s arrive. No separate "inflight" buffer. No re-read on `done` — the stream events ARE what just got written to JSONL.
- **No per-session message cache.** On session switch, clear the array, re-read from disk for the new session. Reload is cheap (JSONL is local), bookkeeping a per-session cache is not.
- **`isStreaming` is derived from events**, never manually toggled. `true` between user submit and `done`/`error`. The loading indicator and the streaming cursor both key off this single flag.
- **Tool call correlation happens at render time**, by searching the messages array backward for a matching `tool_use_id`. Do NOT maintain a `Map<id, ToolStart>` alongside the message list — that's the kind of duplicated state that drifts.
- **Title generation**: opcode uses `Session ${id.slice(0,8)}` (no derived title). kobe goes lighter on UX — `title = first 40 chars of first user prompt, "…"-truncated` — derived in `Orchestrator.createTask`. Phase 2 polish may add an LLM-summary side-call.

The shape impedance — `engine.readHistory()` returns `Message` (per-message disk shape), `engine.stream()` yields `EngineEvent` (normalized live deltas) — is real and not papered over. The chat keeps both as backing data and renders them with a single row mapper. Don't synthesize fake `Message` entries from events; honest type separation beats brittle round-tripping.

The principle, in one line: **anything that can be re-derived from Claude Code's JSONL is not state we own.**

---

## 3. What kobe is / is not

| kobe is | kobe is not |
|---|---|
| A TUI orchestrator for Claude Code | A Claude Code replacement |
| A Conductor-shaped layout in the terminal | A Conductor port |
| Opinionated about the engine (Claude Code) | Vendor-neutral / model-agnostic |
| Pluggable at the engine layer | Pluggable at every layer |
| Greenfield, building on opencode shell | A fork of opencode |
| Single-developer-focused | Team collaboration software |
| Local-first | Cloud-hosted |

---

## 4. Market context

Claude-Code-era multi-task orchestration is a small, fast-moving space. Roughly:

| Product | Form | Multi-task | Engine | Notes |
|---|---|---|---|---|
| **Conductor** (conductor.build) | Desktop (Electron) | Yes | Claude Code | Our visual reference |
| **Crystal** (stravu/crystal) | Desktop | Yes | Claude Code | Closest spiritual sibling; multi-session manager |
| **Claude Squad** (smtg-ai/claude-squad) | TUI | Yes | Claude Code / Codex / Aider | Closest *terminal* analog. Worth a look. |
| **vibe-kanban** (BloopAI/vibe-kanban) | Web + Tauri | Yes | 10+ agents | **Sunsetting** — but their `crates/executors/` is the cleanest agent-abstraction reference we have. Cloned to `refs/`. |
| **opcode** (winfunc/opcode) | Desktop (Tauri) | Partial | Claude Code | Our plumbing reference |
| **opencode** (sst/opencode) | TUI | No (single session) | Multi-vendor | Our shell reference |
| **Plandex** | CLI/TUI | Partial (plans) | Multi-vendor | Plan-mode workflow |
| **Aider** | TUI | No | Multi-vendor | Single chat |
| **Goose** (Block) | Desktop | Partial | Multi-vendor | Recipe + sessions |

The interesting whitespace for kobe:

- **TUI** + **multi-task** + **Claude-Code-opinionated** is a thin slice. Claude Squad is in it. Conductor isn't (desktop). Crystal isn't (desktop). opencode isn't (single-session).
- The only direct competitor in this slice is **Claude Squad**. It uses tmux + git worktrees, similar architecture. We should read it before we ship — not to copy, but to know where it falls short.

**Action item**: skim `smtg-ai/claude-squad` README + architecture before MVP. Add as a fourth ref if useful.

---

## 5. Architecture

### 5.1 Layered

```
┌─────────────────────────────────────────────────────┐
│  TUI Shell  (opentui + Solid, copied from opencode) │
│   ├ panes: history, preview, tree, terminal, chat   │
│   ├ dialogs, command palette, theme                 │
│   └ keybindings, focus mgmt                         │
├─────────────────────────────────────────────────────┤
│  Orchestrator  (kobe core, our code)                │
│   ├ Task lifecycle (create / run / pause / archive) │
│   ├ Worktree manager (git worktree wrapper)         │
│   ├ Status grouping & sidebar tree                  │
│   ├ Task index (JSON manifest)                      │
│   └ Background workers (status polling, log drain)  │
├─────────────────────────────────────────────────────┤
│  AI Engine Port  (interface — single seam)          │
│   spawn(cwd, prompt, opts) → SessionHandle          │
│   resume(session_id) → SessionHandle                │
│   stream(handle) → AsyncIterable<Event>             │
│   readJsonl(session_id) → Message[]                 │
├─────────────────────────────────────────────────────┤
│  Engine impl  (Claude Code subprocess, ported       │
│   from opcode)                                      │
└─────────────────────────────────────────────────────┘
```

The **AI Engine Port** is the only declared interface. Above it: orchestrator owns task semantics. Below it: a Claude Code subprocess wrapper (see §6).

### 5.2 The AI Engine Port (sketch)

```ts
interface AIEngine {
  // Start a fresh session in a working directory.
  spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle>;

  // Resume an existing session by id (Claude Code's session uuid).
  resume(sessionId: string, prompt: string): Promise<SessionHandle>;

  // Stream events from a live session (stream-json line per event).
  stream(handle: SessionHandle): AsyncIterable<EngineEvent>;

  // Read historical messages from disk (JSONL on Claude Code).
  readHistory(sessionId: string): Promise<Message[]>;

  // Stop a running session (SIGTERM → SIGKILL with grace).
  stop(handle: SessionHandle): Promise<void>;
}

type EngineEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "tool.start"; name: string; input: unknown }
  | { type: "tool.result"; name: string; output: unknown }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done" }
  | { type: "error"; message: string };
```

The events are normalized — we don't leak Claude Code's stream-json shape into the orchestrator. This is the *only* place we pay an abstraction tax. It's worth it because it's the only place that ever gets swapped.

### 5.3 What the Orchestrator owns

- **Task index** (`~/.kobe/tasks.json`): array of `{id, title, repo, branch, worktreePath, sessionId, status, createdAt, updatedAt}`. Single file, write-on-mutation. SQLite migration path if it ever gets slow.
- **Worktree manager**: `git worktree add` / `remove`, mapped to task lifecycle. Aware of dirty state.
- **Status state machine**: `backlog → in_progress → in_review → done` (plus `canceled`, `error`). Driven by orchestrator events, not by polling pane content.
- **Background workers**: one per running task, draining the engine's stream into the sync store.
- **Sidebar tree**: groups tasks by status (matching Conductor's grouping); optionally by repo at a higher level when many repos are open.

---

## 6. Pluggability — and the engine port

The AI engine port is the **single** pluggability seam.

### 6.1 The shipped impl: `ClaudeCodeLocal`

Subprocess wrapper around the `claude` CLI. Algorithm ported from opcode (`refs/opcode/src-tauri/src/commands/claude.rs`):

- spawn `claude -p <prompt> --model <model> --output-format stream-json --verbose`
- BufReader → JSONL parse → typed events (this is the normalization layer)
- on session init message, capture session_id; stash in task index
- multi-session = `Map<TaskId, SessionHandle>` in memory
- stop = SIGTERM with 5s grace, then SIGKILL

**Reuses Claude Code's auth.** We assume `claude` is on PATH and authed. We do not handle login.

### 6.2 No Phase 2 backend swap (dropped 2026-05-09)

Earlier drafts of this doc carved out a `ConductorBackend implements AIEngine` for "kanban mode on top of Conductor." We've **dropped** it: kobe's value is the UI; the local subprocess works; Anthropic's own API already covers shared/cloud session needs. Re-litigate only if a concrete swap need surfaces (a forked engine with a stable HTTP API, etc.) — at which point the `AIEngine` interface is still the seam to use.

---

## 7. Module reuse strategy

Concrete inventory from the three explore agents.

### 7.1 From `refs/opencode` — TUI shell (copy wholesale)

| Module | Path | Usage in kobe |
|---|---|---|
| Dialog system | `packages/opencode/src/cli/cmd/tui/ui/dialog.tsx` | All modal flows (new task, confirm delete, etc.) |
| Diff dialog | `packages/opencode/src/cli/cmd/tui/component/dialog-diff.tsx` | File preview pane base (the user already wrote this) |
| Sidebar | `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` | History pane (status-grouped tasks) |
| Layout primitives | `packages/opencode/src/cli/cmd/tui/component/border.tsx` + opentui core | All pane composition |
| Theme system | `context/theme.tsx` + `context/theme/*.json` | Colors, plug-and-play |
| Command palette | `context/command-palette.tsx` | `cmd-k` task switcher |
| Slash commands | pattern from `app.tsx` `appCommands` | `/new`, `/diff`, `/run`, etc. |
| Sync store | `context/sync.tsx` | Reactive state for messages/tasks |
| KV store | `context/kv.tsx` | Persisted UI state (cursor, expanded groups) |

**Strategy**: lift `packages/opencode/src/cli/cmd/tui/` into our repo as a starting point, then strip what we don't need (auth, vendor adapters, opencode-specific routes). What's left is ~70% of our shell, free.

### 7.2 From `refs/opcode` — Claude Code plumbing (port to TS)

| Module | Path | Usage in kobe |
|---|---|---|
| Subprocess spawn | `src-tauri/src/commands/claude.rs` lines 919–1014 | `ClaudeCodeLocal.spawn/resume/stop` |
| stream-json parser | `src-tauri/src/commands/claude.rs` lines 1173–1327 | `stream()` event normalization |
| JSONL reader | `src-tauri/src/commands/claude.rs` lines 147–230 | `readHistory()` |
| Session registry | `src-tauri/src/process/registry.rs` | In-memory `Map<TaskId, Handle>` |
| Binary discovery | `src-tauri/src/claude_binary.rs` | Find `claude` on PATH/NVM/Homebrew |

**Strategy**: rewrite in TS (~400 LoC total). Algorithm is straightforward; Rust→TS is a clean translation. No async runtime gymnastics — Node streams + `child_process` are enough.

### 7.3 From `refs/vibe-kanban` — agent abstraction & worktree manager (interface reference)

vibe-kanban is sunsetting; the repo is a free archive of an agent-orchestration system that already shipped. Two crates are directly relevant:

| Crate | Path | Why |
|---|---|---|
| `executors` | `refs/vibe-kanban/crates/executors/` | Common interface across 10+ agents (Claude Code, Codex, Gemini, Amp, Cursor, etc.). Read this **before** finalizing our `AIEngine` port — it's the most battle-tested shape we have. |
| `worktree-manager` | `refs/vibe-kanban/crates/worktree-manager/` | Worktree creation/cleanup tied to task lifecycle. Algorithm port to TS; we don't take their multi-agent assumption. |
| `workspace-manager` | `refs/vibe-kanban/crates/workspace-manager/` | Workspace = (worktree + agent + branch) bundling. Same triple as our Task. Read for invariants. |
| `services` | `refs/vibe-kanban/crates/services/` | Background dispatch + lifecycle services. Architecture reference. |

**Strategy**: read for interface shape and invariants, port nothing. Their stack is Rust + multi-agent + web; we are TS + Claude-Code-only + TUI. The lessons are at the boundary, not the implementation.

Note: vibe-kanban supports many agents because it has to. We support one because we choose to. If our `AIEngine` port shape ends up looking like a stripped-down version of their executor interface, that's a sign we got the shape right.

### 7.4 From `refs/agent-deck` — orchestration patterns (steal ideas)

| Pattern | Why we want it |
|---|---|
| Background worker pool with channel-driven log drain | Multi-task concurrency without blocking the UI thread |
| Round-robin status polling | If we ever poll pane content, do it batched |
| Group tree + flatten + status filter | The sidebar grouping primitive (Done/In progress/Backlog) |
| SQLite + WAL persistence | Migration target when JSON manifest hits pain |
| Configurable hotkey lookup table | Remappable keys from day one |

**Strategy**: read for *concepts*, port nothing directly. agent-deck is Go and observer-shaped; kobe is TS and orchestrator-shaped. We borrow the architecture, not the code.

---

## 8. Tech stack — recommendation

**Locked**: TypeScript + `@opentui/core` + `@opentui/solid` + Solid.js + Bun (matches opencode).

Rationale: §7.1 alone justifies it — 70% of the TUI shell is reusable from opencode. The user has already written Solid+opentui code for this domain (`dialog-diff.tsx`). Subprocess management is fine in Node, JSONL parsing is trivial.

Rejected paths:
- **Go + Bubble Tea**: agent-deck-style. Loses the §7.1 reuse. Cleaner subprocess story but not where the bulk of work lives.
- **Rust + Ratatui**: maximum perf for zero benefit at this scope.
- **Split front/back (Go TUI + TS backend)**: more complexity, not less — adds IPC seam between two processes that should be one.

Decision is locked; do not re-open.

---

## 9. Phase 1 scope (full 5 panes)

The user has declared Phase 1 = all five panes (per Conductor screenshot). That said, we ship the panes in an order that lets every step be a working product:

1. **Single task, chat-only** — wire up `ClaudeCodeLocal`, render one session in a single chat pane, type prompt, stream response. End-of-step: I can converse with Claude Code through kobe.
2. **Add history sidebar** — task list (one task), status badge, cursor nav. End: I can see the task in the sidebar; same chat.
3. **Add multi-task** — `/new task` creates a worktree + branch + session. Switch tasks via sidebar. End: I have N concurrent tasks in N worktrees.
4. **Add file tree pane** — list files in active task's worktree, distinguish changed files. End: I can browse files for a task without leaving the TUI.
5. **Add diff/preview pane** — open a file from tree, see the diff vs branch base. (Reuse `dialog-diff.tsx` patterns.) End: I can review work without `git diff` in another window.
6. **Add terminal pane** — embedded terminal scoped to active task's worktree. End: I can run tests/builds without context-switching.
7. **Add status flow** — `in_progress → in_review → done`, with a checks pane showing test/build status per task. End: full Conductor parity.

Each step is mergeable and demoable. The order is layout-first → engine-correct → ergonomics → polish.

---

## 10. Data model (sketch)

```ts
type TaskStatus =
  | "backlog"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled"
  | "error";

type Task = {
  id: string;             // ulid
  title: string;          // user-supplied, free text
  repo: string;           // absolute path to source repo
  branch: string;         // e.g. sma1lboy/missoula-v1
  worktreePath: string;   // absolute path to git worktree
  sessionId: string | null; // Claude Code session uuid, set after first run
  status: TaskStatus;
  createdAt: string;      // ISO
  updatedAt: string;      // ISO
};

type TaskIndex = {
  version: 1;
  tasks: Task[];
};
```

Stored at `~/.kobe/tasks.json`. Single writer (the running kobe instance). Single reader for now.

Messages are **not** in this index. Messages live in Claude Code's JSONL files; we read them via `AIEngine.readHistory(sessionId)`.

---

## 11. Open questions (need user input)

1. ~~**Tech stack lock-in**: TS + opentui + Solid + Bun.~~ ✅ Locked 2026-05-08.
2. **City codename → real name**: when do we rename `kobe`?
3. ~~**Worktree root**~~ ✅ Resolved Wave 4: `<repo>/.claude/worktrees/<task-id>/` — per-repo, adjacent to source, shared namespace with Claude Code's own agent-spawn worktrees so users don't have two separate hidden dirs to gitignore. Do NOT move back to `.kobe/worktrees/`.
4. **Branch naming**: auto-generate (`kobe/<slug>-<id>`) or prompt? Conductor auto-generates from task title.
5. **Concurrency cap**: max simultaneous running tasks? (Claude Code rate-limits; we should respect.) Suggestion: 4 concurrent, configurable. **OPEN**.
6. **Phase 2 ref repo**: when does the Conductor-backend reference repo land in `refs/`?
7. **Should we add `refs/claude-squad`**? It's the closest TUI competitor; reading it before MVP would sharpen positioning.
8. **vibe-kanban has been added to `refs/`** (BloopAI/vibe-kanban). It's sunsetting, so it's an archive not a competitor. Use as interface reference for the AI engine port.

---

## 12. What we are not doing in Phase 1

- Cloud sync, multi-machine state.
- Team collaboration / shared task lists.
- Non-Claude-Code engines (we keep the seam, but only ship one impl).
- Conductor-as-backend (Phase 2).
- Web UI / mobile.
- CI integration beyond "shell out to `gh`".
- Plugin system for panes (every pane is hardcoded; pluggability is at the engine layer only).

If you find yourself reaching for any of the above in Phase 1, stop and ask first.

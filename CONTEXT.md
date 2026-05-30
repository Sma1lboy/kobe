# kobe — Context

Domain vocabulary for the TUI orchestrator. Every architectural conversation about kobe uses these terms verbatim; companion docs are [`docs/DESIGN.md`](./docs/DESIGN.md) (philosophy), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (file map), and [`docs/design/v2-tmux-handover.md`](./docs/design/v2-tmux-handover.md) (the v0.6 tmux-handover reshape).

> **v0.6 reshape (KOB-226).** kobe no longer drives `claude` as a stream-json subprocess and no longer renders its own chat. It is now a **task launcher + outer monitor**: each **Task** gets a **tmux Session** that runs interactive `claude` natively, and "entering" a task is a **Handover** (suspend the kobe renderer, attach the real TTY). A **ChatTab** survives the reshape — but it's now a **tmux window**, not a kobe-rendered tab. Terms from the v0.5 chat era — **AI Engine Port**, **SessionPump**, **PendingInputBroker**, **ChatSessionController**, **Bridge** — are **gone**; they're listed in the Retired section so old references resolve.

## Language

### Core nouns

**Task**:
One unit of work the user is tracking. Owns a single **Worktree** and one **tmux Session**. Persisted in `~/.kobe/tasks.json`.
_Avoid_: project, ticket, item, job.

**Worktree**:
The git worktree a **Task** is checked out into. 1:1 with **Task**. Allocated lazily — the directory only materialises on first **Handover** (`Orchestrator.ensureWorktree`).
_Avoid_: workspace (overloaded with the TUI **Pane**), checkout, branch dir.

**Session**:
A persisted Claude Code conversation on disk (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`). kobe reads these for the **Live Preview** and **Cost Dashboard**; it never writes them. Distinct from a **tmux Session** — disambiguate with the `tmux` qualifier when both are in play.
_Avoid_: history (history is the contents OF a Session, not the Session itself).

### Handover model

**tmux Session**:
The per-**Task** tmux session, named `kobe-<task-id>` on kobe's dedicated `-L kobe` socket (isolated from the user's own tmux). Holds one-or-more **ChatTab**s (tmux windows). Tagged with the **Task**'s id + **Worktree** via `@kobe_task` / `@kobe_worktree` session options so a new **ChatTab** can rebuild the same workspace. Persists across **Handover** detach AND a kobe restart. Built by `ensureSession`.
_Avoid_: just "session" (collides with the Claude **Session**), window, workspace.

**ChatTab**:
A tmux **window** inside a **Task**'s **tmux Session** — one independent `claude` conversation on the shared **Worktree**. Every ChatTab has the same four-pane layout: **Tasks pane** (left), claude, **Ops pane** (upper right), shell (lower right). `Ctrl+T` opens a new ChatTab (`kobe new-chattab` → `newChatTab`); the tmux status bar's window list is the tab switcher. The claude pane is tagged `@kobe_role=claude` so the **Live Preview** can find it regardless of tmux's by-position pane numbering.
_Avoid_: tab (unqualified), window (use "tmux window" if you must name the mechanism).

**Handover**:
Entering a **Task**: suspend the kobe renderer (releases the real TTY), `tmux attach` to the task's **tmux Session**, await exit, resume. agent-deck's `tea.Exec()` model. `Ctrl+Q` detaches back to the outer monitor. Implemented by `launchTaskTmux` (`tui/panes/terminal/fullscreen.tsx`).
_Avoid_: enter, takeover, fullscreen (these describe the mechanics, not the concept).

**Ops pane**:
The `kobe ops` subprocess that fills a **ChatTab**'s upper-right pane. Re-hosts the v0.5 FileTree (browse the **Worktree**) plus a slim file/diff viewer. Enter on a file injects `@<path>` into the claude pane via `tmux send-keys` (or opens a full-width syntax-highlighted preview window via `kobe ops --preview`). A separate OS process from the **TUI Client**, so it reads the outer app's theme via `readPersistedUiPrefs` (read-only).
_Avoid_: files pane, sidebar (that's the outer **Pane**).

**Tasks pane**:
The `kobe tasks` subprocess on the far left of a **ChatTab** — a read-only task list (reuses the outer **Sidebar**) so you can jump between **Task**s without detaching to the outer monitor. Enter `tmux switch-client`s to another **Task**'s **tmux Session**. Read-only: the **Orchestrator** / **Daemon** own writes; this pane never mutates task state. agent-deck convention.
_Avoid_: sidebar (that's the outer **Pane**), task list.

### Orchestration

**Orchestrator**:
Owns **Task** lifecycle + **Worktree** allocation + the reactive task-list snapshot the TUI subscribes to. Lives in `src/orchestrator/core.ts`. v0.6-slim: no longer touches any engine subprocess (tmux owns those) — it's task index + git + a Solid signal. TUI-free so the **Daemon** can host it headless.
_Avoid_: manager, coordinator, controller, service.

**tmux client**:
The shared low-level client for kobe's `-L kobe` server (`src/tmux/client.ts`): socket constant, spawn helpers with stderr logging, `tmuxSessionName` / `attachArgv`, session-option tagging (`setSessionOption` / `getSessionOption` — which target the bare session name because `set-option` rejects the `=` exact-match prefix), the claude-pane tag (`tagClaudePane` / `claudePaneId`), and the `base-index`-safe pane-id resolution (`listPaneIds` / `firstPaneId` / `capturePaneById`). The single place that knows how to talk to the tmux server — the **Handover**, the **Ops pane**, the **Tasks pane**, and the **Live Preview** all go through it.
_Avoid_: tmux wrapper, tmux utils.

**Session Layout**:
The pure command/layout builders for a **tmux Session** (`src/tmux/session-layout.ts`): pane percentages, shell-quoting, the keep-alive wrapper, the **Ops pane** command + its fallback. Pure (same inputs → same strings, no IO) so it's unit-tested — the regression net for the quoting/targeting bugs that used to only surface against a real server (KOB-233). `ensureSession` is the imperative applier of this policy.
_Avoid_: pane plan, blueprint.

### Daemon split

**Daemon**:
The long-running process that holds the **Orchestrator** and serves N **TUI Client**s over a Unix socket. One per user. Spawned via `kobe daemon start`. v0.6 RPC surface is task-CRUD + `subscribe` + `task.ensureWorktree` (the chat / PR / merge / plan-usage RPCs are retired).
_Avoid_: server, backend, host.

**TUI Client**:
The kobe TUI process attached to a **Daemon**. Owns view-local state (focus, selected task, pane sizes). Does not own **Task** state.
_Avoid_: frontend, UI process.

**RemoteOrchestrator**:
The **TUI Client**-side facade satisfying the slim **Orchestrator** surface by talking to the **Daemon** over the wire. Hydrates a local task mirror on attach, maintained forward via `task.snapshot` events.
_Avoid_: client, proxy, daemon-client.

### Outer monitor

**Pane**:
A top-level region in the outer TUI shell. v0.6 has two: **Sidebar** (Tasks) and **Workspace**. Owns its own keybindings and focus.
_Avoid_: panel, window, view.

**Workspace** (capital W):
The right **Pane** in the outer TUI. Shows the selected **Task**'s **Live Preview** + a **Handover** launcher, or the **Cost Dashboard**. Distinct from a **Worktree**.
_Avoid_: editor, center.

**Deprecation note**: the outer **Workspace** is transitional in the v0.6+ line. The intended direction is **inner-first**: when a target **Task** is known, launch straight into its tmux **Handover** instead of making the user stop in the outer monitor. Keep the outer **Workspace** only for flows that still lack tmux-native homes: no-Task startup, new/adopt **Task**, settings, daemon recovery, and explicit task selection.

**Live Preview**:
The **Workspace**'s read-only view of a **Task**'s claude pane, refreshed ~1s via `tmux capture-pane` (`monitor/capture-pane.ts`). Resolves the claude pane by its `@kobe_role` tag scoped to the **tmux Session**'s ACTIVE window — so the preview tracks whichever **ChatTab** the user last looked at. Empty until the task's first **Handover** creates its **tmux Session**.
_Avoid_: mirror, snapshot.

**Cost Dashboard**:
The **Workspace** view (toggle `d`) tallying each **Task**'s token usage, summed from its **Session** transcripts (`monitor/cost.ts` + `listSessionFilesForWorktree`).
_Avoid_: analytics, stats panel.

## Relationships

- A **Task** owns exactly one **Worktree** and one **tmux Session**.
- A **tmux Session** holds one-or-more **ChatTab**s (tmux windows); each **ChatTab** has four panes: **Tasks pane**, claude, **Ops pane**, shell. Each ChatTab's claude pane writes one-or-more **Session** transcripts to disk.
- The **Orchestrator** owns all **Task**s; it allocates the **Worktree** lazily on the first **Handover**.
- A **Handover** suspends the **TUI Client**'s renderer and attaches to the **Task**'s **tmux Session**; `Ctrl+Q` detaches back.
- The **tmux client** is the sole path to the `-L kobe` server; **Session Layout** is the pure policy `ensureSession` applies through it.
- A **Daemon** runs one **Orchestrator**; N **TUI Client**s each run one **RemoteOrchestrator**.
- The **Live Preview** and **Cost Dashboard** read **Session** transcripts + `tmux capture-pane`; they never drive claude.

## Example dialogue

> **Dev:** "When the user presses ⏎ on a task, what actually happens?"
> **Maintainer:** "A **Handover**. `enterTask` selects the task, then `launchTaskTmux` ensures the **Worktree** exists, calls `ensureSession` to build the **tmux Session** (applying the **Session Layout** policy through the **tmux client**), then suspends the renderer and `tmux attach`es. `Ctrl+Q` detaches and the renderer resumes."

> **Dev:** "And how does the outer **Workspace** show what claude's doing without entering?"
> **Maintainer:** "The **Live Preview** runs `tmux capture-pane` against the **tmux Session**'s first pane (the claude pane, resolved by id via the **tmux client** so `base-index` config can't break it) every second."

## Flagged ambiguities

- **"session"** — two meanings now: (a) **Session** = a Claude JSONL transcript on disk; (b) **tmux Session** = the per-Task tmux session. Always qualify the tmux one.
- **"workspace"** — (a) the **Workspace** **Pane** in the outer TUI; (b) the abstract notion of a **Task** as a workspace. Prefer the **Pane** sense in code.
- **"pane"** — overloaded between the outer TUI **Pane** (Sidebar / Workspace) and a tmux pane inside a **ChatTab** (Tasks / claude / Ops / shell). Use "tmux pane" for the latter.
- **"tab" / "window"** — a **ChatTab** is a tmux *window*; the outer TUI **Pane** is sometimes loosely called a window too. Prefer **ChatTab** for the tmux-window-as-conversation, and "tmux window" only when naming the mechanism.

## Retired (v0.5, removed in KOB-226/227)

These no longer exist in the code; kept so old comments/commits resolve:

- **AI Engine Port** — the `AIEngine` spawn/stream interface. kobe doesn't drive claude as a subprocess anymore; only the on-disk history readers (`engine/claude-code-local/history.ts`) survive.
- **SessionPump** — per-(Task, ChatTab) `engine.stream()` consumer. No live stream to pump.
- **PendingInputBroker** — the ExitPlanMode / AskUserQuestion waiting-request map. claude handles its own approvals interactively now.
- **ChatSessionController** — the chat pane's per-tab subscription choreography.
- **Bridge** — the MCP server exposing the Orchestrator to spawned claude.

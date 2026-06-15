# kobe — Context

Domain vocabulary for the TUI orchestrator. Every architectural conversation about kobe uses these terms verbatim; companion docs are [`docs/DESIGN.md`](./docs/DESIGN.md) (philosophy), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (file map), and [`docs/design/v2-tmux-handover.md`](./docs/design/v2-tmux-handover.md) (the v0.6 tmux-handover reshape).

> **v0.6 reshape (KOB-226).** kobe no longer drives `claude` as a stream-json subprocess and no longer renders its own chat. It is now a **task launcher**: each **Task** gets a **tmux Session** that runs interactive `claude` natively, and "entering" a task is a **Handover** (attach the real TTY). A **ChatTab** survives the reshape — but it's now a **tmux window**, not a kobe-rendered tab. Terms from the v0.5 chat era — **AI Engine Port**, **SessionPump**, **PendingInputBroker**, **ChatSessionController**, **Bridge** — are **gone**; they're listed in the Retired section so old references resolve.

> **Outer monitor retired (2026-06, docs/design/app-retirement.md).** The transitional opentui shell (`app.tsx`) and its vocabulary — **Workspace** (capital W), **Live Preview**, **Cost Dashboard**, the `KOBE_NO_DAEMON` daemon-less mode — are **gone**. `kobe` launches straight into the tmux workspace (`direct.ts`); the Tasks pane owns task switching. See the Retired section.

## Language

### Core nouns

**Task**:
One unit of work the user is tracking. Owns a single **Worktree** and one **tmux Session**. Persisted in `~/.kobe/tasks.json`.
_Avoid_: project, ticket, item, job.

**Worktree**:
The git worktree a **Task** is checked out into. 1:1 with **Task**. Allocated lazily — the directory only materialises on first **Handover** (`Orchestrator.ensureWorktree`).
_Avoid_: workspace (overloaded with the TUI **Pane**), checkout, branch dir.

**Session**:
A persisted Claude Code conversation on disk (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`). kobe reads these (engine history readers, auto-title, turn detection); it never writes them. Distinct from a **tmux Session** — disambiguate with the `tmux` qualifier when both are in play.
_Avoid_: history (history is the contents OF a Session, not the Session itself).

### Handover model

**tmux Session**:
The per-**Task** tmux session, named `kobe-<task-id>` on kobe's dedicated `-L kobe` socket (isolated from the user's own tmux). Holds one-or-more **ChatTab**s (tmux windows). Tagged with the **Task**'s id + **Worktree** via `@kobe_task` / `@kobe_worktree` session options so a new **ChatTab** can rebuild the same workspace. Persists across **Handover** detach AND a kobe restart. Built by `ensureSession`.
_Avoid_: just "session" (collides with the Claude **Session**), window, workspace.

**ChatTab**:
A tmux **window** inside a **Task**'s **tmux Session** — one independent `claude` conversation on the shared **Worktree**. Every ChatTab has the same four-pane layout: **Tasks pane** (left), claude, **Ops pane** (upper right), shell (lower right). `Ctrl+T` opens a new ChatTab (`kobe new-chattab` → `newChatTab`); the tmux status bar's window list is the tab switcher. The claude pane is tagged `@kobe_role=claude` so kobe can find it regardless of tmux's by-position pane numbering.
_Avoid_: tab (unqualified), window (use "tmux window" if you must name the mechanism).

**Handover**:
Entering a **Task**: `tmux attach` to the task's **tmux Session** with the real TTY, await exit. agent-deck's `tea.Exec()` model, minus the outer shell — `kobe` attaches directly at launch (`startDirectTmux`, `tui/direct.ts`), and the **Tasks pane** `switch-client`s between tasks from inside. `Ctrl+Q` detaches back to the launching shell.
_Avoid_: enter, takeover, fullscreen (these describe the mechanics, not the concept).

**Ops pane**:
The `kobe ops` subprocess that fills a **ChatTab**'s upper-right pane. Re-hosts the v0.5 FileTree (browse the **Worktree**) plus a slim file/diff viewer. Enter on a file injects `@<path>` into the claude pane via `tmux send-keys` (or opens a full-width syntax-highlighted preview window via `kobe ops --preview`). A separate OS process from the **TUI Client**, so it reads the outer app's theme via `readPersistedUiPrefs` (read-only).
_Avoid_: files pane, sidebar (that's the outer **Pane**).

**Tasks pane**:
The `kobe tasks` subprocess on the far left of a **ChatTab** — the task list (the `Sidebar` component) so you can jump between **Task**s without detaching. Enter `tmux switch-client`s to another **Task**'s **tmux Session**. Read-only: the **Orchestrator** / **Daemon** own writes; this pane never mutates task state. agent-deck convention.
_Avoid_: sidebar (that's the component, not the pane), task list.

### Orchestration

**Orchestrator**:
Owns **Task** lifecycle + **Worktree** allocation + the reactive task-list snapshot the TUI subscribes to. Lives in `src/orchestrator/core.ts`. v0.6-slim: no longer touches any engine subprocess (tmux owns those) — it's task index + git + a Solid signal. TUI-free so the **Daemon** can host it headless.
_Avoid_: manager, coordinator, controller, service.

**tmux client**:
The shared low-level client for kobe's `-L kobe` server (`src/tmux/client.ts`): socket constant, spawn helpers with stderr logging, `tmuxSessionName` / `attachArgv`, session-option tagging (`setSessionOption` / `getSessionOption` — which target the bare session name because `set-option` rejects the `=` exact-match prefix), the claude-pane tag (`tagClaudePane` / `claudePaneId`), and the `base-index`-safe pane-id resolution (`listPaneIds` / `firstPaneId` / `capturePaneById`). The single place that knows how to talk to the tmux server — the **Handover**, the **Ops pane**, and the **Tasks pane** all go through it.
_Avoid_: tmux wrapper, tmux utils.

**Session Layout**:
The pure command/layout builders for a **tmux Session** (`src/tmux/session-layout.ts`): pane percentages, shell-quoting, the keep-alive wrapper, the **Ops pane** command + its fallback. Pure (same inputs → same strings, no IO) so it's unit-tested — the regression net for the quoting/targeting bugs that used to only surface against a real server (KOB-233). `ensureSession` is the imperative applier of this policy.
_Avoid_: pane plan, blueprint.

**Session Decision**:
The pure reuse/respawn policy for `ensureSession` (`src/tmux/session-decision.ts`): given the observed facts of an existing **tmux Session** (tags, claude-pane health, window count) and the target **Worktree**/vendor, returns `create | reuse | respawn-engine | rebuild` with a reason. Sibling policy module to **Session Layout** — same seam, same unit-test net; `ensureSession` observes, decides, applies.
_Avoid_: session check, health check (those are inputs, not the policy).

**Engine Registry**:
The per-vendor wiring table (`src/engine/registry.ts`): history reader, account detector, hook adapter factory, turn detector, and default command, keyed by `VendorId`. Neutral layers (auto-title, settings) ask the registry instead of switching on vendor literals or parsing a vendor's transcript format directly. Custom engines resolve to a documented empty entry.
_Avoid_: engine switch, vendor table.

**State Store**:
The single owner of `~/.config/kobe/state.json` I/O (`src/state/store.ts`): atomic read-merge-write transactions so concurrent kobe processes (TUI, **Tasks pane**, CLI) can't clobber each other's keys. The TUI's `KVProvider` and the CLI-side `setPersistedString` family are adapters over it.
_Avoid_: kv file, config file (it's UI/process state, not user config — user config lives in `~/.kobe/settings/`).

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

**DaemonLifetime**:
The policy deciding whether the **Daemon** keeps running and whether its background collectors run (`src/daemon/lifetime.ts`). Owns the gui refcount (only `role: "gui"` subscribers hold the daemon's lifetime — panes don't), the collector gate (`hasSubscribers`), and the idle-shutdown grace timer + `stopping` flag. The server's live client set stays its source of truth (scanned on demand, no drift); the policy is unit-tested in isolation via an injected clock. Distinct from `lifecycle.ts`, which kills an EXTERNAL daemon process (restart/reset).
_Avoid_: lifecycle (that's the external-kill path), refcount, shutdown manager.

### Panes

**Pane**:
A kobe-owned process filling a tmux pane inside a **ChatTab** — today the **Tasks pane** and the **Ops pane** (the claude and shell panes are not kobe-rendered). Each owns its own keybindings and subscribes to the **Daemon** as `role: "pane"`. With the outer monitor retired, this is the only sense of "pane" in kobe code; use "tmux pane" when naming the raw mechanism.
_Avoid_: panel, window, view.

## Relationships

- A **Task** owns exactly one **Worktree** and one **tmux Session**.
- A **tmux Session** holds one-or-more **ChatTab**s (tmux windows); each **ChatTab** has four panes: **Tasks pane**, claude, **Ops pane**, shell. Each ChatTab's claude pane writes one-or-more **Session** transcripts to disk.
- The **Orchestrator** owns all **Task**s; it allocates the **Worktree** lazily on the first **Handover**.
- A **Handover** attaches the real TTY to the **Task**'s **tmux Session**; `Ctrl+Q` detaches back to the launching shell.
- The **tmux client** is the sole path to the `-L kobe` server; **Session Layout** is the pure policy `ensureSession` applies through it.
- A **Daemon** runs one **Orchestrator**; N **TUI Client**s each run one **RemoteOrchestrator**.

## Example dialogue

> **Dev:** "When the user presses ⏎ on a task in the **Tasks pane**, what actually happens?"
> **Maintainer:** "A **Handover**. The pane ensures the **Worktree** exists, calls `ensureSession` to build the **tmux Session** (applying the **Session Layout** policy through the **tmux client**), then `tmux switch-client`s into it. At launch, `kobe` itself does the same dance via `startDirectTmux` and `tmux attach`es directly; `Ctrl+Q` detaches back to the shell."

## Flagged ambiguities

- **"session"** — two meanings now: (a) **Session** = a Claude JSONL transcript on disk; (b) **tmux Session** = the per-Task tmux session. Always qualify the tmux one.
- **"workspace"** — the abstract notion of a **Task** as a workspace ("the tmux workspace"). The capital-W **Workspace** **Pane** is retired; don't reuse the word for a UI region.
- **"pane"** — a kobe **Pane** (Tasks / Ops — kobe-owned processes) vs a raw tmux pane inside a **ChatTab** (Tasks / claude / Ops / shell). Use "tmux pane" for the mechanism.
- **"tab" / "window"** — a **ChatTab** is a tmux *window*; the outer TUI **Pane** is sometimes loosely called a window too. Prefer **ChatTab** for the tmux-window-as-conversation, and "tmux window" only when naming the mechanism.

## Retired (v0.5, removed in KOB-226/227)

These no longer exist in the code; kept so old comments/commits resolve:

- **AI Engine Port** — the `AIEngine` spawn/stream interface. kobe doesn't drive claude as a subprocess anymore; only the on-disk history readers (`engine/claude-code-local/history.ts`) survive.
- **SessionPump** — per-(Task, ChatTab) `engine.stream()` consumer. No live stream to pump.
- **PendingInputBroker** — the ExitPlanMode / AskUserQuestion waiting-request map. claude handles its own approvals interactively now.
- **ChatSessionController** — the chat pane's per-tab subscription choreography.
- **Bridge** — the MCP server exposing the Orchestrator to spawned claude.

## Retired (v0.6 outer monitor, removed 2026-06 — docs/design/app-retirement.md)

The transitional opentui shell and its surfaces; kept so old comments/commits resolve:

- **Outer monitor** — the `app.tsx` opentui shell (sidebar + Workspace) that `kobe` used to boot into. The v0.6+ direction was always inner-first; once every flow had a tmux-native home, the shell was deleted. `kobe` now attaches straight to a **tmux Session** (`tui/direct.ts`).
- **Workspace** (capital W) — the outer shell's right **Pane**: **Live Preview** + a **Handover** launcher (`ClaudeLauncher`), or the **Cost Dashboard**. Don't reuse the word for a UI region; "the tmux workspace" (the abstract Task-as-workspace sense) is still fine.
- **Live Preview** — the Workspace's ~1s `tmux capture-pane` view of a Task's claude pane (`monitor/capture-pane.ts`). Dropped without a port: switching sessions *is* the preview, and the **Tasks pane** carries status badges.
- **Cost Dashboard** — the Workspace's per-Task token table (toggle `d`). Dropped without a port; the `monitor/cost.ts` summarizer briefly survived as **Engine Registry** plumbing (`summarizeCost`), but with zero production callers the whole chain (`monitor/cost.ts`, the registry field, `engine/claude-code-local/cost.ts`) was deleted too.
- **`KOBE_NO_DAEMON`** — env flag that hosted a daemon-less in-process **Orchestrator** inside the TUI. Retired: the **Daemon** is the product; `kobe doctor` / `kobe reset` cover its failure modes. (The **Orchestrator** class itself lives on, hosted by the Daemon.)

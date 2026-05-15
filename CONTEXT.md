# kobe — Context

Domain vocabulary for the TUI orchestrator. Every architectural conversation about kobe uses these terms verbatim; companion docs are [`docs/DESIGN.md`](./docs/DESIGN.md) (philosophy), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (file map), and [`docs/design/tasks.md`](./docs/design/tasks.md) (the Task/Worktree/ChatTab triple in detail).

## Language

### Core nouns

**Task**:
One unit of work the user is tracking. Owns a single **Worktree** and one or more **ChatTab**s. Persisted in `~/.kobe/tasks.json`.
_Avoid_: project, ticket, item, job.

**Worktree**:
The git worktree a **Task** is checked out into. 1:1 with **Task**.
_Avoid_: workspace (overloaded with the TUI pane), checkout, branch dir.

**ChatTab**:
One Claude Code session inside a **Task**, with its own conversation transcript and resumable `sessionId`. N per **Task**.
_Avoid_: chat, conversation, thread, session-tab.

**Session**:
A persisted Claude Code conversation on disk (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`). Belongs to exactly one **ChatTab** once attached.
_Avoid_: history (history is the contents OF a Session, not the Session itself).

### Engine + orchestration

**AI Engine Port** (or **Engine Port**):
The `AIEngine` interface in `src/types/engine.ts`. The single declared pluggability seam. Everything below it is "how `claude` is invoked"; everything above doesn't know.
_Avoid_: backend, adapter, provider, vendor.

**Orchestrator**:
The thing wiring **AI Engine Port** + git + task index. Lives in `src/orchestrator/core.ts`. The one place that knows about all three. TUI-free: depends on Solid signals as a reactive primitive but never on opentui or any rendering, so the **Daemon** can host it headless.
_Avoid_: manager, coordinator, controller, service.

**SessionPump** (or **Pump**):
One-per-(**Task**, **ChatTab**) consumer of `engine.stream()`. Detects pause tools (ExitPlanMode / AskUserQuestion), records pending input, kills the subprocess, and dispatches events to subscribers. Owns the per-session run lifecycle; the Orchestrator just spawns it.
_Avoid_: stream loop, event driver, runner.

**PendingInputBroker** (or **Broker**):
The map of "which **ChatTab** has which request waiting for a user response." Two adapters: a local in-process implementation and a wire-fed replica. The Pump records into the broker; the chat UI reads from it.
_Avoid_: pending map, awaiting-input store, input queue.

**Bridge**:
The MCP server exposing the **Orchestrator** to spawned `claude` subprocesses. Lives in `src/orchestrator/bridge/`. A separate seam from the **AI Engine Port** — Bridge is "claude → kobe," Engine Port is "kobe → claude."
_Avoid_: mcp-server, plugin-host.

### Daemon split

**Daemon**:
The long-running process that holds the **Orchestrator** and serves N **TUI Clients** over a Unix socket. One per user, not per repo. Spawned via `kobe daemon start` (was `kobed start` pre-KOB-136).
_Avoid_: server, backend, host.

**TUI Client**:
The kobe TUI process attached to a **Daemon**. Owns view-local state (focus, drafts, cursor); does not own **Task** or **ChatTab** state.
_Avoid_: frontend, UI process.

**RemoteOrchestrator**:
The **TUI Client**-side facade that satisfies the same surface as **Orchestrator** by talking to the **Daemon** over the wire. Hydrates a local mirror of tasks / pending inputs / run state on attach and maintains it forward via wire events.
_Avoid_: client, proxy, daemon-client.

**ChatSessionController**:
The per-**ChatTab** subscription / history-load / lifecycle hook used by the chat pane. Owns the `(currentTask, orchestrator) → chatState` choreography that used to live as scattered Solid effects inside `Chat.tsx`.
_Avoid_: chat manager, session driver, tab controller.

### TUI

**Pane**:
One of the five top-level regions in the TUI shell — Sidebar, Workspace, Files, Preview, Terminal. Owns its own keybindings and focus.
_Avoid_: panel, window, view.

**Workspace** (capital W):
The center **Pane** that holds the chat + preview tabs. Distinct from a **Worktree** (lowercase usage in code paths).
_Avoid_: editor, center.

## Relationships

- A **Task** owns exactly one **Worktree** and one-or-more **ChatTab**s.
- A **ChatTab** resumes at most one **Session** (the `sessionId` field).
- The **Orchestrator** owns all **Task**s; one **SessionPump** runs per active **ChatTab**.
- A **SessionPump** writes pending-input requests into the **PendingInputBroker**; the chat **Pane** reads them out via the **ChatSessionController**.
- A **Daemon** runs one **Orchestrator**; N **TUI Client**s each run one **RemoteOrchestrator** pointing at the **Daemon**.
- The **PendingInputBroker** has two adapters: a local one inside the **Daemon**'s **Orchestrator** and a wire-fed replica inside each **RemoteOrchestrator**.

## Example dialogue

> **Dev:** "When the user clicks Approve on an ExitPlanMode plan, which thing actually resumes the **Session**?"
> **Maintainer:** "The **Orchestrator**'s `respondToInput` — it pops the entry out of the **PendingInputBroker**, renders the synthetic user prompt, and calls `runTask` again. That spawns a new **SessionPump** which streams the resumed session."

> **Dev:** "And in daemon mode?"
> **Maintainer:** "Same flow on the **Daemon** side. The **TUI Client** sent a `chat.input.respond` wire request; the **RemoteOrchestrator** translated the Approve click into that. The local replica **PendingInputBroker** in the client drops the entry when the daemon broadcasts the `user_input.resolved` event."

## Flagged ambiguities

- "workspace" — two meanings: (a) the center **Pane** in the TUI ("Workspace pane"), (b) the abstract notion of a **Task** as a workspace-not-a-conversation in `docs/design/tasks.md`. Prefer the **Pane** sense in code; use **Task** when you mean the conceptual workspace.
- "session" — Claude Code's term for one resumable conversation. In kobe we say **Session** for the on-disk JSONL and **ChatTab** for the in-orchestrator owner. Don't conflate.
- "history" — the contents of a **Session**, not the **Session** itself. `engine.readHistory(sessionId)` returns Messages from one **Session**.
- "client" — overloaded between (a) `KobeDaemonClient` (the wire-protocol object), (b) **TUI Client** (the process), and (c) **RemoteOrchestrator** (the orchestrator-shaped façade). Use the most specific term.

# kobe domain context

Use these terms consistently in code, docs, issues, and reviews.

## Product unit

```text
Task = Worktree + hosted engine sessions + branch
```

**Task** — one tracked unit of work persisted in `~/.kobe/tasks.json`. A Task
owns one Worktree and may have several Terminal Tabs. A `kind: "main"` Task
represents a saved repository's root checkout.

**Worktree** — the git worktree where a Task's files and engine sessions run.
It is distinct from the source repository checkout.

**Session** — a persisted engine conversation on disk. Qualify this as an
engine Session when it could be confused with a live Hosted PTY session.

## Runtime

**Workspace Host** — the single React PureTUI process started by plain `kobe`.
It renders Sidebar | Terminal Tabs | Files and holds daemon GUI lifetime.

**Terminal Tab** — one engine, shell, editor, or diff command in the Workspace
Host. A tab's process lives in a Hosted PTY under key
`${taskId}::${tabId}`. The canonical first engine tab is always `tab-1`.

**Split** — the content-neutral tree inside a Terminal Tab. A Split leaf is not
called a pane.

**PTY Host** — the standalone `kobe pty-host` process. It owns interactive
children, buffers output, and lets TUI/API clients attach and detach. Engine
sessions therefore survive TUI exits and daemon restarts. Only explicit
`pty.kill`, tab close, task archive/delete, or host teardown ends them.

**PTY Registry** — the Workspace Host's client-side attachment manager. It
maps tab keys to hosted sessions and reference-counts local consumers; it does
not own child lifetime.

**Daemon** — the long-lived control plane for the Task index, Worktree
operations, settings, issues, activity channels, and browser transport. It does
not own or kill Hosted PTY children.

**Orchestrator** — framework-free Task/Worktree state owned by the Daemon.

**TUI Client** — a `RemoteOrchestrator` connection. Attached Workspace Hosts
use `role: "gui"`; background consumers use `role: "pane"` for protocol
compatibility, though they are not UI panes.

## UI vocabulary

**Sidebar** — the left task/project rail.

**Workspace** — the center Terminal Tab region. Avoid using this bare word for
the whole app; say Workspace Host.

**Files** — the right file tree, changes, preview, and diff region.

**Focus** — the active keyboard region: `sidebar`, `workspace`, `files`, or
`terminal`.

**Binding Stack** — the runtime, modal-aware key dispatch stack. `KobeKeymap`
defines which chords exist; the stack decides which focused surface receives a
chord.

**PureTUI prefix** — a configurable two-stroke sequence, default `ctrl+a`,
followed by an action key. It is configured in
`~/.kobe/settings/keybindings.yaml`.

## Engine boundary

Engine adapters own product identity, launch argv, capabilities, model/effort
catalogs, history, completion detection, and normalized telemetry. The TUI,
Daemon, and Orchestrator consume this contract and do not hard-code vendor
behavior.

The shared launch builder in `src/engine/session-launch.ts` composes shell
launch, repository init, engine protocol, and the first prompt. PureTUI tabs and
headless `kobe api send/add/fan-out` use the same builder.

## Retired vocabulary

The following may appear in historical changelog or decision records but is
not current product architecture: Handover, tmux Session, ChatTab, Tasks pane,
Ops pane, outer monitor, Live Preview, Cost Dashboard, Native chat pane,
Provider Runtime, Solid TUI, SessionPump, PendingInputBroker, and Bridge.

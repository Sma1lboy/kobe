# Rove domain context

Use these terms consistently in code, docs, issues, and reviews.

## Product unit

```text
Managed task = Worktree + branch + Terminal Tabs
```

**Task** — one tracked unit of work persisted in `~/.rove/tasks.json`. A Task
may have several Terminal Tabs. A regular `kind: "task"` Task owns a managed
Worktree and branch; a `kind: "main"` Task represents a saved repository's root
checkout; a `kind: "dir"` Task points at a user-owned directory. Main and
directory Tasks do not own a Rove-created Worktree or branch.

**Task directory** — `Task.worktreePath`, the directory where a Task's files
and terminal processes run. A managed Task points it at an isolated Worktree;
main and directory Tasks point it at an existing directory.

**Worktree** — the isolated git working tree Rove creates for a managed Task,
distinct from the source repository checkout.

**Session** — a persisted engine conversation on disk. Qualify this as an
engine Session when it could be confused with a live Hosted PTY session.

## Runtime

**Workspace Host** — the single React PureTUI process started by plain `rove`.
It renders Sidebar | Terminal Tabs | Files and holds daemon GUI lifetime.

**Terminal Tab** — one engine, shell, editor, or diff command in the Workspace
Host. A tab's process lives in a Hosted PTY under key
`${taskId}::${tabId}`. The canonical first engine tab is always `tab-1`.

**Split** — the content-neutral tree inside a Terminal Tab. A Split leaf is not
called a pane.

**PTY Host** — the standalone `rove pty-host` process. It owns interactive
children, buffers output, and lets TUI/API clients attach and detach. Engine
sessions therefore survive TUI exits and daemon restarts. It also freezes
bounded scrollback plus launch metadata so a host restart or reboot can restore
the screen and respawn the recorded command on first attach. Explicit
`pty.kill`, tab close, task archive/delete, terminal reset, or `rove reset`
tears down the corresponding hosted session and frozen record.

**Browser PTY sidecar** — the Node process started by `rove web`. It owns only
browser-created terminal children and is separate from the standalone PTY Host.

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
`~/.rove/settings/keybindings.yaml`.

## Engine boundary

Engine adapters own product identity, launch argv, capabilities, model/effort
catalogs, history, completion detection, and normalized telemetry. The TUI,
Daemon, and Orchestrator consume this contract and do not hard-code vendor
behavior.

The shared launch builder in `src/engine/session-launch.ts` composes shell
launch, repository init, engine protocol, and the first prompt. PureTUI tabs and
headless `rove api send/add/fan-out` use the same builder.

## Retired vocabulary

The following may appear in historical changelog or decision records but is
not current product architecture: Handover, tmux Session, ChatTab, Tasks pane,
Ops pane, outer monitor, Live Preview, Cost Dashboard, Native chat pane,
Provider Runtime, Solid TUI, SessionPump, PendingInputBroker, and Bridge.

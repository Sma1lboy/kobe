# PureTUI-only tmux removal design

## Goal

Remove tmux as a kobe runtime, UI surface, session backend, configuration
namespace, and development requirement. Plain `kobe` boots the React PureTUI
Workspace Host and the standalone PTY Host is the only owner of interactive
engine and shell sessions.

The removal must preserve unattended automation: `kobe api send`, `add` with a
prompt, and `fan-out` must start an engine session through the PTY Host when no
session exists, even when no PureTUI process is open.

## Product contract

- `kobe` has one launch behavior: start PureTUI.
- There are no `--tmux` or `--puretui` launch flags and no environment launch
  switch. A UI mode selector would describe a product choice that no longer
  exists.
- Tasks own a Worktree, branch, engine metadata, and zero or more Hosted PTY
  sessions. They do not own a tmux Session.
- Engine sessions survive PureTUI exits and daemon restarts because the
  standalone PTY Host owns their child processes.
- Task archive/delete/reset operations kill the task's Hosted PTY sessions.
- `kobe api send`, prompted `add`, and `fan-out` preserve their current
  auto-start semantics through the PTY Host.
- Existing installations' old `tmux -L kobe` sessions are not managed by the
  new runtime. Release notes provide `tmux -L kobe kill-server` as a one-time
  manual cleanup command; no legacy shim remains in product code.

## Single session backend

### Stable addressing

The first engine session for a task uses the existing deterministic key
`<taskId>::tab-1`. Additional PureTUI tabs keep their existing
`<taskId>::tab-N` keys. Session inventory, running checks, delivery, and
teardown all resolve through the PTY Host's `pty.list/open/write/kill` RPCs.

### Existing-session delivery

When an alive engine key exists, API delivery reattaches with `pty.open`,
writes the prompt as bracketed paste, waits the existing submit delay, and
writes carriage return. It never creates another engine for the same key.

### Automatic fresh launch

When no engine key exists:

1. Ensure the task Worktree exists.
2. Start or reconnect to the standalone PTY Host through
   `ensurePtyHostReachable()`.
3. Resolve the engine command, vendor/model/session protocol, repository init
   script, and explicit first prompt through one neutral launch builder.
4. Call `pty.open` for `<taskId>::tab-1` with the user's interactive shell.
5. Only when `pty.open.created` is true, write the launch line as initial PTY
   input. The explicit prompt rides the fresh engine argv, matching the
   existing PureTUI quick-fork first-spawn rule and avoiding a readiness race.
6. Detach the short-lived API client after successful creation; the PTY Host
   keeps the engine alive.

The PTY Host's key-level `pty.open` idempotence is the concurrency guard: a
second opener attaches to the existing key and must not retype initial input.

### Shared launch composition

Move shell quoting, repository init-script weaving, one-time init markers, and
engine argv composition out of tmux-owned modules into a neutral engine/session
module. Both PureTUI tab creation and headless API creation use this builder so
they cannot drift on init scripts, engine protocols, model effort, or first
prompt priority.

The builder must preserve the current interactive-shell behavior: the engine
is typed into the user's real shell so rc-file context is available and exiting
the engine returns to a shell rather than terminating the terminal tab.

## Runtime deletion boundary

Delete tmux-only code rather than retaining disabled adapters:

- `packages/kobe/src/tmux/` after moving genuinely generic helpers.
- tmux session/layout/chattab/heal modules under
  `packages/kobe/src/tui/panes/terminal/`.
- the direct Handover entrypoint and task-enter/switch-client plumbing.
- tmux-only Tasks/Ops/quick-task/settings/help/update/worktree/history pane-host
  entrypoints while retaining components and framework-free cores used by the
  Workspace Host.
- internal tmux pane CLI commands and their dispatch table.
- tmux-only API fallback, runtime seams, prompt delivery, and liveness checks.
- tmux keybinding defaults, parser namespace, Settings copy, help rows, and
  keybinding documentation.
- tmux doctor/resource reporting, `reload`, `kill-sessions`, tmux teardown in
  `reset`, and `KOBE_TMUX_SOCKET` controls.
- tmux-specific unit, render, socket, and behavior tests.

Code is retained only when PureTUI uses the behavior independently of tmux.
Such code is renamed and moved to a neutral owner before the tmux directory is
removed. Known examples include editor command resolution and shell/engine
launch composition. Generic split-tree algorithms may keep their behavior but
must not import or require tmux.

## Daemon and protocol cleanup

- The daemon runtime's `ensureTaskSession` and `tearDownTaskSession` adapters
  become PTY Host operations.
- Remove the tmux chat-tab naming pass from daemon runtime contracts; PureTUI
  tab titles and transcript-derived task titles remain authoritative.
- Remove the tmux-specific `pane` subscriber meaning if no non-GUI consumer
  requires it; otherwise rename the role to a backend-neutral background
  client term and migrate protocol tests.
- Rewrite daemon lifecycle comments and invariants around the PTY Host. Daemon
  shutdown continues not to kill engine sessions; `kobe reset` explicitly
  stops the PTY Host.
- `doctor` reports daemon, PTY Host, state, terminal, and resource information
  without probing a tmux binary.

## CLI and development scripts

- Bare `kobe` dynamically imports and starts the Workspace Host directly.
- Remove the dual-mode launch parser introduced on this branch.
- `bun run dev` and `bun run dev:sandbox` start PureTUI without a mode flag.
- `dev:sandbox:reset` resets the sandbox daemon and PTY Host only.
- Remove internal pane-host subcommands from help, completions, routing, and
  tests. Keep `pty-host` internal.
- Remove tmux from installation guidance, doctor requirements, release notes,
  and architecture vocabulary.

## Documentation and migration

Update `AGENTS.md`, `CONTEXT.md`, active design/architecture/harness/keybinding
docs, READMEs, the installed Kobe skill, inline comments, and the patch
changeset. The canonical product unit becomes:

```text
Task = git worktree + hosted engine sessions + branch
```

Historical CHANGELOG entries and superseded decision records may describe tmux
as history, but active instructions must not tell users or agents to install,
start, configure, diagnose, or depend on it.

## Error handling

- Failure to start the PTY Host is a visible `SESSION_FAILED` API error with
  the host socket/log path, never a silent fallback.
- A dead existing engine key returns `delivered:false` or is explicitly killed
  and recreated according to the current session-recovery policy; it never
  opens a second key implicitly.
- A failed fresh spawn must not report `started:true` or `delivered:true`.
- Task teardown remains idempotent when the PTY Host is absent or already
  exited.

## Verification

- TDD coverage proves fresh PTY auto-start, existing-session delivery,
  concurrent open idempotence, init-script composition, explicit prompt
  priority, running detection, and teardown.
- Black-box behavior coverage proves a built `kobe` starts PureTUI without
  flags and prompted API creation works without an open UI.
- CLI tests prove tmux launch flags and removed subcommands are rejected.
- Static guards prove no production import reaches deleted tmux modules and no
  production code spawns or requires the `tmux` executable.
- File-size, coverage, lint, typecheck, fast/socket tests, build, and the full
  behavior suite pass.
- Final scope inspection proves unrelated `.agents/skills/brand-studio` and
  `.planning/` files were not staged or committed.

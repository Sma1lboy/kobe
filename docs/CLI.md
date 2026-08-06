# CLI + API reference

The human index of everything the `kobe` binary does. Two machine-readable
surfaces stay authoritative when this page and the binary disagree:

- `kobe --help`: the top-level command list. It is a single tested string
  (`packages/kobe/src/cli/usage.ts`); adding a subcommand fails CI until
  help and completions agree.
- `kobe api schema`: the full `kobe api` verb/flag spec as JSON. This is
  **the** source of truth for the scriptable surface: names, types,
  required flags, enum values. Agents should read it once and drill in with
  `--verb <name>` instead of parsing this page.

Design rationale (why a CLI instead of MCP) lives in
[design/cli-api.md](./design/cli-api.md), which is historical; the shipped
surface outgrew it.

## Install + update

Requires Bun ≥ 1.3.11, git, and at least one engine CLI on `PATH`.

```bash
bun install -g @sma1lboy/kobe   # install
bunx @sma1lboy/kobe             # zero-install trial
```

`kobe update` is a thin wrapper that delegates to the GitHub-hosted
`scripts/update.sh` (so install-flow changes ship without a binary release):

```bash
kobe update            # update to latest
kobe update 0.7.90     # pin an exact version
kobe update list       # browse recent versions (TUI when interactive, plain text when piped)
kobe update dry-run    # print the command without running it
```

`--list` / `--dry-run` are accepted aliases of the verbs. The script updates
with the same package manager that owns the `kobe` on `PATH` (bun or npm),
so the new version doesn't land in a shadowed prefix. Manual fallback:
`npm install -g @sma1lboy/kobe@latest`.

Installing across a version registered as breaking prints a heads-up: the
next launch refuses to start until you run `kobe reset` (the boot gate is
the enforcement point; worktrees are never touched). `kobe update list`
marks those versions `(breaking — needs `kobe reset`)`.

## Launching

```bash
kobe            # launch the TUI (first run: onboarding wizard instead)
kobe .          # open a directory as a standalone task — the `code .` gesture
kobe <path>     # same, for any path-like argument
kobe web        # the browser dashboard on http://localhost:5174
```

An unrecognized subcommand prints usage and exits 2; a typo never silently
opens the TUI.

### Projects: add / remove / adopt

```bash
kobe add [path]   # save a repo for the new-task picker (path defaults to .)
kobe remove [path]
kobe adopt [glob] [--repo <path>] [--vendor <v>] [--yes]
```

- `kobe add` requires a real git repository. It also creates the repo's
  PROJECTS sidebar row and folds in any existing unlinked git worktrees as
  tasks (most-recently-active first).
- `kobe add --remote --host <host> --user <user> --path <basePath> [--port N]
  [--key [path] | --password]` registers an SSH-backed project whose
  worktrees + engine run on the remote host. Experimental; enable
  Settings → Dev → Experimental → Remote projects first. Auth is one of
  `--key` (ssh-agent when the path is omitted) or `--password` (prompted,
  stored in the OS keychain, never in state.json).
- `kobe remove` is the inverse: forget a saved project. Non-destructive:
  files, worktrees, branches, and tasks stay on disk; a remote project's
  stored connection config is dropped. With no match it prints the saved
  list so you can copy the exact entry.
- `kobe adopt` imports existing git worktrees as tasks. No glob → dry-run
  listing; a glob lists matches (absolute path or basename, e.g.
  `kobe adopt 'feature-*'`); `--yes` actually adopts them.

## Top-level commands

As rendered by `kobe --help`:

```text
Usage: kobe [command] [options]

  web [options]           Launch the browser dashboard
  completions <shell>     Generate shell completion script (bash/zsh/fish)
  add [path]              Save a repo path for the new-task picker
  remove [path]           Forget a saved project (inverse of add; non-destructive)
  adopt [glob]            Import existing git worktrees as tasks
  export [--csv|--json]   Print the task list (json/csv/table; daemon-free)
  repo <verb>             Per-repo init script + first prompt (show|set|unset)
  api <verb>              Scriptable RPC surface for agents (see `kobe api --help`)
  daemon <verb>           Manage the daemon (start|stop|status|restart)
  doctor [--report]       Diagnose daemon/PTY/engines/git; --report writes a bundle
  config [--path]         Open kobe's config file (state.json) in your editor
  reset [--hard]          Stop runtimes; optionally wipe task/UI state
  theme <verb>            Manage user themes (list|add|remove)
  skill <verb>            Install the kobe agent skill (install|status|command)
  plugin <verb>           Install and run plugins (install|link|list|action|…)
  feedback                Send feedback to GitHub Discussions
  update [version|list]   Self-update kobe, or browse versions with `list`

Options:
  -v, --version           Print version
  -h, --help              Print this help
```

### web

```bash
kobe web [--port <n>] [--routes-only] [--no-takeover]
```

Serves the web dashboard through the daemon-hosted HTTP/SSE transport on
`:5174` (override with `--port`), plus a PTY sidecar for browser terminal
tabs. `--routes-only` starts only the daemon web routes (Vite serves the SPA
separately, for dev). `--no-takeover` is reserved for compatibility; the
daemon owns the web port. The daemon's web port can also be set (or
disabled with `0`/`off`/`false`) via `KOBE_DAEMON_WEB_PORT`.

### completions

```bash
source <(kobe completions zsh)                          # zsh
kobe completions bash > ~/.bash_completion.d/kobe       # bash
kobe completions fish > ~/.config/fish/completions/kobe.fish
```

Completes subcommands only (each subcommand owns its own flags).

### export

```bash
kobe export [--json | --csv | --format <json|csv|table>]
```

Prints the task list from `~/.kobe/tasks.json`. Read-only and daemon-free:
it works with the daemon down (complement to `kobe api list`, which is
JSON-only and needs the daemon). Default is a JSON array of rows with
columns `id, title, status, archived, vendor, branch, repo, worktreePath`;
`--csv` emits RFC-4180-style CSV with a header; `--format table` aligns
columns for humans.

### repo

```bash
kobe repo show [path]
kobe repo set [path] --init-script <text> | --init-script-file <path>
                    [--init-prompt <text> | --init-prompt-file <path>]
kobe repo unset [path] [--init-script] [--init-prompt]
```

Manages a repo's per-user init override (state.json), the fallback for
repos that don't ship their own `.kobe/init.sh` / `.kobe/init-prompt.md`
(the in-repo files win when present; see AGENTS.md "Per-repo init"). Path
defaults to the current directory, resolved to its git toplevel. `unset`
with no field flag clears both.

### config

```bash
kobe config [--path]
```

Opens kobe's user config, `~/.config/kobe/state.json` (theme, locale,
engine + editor prefs), in your editor: `$VISUAL` / `$EDITOR`, else the
configured editor (Settings → General → Editor), else the first of
nvim / vim / emacs / nano. `--path` just prints the path. kobe re-reads the
file on next launch; a missing file is seeded as `{}`.

### theme

```bash
kobe theme list                                    # bundled + user themes
kobe theme add <source> [--name <name>] [--force]  # URL or local theme JSON
kobe theme remove <name>
```

User themes land in `~/.kobe/themes/<name>.json` and may shadow a bundled
name. `remove` refuses bundled (read-only) themes. `ls` / `rm` are accepted
aliases.

### skill

```bash
kobe skill install [--agent NAME]   # wraps `npx skills add Sma1lboy/kobe`
kobe skill status
kobe skill command [--agent NAME]   # print the npx command without running it
```

Installs the kobe agent skill, the thing that teaches a coding agent how
to drive `kobe api`. Default agent: `claude-code`. `kobe doctor` reports
the skill as missing/stale and points here.

### plugin

```text
kobe plugin install <owner/repo[/subdir]> [--yes] [--ref <rev>]
kobe plugin link <dir>                         register a local plugin directory (dev)
kobe plugin list                               installed + linked plugins
kobe plugin search [query]                     browse the marketplace (GitHub topic kobe-plugin)
kobe plugin outdated                           check GitHub installs against upstream
kobe plugin update <id…> | --all [--yes]       reinstall stale plugins from GitHub
kobe plugin enable <id> | disable <id>         toggle without unregistering
kobe plugin unlink <id>                        unregister a linked plugin (files untouched)
kobe plugin uninstall <id-or-spec>             unregister + remove the managed checkout
kobe plugin config-dir <id>                    print the plugin's config directory
kobe plugin log <id> [-n <count>]              tail the plugin's command-run log (default 20)
kobe plugin action list [--plugin <id>]        declared actions
kobe plugin action invoke <plugin-id.action-id> [args…]
kobe plugin pane open <plugin-id.pane-id> [--task <task-id>]
```

The registry is `~/.kobe/plugins.json`; the daemon's PluginHost watches it,
so changes apply to a running daemon without a restart. Authoring contract:
[PLUGIN-AUTHORING.md](./PLUGIN-AUTHORING.md). Marketplace:
`https://github.com/topics/kobe-plugin`.

### feedback

```bash
kobe feedback --title <text> (--body <text> | --body-file <path>) [--category <slug>]
```

Creates a GitHub Discussion in the kobe repo via the `gh` CLI (requires
`gh auth login`). `--body-file -` reads the body from stdin; default
category is `feedback`.

### doctor

```bash
kobe doctor [--report]
```

Read-only diagnosis: build + home, terminal env, git, engine CLIs and
account state (claude / codex / copilot), daemon reachability (with
stale-build warning), PTY host inventory, legacy pre-v0.8 tmux sessions,
agent-skill state, and the state files (tasks.json / state.json /
daemon.log / pty-host.log). Never mutates. `--report` additionally writes a
bug bundle (diagnosis + recent logs + env) to a file and prints its path;
attach it to bug reports. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### reset

```bash
kobe reset [--hard] [--yes]
```

Recovers a wedged install: stops the daemon (graceful → SIGTERM → SIGKILL)
and removes its socket/pidfile, stops the standalone PTY host (ending all
background terminal/engine sessions), and stops any pre-v0.8 tmux sessions.
**Never touches git worktrees.** `--hard` additionally deletes the task
index (`~/.kobe/tasks.json`) and the UI state (`state.json`). Interactive
y/N confirmation unless `--yes` (a non-TTY without `--yes` prints the
re-run hint and changes nothing).

### daemon

```bash
kobe daemon status     # status JSON (default verb); exit 1 when no daemon runs
kobe daemon start      # run the daemon in the FOREGROUND (this process becomes it)
kobe daemon stop       # ask the daemon to shut down (exit 0 when none running)
kobe daemon restart    # stop, then respawn detached
```

The daemon is a long-lived background process, refcounted on attached
GUIs; `kobe api` and the TUI auto-start it as needed, so `start` is
mainly for debugging. Logs: `~/.kobe/daemon.log` (rotated at boot, one
generation kept as `daemon.log.old`); read it first when debugging.
**After editing daemon/orchestrator/engine code in a checkout, run
`kobe daemon restart`**, since Bun doesn't hot-reload. Mechanics:
[design/daemon.md](./design/daemon.md).

### Internal subcommands

Not in `kobe --help`; documented so their behavior isn't a mystery:

- `kobe pty-host`: the standalone PTY host process that owns embedded
  terminal PTYs so they survive TUI exits and daemon restarts. Spawned
  detached when a terminal pane needs it; runs in the foreground when
  invoked by hand. It's a separate process from the daemon precisely so
  `kobe daemon restart` never ends running engine sessions.
- `kobe hook <verb>`: fired by an engine's own hooks (installed into e.g.
  `~/.claude/settings.json`) to report normalized activity events to the
  daemon. Contract: **always exits 0** and **never spawns the daemon**; a
  hook must never fail the engine or resurrect an idle-stopped daemon.
  `kobe hook setup` is deprecated (cleanup-only no-op).

## `kobe api`: the scriptable surface

Each invocation is a short-lived process: connect to (or auto-start) the
daemon, do the work, print one JSON object to stdout, exit. Read-only verbs
marked *offline* below skip the daemon entirely.

### Output + exit-code contract

- **Success** → one JSON object on stdout, newline-terminated, exit 0.
  `--pretty` indents it (humans only).
- **Error** → `{ "error": { "message", "code", ... } }` on stderr. Common
  rejections additionally carry `hint` and `nextCommandArgs` (argv runnable
  verbatim) so a caller can self-heal without parsing prose.
- Exit codes: `0` success · `1` handler/RPC failure · `2` usage errors
  (unknown verb, bad/missing flag, unreachable daemon) · `3` partial
  fan-out (some tasks created, some failed; the full payload still goes to
  stdout so created tasks are never lost).
- `kobe api <verb> --help` prints that verb's usage and exits 0.

Flag parsing: `--key value` and `--key=value` both work; boolean flags may
be given bare (`--force` ⇒ true) or explicitly (`--archived=false`);
`--task-id` / enum / positive-int values are validated against the verb's
spec, and unknown flags are rejected (exit 2). `--repo` resolves relative
paths against `$PWD` (`~` expanded). Engine vendors: `claude`, `codex`,
`copilot`, `kimi`. `spawn-task` is an alias of `add`.

### Discovery

- `schema` *(offline)*: the API, as JSON. Default is a compact index
  (groups + verb summaries, no flags); drill in with `--verb <name>` (full
  flag detail for one verb), `--group <g>`, or `--all` (everything; large).
  Includes an `apiVersion` agents can gate on.

### read

- `list`: list all tasks (incl. archived). Returns `{ tasks }`.
- `get-task --task-id <id>`: one task's metadata; `.running` = its hosted
  engine session is live.
- `collect [--task-ids a,b,c] [--repo PATH]`: read-only comparison
  snapshot of several tasks: identity, branch, `.running`, uncommitted
  `.changes`, and committed `.base` (ahead count + diffstat vs base).
- `pty-list` *(offline)*: hosted PTY sessions (key, alive, pid, command,
  live window title). Empty when no PTY host runs.
- `read-output [--task-id ID] [--source auto|history|terminal] [--cursor C]
  [--limit N]`: a task's engine output as bounded, cursor-paged JSON: the
  engine's structured history when available, else a labeled terminal tail
  (`fallbackReason`). Read-only; the cursor stays pinned to one
  source/session and returns a typed `SOURCE_CHANGED` error when it moved.

### create

- `add --repo PATH [--title T] [--branch B] [--base-branch B] [--vendor V]
  [--status S] [--pin] [--activate] [--prompt TEXT]`: create a task
  (appears in the sidebar immediately). With `--prompt` it also
  materializes the worktree, starts the engine, and delivers the prompt.
  Does not steal focus unless `--activate`. Alias: `spawn-task`.
- `fan-out --repo PATH --prompt TEXT (--count N | --agents claude:2,codex:1)
  [--vendor V] [--title T] [--base-branch B]`: spawn N tasks of one prompt
  in a single call (parallel attempts). Capped at 10.

### drive

- `send [--task-id ID] --prompt TEXT`: paste a follow-up into a task's
  running engine (one full turn). Defaults to the active task.
  Directed delegation created by the TUI's `prefix+@` always uses an explicit
  id: primary → subagent for a bounded request, then subagent → primary for one
  structured result. The installed Kobe skill defines the v1 envelope and
  prevents this from becoming an unbounded chat loop.
- `dispatch --task-id ID --prompt TEXT`: route text into a task's live
  session via the daemon's `session.deliver` channel; requires an
  already-hosted session (the dispatcher's messenger; see
  [design/dispatcher.md](./design/dispatcher.md)).
- `note --task-id ID --text TEXT`: file a one-line field note (a resolved,
  repo-level gotcha); kobe forwards it to the repo's dispatcher session,
  which relays it to in-flight tasks.
- `set-active [--task-id ID] [--none]`: set (or clear) the shared active
  task every Tasks pane highlights.

### supervise

- `report --outcome succeeded|failed [--task-id ID] [--summary TEXT]`:
  worker-side. Files an EXPLICIT outcome for a task, stored verbatim as its
  `workerReport` (worker report, not kobe-verified; kobe never infers an
  outcome). Task defaults to `$KOBE_TASK_ID`, then the cwd's worktree.
- `await --task-ids a,b,c [--timeout-secs N]`: coordinator-side. Blocks
  (poll-free, on daemon push) until every listed task has a worker report,
  then returns all outcomes as JSON. A timeout is a checkpoint, not a
  failure: exit 0 with `{ timedOut: true, ... }` (default 900 s).

### edit

- `rename --task-id ID --title T`: set a task's title.
- `set-branch --task-id ID --branch B`: rename a task's branch
  (`git branch -m` if materialized, else recorded).
- `set-vendor --task-id ID --vendor V`: change the engine vendor (takes
  effect on next session rebuild).
- `set-status --task-id ID --status S`: set lifecycle status:
  `backlog`, `in_progress`, `in_review`, `done`, `canceled`, `error`.

### issues

The daemon-owned issue store (backlog; see
[WORK-TRACKING.md](./WORK-TRACKING.md)). Statuses: `open`, `doing`, `hold`,
`done`.

- `issue-list --repo PATH`: list a repo's issues.
- `issue-create --repo PATH --title T [--body TEXT]`: create an issue.
- `issue-set-status --repo PATH --id N --status S`: set an issue's status.
- `issue-update --repo PATH --id N [--title T] [--body TEXT] [--task ID]`:
  edit title/body and/or link a task (kanban: In progress; `--task none`
  unlinks).

### workitems

A **read-only** view of a repo's GitHub issues (through the `gh` CLI), plus one
action: start a task on one. Deliberately not an import — the issue stays
GitHub's, and nothing is copied into kobe's own issue store. Mechanics:
[design/work-items.md](./design/work-items.md).

- `workitem-list --repo PATH [--state open|closed|all] [--limit N] [--search Q]
  [--assignee USER] [--label L]`: list issues. `--assignee @me` for your own.
- `workitem-start --repo PATH --number N [--vendor V] [--base-branch B]`:
  create a task for issue N and start its engine with the issue title, body,
  and URL as the first message. The task keeps a `linkedWorkItem` pointing
  back, and its branch derives from the issue title
  (`kobe/307-memory-ce2e8j`).

Requires `gh` installed and authenticated; failures name which of those is
missing (`gh-missing` / `auth` / `no-remote`) rather than a generic error.

### routine

Scheduled agent tasks (Routines): a cron rule + a prompt + a repo. Every firing creates a
**fresh task** (worktree + branch + engine session) with the prompt as its
first message — a run is an ordinary task you can open and keep talking to.
An enabled routine keeps the daemon alive so schedules fire with no TUI
attached. Mechanics: [design/automations.md](./design/automations.md).

- `routine-list`: every routine with its next run time.
- `routine-create --repo PATH --name N --prompt TEXT --schedule CRON
  [--vendor V] [--base-branch B] [--precheck CMD] [--precheck-timeout SEC]
  [--grace MIN] [--disabled]`: schedule a prompt. `--schedule` is five-field
  cron in the daemon host's local time (`"0 9 * * MON-FRI"`).
- `routine-update --id ID [...]`: change any field. A new `--schedule`
  re-anchors the next run; `--precheck ''` clears the precheck.
- `routine-set-enabled --id ID --enabled BOOL`: pause / resume.
- `routine-run-now --id ID`: run immediately, skipping the precheck. Does
  not shift the schedule.
- `routine-runs --id ID`: run history, newest first.
- `routine-delete --id ID`: delete it and its history (tasks it already
  created are untouched).

**`--precheck`** runs a shell command in the repo before the engine starts;
a non-zero exit skips the run *without* creating a task. Use it so a schedule
does not burn a turn when nothing changed (`git log --since=24.hours --oneline
| grep -q .`). Run statuses distinguish `skipped_precheck` (healthy — nothing
to do) from `dispatch_failed` (needs a human).

### lifecycle

- `archive --task-id ID [--archived=false]`: archive/unarchive.
  Non-destructive: worktree, branch, and history stay.
- `pin --task-id ID [--pinned=false]`: pin/unpin a task to the top of the
  sidebar.
- `land --task-id ID [--strategy merge|squash] [--delete-branch]
  [--then-archive]`: merge a task's branch back into its base repo's
  current branch (`--no-ff` merge, or one squash commit). Refuses a dirty
  base checkout; on conflict it aborts and returns the conflicted files.
  Returns `{ landedOn, commit }`.
- `delete --task-id ID [--force]`: permanently remove a task **and its
  worktree**. Destructive; prefer `archive`. Needs `--force` on a dirty
  worktree.

### worktree

- `ensure-worktree --task-id ID`: materialize a task's git worktree on
  disk now (without starting an engine). Returns `{ worktreePath }`.
- `discover-adoptable --repo PATH`: list existing git worktrees not yet
  tracked as kobe tasks.
- `adopt --repo PATH --worktree PATH [--branch B] [--vendor V] [--title T]`:
  import an existing git worktree as a kobe task.

### feedback + other

- `feedback --title T --body TEXT [--category SLUG]` *(offline)*: create a
  GitHub Discussion in the kobe repo's Feedback category via `gh`.
- `notify --title TEXT [--kind KIND] [--task-id ID] [--source TAG]`: show
  a toast in every attached kobe UI. `done` / `needs_input` / `error` get
  severity styling; any other kind renders neutrally.
- `prompt --title TEXT [--placeholder T] [--initial T] [--timeout MS]`:
  ask the human for a line of text through the attached TUI's input dialog;
  blocks until answered/cancelled/timeout (default 120000 ms, max 600000)
  and returns `{ value }` or `{ cancelled, reason }`.

## Exit codes + output conventions (whole CLI)

There is no global exit-code registry; the conventions that hold across the
binary:

- **2**: malformed invocation everywhere: unknown command/verb/flag,
  missing required value. The error always comes with usage text.
- **1**: runtime failure (`kobe add` on a non-repo, `kobe config` with no
  editor, `kobe daemon status` with no daemon, plugin errors, ...).
- **0**: success, including "already in the requested state" (`daemon
  stop` with no daemon) and `kobe api await` timeouts. `kobe hook` exits 0
  unconditionally.
- **`kobe api`** is the only JSON-first surface (stdout JSON on success,
  JSON error envelope on stderr). Other subcommands print human text;
  machine-readable task data without a daemon is what `kobe export --json`
  is for. `kobe daemon status` prints status JSON when the daemon is up.

## Environment variables + state paths

Env vars the binary respects (accessor home: `packages/kobe/src/env.ts`):

- `KOBE_HOME_DIR`: override the home kobe persists under (everything below
  moves with it); used by tests and the dev sandbox.
- `KOBE_DAEMON_WEB_PORT`: daemon web transport port (default 5174;
  `0`/`off`/`false` disables it). `KOBE_WEB_HOST`,
  `KOBE_DAEMON_WEB_STATIC_DIR`: web transport host / static dir overrides.
- `KOBE_DEV=1`: declares a developer checkout (suppresses the
  update-available chip).
- `KOBE_DEBUG=1`: print full startup errors instead of the one-line
  message.
- `KOBE_TASK_ID` / `KOBE_TAB_ID`: exported into engine tabs; hooks and
  `kobe api report` resolve their task from these.

State layout (defaults; all under `KOBE_HOME_DIR` when set):

- `~/.kobe/`: task index (`tasks.json`), worktrees
  (`worktrees/<repo-key>/<task-slug>/`), daemon socket/pidfile/`daemon.log`,
  PTY host socket/pidfile/`pty-host.log`, plugins (`plugins.json`,
  `plugins/<id>/`), user themes (`themes/`), settings
  (`settings/keybindings.yaml`).
- `~/.config/kobe/state.json`: the KV user config `kobe config` opens.

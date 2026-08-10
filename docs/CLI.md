# CLI reference

The human index of everything the `kobe` binary does. The scriptable agent
surface has its own page: [`kobe api` reference](./API.md).

Two machine-readable surfaces stay authoritative when this page and the
binary disagree:

- `kobe --help`: the top-level command list. It is a single tested string
  (`packages/kobe/src/cli/usage.ts`); adding a subcommand fails CI until
  help and completions agree.
- `kobe api schema`: the full `kobe api` verb/flag spec as JSON. This is
  **the** source of truth for the scriptable surface: names, types,
  required flags, enum values. Agents should read it once and drill in with
  `--verb <name>` instead of parsing the docs.

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

Run with no command to launch PureTUI.
Run `kobe .` (or `kobe <path>`) to open a directory as a standalone task.

Commands:
  web [options]           Launch the browser dashboard
  completions <shell>     Generate shell completion script (bash/zsh/fish)
  add [path]              Save a repo path for the new-task picker
  remove [path]           Forget a saved project (inverse of add; non-destructive)
  adopt [glob]            Import existing git worktrees as tasks
  export [--csv|--json]   Print the task list (json/csv/table; daemon-free)
  repo <verb>             Per-repo init script + first prompt (show|set|unset)
  api <verb>              Scriptable RPC surface for agents (see `kobe api --help`)
  daemon <verb>           Manage the daemon (start|stop|status|restart)
  doctor [--report]        Diagnose daemon/PTY/engines/git; --report writes a bundle
  config [--path]          Open kobe's config file (state.json) in your editor
  reset [--hard]           Stop runtimes; optionally wipe task/UI state
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
kobe skill install [--agent NAME]…  # wraps `npx skills add <bundled path>`
kobe skill status
kobe skill command [--agent NAME]…  # print the npx command without running it
```

Installs the kobe agent skill, the thing that teaches a coding agent how
to drive `kobe api`. `kobe doctor` reports the skill as missing/stale and
points here.

**Which agent** is the agent-skills CLI's call, not kobe's: with no
`--agent` it detects your installed agents and asks. It writes the real
SKILL.md to `.agents/skills/kobe/` and symlinks the agent-specific dirs
(`.claude/skills/kobe` → `../../.agents/skills/kobe`) at it. To name agents
yourself, repeat the flag — `--agent claude-code --agent codex`; a
comma-joined list is rejected rather than silently using only the first.

**No download.** The skill ships inside the npm package, so install points
the CLI at that local copy. `npx skills add Sma1lboy/kobe` also works but
does a `git clone --depth 1` — ~198MB of working tree for an 8KB file,
which is unusable on a slow connection. Use it only without kobe installed.

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

Everything the TUI can do, driven from a shell script or another AI agent:
spawn tasks, fan a prompt across N isolated attempts, supervise them, read
their output, land the winner. Each invocation is a short-lived process that
prints one JSON object and exits.

Full verb reference — including the fan-out / supervise / observe / fan-in
loop and the output + exit-code contract — lives in the
[`kobe api` reference](./API.md). `kobe api schema` stays the machine-readable
source of truth, and `kobe skill install` teaches a coding agent the surface
without pasting docs into a prompt.

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
- `KOBE_OPEN_EDITOR`: command that opens a worktree in an external editor
  (`code`, `cursor`, `nvim`, …), used by `prefix+o` / the sidebar's `o`.
  It wins over kobe's auto-detection of installed editors, and the TUI's
  "No editor found" toast names this variable. Separate from the
  `editor.*` config keys, which pick the TTY editor for `kobe config` and
  the file tree's `e` (see [Configuration](./CONFIGURATION.md)).
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

# CLI reference

Everything the `rove` and `kobe` binaries do. The scriptable surface for agents and
scripts has its own page: [`rove api`](./API.md).

Two things stay authoritative if this page and the binary ever disagree:
`rove --help` for the command list, and `rove api schema` for the `rove api`
surface.

## Install and update

Needs Bun ≥ 1.3.11, git, and at least one engine CLI on `PATH`.

```bash
bun install -g @sma1lboy/rove   # install
bunx @sma1lboy/rove             # try without installing
```

The installed package exposes both `rove` and `kobe`. `rove` is the canonical
entry point; `kobe` remains a fully supported compatibility alias. They run the
same commands against the same daemon, worktrees, and persisted state. This
rename uses `~/.rove` and `~/.config/rove/state.json` for canonical product
data. First launch copies supported legacy data without overwriting or removing
the old files; runtime and plugin paths retain their compatibility names.

```bash
rove update            # latest
rove update 0.7.90     # pin a version
rove update list       # browse recent versions
rove update dry-run    # print the command without running it
```

rove updates using whichever package manager owns the `rove` on your `PATH`,
so the new version can't land in a shadowed prefix. Manual fallback:
`npm install -g @sma1lboy/rove@latest`.

Some versions are marked breaking. Installing across one prints a heads-up,
and the next launch asks you to run `rove reset` first. Worktrees are never
touched.

## Launching

```bash
rove            # the TUI (first run: onboarding wizard)
rove .          # open a directory as a task — the `code .` gesture
rove web        # the browser dashboard on http://localhost:45174
```

A typo never silently opens the TUI: an unknown subcommand prints usage and
exits 2.

## All commands

```text
Usage: rove [command] [options]

Commands:
  web [options]           Launch the browser dashboard
  completions <shell>     Generate shell completion script (bash/zsh/fish)
  add [path]              Save a repo path for the new-task picker
  remove [path]           Forget a saved project (inverse of add; non-destructive)
  adopt [glob]            Import existing git worktrees as tasks
  export [--csv|--json]   Print the task list (json/csv/table; daemon-free)
  repo <verb>             Per-repo init script + first prompt (show|set|unset)
  api <verb>              Scriptable RPC surface for agents (see `rove api --help`)
  daemon <verb>           Manage the daemon (start|stop|status|restart)
  doctor [--report]       Diagnose daemon/PTY/engines/git; --report writes a bundle
  config [--path]         Open Rove's config file (state.json) in your editor
  reset [--hard]          Stop runtimes; optionally wipe task/UI state
  theme <verb>            Manage user themes (list|add|remove)
  skill <verb>            Install the Rove agent skill (install|status|command|print)
  plugin <verb>           Install and run plugins (install|link|list|action|…)
  feedback                Send feedback to GitHub Discussions
  update [version|list]   Self-update Rove, or browse versions with `list`

Options:
  -v, --version           Print version
  -h, --help              Print this help
  --skill                 Print the agent skill file and exit
```

## Managing projects

```bash
rove add [path]      # save a repo for the new-task picker (defaults to .)
rove remove [path]   # forget it — files, worktrees, and tasks all stay
rove adopt [glob]    # import existing git worktrees as tasks
```

`rove add` needs a real git repo. It creates the project's sidebar row and
folds in any existing unlinked worktrees as tasks.

`rove adopt` with no glob is a dry run that lists what it would import; pass
a glob to filter (`rove adopt 'feature-*'`) and `--yes` to actually do it.

**Remote projects** (experimental — enable Settings → Dev → Experimental
first) run their worktrees and engine on another host over SSH:

```bash
rove add --remote --host <host> --user <user> --path <basePath> \
         [--port N] [--key [path] | --password]
```

Auth is either `--key` (ssh-agent when you omit the path) or `--password`,
which is prompted and stored in your OS keychain — never in `state.json`.

## web

```bash
rove web [--port <n>]
```

Serves the dashboard on `:45174`, plus a sidecar for browser terminal tabs.
`KOBE_DAEMON_WEB_PORT` sets the port globally (`0`/`off`/`false` disables it).

## completions

```bash
source <(rove completions zsh)
rove completions bash > ~/.bash_completion.d/rove
rove completions fish > ~/.config/fish/completions/rove.fish
```

Completes subcommands; each subcommand owns its own flags.

## export

```bash
rove export [--json | --csv | --format <json|csv|table>]
```

Prints your task list. Read-only and **works with the daemon down**, which is
what makes it different from `rove api list`. Columns: `id, title, status,
archived, vendor, branch, repo, worktreePath`. Default is JSON; `--format
table` aligns it for humans.

## config

```bash
rove config [--path]
```

Opens `~/.config/rove/state.json` in your editor. See
[Configuration](./CONFIGURATION.md).

## theme

```bash
rove theme list
rove theme add <url|path> [--name <name>] [--force]
rove theme remove <name>
```

User themes land in `~/.rove/themes/` and can shadow a bundled name. Bundled
themes can't be removed. See [Themes](./themes.md).

## repo

```bash
rove repo show [path]
rove repo set [path] --init-script <text> | --init-script-file <path>
                    [--init-prompt <text> | --init-prompt-file <path>]
rove repo unset [path] [--init-script] [--init-prompt]
```

Sets a per-user init override for a repo. If the repo commits its own
`.rove/init.sh` / `.rove/init-prompt.md`, those win. Legacy `.kobe` files are
field-by-field fallbacks. Path defaults to the current directory. `unset` with
no flag clears both.

## skill

```bash
rove skill install [--project] [--agent NAME]…
rove skill status
rove skill command [--project] [--agent NAME]…   # print the command without running it
rove skill print                                 # print the SKILL.md itself
```

Installs the Rove agent skill — what teaches a coding agent to drive
`rove api`. Installs are **global** (user-level) by default: the skill
drives a machine-wide daemon, so one copy per machine keeps one staleness
lifecycle; `--project` installs into the current project instead. With no
`--agent` it detects your installed agents and asks. To name them yourself,
repeat the flag (`--agent claude-code --agent codex`); a comma-joined list
is rejected rather than silently using only the first.

The skill ships inside the npm package, so nothing is downloaded.

`rove --skill` (top-level flag) is shorthand for `rove skill print`: it dumps
the bundled SKILL.md to stdout so an agent can learn the `rove api` surface in
one command — e.g. prompt your agent with ``read `rove --skill` then fan out
tasks``, no pre-installed skill required.

## plugin

```text
rove plugin install <owner/repo[/subdir]> [--yes] [--ref <rev>]
rove plugin link <dir>                         register a local directory (dev)
rove plugin list                               installed + linked plugins
rove plugin search [query]                     browse the marketplace
rove plugin outdated                           check installs against upstream
rove plugin update <id…> | --all [--yes]       reinstall stale plugins
rove plugin enable <id> | disable <id>         toggle without unregistering
rove plugin unlink <id>                        unregister a linked plugin
rove plugin uninstall <id-or-spec>             unregister + remove the checkout
rove plugin config-dir <id>                    print its config directory
rove plugin log <id> [-n <count>]              tail its command log
rove plugin action list [--plugin <id>]
rove plugin action invoke <plugin-id.action-id> [args…]
rove plugin pane open <plugin-id.pane-id> [--task <task-id>]
```

Changes apply to a running daemon without a restart. Writing one:
[Plugin authoring](./PLUGIN-AUTHORING.md). Marketplace:
<https://github.com/topics/kobe-plugin>.

## doctor

```bash
rove doctor [--report]
```

Read-only check of your build, terminal, git, engine CLIs and logins, daemon,
running sessions, agent skill, and state files. Never changes anything.
`--report` also writes a bug bundle (diagnosis + recent logs + env) and
prints its path — attach that to bug reports. See
[Troubleshooting](./TROUBLESHOOTING.md).

## reset

```bash
rove reset [--hard] [--yes]
```

Recovers a wedged install: stops the daemon and the PTY host (ending all
background sessions). **Never touches git worktrees.** `--hard` also deletes
your task index and UI state. Asks for confirmation unless `--yes`.

## daemon

```bash
rove daemon status     # status JSON; exit 1 when nothing is running
rove daemon start      # run in the FOREGROUND (this process becomes it)
rove daemon stop
rove daemon restart    # stop, then respawn in the background
```

The daemon auto-starts when the TUI or `rove api` needs it, so `start` is
mainly for debugging. Logs are at `~/.kobe/daemon.log` — read them first when
something's wrong.

> **Working on Rove itself?** Run `rove daemon restart` after editing
> daemon/orchestrator/engine code. Bun doesn't hot-reload.

## feedback

```bash
rove feedback --title <text> (--body <text> | --body-file <path>) [--category <slug>]
```

Opens a GitHub Discussion via the `gh` CLI (needs `gh auth login`).
`--body-file -` reads from stdin.

## Internal subcommands

Not in `--help`, listed so they aren't a mystery if you see them:

- **`rove pty-host`** — the process that owns embedded terminals so they
  survive TUI exits and daemon restarts. Spawned automatically.
- **`rove hook <verb>`** — fired by an engine's own hooks to report activity.
  It always exits 0 and never starts the daemon, so it can't fail your engine.

## Exit codes

- **0** — success, including "already in that state" (`daemon stop` with no
  daemon).
- **1** — runtime failure: `rove add` on a non-repo, no editor found, no
  daemon for `daemon status`, plugin errors.
- **2** — bad invocation: unknown command, verb, or flag; missing value.
  Always comes with usage text.

`rove api` is the JSON-first surface (JSON on stdout, a JSON error envelope on
stderr). Everything else prints human text — for machine-readable task data
without a daemon, use `rove export --json`.

## Environment variables

Every user-supplied `KOBE_*` variable also accepts the corresponding `ROVE_*`
name. If both are set, `ROVE_*` wins. The established names below remain valid
for compatibility; for example, `ROVE_HOME_DIR` takes precedence over
`KOBE_HOME_DIR`, and `ROVE_OPEN_EDITOR` takes precedence over
`KOBE_OPEN_EDITOR`.

| Variable | What it does |
|---|---|
| `KOBE_HOME_DIR` | Move everything Rove persists somewhere else |
| `KOBE_OPEN_EDITOR` | Command that opens a worktree in a GUI editor (`code`, `cursor`, …) |
| `KOBE_DAEMON_WEB_PORT` | Web dashboard port (default 45174; `0`/`off` disables) |
| `KOBE_DEV=1` | Mark a developer checkout — hides the update chip |
| `KOBE_DEBUG=1` | Print full startup errors instead of one line |
| `ROVE_TASK_ID` / `ROVE_TAB_ID` | Set inside engine tabs; how `rove api` verbs resolve the calling task |
| `KOBE_TASK_ID` / `KOBE_TAB_ID` | Compatibility aliases exported beside the Rove names |

`KOBE_OPEN_EDITOR` wins over Rove's auto-detection, and it's separate from the
`editor.*` settings, which pick your TTY editor.

## Where state lives

Canonical product data under `~/.rove/` (or `ROVE_HOME_DIR`, with
`KOBE_HOME_DIR` as fallback):

- `tasks.json` — the task index
- `worktrees/<repo-key>/<task-slug>/` — per-task worktrees
- `themes/`, `settings/keybindings.yaml`, issues, notes, and automations

Plus `~/.config/rove/state.json`, the settings file `rove config` or
`kobe config` opens. Existing `~/.kobe/worktrees` paths remain recognized and
are never copied or rewritten. Daemon/PTY runtime files and `plugins.json` +
`plugins/<id>/` deliberately remain under `~/.kobe` for continuity. The first
launch copies other supported legacy data additively and never deletes the
source or overwrites canonical files. Daemon-owned stores are copied at
new-daemon startup, only after the legacy writer has stopped.

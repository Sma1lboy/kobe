# CLI reference

Everything the `kobe` binary does. The scriptable surface for agents and
scripts has its own page: [`kobe api`](./API.md).

Two things stay authoritative if this page and the binary ever disagree:
`kobe --help` for the command list, and `kobe api schema` for the `kobe api`
surface.

## Install and update

Needs Bun ≥ 1.3.11, git, and at least one engine CLI on `PATH`.

```bash
bun install -g @sma1lboy/kobe   # install
bunx @sma1lboy/kobe             # try without installing
```

```bash
kobe update            # latest
kobe update 0.7.90     # pin a version
kobe update list       # browse recent versions
kobe update dry-run    # print the command without running it
```

kobe updates using whichever package manager owns the `kobe` on your `PATH`,
so the new version can't land in a shadowed prefix. Manual fallback:
`npm install -g @sma1lboy/kobe@latest`.

Some versions are marked breaking. Installing across one prints a heads-up,
and the next launch asks you to run `kobe reset` first. Worktrees are never
touched.

## Launching

```bash
kobe            # the TUI (first run: onboarding wizard)
kobe .          # open a directory as a task — the `code .` gesture
kobe web        # the browser dashboard on http://localhost:5174
```

A typo never silently opens the TUI: an unknown subcommand prints usage and
exits 2.

## All commands

```text
Usage: kobe [command] [options]

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
  doctor [--report]       Diagnose daemon/PTY/engines/git; --report writes a bundle
  config [--path]         Open kobe's config file (state.json) in your editor
  reset [--hard]          Stop runtimes; optionally wipe task/UI state
  theme <verb>            Manage user themes (list|add|remove)
  skill <verb>            Install the kobe agent skill (install|status|command|print)
  plugin <verb>           Install and run plugins (install|link|list|action|…)
  feedback                Send feedback to GitHub Discussions
  update [version|list]   Self-update kobe, or browse versions with `list`

Options:
  -v, --version           Print version
  -h, --help              Print this help
  --skill                 Print the agent skill file and exit
```

## Managing projects

```bash
kobe add [path]      # save a repo for the new-task picker (defaults to .)
kobe remove [path]   # forget it — files, worktrees, and tasks all stay
kobe adopt [glob]    # import existing git worktrees as tasks
```

`kobe add` needs a real git repo. It creates the project's sidebar row and
folds in any existing unlinked worktrees as tasks.

`kobe adopt` with no glob is a dry run that lists what it would import; pass
a glob to filter (`kobe adopt 'feature-*'`) and `--yes` to actually do it.

**Remote projects** (experimental — enable Settings → Dev → Experimental
first) run their worktrees and engine on another host over SSH:

```bash
kobe add --remote --host <host> --user <user> --path <basePath> \
         [--port N] [--key [path] | --password]
```

Auth is either `--key` (ssh-agent when you omit the path) or `--password`,
which is prompted and stored in your OS keychain — never in `state.json`.

## web

```bash
kobe web [--port <n>]
```

Serves the dashboard on `:5174`, plus a sidecar for browser terminal tabs.
`KOBE_DAEMON_WEB_PORT` sets the port globally (`0`/`off`/`false` disables it).

## completions

```bash
source <(kobe completions zsh)
kobe completions bash > ~/.bash_completion.d/kobe
kobe completions fish > ~/.config/fish/completions/kobe.fish
```

Completes subcommands; each subcommand owns its own flags.

## export

```bash
kobe export [--json | --csv | --format <json|csv|table>]
```

Prints your task list. Read-only and **works with the daemon down**, which is
what makes it different from `kobe api list`. Columns: `id, title, status,
archived, vendor, branch, repo, worktreePath`. Default is JSON; `--format
table` aligns it for humans.

## config

```bash
kobe config [--path]
```

Opens `~/.config/kobe/state.json` in your editor. See
[Configuration](./CONFIGURATION.md).

## theme

```bash
kobe theme list
kobe theme add <url|path> [--name <name>] [--force]
kobe theme remove <name>
```

User themes land in `~/.kobe/themes/` and can shadow a bundled name. Bundled
themes can't be removed. See [Themes](./themes.md).

## repo

```bash
kobe repo show [path]
kobe repo set [path] --init-script <text> | --init-script-file <path>
                    [--init-prompt <text> | --init-prompt-file <path>]
kobe repo unset [path] [--init-script] [--init-prompt]
```

Sets a per-user init override for a repo. If the repo commits its own
`.kobe/init.sh` / `.kobe/init-prompt.md`, those win. Path defaults to the
current directory. `unset` with no flag clears both.

## skill

```bash
kobe skill install [--agent NAME]…
kobe skill status
kobe skill command [--agent NAME]…   # print the command without running it
kobe skill print                     # print the SKILL.md itself
```

Installs the kobe agent skill — what teaches a coding agent to drive
`kobe api`. With no `--agent` it detects your installed agents and asks. To
name them yourself, repeat the flag (`--agent claude-code --agent codex`); a
comma-joined list is rejected rather than silently using only the first.

The skill ships inside the npm package, so nothing is downloaded.

`kobe --skill` (top-level flag) is shorthand for `kobe skill print`: it dumps
the bundled SKILL.md to stdout so an agent can learn the `kobe api` surface in
one command — e.g. prompt your agent with ``read `kobe --skill` then fan out
tasks``, no pre-installed skill required.

## plugin

```text
kobe plugin install <owner/repo[/subdir]> [--yes] [--ref <rev>]
kobe plugin link <dir>                         register a local directory (dev)
kobe plugin list                               installed + linked plugins
kobe plugin search [query]                     browse the marketplace
kobe plugin outdated                           check installs against upstream
kobe plugin update <id…> | --all [--yes]       reinstall stale plugins
kobe plugin enable <id> | disable <id>         toggle without unregistering
kobe plugin unlink <id>                        unregister a linked plugin
kobe plugin uninstall <id-or-spec>             unregister + remove the checkout
kobe plugin config-dir <id>                    print its config directory
kobe plugin log <id> [-n <count>]              tail its command log
kobe plugin action list [--plugin <id>]
kobe plugin action invoke <plugin-id.action-id> [args…]
kobe plugin pane open <plugin-id.pane-id> [--task <task-id>]
```

Changes apply to a running daemon without a restart. Writing one:
[Plugin authoring](./PLUGIN-AUTHORING.md). Marketplace:
<https://github.com/topics/kobe-plugin>.

## doctor

```bash
kobe doctor [--report]
```

Read-only check of your build, terminal, git, engine CLIs and logins, daemon,
running sessions, agent skill, and state files. Never changes anything.
`--report` also writes a bug bundle (diagnosis + recent logs + env) and
prints its path — attach that to bug reports. See
[Troubleshooting](./TROUBLESHOOTING.md).

## reset

```bash
kobe reset [--hard] [--yes]
```

Recovers a wedged install: stops the daemon and the PTY host (ending all
background sessions). **Never touches git worktrees.** `--hard` also deletes
your task index and UI state. Asks for confirmation unless `--yes`.

## daemon

```bash
kobe daemon status     # status JSON; exit 1 when nothing is running
kobe daemon start      # run in the FOREGROUND (this process becomes it)
kobe daemon stop
kobe daemon restart    # stop, then respawn in the background
```

The daemon auto-starts when the TUI or `kobe api` needs it, so `start` is
mainly for debugging. Logs are at `~/.kobe/daemon.log` — read them first when
something's wrong.

> **Working on kobe itself?** Run `kobe daemon restart` after editing
> daemon/orchestrator/engine code. Bun doesn't hot-reload.

## feedback

```bash
kobe feedback --title <text> (--body <text> | --body-file <path>) [--category <slug>]
```

Opens a GitHub Discussion via the `gh` CLI (needs `gh auth login`).
`--body-file -` reads from stdin.

## Internal subcommands

Not in `--help`, listed so they aren't a mystery if you see them:

- **`kobe pty-host`** — the process that owns embedded terminals so they
  survive TUI exits and daemon restarts. Spawned automatically.
- **`kobe hook <verb>`** — fired by an engine's own hooks to report activity.
  It always exits 0 and never starts the daemon, so it can't fail your engine.

## Exit codes

- **0** — success, including "already in that state" (`daemon stop` with no
  daemon) and `kobe api await` timeouts.
- **1** — runtime failure: `kobe add` on a non-repo, no editor found, no
  daemon for `daemon status`, plugin errors.
- **2** — bad invocation: unknown command, verb, or flag; missing value.
  Always comes with usage text.

`kobe api` is the JSON-first surface (JSON on stdout, a JSON error envelope on
stderr). Everything else prints human text — for machine-readable task data
without a daemon, use `kobe export --json`.

## Environment variables

| Variable | What it does |
|---|---|
| `KOBE_HOME_DIR` | Move everything kobe persists somewhere else |
| `KOBE_OPEN_EDITOR` | Command that opens a worktree in a GUI editor (`code`, `cursor`, …) |
| `KOBE_DAEMON_WEB_PORT` | Web dashboard port (default 5174; `0`/`off` disables) |
| `KOBE_DEV=1` | Mark a developer checkout — hides the update chip |
| `KOBE_DEBUG=1` | Print full startup errors instead of one line |
| `KOBE_TASK_ID` / `KOBE_TAB_ID` | Set inside engine tabs; how `kobe api report` finds its task |

`KOBE_OPEN_EDITOR` wins over kobe's auto-detection, and it's separate from the
`editor.*` settings, which pick your TTY editor.

## Where state lives

Under `~/.kobe/` (or `KOBE_HOME_DIR`):

- `tasks.json` — the task index
- `worktrees/<repo-key>/<task-slug>/` — per-task worktrees
- `daemon.log`, `pty-host.log` and their sockets
- `plugins.json` + `plugins/<id>/`, `themes/`, `settings/keybindings.yaml`

Plus `~/.config/kobe/state.json`, the settings file `kobe config` opens.

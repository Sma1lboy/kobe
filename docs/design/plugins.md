# Plugins

Status: v1 shipped (manifest + CLI + daemon runtime + marketplace page).
Developer-facing contract/reference: [../PLUGIN-AUTHORING.md](../PLUGIN-AUTHORING.md).
Model: deliberately isomorphic to herdr's plugin system
(https://herdr.dev/docs/plugins/) — same philosophy, Rove's domain.

## Philosophy

A plugin is a directory with a `rove-plugin.toml` manifest and argv commands
Rove can launch. There is **no required plugin SDK**: the whole `rove` CLI
(every `rove api` verb) and the daemon socket are the plugin API. Rove owns the host
surface — install, validation, event dispatch, env injection, run logs. The
plugin owns its language, dependencies, and durable state.

Plugins exist so the core stays lean: workflows that don't belong in every
install (notifications, issue-tracker bridges, layout bootstrap) become
shareable packages instead of feature requests.

The manifest shape mirrors herdr's on purpose. Their ecosystem (396 repos on
the `herdr-plugin` GitHub topic as of 2026-07) proves the shape works, and an
author porting a plugin between the two only renames the manifest and swaps
`HERDR_*`/`herdr` for `ROVE_*`/`rove api`.

## Manifest — `rove-plugin.toml`

```toml
id = "example.notify"            # letters/digits/dot/colon/underscore/hyphen
name = "Notify"
version = "0.1.0"
min_rove_version = "0.8.23"      # oldest Rove this plugin works on; install refuses older
description = "…"                # optional
platforms = ["macos", "linux"]   # optional; item-level `platforms` overrides

[[build]]                        # GitHub install only, after preview confirm
command = ["bun", "install"]

[[startup]]                      # once per daemon start, after socket is ready
command = ["node", "restore.js"]

[[actions]]                      # invoked on demand: rove plugin action invoke <id>.<action>
id = "test"                      # local id, no dots
title = "Send a test notification"
command = ["sh", "notify.sh", "test"]

[[events]]                       # fired by the daemon on derived events
on = "agent.turn-complete"
command = ["sh", "notify.sh"]

[[panes]]                        # a terminal tab in the task workspace
id = "git"
title = "lazygit"
command = ["lazygit"]            # cwd = the task worktree; use $ROVE_PLUGIN_ROOT/... for plugin files
```

`command` is argv — never run through a shell. Parsing/validation:
`packages/kobe-daemon/src/plugins/manifest.ts` (unknown event names are a
warning, not an error, for forward compat).

## Events (v1)

Beyond the product-layer table below, plugins subscribe to the full
engine-agnostic agent lifecycle — `session.*`, `turn.*`, `tool.*`,
`attention.*`, `context.*-compact`, `subagent.*` — normalized across
Claude Code and Codex. Catalog, payload envelope, and gating:
[plugin-events.md](./plugin-events.md).

Derived from daemon push channels by `plugins/events.ts` (channels are
last-value state; the reducer emits edges, and the first `task.snapshot`
after daemon start is baseline — no replay storms):

| event | source |
|---|---|
| `task.created` / `task.deleted` | `task.snapshot` diff |
| `worktree.created` | `task.jobs` ensureWorktree → done |
| `agent.running` / `agent.idle` / `agent.turn-complete` / `agent.permission-needed` / `agent.rate-limited` / `agent.error` | `engine-state` transitions, per task+tab |

## Runtime env contract

Injected for every plugin command (`plugins/env.ts`; shared by the daemon
host and `rove plugin action invoke`):

- `ROVE_BIN_PATH` — exec this to call back into Rove (portable across dev/packaged)
- `ROVE_SOCKET_PATH` — daemon socket, for raw JSON requests
- `ROVE_HOME_DIR` — passed through so sandbox daemons keep their isolation
- `ROVE_PLUGIN_ID`, `ROVE_PLUGIN_ROOT`
- `ROVE_PLUGIN_CONFIG_DIR` — user-editable config (`.env` etc.); survives reinstall
- `ROVE_PLUGIN_STATE_DIR` — plugin-owned runtime state; survives reinstall
- events: `ROVE_PLUGIN_EVENT`, `ROVE_PLUGIN_EVENT_JSON`, plus plain
  `ROVE_PLUGIN_TASK_ID` / `ROVE_PLUGIN_TASK_TITLE` so shell plugins skip JSON
- startup: `ROVE_PLUGIN_EVENT=startup`
- actions: `ROVE_PLUGIN_ACTION_ID`, `ROVE_PLUGIN_INVOKE_CWD` (where the user
  ran the invoke — "the repo I mean"), extra CLI args appended to argv

Every canonical variable is also injected as a `KOBE_*` compatibility alias.
Do not store durable state under `ROVE_PLUGIN_ROOT`: GitHub installs are
managed checkouts, replaced on reinstall.

## Install / registry / layout

`rove plugin install owner/repo[/subdir]` (GitHub shorthand only): clone →
parse manifest → preview commands + confirm (`--yes` to skip, refused
non-interactively without it) → run `[[build]]` → move under
`~/.kobe/plugins/<id>/checkout/` → register. `rove plugin link <dir>` for
local authoring (no build; your tree, your build). `uninstall` removes the
managed checkout but keeps `config/` + `state/`; `unlink` never touches files.

Registry: `~/.kobe/plugins.json`, written only by the CLI. The daemon
(`plugins/runtime.ts`, wired in `daemon/server.ts`) file-watches it, so
install/enable/disable apply to a running daemon without a restart. Run log:
`~/.kobe/plugins/<id>/log.jsonl` (`rove plugin log <id>`), stdout/stderr
capped at 8 KB per run.

Trust model is herdr's: plugins are ordinary code running as you; Rove
validates the manifest and previews commands but does not sandbox or review.

## Marketplace

Zero infrastructure: the canonical GitHub topic is **`rove-plugin`**. Search
also unions the legacy **`kobe-plugin`** topic, so existing publishers stay listed.
The landing page (`packages/kobe-landing/plugins.html`, rove.sma1lboy.me)
queries GitHub's repo search client-side and lists tagged public repos;
first-party examples live in [Sma1lboy/kobe-plugins](https://github.com/Sma1lboy/kobe-plugins) (topic-tagged, so the repo auto-lists) and also seed the list per-plugin. No
submission, no review queue. If the unauthenticated search rate limit ever
bites, the upgrade path is herdr's ~400-line Cloudflare worker index.

## Panes

`rove plugin pane open <plugin-id>.<pane-id>` (defaults to the active task)
→ `tab.open` RPC → the daemon validates and broadcasts → the TUI hosting the
task places the pane. Default placement is **`split`** (owner semantics
2026-07-29): the pane joins the focused chattab's split group beside the
engine — herdr's `placement = "split"`. `placement = "tab"` opens a separate
self-closing command tab instead; overlay/popup are tolerated with a warning
and treated as split. Falls back to a tab when the active tab can't host a
split (content tab / min-pane-size gate). The pane's cwd is the task
worktree;
`$ROVE_PLUGIN_ROOT` (or legacy `$KOBE_PLUGIN_ROOT`) in command elements is expanded by the CLI, and the
plugin env contract rides an `env` prefix inside one `sh -lc` script, so no
tab/PTY schema knows about plugins. Trust: same boundary as `pty.open` —
the daemon socket already grants argv execution.

## In-TUI entry points

`ctrl+e` (the tab picker) lists every enabled plugin's panes after the
engines and the shell — picking one opens it with the pane's placement.
Launch composition is shared with the CLI (`plugins/pane-command.ts`).

## Keybindings

Users bind their own chords to plugin panes/actions via the `plugins:`
section of `~/.rove/settings/keybindings.yaml`
(`ctrl+g: pane:examples.lazygit.git`) — Rove ships no default plugin chords.
Mechanics + resolution record: docs/KEYBINDINGS.md §Plugin chords.

## Deferred (v2+, deliberate)

- **Pane placements** beyond `split`/`tab` (overlay / popup) and Windows
  pane support (the v1 wrap is `sh -lc`).
- **Link handlers** — needs the terminal URL-click plumbing.
- **Richer context JSON** (active task, selection) on action invokes.
- **`plugin update`** — reinstall replaces the checkout, same as herdr v1.

## What the herdr ecosystem says people actually build

Survey of the 396 `herdr-plugin` repos (2026-07-28), by demand signal:

1. **Notifications / remote monitoring** — the biggest cluster by far
   (ntfy/Telegram bridges, macOS toasts, phone PWAs, mobile relays; top repos
   1.2k/325/148/145 stars). Rove: `examples.notify`; the attention inbox
   covers the in-TUI half natively.
2. **Worktree/workspace bootstrap** — declarative layouts, worktree-from-PR/
   issue/Linear, copy-env-into-worktree, per-project setup. Rove:
   `examples.github-start`, `examples.worktree-include`; `.rove/init.sh`
   already covers in-worktree setup.
3. **Sidebar tools in panes** — file viewers, lazygit, kanban boards, PR
   review TUIs. Blocked on pane support (v2).
4. **Session/agent management** — handoff between engines, session parking,
   auto-rename, usage dashboards. Rove ships auto-title, quota-resume, and
   telemetry natively; the gap is third-party experimentation space.
5. **Navigation/pickers** — fuzzy switchers, vim-style pane nav. Mostly
   TUI-internal for Rove; revisit with panes.

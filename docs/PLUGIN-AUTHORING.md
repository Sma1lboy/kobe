# Writing Rove plugins

The developer-facing reference: everything a plugin can declare, every event
Rove fires, every environment variable it injects, and every way to call
back in. Design rationale lives in [design/plugins.md](./design/plugins.md)
and [design/plugin-events.md](./design/plugin-events.md); this page is the
contract.

A plugin is **a directory with a `rove-plugin.toml` manifest** plus any argv
commands your machine can run: Bash, Node, Bun, Python, Rust, a prebuilt
binary. No SDK is required: the whole `rove` CLI and the daemon socket are the
plugin API, with an optional TypeScript SDK described below. Rove owns the host
surface (install, validation, event dispatch, env injection, panes, settings
UI, run logs); you own the implementation.

## Quickstart

```bash
mkdir my-plugin && cd my-plugin
cat > rove-plugin.toml <<'EOF'
id = "you.hello"
name = "Hello"
version = "0.1.0"
min_rove_version = "0.8.24"

[[events]]
on = "agent.turn-complete"
command = ["sh", "-c", "echo \"$ROVE_PLUGIN_TASK_TITLE finished a turn\" >> \"$ROVE_PLUGIN_STATE_DIR/log\""]
EOF

rove plugin link .            # register your working directory (dev loop)
rove plugin log you.hello     # inspect hook runs (exit codes, output, timing)
```

## Optional SDK (TypeScript)

The contract above is the API: any language, no SDK required. For
TypeScript/JavaScript authors, **`@sma1lboy/rove-plugin-sdk`** wraps that
same contract with types and autocomplete (zero deps, Node ≥ 18 or Bun):

```ts
import { pluginContext, pluginEvent, notify, Pane, RoveSocket } from "@sma1lboy/rove-plugin-sdk"

const ctx = pluginContext()   // typed ROVE_PLUGIN_* env
const ev = pluginEvent()      // typed event envelope (null outside [[events]])
```

- `pluginContext()` / `pluginEvent()`: the env contract, typed.
- `readSettings()` / `setting()`: your `[[settings]]` values from config `.env`.
- `rove()` / `roveJson()` + `notify` / `dispatch` / `listTasks` / `openPane`:
  `$ROVE_BIN_PATH` callbacks.
- `RoveSocket`: daemon socket client: `request(name, payload)` + live
  channel `subscribe` (always `role: "pane"`).
- `Pane`: a tiny pane kit for `[[panes]]` pages: alt screen, raw-mode
  keys, resize, absolute-addressed `draw(lines)`.
- `PLUGIN_EVENT_NAMES` / `DAEMON_CHANNELS`: the catalogs as typed unions.
  These are the SINGLE source: the daemon itself imports them from the
  SDK's `./contract` module, so host and SDK can't drift by construction.

Package README has full examples: `packages/kobe-plugin-sdk/README.md`.

Publish: push a public GitHub repo (one plugin per subdirectory is fine),
add the topic **`rove-plugin`** → it appears in the marketplace
([kobe.sma1lboy.me/plugins](https://kobe.sma1lboy.me/plugins) and
`rove plugin search`) automatically. Users install with
`rove plugin install owner/repo[/subdir]` and stay fresh with
`rove plugin outdated` / `rove plugin update --all` (an update is a clean
reinstall of the managed checkout; config/state survive).

## Manifest reference

```toml
id = "you.example"               # letters/digits/dot/colon/underscore/hyphen
name = "Example"
version = "0.1.0"
min_rove_version = "0.8.24"      # install refuses older Rove versions
description = "…"                # optional
platforms = ["macos", "linux", "windows"] # optional; item-level override

[[build]]                        # runs at GitHub install (after preview confirm), cwd = checkout
command = ["npm", "install"]     # self-provision deps INTO the plugin dir; `link` skips build

[[startup]]                      # once per daemon start, after the socket is ready; one-shot, not a daemon
command = ["node", "restore.js"]

[[actions]]                      # on-demand: rove plugin action invoke you.example.greet [args…]
id = "greet"                     # local id, no dots; extra CLI args append to argv
title = "Say hello"
command = ["sh", "greet.sh"]

[[events]]                       # async observer fired by the daemon (catalog below)
on = "agent.turn-complete"
command = ["sh", "notify.sh"]

[[panes]]                        # a terminal surface in the task workspace
id = "board"
title = "Board"
placement = "split"              # split (default: joins the focused chattab's
                                 # split group beside the engine) | tab (own tab)
command = ["node", "$ROVE_PLUGIN_ROOT/board.js"]   # cwd = the TASK WORKTREE

[[settings]]                     # rendered as an editor in Settings → Plugins
key = "YOU_EXAMPLE_MODE"         # stored as KEY=value in your config .env
label = "Mode"
type = "enum"                    # string | number | boolean | enum
options = ["fast", "fancy"]
default = "fast"

[[file_handlers]]                # claim Files-pane opens by filename pattern
pattern = "\\.(png|jpg)$"        # JS regex, case-insensitive, vs the file name
action = "greet"                 # your action, invoked with the absolute path
```

`command` is always argv: never a shell, no expansion (panes expand only
`$ROVE_PLUGIN_ROOT`). Unknown event names are warnings (forward compat);
invalid types/patterns are install-time errors.

The accepted platform tokens are exactly `macos`, `linux`, and `windows`.
A top-level list applies to the whole plugin; `platforms` on an individual
build, startup, action, event, or pane replaces that list for that item. With
no declaration, Rove assumes the command is portable and allows it everywhere.

## Event catalog

Declare `[[events]]` hooks; each fire runs your command with the envelope in
`ROVE_PLUGIN_EVENT_JSON`. Events are **asynchronous observers**. Your exit
code and output never block or change what happened. Support: C = Claude
Code, X = Codex (Kimi adapter pending).

| Event | Fires when | Detail highlights |
|---|---|---|
| `task.created` / `task.deleted` | task appears/disappears in the index | task context |
| `task.landed` | a task's branch merged back into its base repo | `strategy`, `landedOn`, `commit` |
| `task.archived` | a task was archived (restores don't fire) | task context |
| `worktree.created` | a task's worktree materialized | task context |
| `issue.changed` | a daemon-tracker issue mutated (create/edit/status) | `repo`, `op` |
| `task.opened` / `project.opened` | the user selects/enters a task / project row | |
| `file.will-open` / `file.opened` / `file.closed` | Files-pane open, before/after; editor tab closed | `path`, `via: plugin\|editor\|external` |
| `tab.opened` / `tab.closed` | a workspace tab appeared/went away (restores don't fire) | `tabId`, `kind`, `title`, `vendor`, `purpose` |
| `agent.running` / `agent.idle` / `agent.turn-complete` / `agent.permission-needed` / `agent.rate-limited` / `agent.error` | activity-STATE transitions, deduped per task+tab | |
| `session.start` / `session.end` | engine session lifecycle (C; X start only) | |
| `turn.prompt` / `turn.complete` / `turn.failed` / `turn.interrupted` | one event per turn edge (C, X; interrupted: Kimi-shaped) | `failure` class on failed |
| `tool.pre` / `tool.post` / `tool.failed` | every tool call (C, X; failed: C); **installed into engine config only while some enabled plugin subscribes** | `tool.name`, `tool.id` |
| `attention.permission` / `attention.question` | the engine blocked on a human (C) | `waiting` |
| `context.pre-compact` / `context.post-compact` | context compaction (C, X) | `compact.trigger: manual\|auto` |
| `subagent.start` / `subagent.stop` | nested agent lifecycle (C) | `subagent.type/id` |

Envelope (`ROVE_PLUGIN_EVENT_JSON`):

```jsonc
{
  "event": "tool.post",
  "taskId": "…",                 // when the event mapped to a task
  "task": { "id", "title", "repo", "branch", "worktreePath", "vendor", "status" },
  "vendor": "claude",            // agent-layer events
  "tabId": "…", "sessionId": "…",// when known
  "detail": { /* per-event, see table */ },
  "at": 1690000000000
}
```

**The principle: any observable product moment is a candidate event.** The
catalog grows as subsystems expose their edges (PR status and task status
transitions are natural next ones). If your plugin needs a
moment that isn't fired yet, ask via `rove feedback` or a GitHub issue; the
plumbing (`ui.reportEvent` → plugin sink) makes additions cheap.

## Environment contract

Every plugin command gets, on top of the user's environment:

| Variable | Meaning |
|---|---|
| `ROVE_BIN_PATH` | exec this to call back into Rove |
| `ROVE_SOCKET_PATH` | daemon unix socket, for raw JSON requests |
| `ROVE_HOME_DIR` | set when Rove runs against a non-default home (keep passing it through) |
| `ROVE_PLUGIN_ID`, `ROVE_PLUGIN_ROOT` | who you are, where your files are |
| `ROVE_PLUGIN_CONFIG_DIR` | user-editable config (`.env` etc.); survives reinstall |
| `ROVE_PLUGIN_STATE_DIR` | your durable state; survives reinstall |
| events | `ROVE_PLUGIN_EVENT`, `ROVE_PLUGIN_EVENT_JSON`, `ROVE_PLUGIN_TASK_ID`, `ROVE_PLUGIN_TASK_TITLE` |
| startup | `ROVE_PLUGIN_EVENT=startup` |
| actions | `ROVE_PLUGIN_ACTION_ID`, `ROVE_PLUGIN_INVOKE_CWD` (where the user invoked, usually "the repo I mean") |
| panes | `ROVE_PLUGIN_ENTRYPOINT_ID`; cwd is the task worktree |

Every `ROVE_*` variable above is also injected under its established `KOBE_*`
alias. Existing plugins need no edits; when both are supplied, SDK readers
prefer `ROVE_*`. Likewise, `kobe-plugin.toml`, `min_kobe_version`, and
`@sma1lboy/kobe-plugin-sdk` remain supported compatibility spellings.

Never write durable state under `ROVE_PLUGIN_ROOT`. GitHub installs are
managed checkouts replaced on reinstall. Settings you declare in
`[[settings]]` arrive as plain vars in your config `.env`; source it
(`. "$ROVE_PLUGIN_CONFIG_DIR/.env"`) or read it yourself.

## Calling back into Rove

**CLI (recommended, portable):** exec `$ROVE_BIN_PATH` with any command.
The high-value verbs live under `rove api`: machine-readable list via
`rove api schema`, human list via `rove api help`. Highlights:

```bash
"$ROVE_BIN_PATH" api add --repo <dir> --title T --prompt "…"   # create task + start engine
"$ROVE_BIN_PATH" api dispatch --task-id ID --prompt "…"        # text into a live session
"$ROVE_BIN_PATH" api list                                      # all tasks (JSON)
"$ROVE_BIN_PATH" api notify --title "done"                     # toast in every attached UI
"$ROVE_BIN_PATH" api issue-create --repo <dir> --title "…"     # daemon issue tracker
"$ROVE_BIN_PATH" api prompt --title "URL?"                     # host input dialog → {value}|{cancelled}
"$ROVE_BIN_PATH" api read-output --task-id ID                  # structured session reads
"$ROVE_BIN_PATH" plugin pane open you.example.board            # qualified-id form
"$ROVE_BIN_PATH" plugin pane open --plugin you.example \
  --entrypoint board                                           # equivalent flag form
```

**Socket (advanced):** newline-delimited JSON frames on `ROVE_SOCKET_PATH`
(`{"type":"request","id":"1","name":"task.list","payload":{}}`); request
names and payloads in `packages/kobe-daemon/src/daemon/protocol.ts`. Prefer
the CLI unless you need push channels.

## Interaction surfaces

- **ctrl+e picker**: every enabled plugin's panes are listed by title;
  picking one opens it with your declared placement.
- **User keybindings**: users bind chords themselves in
  `~/.rove/settings/keybindings.yaml`:
  `plugins: { ctrl+b: pane:you.example.board, f6: action:you.example.greet }`.
  Ship the suggestion in your README; Rove ships no default plugin chords.
- **Files pane**: `[[file_handlers]]` claims opens by pattern.
- **Host input dialog**: `rove api prompt --title "…"` (SDK: `promptUser()`)
  pops the TUI's standard input dialog and blocks for the answer: `{value}`
  on submit, `{cancelled, reason}` on esc/timeout. Use it instead of
  hand-rolling in-pane prompts.
- **Settings → Plugins**: enable/disable, declared surfaces, last run,
  and your `[[settings]]` editors.
- **CLI**: `rove plugin action invoke`, `rove plugin pane open`, `rove
  plugin log`.

## Ground rules

- **Hooks must be fast and silent.** Event hooks run on real product
  moments; do your slow work detached. Exit non-zero only for real failures;
  output is capped at 8 KB per run in `log.jsonl`.
- **Never block.** Events are observers; there is no veto surface. Blocking
  tweaks (deny a tool call) belong in engine-native hooks the user installs
  directly.
- **Trust model**: plugins run as the user with their environment; installs
  preview every command and build step first, but nothing is sandboxed.
  Keep your repo auditable. That's what gets you installed.
- Reference implementations: the first-party plugins in
  [Sma1lboy/kobe-plugins](https://github.com/Sma1lboy/kobe-plugins)
  (notifications, GitHub/Linear task starters, lazygit pane, Chromium pane,
  the character-cell video player).

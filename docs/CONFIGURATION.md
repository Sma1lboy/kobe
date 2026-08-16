# Configuration

Most settings are written for you by the Settings dialog — press `ctrl+a`,
then `,`. This page is for when you want to edit them by hand.

## Where things live

| Path | What | Written by |
|---|---|---|
| `~/.config/rove/state.json` | All your preferences, as flat JSON | Rove (Settings, CLI); yours to hand-edit |
| `~/.rove/themes/*.json` | Installed themes | `rove theme add`, or drop files in |
| `~/.rove/settings/keybindings.yaml` | Keybinding overrides | You only |
| `<repo>/.rove/init.sh` + `init-prompt.md` | Per-repo worktree setup | You (committed to the repo) |
| `<repo>/.rove/pr-instructions.md` | Per-repo PR action prompt | You (committed to the repo) |

Setting `ROVE_HOME_DIR` changes the home beneath these paths. `KOBE_HOME_DIR`
remains a supported fallback; when both are set, `ROVE_HOME_DIR` wins. On first
launch, Rove copies missing client-owned data from `.kobe` and `.config/kobe`;
daemon-owned stores are copied when the new daemon starts, after the old writer
has stopped. Neither phase overwrites or deletes old files. Existing worktrees
stay where they are; daemon/PTY runtime files and plugins retain their compatibility paths.

## Editing settings

```sh
rove config          # open state.json in your editor
rove config --path   # just print the path
```

rove picks your editor in this order: `$VISUAL` / `$EDITOR` → your configured
editor (`editor.kind` below) → the first installed of nvim, vim, emacs, nano.

Restart Rove to apply a hand edit everywhere.

**Hand-editing is safe.** Unknown keys are ignored and bad values fall back to
defaults, so a typo can't wedge the app — worst case a preference resets. If
the file becomes invalid JSON, Rove renames it to
`state.json.corrupt-<timestamp>` and starts fresh rather than deleting it.
Concurrent Rove processes re-read before writing, so they don't clobber each
other.

## Settings reference

Keys not listed here are internal UI state (saved repos, tab layouts) that
happen to share the file.

### Appearance

| Key | Type | Default | What it does |
|---|---|---|---|
| `activeTheme` | theme name | `"claude"` | See [Themes](#themes) |
| `transparentBackground` | boolean | `true` | Let the terminal background show through |
| `focusAccent` | `primary` \| `success` \| `info` | `primary` | Color of the focused-pane indicator |
| `appearance.splitStyle` | `box` \| `line` | `box` | `box` frames each split; `line` is the minimal tmux-style look |
| `locale` | `en` \| `zh` | `en` | UI language |
| `hints.keyboard.enabled` | boolean | `true` | Keyboard discoverability hints |

Turning keyboard hints back on relights the first-use pane hints you'd
already dismissed.

### Editor

`editor.kind` and `editor.customCommand` control the file tree's `enter`
action and `rove config`. Opening an entire worktree (`o` in the sidebar or
`ctrl+a` `o`) uses the separate GUI/workspace opener described below.

| Key | Type | Default | What it does |
|---|---|---|---|
| `editor.kind` | `auto` \| `vim` \| `nvim` \| `nano` \| `emacs` \| `custom` | `auto` | `auto` honors `$VISUAL`/`$EDITOR`, then auto-detects |
| `editor.customCommand` | string | unset | Command for `custom`, e.g. `code -w` |

In `editor.customCommand`, `{file}` is replaced by the quoted file path. Without
it, the path is appended.

Set `ROVE_OPEN_EDITOR` to choose the GUI editor for a whole worktree, for
example `ROVE_OPEN_EDITOR=zed`. `KOBE_OPEN_EDITOR` remains a compatibility
fallback; when both are set, `ROVE_OPEN_EDITOR` wins. Without either variable,
Rove tries the `code`, `cursor`, `windsurf`, and `zed` CLIs in that order,
then the platform opener. These variables do not change the file tree's
per-file TTY editor.

### Engines

| Key | Type | Default | What it does |
|---|---|---|---|
| `defaultVendor` | engine id | `"claude"` | Default engine for new tasks |
| `engineCommand.<id>` | string | built-in | Launch command, e.g. `"engineCommand.claude": "claude --model opus"` |
| `engineName.<id>` | string | built-in | Display name |
| `customEngineIds` | string[] | `[]` | Your own engines — see [Custom engines](#custom-engines) |
| `lastActiveVendor.<repo>` | engine id | unset | Per-project last used; outranks `defaultVendor`. Written by Rove |

Launch commands are parsed shell-ish — quotes group arguments. Clear both
`engineName.<id>` and `engineCommand.<id>` to reset an engine to its default.

### Terminal and tabs

| Key | Type | Default | What it does |
|---|---|---|---|
| `terminal.scrollbackRows` | number | `1000` | History per embedded terminal. Clamped 100–100,000 |
| `chat.tabStrip.mode` | `always` \| `multipleOnly` \| `never` | `never` | Horizontal chat tab strip |

The tab strip is off by default because the sidebar tree already lists every
tab. `multipleOnly` shows it once a task has more than one. (An older
`chat.tabStrip.hideSingle` boolean still works if you set it before
`chat.tabStrip.mode` existed; writing the new key retires it.)

Scrollback changes apply to terminals started *after* the change; live ones
keep the buffer they were born with.

### Notifications

All three default to on.

| Key | Type | What it does |
|---|---|---|
| `notifications.toast.enabled` | boolean | In-TUI completion toasts |
| `notifications.sound.enabled` | boolean | Chime when a background tab finishes |
| `notifications.crossTask.enabled` | boolean | Toasts for tasks you aren't looking at |

Error toasts always show, even with toasts off. See
[Notifications](#notifications-and-sound) for how they're delivered.

### Zen mode

Zen hides the Files pane so the active workspace gets the freed width. The
engine or shell in the workspace remains visible. Toggle with `ctrl+a` `z`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `zen.active` | boolean | `false` | On/off. Persisted, so switching projects keeps you in zen |

The current PureTUI always keeps the Tasks rail visible in zen mode because
the rail also contains the exit affordance. `zen.keepTasks` is a legacy value:
Settings can still write it, but it currently has no layout effect.

### Worktree location

By default new worktrees land under `~/.rove/worktrees/<repo-key>/<slug>`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `worktree.basePath` | string | `~/.rove/worktrees` | Where new worktrees go |
| `worktree.basePath.custom` | string | unset | Remembers your last custom path in the TUI |

`worktree.basePath` takes an absolute path, or one starting with the
`$project_dir` token, which expands to each task's project root — one setting
that gives you a per-project layout. `$project_dir/..` puts worktrees next to
each repo. The token only counts as the **first** segment.

**Only new tasks move.** Existing tasks keep the path they were created with,
including legacy global and repo-local roots. New remote (SSH) worktrees use
`<basePath>/.rove/worktrees`; their existing `.kobe/worktrees` remain
discoverable. No restart needed.

### Sidebar

The current tree sidebar follows persisted project/task order and supports
manual project reordering with `shift+m`. Older state files may contain
`activeSortMode` and `tasksPane.projectFilter`; the daemon still mirrors those
compatibility values, but the current PureTUI tree does not consume them.

### Experimental

Off by default. These can change without notice.

| Key | What it enables |
|---|---|
| `experimental.remoteProjects` | Projects over SSH |
| `experimental.autoStatus` | Tasks move to `in_progress` and self-report `in_review` |
| `experimental.dispatcher` | Per-repo routing of field notes between sessions |
| `experimental.archivedHistoryPreview` | Reserved legacy toggle; the current PureTUI has no archived-history viewer |

## Themes

rove bundles three themes — `claude`, `conductor`, and `tokyonight` — and ten
more are one command away:

```sh
rove theme list
rove theme add https://rove.sma1lboy.me/themes/gruvbox.json
rove theme remove gruvbox
```

Available hosted: `catppuccin`, `dracula`, `everforest`, `gruvbox`,
`kanagawa`, `nord`, `opencode`, `osaka-jade`, `rose-pine`, `solarized`.
Preview them at <https://rove.sma1lboy.me/themes>.

You can also drop your own `<name>.json` into `~/.rove/themes/` — no
recompile, loaded at boot, and a user theme wins over a bundled one with the
same name. Writing one: [Themes](./themes.md).

## Keybindings

Full vocabulary: [Keybindings](./KEYBINDINGS.md). The configuration surface:

- Edit `~/.rove/settings/keybindings.yaml` by hand. Rove never writes it.
- Changes **reload live** — no restart. Problems show up as warnings in
  Settings → Keybindings.
- A direct override replaces that binding's whole chord list; `null` or `[]`
  unbinds it. Prefix overrides set second-stroke keys and keep the original
  pane scope. Platform overlays (`darwin:`, …) win per chord.
- A `plugins:` section binds chords to installed plugin panes and actions.
  Rove ships no default plugin chords.
- Unknown ids are ignored with a warning — a typo never breaks the keymap.

## Notifications and sound

Three kinds: `done` (green), `needs_input` (yellow), `error` (red). Yellow and
red outrank green when both fire for the same tab. Three delivery channels:

- **Toasts** — in-TUI, 4.5 seconds. Error toasts always show, even with
  toasts disabled: a failure shouldn't vanish because you turned off
  completion popups.
- **Desktop notification** — Rove emits an OSC 9 escape that iTerm2, kitty,
  WezTerm, and Ghostty turn into a real OS notification; other terminals
  ignore it. Because it travels down the terminal stream, **it reaches you
  over SSH**. No separate switch.
- **Sound** — a short chime when a background tab finishes. Rove uses the
  first player it finds on `PATH` (`afplay`, `ffplay`, `mpv`, `play`,
  `aplay`, …). With none installed it's silent and the terminal bell is the
  fallback.

## Custom engines

Built-in engines are `claude`, `codex`, `copilot`, and `kimi`. You can
register any other CLI from **Settings → Engines**, or by hand:

```json
{
  "customEngineIds": ["aider"],
  "engineCommand.aider": "aider --model sonnet",
  "engineName.aider": "Aider"
}
```

Being in `customEngineIds` *is* the registration — there's no other step. Ids
must match `^[a-z][a-z0-9_-]{0,47}$` and can't collide with a built-in;
invalid ones are dropped on read.

A custom engine launches and runs like any other, but Rove deliberately
doesn't guess at its internals: no history reader, no account detection, no
activity hooks, no session resume. More in [Engines](./ENGINES.md).

## Claude Code plugin

Rove integrates with Claude Code through global activity hooks (so the
sidebar can show working / done / needs-input for every session) and the
companion agent skill. There are two ways to get both, and you should run
exactly one:

- **Default (no action needed)**: every Rove launch idempotently writes its
  hooks into `~/.claude/settings.json`, and `rove skill install` places the
  skill. This is what most existing installs use.
- **The Claude Code plugin** — one install carries hooks and skill together,
  with no PATH or settings.json involvement:

  ```text
  /plugin marketplace add Sma1lboy/rove
  /plugin install rove@rove
  ```

  The plugin's hook commands call a bundled wrapper by absolute path, so they
  work even when `rove` isn't on the shell's PATH. The bundled skill versions
  with the plugin (`/plugin update` refreshes both), so Rove's skill staleness
  prompts step aside while the plugin is enabled.

Once Rove sees the plugin enabled, it stops writing the Claude hooks into
`settings.json` on launch. If you were running Rove **before** installing the
plugin, the old settings-managed hooks are still there and every event would
fire twice — Rove warns about this at startup and the fix is one command:

```bash
rove hook cleanup
```

That removes only Rove's own entries from `~/.claude/settings.json`; your
other hooks are untouched. If you also have a pre-plugin skill copy under
`~/.claude/skills/rove` (or `…/kobe`), delete that directory — the plugin's
bundled copy replaces it. Rove never edits or removes either one silently.

Uninstalling or disabling the plugin reverses the handoff: the next Rove
launch reinstalls the settings-managed hooks automatically.

Only Claude Code is affected. Codex (and other engines') hook integration is
engine-owned and unchanged by the plugin.

## Per-repo init

A repo can ship two files in its own `.rove/` directory:

- **`.rove/init.sh`** — runs in each new task worktree before the engine
  starts, once per worktree. Use it for `bun install`, direnv, codegen.
- **`.rove/init-prompt.md`** — sent as the engine's first message.

Files committed in the repo win over any per-user override you set with
`rove repo set`. Legacy `.kobe/init.sh` and `.kobe/init-prompt.md` remain
field-by-field fallbacks; a `.rove` file wins when both spellings exist.

The PR action also reads `.rove/pr-instructions.md` as its prompt template.
It falls back to `.kobe/pr-instructions.md`; when both files are present, the
non-empty `.rove` file wins.

# Configuration

Most settings are written for you by the Settings dialog — press `ctrl+a`,
then `,`. This page is for when you want to edit them by hand.

## Where things live

| Path | What | Written by |
|---|---|---|
| `~/.config/kobe/state.json` | All your preferences, as flat JSON | kobe (Settings, CLI); yours to hand-edit |
| `~/.kobe/themes/*.json` | Installed themes | `kobe theme add`, or drop files in |
| `~/.kobe/settings/keybindings.yaml` | Keybinding overrides | You only |
| `<repo>/.kobe/init.sh` + `init-prompt.md` | Per-repo worktree setup | You (committed to the repo) |

Setting `ROVE_HOME_DIR` moves all of it somewhere else. `KOBE_HOME_DIR` remains
a supported fallback; when both are set, `ROVE_HOME_DIR` wins. The directory
names themselves deliberately stay `.kobe` and `.config/kobe` during the first
rename phase, so existing state is reused without migration.

## Editing settings

```sh
kobe config          # open state.json in your editor
kobe config --path   # just print the path
```

kobe picks your editor in this order: `$VISUAL` / `$EDITOR` → your configured
editor (`editor.kind` below) → the first installed of nvim, vim, emacs, nano.

Restart kobe to apply a hand edit everywhere.

**Hand-editing is safe.** Unknown keys are ignored and bad values fall back to
defaults, so a typo can't wedge the app — worst case a preference resets. If
the file becomes invalid JSON, kobe renames it to
`state.json.corrupt-<timestamp>` and starts fresh rather than deleting it.
Concurrent kobe processes re-read before writing, so they don't clobber each
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

Used by the file tree's `e`, `ctrl+a` `o` (open worktree), and `kobe config`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `editor.kind` | `auto` \| `vim` \| `nvim` \| `nano` \| `emacs` \| `custom` | `auto` | `auto` honors `$VISUAL`/`$EDITOR`, then auto-detects |
| `editor.customCommand` | string | unset | Command for `custom`, e.g. `code -w` |

In `editor.customCommand`, `{file}` is replaced by the quoted file path. Without
it, the path is appended.

> Separately, `KOBE_OPEN_EDITOR` picks the GUI editor for opening a whole
> worktree (`code`, `cursor`, …). These keys are for the TTY editor.

### Engines

| Key | Type | Default | What it does |
|---|---|---|---|
| `defaultVendor` | engine id | `"claude"` | Default engine for new tasks |
| `engineCommand.<id>` | string | built-in | Launch command, e.g. `"engineCommand.claude": "claude --model opus"` |
| `engineName.<id>` | string | built-in | Display name |
| `customEngineIds` | string[] | `[]` | Your own engines — see [Custom engines](#custom-engines) |
| `lastActiveVendor.<repo>` | engine id | unset | Per-project last used; outranks `defaultVendor`. Written by kobe |

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

Zen hides the files and terminal panes so each engine pane fills its window.
Toggle with `ctrl+a` `z`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `zen.active` | boolean | `false` | On/off. Persisted, so switching projects keeps you in zen |
| `zen.keepTasks` | boolean | `true` | Keep the Tasks rail visible |

### Worktree location

By default worktrees land under `~/.kobe/worktrees/<repo-key>/<slug>`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `worktree.basePath` | string | `~/.kobe/worktrees` | Where new worktrees go |
| `worktree.basePath.custom` | string | unset | Remembers your last custom path in the TUI |

`worktree.basePath` takes an absolute path, or one starting with the
`$project_dir` token, which expands to each task's project root — one setting
that gives you a per-project layout. `$project_dir/..` puts worktrees next to
each repo. The token only counts as the **first** segment.

**Only new tasks move.** Existing tasks keep the path they were created with,
and remote (SSH) projects are unaffected. No restart needed.

### Sidebar

| Key | Type | Default | What it does |
|---|---|---|---|
| `activeSortMode` | `recent` \| `default` | `default` | Task ordering. `recent` reshuffles as you switch tasks |

Hand-edit only today — nothing in the UI writes this key.

### Experimental

Off by default. These can change without notice.

| Key | What it enables |
|---|---|
| `experimental.remoteProjects` | Projects over SSH |
| `experimental.autoStatus` | Tasks move to `in_progress` and self-report `in_review` |
| `experimental.dispatcher` | Per-repo routing of field notes between sessions |
| `experimental.archivedHistoryPreview` | Read-only history for archived tasks |

## Themes

kobe bundles three themes — `claude`, `conductor`, and `tokyonight` — and ten
more are one command away:

```sh
kobe theme list
kobe theme add https://kobe.sma1lboy.me/themes/gruvbox.json
kobe theme remove gruvbox
```

Available hosted: `catppuccin`, `dracula`, `everforest`, `gruvbox`,
`kanagawa`, `nord`, `opencode`, `osaka-jade`, `rose-pine`, `solarized`.
Preview them at <https://kobe.sma1lboy.me/themes>.

You can also drop your own `<name>.json` into `~/.kobe/themes/` — no
recompile, loaded at boot, and a user theme wins over a bundled one with the
same name. Writing one: [Themes](./themes.md).

## Keybindings

Full vocabulary: [Keybindings](./KEYBINDINGS.md). The configuration surface:

- Edit `~/.kobe/settings/keybindings.yaml` by hand. kobe never writes it.
- Changes **reload live** — no restart. Problems show up as warnings in
  Settings → Keybindings.
- A direct override replaces that binding's whole chord list; `null` or `[]`
  unbinds it. Prefix overrides set second-stroke keys and keep the original
  pane scope. Platform overlays (`darwin:`, …) win per chord.
- A `plugins:` section binds chords to installed plugin panes and actions.
  kobe ships no default plugin chords.
- Unknown ids are ignored with a warning — a typo never breaks the keymap.

## Notifications and sound

Three kinds: `done` (green), `needs_input` (yellow), `error` (red). Yellow and
red outrank green when both fire for the same tab. Three delivery channels:

- **Toasts** — in-TUI, 4.5 seconds. Error toasts always show, even with
  toasts disabled: a failure shouldn't vanish because you turned off
  completion popups.
- **Desktop notification** — kobe emits an OSC 9 escape that iTerm2, kitty,
  WezTerm, and Ghostty turn into a real OS notification; other terminals
  ignore it. Because it travels down the terminal stream, **it reaches you
  over SSH**. No separate switch.
- **Sound** — a short chime when a background tab finishes. kobe uses the
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

A custom engine launches and runs like any other, but kobe deliberately
doesn't guess at its internals: no history reader, no account detection, no
activity hooks, no session resume. More in [Engines](./ENGINES.md).

## Per-repo init

A repo can ship two files in its own `.kobe/` directory:

- **`.kobe/init.sh`** — runs in each new task worktree before the engine
  starts, once per worktree. Use it for `bun install`, direnv, codegen.
- **`.kobe/init-prompt.md`** — sent as the engine's first message.

Files committed in the repo win over any per-user override you set with
`kobe repo set`.

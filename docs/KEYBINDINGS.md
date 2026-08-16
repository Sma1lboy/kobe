# Keybindings

**Press `F1` inside Rove** for the live, localized keymap, including your own
overrides. This page is the stable vocabulary and behavior reference.

## How keys work

Two things decide what a key does:

- **Where** — a key is either Rove-wide, or owned by the focused pane.
- **How** — one press, or the prefix followed by a second key.

Which gives you three patterns:

| Pattern | Example | Used for |
|---|---|---|
| Bare letter | `n`, `a`, `d` | Actions in the focused pane |
| One press | `ctrl+t`, `ctrl+w` | Frequent Rove-wide actions |
| Prefix sequence | `ctrl+a` then `i` | Everything less frequent |

Inside the embedded engine terminal, unclaimed keys go straight to the engine
— Rove only reserves its explicit chords. The prefix still works there, so
the command menu is reachable from every pane. Press `ctrl+q` to leave the
terminal without opening it.

## The prefix

The default first stroke is `ctrl+a`. Press it, then one more key within 5
seconds. After a short pause an on-screen command map appears, showing only
the actions that can actually run right now.

| Sequence | Action |
|---|---|
| `ctrl+a` `f` | New-conversation dialog, preset to "fork a child task" — new managed worktree, branched off this Task's branch |
| `ctrl+a` `c` | New-conversation dialog, preset to "continue this chat" in a new tab of the same Task directory |
| `ctrl+a` `i` | Open the Inbox |
| `ctrl+a` `y` | Resume a prior engine session |
| `ctrl+a` `h` / `l` | Move focus left / right across panes |
| `ctrl+a` `o` | Open the Task directory in your editor |
| `ctrl+a` `m` | Reorder projects in the sidebar |
| `ctrl+a` `w` | Close the active split |
| `ctrl+a` `1` / `2` / `3` | Kanban / Automations / GitHub Issues |
| `ctrl+a` `z` | Toggle zen mode |
| `ctrl+a` `,` | Open Settings |
| `ctrl+a` `p` | Create a PR from the active task |

`ctrl+a` `c` picks an engine first. Claude and Codex can fork their own
conversations natively. Copilot and Kimi use a transcript handoff even for a
same-engine continuation; a built-in source can also hand off to a different
built-in or custom target. A custom source has no readable transcript, so its
continuation is refused. See [Engines](./ENGINES.md#resuming-and-forking).

The sequence cancels on timeout, `esc`, an invalid second key, or a change of
focus or dialog.

## One-press keys

| Key | Action |
|---|---|
| `F1` | The live keymap — works everywhere, including inside the terminal |
| `ctrl+q` | Focus the sidebar; from the sidebar, quit |
| `ctrl+t` | New engine tab |
| `ctrl+e` | New-conversation dialog — engine/shell picker; inside it, `tab` switches the destination (new tab here ⇄ fork a child task) and `ctrl+f` the context (fresh ⇄ continue this chat). The trailing "scratch shell" choice opens a Scratch shell task |
| `ctrl+w` | Close the active split, otherwise the tab |
| `ctrl+[` / `ctrl+]` | Previous / next tab |
| `ctrl+\` | Split right |
| `ctrl+=` | Split down |
| `ctrl+2` … `ctrl+9`, `ctrl+0` | Jump to the sidebar row printing that digit |
| `F2` | Rename the active split, otherwise the tab |
| `F3` | Focus the next split |
| `F4` | Cycle focus forward |
| `F5` | Confirm and reset the active terminal |
| `F7` | Jump to the next Inbox item across all projects |

Overlap resolves by context: `ctrl+w` closes the innermost split when a tab
is split, otherwise the tab. `F2` follows the same rule.

**Jump digits.** Each sidebar row prints the digit that jumps to it, so you
read it off the screen rather than counting. There is no `ctrl+1` — the
terminal protocol can't encode it, so the first row answers to `2`.

## Sidebar and Files

Bare letters work only while that pane has focus and no dialog or text input
is active.

**Sidebar**

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `n` | New task | | `r` | Rename |
| `enter` | Open | | `b` | Rename branch |
| `l` / `space` | Open the row under the cursor | | `v` | Change engine |
| `o` | Open Task directory in your editor | | `s` | Settings |
| `a` | Archive non-main Task | | `u` | Update page |
| `d` | Delete Task / forget project | | `/` | Search |
| `gg` / `shift+g` | Top / bottom | | `x` | Worktrees page |
| `shift+p` | Pin / unpin managed Task | | `right` | Focus the current engine pane |
| `shift+m` | Enter project reorder mode | | | |

In reorder mode, `j`/`k` moves the highlighted project and `enter` or `esc`
finishes. Project headings themselves aren't cursor rows; the move routes
through a Task row in that project.

**Files**

| Key | Action |
|---|---|
| `j` / `k` | Move |
| `h` / `l` | Collapse / expand |
| `enter` | Open in your configured editor; changed files use a Vim/Nvim diff when available, otherwise Rove falls back to its read-only preview |
| `d` | Open a read-only diff in a workspace tab without moving focus |
| `r` | Refresh the current file tab |
| `b` | On Changes, switch working-tree changes ⇄ branch vs base |
| `o` | Open audio, video, or PDF files in the system application |
| `a` | Insert an `@path` mention into the engine pane |
| `[` / `]` | Switch file tabs |

The sidebar is a tree — project → Task → Terminal Tab — and it never folds, so
everything is always visible. Search (`/`) matches titles, repos, branches,
and live tab titles, and keeps matching rows' parents so a hit is never
orphaned.

Right-click any row for its context menu; common row actions also have direct
chords. (If right-click opens your *terminal's* menu instead, see
[Troubleshooting](./TROUBLESHOOTING.md).)

## Terminal scrollback

These chords are trapped by Rove while the embedded terminal has focus; the
engine or shell does not receive them.

| Key | Action |
|---|---|
| `ctrl+pageup` | Scroll one page up through buffered terminal output |
| `ctrl+pagedown` | Scroll one page down; reaching the bottom resumes following live output |

The mouse wheel uses the same scrollback. Buffer size is configured in
Settings → General → Terminal and applies to newly opened terminals.

## Inbox

`ctrl+a` `i` opens it. What the sections mean and how items clear:
[The TUI → Inbox](TUI.md#inbox).

| Key | Action |
|---|---|
| `j` / `k` (or arrows) | Select |
| `enter` | Open the target task and its exact tab when present, then clear the item |
| `d` | Clear an ATTENTION item without navigating |
| `esc` | Close |

## Diff review

In the read-only diff tab, with the workspace focused:

| Key | Action |
|---|---|
| `j` / `k` | Move the line cursor |
| `v` | Anchor a range (`v` again cancels) |
| `c` | Write a note |
| `s` | Send all unsent notes to the engine |

These four are fixed — they can't be rebound. The workflow:
[The TUI → Diff review](TUI.md#diff-review).

## Workspace pages

All of these pages close with `q` or `esc`. Their bare letters are active only
while the page has focus.

| Page | Keys |
|---|---|
| Kanban | arrows move between cards; `tab` changes project; `enter` opens details; `n` creates; `d` deletes; `r` refreshes |
| Routines | `j`/`k` select; `n` creates; `e` pauses/resumes; `s` runs now; `d` deletes; `r` refreshes; `enter` opens the latest run's Task |
| GitHub Issues | `j`/`k` select; `tab` changes repo; `a` toggles “assigned to me”; `r` refreshes; `enter` starts a Task |
| Worktrees | arrows select; `l` lands; `d` starts removal; see [Managing worktrees](WORKTREES.md) |
| Update | `j`/`k` selects an action; `u` updates; `r` opens the release page; `enter` runs the selected action |

In the Kanban story drawer, `tab` / `shift+tab` walks fields and `ctrl+enter`
activates its primary action: start an unlinked story or open the linked Task.
While creating a story, `ctrl+s` saves without starting and `esc` cancels.
In an existing story, `esc` saves edits and closes, while `ctrl+c` discards
them.

## Customizing

Change the first stroke in **Settings → Keybindings → Prefix key**, or edit
`~/.rove/settings/keybindings.yaml` for the full keymap. Changes reload live —
no restart. Enter `disabled` in Settings (or use `null` in YAML) to turn the
prefix layer off.

```yaml
prefix:
  key: ctrl+a          # null disables prefix bindings
  timeoutMs: 5000
  bindings:
    chat.fork.new: f

bindings:
  chat.tab.new: ctrl+t
  chat.tab.chooseEngine: ctrl+e
  sidebar.select: [enter]
  files.createPR: null   # null or [] unbinds

darwin:                  # platform overlays win per chord
  bindings:
    files.openExternal: cmd+o
```

- A direct override **replaces** that binding's whole chord list.
- Prefix overrides set second-stroke keys and keep the binding's pane scope.
- Uppercase is a distinct chord: `shift+p` (or just `P`) can be bound apart
  from `p`. Shift with another modifier on a letter (`ctrl+shift+p`) is
  invalid — legacy terminals send the same byte either way.
- Unknown ids and invalid entries are ignored with a warning in
  Settings → Keybindings. A typo never breaks the default keymap.

### Plugin chords

rove ships none — every plugin chord is your own choice:

```yaml
plugins:
  ctrl+g: pane:examples.lazygit.git
  f6: action:examples.notify.test
```

See [design/plugins.md](./design/plugins.md).

---

Why each chord sits where it does, and which ones are still open questions:
[design/keybinding-decisions.md](./design/keybinding-decisions.md).

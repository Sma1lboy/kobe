# Keybindings

**Press `F1` inside kobe** for the live, localized keymap — it's always
correct, including your own overrides. This page is the stable vocabulary.

## How keys work

Two things decide what a key does:

- **Where** — a key is either Kobe-wide, or owned by the focused pane.
- **How** — one press, or the prefix followed by a second key.

Which gives you three patterns:

| Pattern | Example | Used for |
|---|---|---|
| Bare letter | `n`, `a`, `d` | Actions in the focused pane |
| One press | `ctrl+t`, `ctrl+w` | Frequent Kobe-wide actions |
| Prefix sequence | `ctrl+a` then `i` | Everything less frequent |

Inside the embedded engine terminal, unclaimed keys go straight to the engine
— kobe only reserves its explicit chords. The prefix still works there, so
the command menu is reachable from every pane. Press `ctrl+q` to leave the
terminal without opening it.

## The prefix

The default first stroke is `ctrl+a`. Press it, then one more key within 5
seconds. After a short pause an on-screen command map appears, showing only
the actions that can actually run right now.

| Sequence | Action |
|---|---|
| `ctrl+a` `f` | New-conversation dialog, preset to "fork a child task" — new worktree, branched off this task's branch |
| `ctrl+a` `c` | New-conversation dialog, preset to "continue this chat" in a new tab of the same worktree |
| `ctrl+a` `i` | Open the Inbox |
| `ctrl+a` `y` | Resume a prior engine session |
| `ctrl+a` `h` / `l` | Move focus left / right across panes |
| `ctrl+a` `o` | Open the task's worktree in your editor |
| `ctrl+a` `m` | Reorder projects and tasks in the sidebar |
| `ctrl+a` `w` | Close the active split |
| `ctrl+a` `1` / `2` / `3` | Kanban / Automations / GitHub Issues |
| `ctrl+a` `z` | Toggle zen mode |
| `ctrl+a` `,` | Open Settings |
| `ctrl+a` `p` | Create a PR from the active task |

`ctrl+a` `c` picks an engine first. The same engine forks the conversation
natively; a different one gets a transcript handoff (claude ⇄ codex — see
[Engines](./ENGINES.md)).

The sequence cancels on timeout, `esc`, an invalid second key, or a change of
focus or dialog.

## One-press keys

| Key | Action |
|---|---|
| `F1` | The live keymap — works everywhere, including inside the terminal |
| `ctrl+q` | Focus the sidebar; from the sidebar, quit |
| `ctrl+t` | New engine tab |
| `ctrl+e` | New-conversation dialog — engine/shell picker; inside it, `tab` switches the destination (new tab here ⇄ fork a child task) and `ctrl+f` the context (fresh ⇄ continue this chat) |
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
| `o` | Open worktree in your editor | | `s` | Settings |
| `a` | Archive | | `u` | Update page |
| `d` | Delete | | `/` | Search |
| `[` / `]` | Switch Working / Archives | | | |

**Files**

| Key | Action |
|---|---|
| `j` / `k` | Move |
| `h` / `l` | Collapse / expand |
| `enter` | Preview |
| `e` | Open in your editor |
| `d` | Diff |
| `[` / `]` | Switch file tabs |

The sidebar is a tree — project → worktree → tab — and it never folds, so
everything is always visible. Search (`/`) matches titles, repos, branches,
and live tab titles, and keeps matching rows' parents so a hit is never
orphaned.

Right-click any row for its menu. Every entry there is also a direct chord on
the row, so the menu is optional. (If right-click opens your *terminal's*
menu instead, see [Troubleshooting](./TROUBLESHOOTING.md).)

## Inbox

`ctrl+a` `i` opens it. Rows are pending items, oldest first.

| Key | Action |
|---|---|
| `j` / `k` | Select |
| `enter` | Open the target task and tab, and clear the item |
| `d` | Clear the item without navigating |

Visiting a target clears its item too — visiting means handled. A newer item
for the same task and tab replaces the older one.

## Diff review

In the read-only diff tab, with the workspace focused:

| Key | Action |
|---|---|
| `j` / `k` | Move the line cursor |
| `v` | Anchor a range |
| `c` | Write a note |
| `s` | Send all unsent notes to the engine |

## Customizing

Edit `~/.kobe/settings/keybindings.yaml`. Changes reload live — no restart.

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

kobe ships none — every plugin chord is your own choice:

```yaml
plugins:
  ctrl+g: pane:examples.lazygit.git
  f6: action:examples.notify.test
```

See [design/plugins.md](./design/plugins.md).

---

Why each chord sits where it does, and which ones are still open questions:
[design/keybinding-decisions.md](./design/keybinding-decisions.md).
